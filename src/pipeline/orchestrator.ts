/**
 * One chat turn:
 *
 *   understand (1 Jev call, ~40 typed questions)
 *     -> score the community vote data for every perfume (deterministic)
 *     -> screen (Jev judges EVERY perfume: one yes/no each, ~40 per request,  } compose (1 Jev call:
 *                requests concurrent)                                         }  lead, tone, clarify,
 *     -> rank (1 detailed Jev call for each of the top 14, concurrent)       }  follow-ups) runs
 *     -> render (deterministic templates)                                     }  alongside
 *
 * Explain / compare / small-talk intents take shorter paths.
 */
import type { Catalog } from '../catalog/catalog.js';
import { JevError } from '../jev/client.js';
import type { ChoiceAnswer, DecideOptions, Decider, QuestionSet } from '../jev/types.js';
import { choice } from '../jev/types.js';
import type { ChatReply, Fragrance, Intent, Recommendation, Session } from '../types.js';
import type { Composition } from './compose.js';
import { compose, followUpPool } from './compose.js';
import { describeFacets, describeFragrance } from './describe.js';
import { FOLLOW_UPS } from './followups.js';
import { NoteLexicon } from './lexicon.js';
import { rank } from './rank.js';
import { TurnRecorder } from './recorder.js';
import { CANNED, renderCompare, renderExplain, renderNoMatch, renderRecommendations } from './render.js';
import { retrieve } from './retrieve.js';
import { screen } from './screen.js';
import { SessionStore } from './session.js';
import { buildTrace } from './trace.js';
import type { UnderstandResult, Unresolved } from './understand.js';
import { understand } from './understand.js';

/**
 * Time each Jev call of a stage may take, retries and queueing included. A slow or
 * overloaded Jev then fails one call and its stage falls back (screen/rank -> vote
 * data, compose -> a default shape, compare -> no winner) instead of the whole turn
 * timing out. Understand has no fallback, so it gets room for a retry beyond one
 * full 10 s attempt. The stages run understand -> screen -> judge (compose alongside),
 * so the worst case is 22 + 12 + 10 = 44 s, inside the 50 s turn.
 */
export const STAGE_BUDGET_MS = { understand: 22_000, screenBatch: 12_000, judge: 10_000, compose: 10_000, compare: 10_000 } as const;
export const TURN_TIMEOUT_MS = 50_000;

/** Gives every call of one stage its budget; screen() and rank() take a plain Decider. */
function withBudget(d: Decider, budgetMs: number): Decider {
  return {
    mode: d.mode,
    decide: <QS extends QuestionSet>(state: unknown, questions: QS, opts?: DecideOptions) =>
      d.decide(state, questions, { ...opts, budgetMs: opts?.budgetMs ?? budgetMs }),
  };
}

export interface BotOptions {
  /** How many of Jev's top-screened perfumes get a detailed judgement. */
  judge?: number;
  /**
   * Jev screens every perfume when the catalog (after exclusions) is at most this
   * size; above it, the community-vote scores pick which perfumes Jev screens.
   */
  screenLimit?: number;
  /** Screening questions per Jev request. */
  screenBatch?: number;
  /** Recommendations per reply. */
  take?: number;
  turnTimeoutMs?: number;
}

export interface ChatResult {
  sessionId: string;
  mode: 'live' | 'mock';
  reply: ChatReply;
}

export class PerfumeBot {
  readonly sessions = new SessionStore();
  private readonly lexicon: NoteLexicon;

  constructor(
    readonly catalog: Catalog,
    private readonly decider: Decider,
    private readonly opts: BotOptions = {},
  ) {
    this.lexicon = new NoteLexicon(catalog);
  }

  get mode() {
    return this.decider.mode;
  }

  /** Real FragDB vote data can be quoted as numbers; the seed catalog's estimates cannot. */
  private get measured(): boolean {
    return this.catalog.source !== 'seed';
  }

  async chat(sessionId: string | undefined, rawMessage: string, signal?: AbortSignal): Promise<ChatResult> {
    const message = rawMessage.trim().slice(0, 1000);
    const session = this.sessions.getOrCreate(sessionId);
    const rec = new TurnRecorder(this.decider);
    const started = performance.now();
    const turnSignal = AbortSignal.any([
      AbortSignal.timeout(this.opts.turnTimeoutMs ?? TURN_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);

    const u = await understand({
      message, session, catalog: this.catalog, lexicon: this.lexicon, decider: withBudget(rec, STAGE_BUDGET_MS.understand), signal: turnSignal,
    });

    let body: Pick<ChatReply, 'text' | 'recommendations' | 'followUps'>;
    let recs: Recommendation[] = [];
    let shortlist: Array<{ name: string; screen?: number; retrieval: number; final?: number }> = [];
    let candidates = 0;
    let screening: { screened: number; of: number; batches: number; failedBatches: number } | undefined;

    const route = u.unresolved ? 'unresolved' as const : u.intent;
    switch (route) {
      case 'unresolved':
        body = unresolvedReply(u.unresolved!, u.intent, session.lastShown.length);
        break;

      case 'greeting':
      case 'thanks':
      case 'out_of_scope':
        body = { text: CANNED[route].text, recommendations: [], followUps: [...CANNED[route].followUps] };
        break;

      case 'explain': {
        const fr = this.catalog.get(u.focusPids[0]!)!;
        body = renderExplain(fr, session.lastBullets[fr.pid], { measured: this.measured });
        break;
      }

      case 'compare':
        body = await this.compare(message, u, rec, turnSignal);
        break;

      default: {
        // Every perfume the user has not excluded, scored on community data but never dropped:
        // what reaches the shortlist is Jev's call.
        const all = retrieve(this.catalog, u.facets, {
          exclude: u.exclude,
          seen: u.intent === 'refine' ? session.seen : [],
          limit: Infinity,
          maxPerBrand: Infinity,
          hardGate: false,
        });
        candidates = all.length;
        if (all.length === 0) {
          body = renderNoMatch(u.facets);
          break;
        }
        const take = this.opts.take ?? 4;
        const judge = this.opts.judge ?? 14;
        const pool = all.slice(0, this.opts.screenLimit ?? 400);
        const refs = u.facets.referencePids.map((p) => this.catalog.get(p)).filter((x): x is Fragrance => !!x);
        const proxy = all.slice(0, take).map((c) => ({
          fragrance: c.fragrance, final: c.retrieval, retrieval: c.retrieval, judgement: { fit: NaN, confidence: 0, facets: {} }, reasons: [],
        }));

        const compositionP = compose({
          message, facets: u.facets, recs: proxy, uncertain: u.uncertain, gift: u.gift, decider: withBudget(rec, STAGE_BUDGET_MS.compose), signal: turnSignal,
        })
          .catch((e): Composition => {
            if (turnSignal.aborted || (e instanceof JevError && e.status === 401)) throw e;
            return { lead: 'general', tone: 'warm', clarify: null, tip: false, followUps: followUpPool(u.facets, proxy).slice(0, 3) };
          });
        const rankedP = screen({
          message, facets: u.facets, fragrances: pool.map((c) => c.fragrance), refs, decider: withBudget(rec, STAGE_BUDGET_MS.screenBatch),
          batchSize: this.opts.screenBatch, signal: turnSignal,
        }).then((sc) => {
          screening = { screened: sc.screened, of: all.length, batches: sc.batches, failedBatches: sc.failedBatches };
          for (const c of pool) c.screen = sc.scores.get(c.fragrance.pid);
          // Jev's screening decides the shortlist; a perfume whose batch failed falls back to its vote-data score.
          const ordered = [...pool].sort((a, b) => (b.screen ?? b.retrieval) - (a.screen ?? a.retrieval) || b.retrieval - a.retrieval);
          const perBrand = new Map<string, number>();
          const shortlisted = ordered.filter((c) => {
            const n = perBrand.get(c.fragrance.brand) ?? 0;
            perBrand.set(c.fragrance.brand, n + 1);
            return n < 3;
          });
          return rank({
            message, facets: u.facets, candidates: shortlisted, decider: withBudget(rec, STAGE_BUDGET_MS.judge), catalogLookup: (p) => this.catalog.get(p),
            judge, take, signal: turnSignal,
          }).then((r) => ({ r, shortlisted }));
        });
        // allSettled-then-rethrow so a failure in one never leaves the other as an unhandled rejection.
        const [rankedS, compositionS] = await Promise.allSettled([rankedP, compositionP]);
        if (rankedS.status === 'rejected') throw rankedS.reason;
        if (compositionS.status === 'rejected') throw compositionS.reason;
        const { r: ranked, shortlisted } = rankedS.value;

        recs = ranked.recommendations;
        const finals = new Map(recs.map((x) => [x.fragrance.pid, x.final]));
        shortlist = shortlisted.slice(0, judge).map((c) => ({
          name: `${c.fragrance.name} (${c.fragrance.brand})`, screen: c.screen, retrieval: c.retrieval, final: finals.get(c.fragrance.pid),
        }));
        body = renderRecommendations({ message, facets: u.facets, recs, composition: compositionS.value, refs, gift: u.gift, measured: this.measured });
      }
    }

    this.remember(session, message, u, body, recs);

    return {
      sessionId: session.id,
      mode: this.decider.mode,
      reply: {
        ...body,
        debug: {
          understanding: {
            intent: u.intent,
            intentConfidence: u.intentConfidence,
            facets: u.facets,
            uncertain: u.uncertain,
            refine: u.refine,
            proposed: u.proposed,
            summary: describeFacets(u.facets),
          },
          telemetry: rec.summary(),
          trace: buildTrace(rec.log, u, this.catalog),
          jevCalls: rec.calls.map(({ attempts: _a, ...c }) => c),
          wallMs: Math.round(performance.now() - started),
          candidates,
          screening,
          shortlist,
        },
      },
    };
  }

  /** Jev picks the better perfume for this user; code renders the side-by-side. */
  private async compare(message: string, u: UnderstandResult, rec: Decider, signal: AbortSignal) {
    const frs = u.focusPids.slice(0, 3).map((p) => this.catalog.get(p)).filter((x): x is Fragrance => !!x);
    const opts = Object.fromEntries(frs.map((f) => [`p_${f.pid}`, `${f.name} by ${f.brand}`]));
    let winner: ChoiceAnswer | undefined;
    try {
      const { answers } = await rec.decide(
        { user_request: message, what_we_know: describeFacets(u.facets), perfumes: frs.map(describeFragrance) },
        { winner: choice('Which of these perfumes better suits what this user wants?', opts) },
        { signal, label: 'compare', budgetMs: STAGE_BUDGET_MS.compare },
      );
      winner = answers.winner as ChoiceAnswer;
    } catch (e) {
      // A Jev failure still renders the side-by-side (all catalog data) as "too close to call".
      // A rejected key, the turn's own timeout and programming errors still surface.
      if (signal.aborted || !(e instanceof JevError) || e.status === 401) throw e;
    }
    return renderCompare(frs, winner ? winner.choice.slice(2) : null, winner?.confidence ?? 0, describeFacets(u.facets, 'user'));
  }

  private remember(s: Session, message: string, u: UnderstandResult, body: Pick<ChatReply, 'text' | 'recommendations'>, recs: Recommendation[]) {
    s.turns.push({ role: 'user', text: message });
    s.turns.push({ role: 'assistant', text: body.text.slice(0, 600), shown: recs.map((r) => r.fragrance.pid) });
    if (s.turns.length > 20) s.turns.splice(0, s.turns.length - 20);
    if (u.intent !== 'greeting' && u.intent !== 'thanks' && u.intent !== 'out_of_scope') s.facets = u.facets;
    if (recs.length) {
      s.lastShown = recs.map((r) => r.fragrance.pid);
      s.seen = [...new Set([...s.seen, ...s.lastShown])].slice(-60);
      s.lastBullets = Object.fromEntries(body.recommendations.map((c) => [c.pid, c.bullets]));
    }
    s.updatedAt = Date.now();
  }
}

/** A reference we cannot resolve is said plainly - never quietly swapped for another perfume. */
export function unresolvedReply(r: Unresolved, intent: Intent, shown: number): Pick<ChatReply, 'text' | 'recommendations' | 'followUps'> {
  const compare = intent === 'compare';
  let text: string;
  if (r.kind === 'position') {
    text = `I only showed ${r.shown} option${r.shown === 1 ? '' : 's'}, so there's no #${r.position}. `
      + (compare ? 'Which two would you like me to compare?' : 'Which one would you like to know more about?');
  } else if (compare) {
    text = `I couldn't find one of those perfumes in my catalog, so I can't compare them fairly.${shown ? ' I can compare any of the ones I suggested.' : ''}`;
  } else {
    text = 'I couldn\'t find that perfume in my catalog, so I can\'t describe it reliably. Tell me what you like about it and I\'ll suggest similar scents I know well.';
  }
  const followUps = [...(shown >= 1 ? [FOLLOW_UPS.why_top.text] : []), ...(shown >= 2 ? [FOLLOW_UPS.compare_top.text] : [])];
  return { text, recommendations: [], followUps };
}
