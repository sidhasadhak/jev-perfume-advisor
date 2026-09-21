/**
 * One chat turn:
 *
 *   understand (1 Jev call, ~50 typed questions)
 *     -> a question that needs an answer rather than picks (health and safety, a
 *        requirement we cannot check, two wearers at once, a general perfume question,
 *        something we cannot resolve) is answered from fixed templates and stops here
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
import type { Candidate, ChatReply, Fragrance, Intent, Recommendation, Session } from '../types.js';
import type { Composition } from './compose.js';
import { compose, followUpPool } from './compose.js';
import { describeFacets, describeFragrance } from './describe.js';
import { FOLLOW_UPS, cheaperAlternatives, moreLike, tellMeMore } from './followups.js';
import {
  CAUTIOUS_INTRO, ENGLISH_ONLY, brandNotCarriedLine, conflictLine, perfumeNotCarriedLine, renderKnowledge, renderRequirement, renderSafety,
  renderTwoWearers, renderVariant, requirementBlocksPicks, requirementBridge, requirementLine, variantLine,
} from './knowledge.js';
import { NoteLexicon, concentrationTerms } from './lexicon.js';
import { rank } from './rank.js';
import { TurnRecorder } from './recorder.js';
import type { AppliedShape } from './render.js';
import { CANNED, renderCompare, renderExplain, renderNoMatch, renderRecommendations } from './render.js';
import { features, retrieve } from './retrieve.js';
import { screen } from './screen.js';
import { SessionStore } from './session.js';
import { buildTrace } from './trace.js';
import type { UnderstandResult, Unresolved } from './understand.js';
import { MAX_COMPARE, nameTheUnknown, understand } from './understand.js';

/**
 * Time each Jev call of a stage may take, retries and queueing included. A slow or
 * overloaded Jev then fails one call and its stage falls back (screen/rank -> vote
 * data, compose -> a default shape, compare -> no winner) instead of the whole turn
 * timing out. Understand has no fallback, so it gets room for a retry beyond one
 * full 10 s attempt. The stages run understand -> screen -> judge (compose, and the
 * rare "which words name it" call, alongside), so the worst case is 22 + 12 + 10 = 44 s,
 * inside the 50 s turn.
 */

/** Price tiers a stated budget allows outright; a luxury budget does not rule cheaper scents out. */
const BUDGET_TIERS: Partial<Record<string, ReadonlyArray<Fragrance['priceTier']>>> = {
  budget: ['budget'],
  mid: ['budget', 'mid'],
};

/** The user's own words for a brand or perfume we do not carry, when Jev could point at them. */
type Names = { brand?: string; perfume?: string };

/** Mean sillage (0-1 vote level) below which picks may be called lighter and softer. */
const LIGHT_SILLAGE = 0.5;

/** Intents whose understanding is kept for the next turn. A question about a perfume changes nothing. */
const REQUEST_INTENTS: ReadonlySet<Intent> = new Set(['recommend', 'refine', 'more_like']);
export const STAGE_BUDGET_MS = { understand: 22_000, screenBatch: 12_000, judge: 10_000, compose: 10_000, compare: 10_000, name: 8_000 } as const;
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
    let applied: AppliedShape | undefined;
    let explained: string | undefined;
    let route: string;
    /** The brief is kept for a follow-up ("Show me regular sprays in that style") even on a non-request intent. */
    let keepBrief = false;
    const focus = u.focusPids.map((p) => this.catalog.get(p)).filter((x): x is Fragrance => !!x);
    const asksAboutPerfume = u.intent === 'explain' || u.intent === 'compare' || u.intent === 'knowledge';
    // Only when a reply will name something we do not carry: Jev points at the words the user used.
    // Started on first use, so a route that never names anything never starts (or leaves unawaited) the call.
    const needName = {
      brand: u.brandNotCarried,
      perfume: u.perfumeNotCarried || u.unresolved?.kind === 'perfume' || (u.compareMissing && !u.variants.length) || (!!u.knowledge && u.unknownPerfume),
    };
    let namesStarted: Promise<Names> | undefined;
    const names = (): Promise<Names> => (namesStarted ??= needName.brand || needName.perfume
      ? nameTheUnknown(message, rec, needName, turnSignal, STAGE_BUDGET_MS.name, focus.map((f) => f.name)).catch((e): Names => {
        if (turnSignal.aborted || (e instanceof JevError && e.status === 401)) throw e;
        return {};
      })
      : Promise.resolve({}));

    if (u.safety) {
      // Never a product list, and never "You're in good hands", for a pregnancy, a baby or a pet.
      route = `safety:${u.safety}`;
      body = renderSafety(u.safety, focus[0]);
    } else if (u.requirement && ((asksAboutPerfume && focus[0]) || requirementBlocksPicks(u.requirement))) {
      // A question about one perfume ("is N°5 vegan?"), or alcohol-free: answered without picks.
      route = `requirement:${u.requirement}`;
      body = renderRequirement(u.requirement, asksAboutPerfume ? focus[0] : undefined, hasTaste(u), this.catalog.source === 'seed');
      keepBrief = !(asksAboutPerfume && focus[0]);
    } else if (u.twoWearers) {
      route = 'two_wearers';
      body = renderTwoWearers(u.twoWearers);
    } else if (u.knowledge) {
      route = `knowledge:${u.knowledge.topic}`;
      body = renderKnowledge({
        topic: u.knowledge.topic,
        frs: u.knowledge.pids.map((p) => this.catalog.get(p)).filter((x): x is Fragrance => !!x),
        notes: u.knowledge.notes, message, catalog: this.catalog,
        unknownPerfume: u.unknownPerfume, unknownName: u.unknownPerfume ? (await names()).perfume : undefined,
        concentrations: concentrationTerms(message),
      });
      // "Which hypoallergenic perfume suits my skin type?": the general answer, and the requirement's caveat first.
      if (u.requirement && !requirementBlocksPicks(u.requirement)) {
        body = { ...body, text: `${requirementLine(u.requirement, undefined, this.catalog.source === 'seed')}\n\n${body.text}` };
      }
    } else if (u.unresolved) {
      route = `unresolved:${u.unresolved.kind}`;
      body = unresolvedReply(u.unresolved, u.intent, session.lastShown.map((p) => this.catalog.get(p)).filter((x): x is Fragrance => !!x), this.catalog, (await names()).perfume);
    } else {
      route = u.intent;
      switch (u.intent) {
        case 'greeting':
        case 'thanks':
        case 'out_of_scope':
          body = { text: CANNED[u.intent].text, recommendations: [], followUps: [...CANNED[u.intent].followUps] };
          break;

        case 'explain': {
          const fr = focus[0]!;
          // The card was the previous reply: repeating it word for word answers nothing.
          body = session.lastExplained === fr.pid
            ? renderRepeat(fr, session.lastShown.length)
            : renderExplain(fr, session.lastBullets[fr.pid], { measured: this.measured });
          explained = fr.pid;
          break;
        }

        case 'compare':
          body = await this.compare(message, u, rec, turnSignal, names);
          break;

        default: {
          const out = await this.recommend(message, u, session, rec, turnSignal, names());
          ({ recs, shortlist, candidates, screening, applied } = out);
          body = out.body;
        }
      }
    }

    this.remember(session, message, u, body, recs, route, explained, keepBrief);

    return {
      sessionId: session.id,
      mode: this.decider.mode,
      reply: {
        ...body,
        debug: {
          understanding: {
            intent: u.intent,
            route,
            intentConfidence: u.intentConfidence,
            facets: u.facets,
            uncertain: u.uncertain,
            refine: u.refine,
            proposed: u.proposed,
            summary: describeFacets(u.facets),
          },
          telemetry: rec.summary(),
          trace: buildTrace(rec.log, u, this.catalog, applied),
          jevCalls: rec.calls.map(({ attempts: _a, ...c }) => c),
          wallMs: Math.round(performance.now() - started),
          candidates,
          screening,
          shortlist,
        },
      },
    };
  }

  /**
   * The default route: every perfume scored on community data, screened by Jev, the
   * best judged in detail, rendered with any caveat the request needs up front.
   */
  private async recommend(
    message: string, u: UnderstandResult, session: Session, rec: TurnRecorder, turnSignal: AbortSignal,
    namesP: Promise<Names>,
  ) {
    // Hypoallergenic, or a sensitivity, is a requirement we cannot check; lighter, softer scents are the honest lean.
    const gentle = u.requirement === 'hypoallergenic' || u.requirement === 'sensitivity';
    const facets = gentle && !u.facets.projection ? { ...u.facets, projection: 1 as const } : u.facets;
    const take = this.opts.take ?? 4;
    const judge = this.opts.judge ?? 14;
    // Every perfume the user has not excluded, scored on community data but never dropped:
    // what reaches the shortlist is Jev's call.
    const all = retrieve(this.catalog, facets, {
      exclude: u.exclude,
      seen: u.intent === 'refine' ? session.seen : [],
      limit: Infinity,
      maxPerBrand: Infinity,
      hardGate: false,
    });
    const preface: string[] = [];
    const late: Array<() => string> = [];
    let intro: string | undefined;
    // A language notice is not a caveat about the picks: it never makes them "the closest matches".
    const notice = u.nonEnglish && !session.notices?.includes('english') ? ENGLISH_ONLY : undefined;
    if (u.requirement) preface.push(requirementLine(u.requirement, undefined, this.catalog.source === 'seed'));
    const variant = u.variants[0];
    const variantBase = variant ? this.catalog.get(variant.pid) : undefined;
    if (variant && variantBase) {
      preface.push(variantLine(variant.name, variantBase));
      intro ??= CAUTIOUS_INTRO.variant;
    }
    if (u.brandNotCarried) {
      late.push(() => brandNotCarriedLine(names.brand));
      intro ??= CAUTIOUS_INTRO.notCarried;
    } else if (u.perfumeNotCarried && !variant) {
      late.push(() => perfumeNotCarriedLine(names.perfume));
      intro ??= CAUTIOUS_INTRO.notCarried;
    }

    let pool: Candidate[] = all;
    // "The best Chanel perfume" means Chanel's perfumes, not a Chanel-flavoured list.
    const house = facets.brands.join(' and ');
    if (facets.brands.length) {
      const own = pool.filter((c) => facets.brands.includes(c.fragrance.brand));
      if (own.length) {
        pool = own;
        if (own.length < take) preface.push(`I only carry ${own.length} perfume${own.length === 1 ? '' : 's'} from ${house}.`);
      }
    }
    // A stated budget is a limit, not a preference: "under $60" never returns a luxury pick called good value.
    // When too few fit, the line is written once the picks are known, so it counts what is actually shown.
    const tiers = BUDGET_TIERS[facets.budget];
    let overBudget: ((recs: Recommendation[]) => string) | undefined;
    if (tiers) {
      const fits = pool.filter((c) => tiers.includes(c.fragrance.priceTier));
      if (fits.length >= take) pool = fits;
      else {
        const nextUp: Fragrance['priceTier'] = facets.budget === 'budget' ? 'mid' : 'luxury';
        const stepUp = pool.filter((c) => c.fragrance.priceTier === nextUp || (nextUp === 'luxury' && c.fragrance.priceTier === 'niche'));
        // A house with nothing near the budget ("a Chanel under $60") still shows its closest options, and says so.
        pool = fits.length || stepUp.length ? [...fits, ...stepUp] : pool;
        overBudget = (shown) => {
          const n = shown.filter((r) => tiers.includes(r.fragrance.priceTier)).length;
          const whose = facets.brands.length ? `${house} perfume` : 'perfume';
          if (n === 0 && fits.length === 0) return `None of the ${whose}s I carry fit that budget, so these are the closest options a step up in price.`;
          // Some do fit, but not the rest of the request as well: say that, not that none exist.
          if (n === 0) return `These are a step up in price: the ${fits.length === 1 ? `one ${whose}` : `${fits.length} ${whose}s`} I carry within that budget suit${fits.length === 1 ? 's' : ''} the rest of your request less well.`;
          if (n === shown.length) return '';
          return `Only ${n} of these ${n === 1 ? 'is' : 'are'} within that budget; the rest are a step up in price.`;
        };
      }
    }
    if (u.conflicting) preface.push(conflictLine(facets));

    const candidates = pool.length;
    if (pool.length === 0) {
      // Settle the naming call first: left unawaited, a rejection would go unhandled.
      await namesP;
      return { body: renderNoMatch(facets), recs: [], shortlist: [], candidates, screening: undefined, applied: undefined };
    }

    const screenPool = pool.slice(0, this.opts.screenLimit ?? 1000);
    const refs = facets.referencePids.map((p) => this.catalog.get(p)).filter((x): x is Fragrance => !!x);
    // A refine ("something cheaper?") is read against what the user said before, not the latest words alone.
    const earlier = u.intent === 'refine'
      ? session.turns.filter((t) => t.role === 'user').slice(-3).map((t) => t.text.slice(0, 300))
      : undefined;
    const proxy = screenPool.slice(0, take).map((c) => ({
      fragrance: c.fragrance, final: c.retrieval, retrieval: c.retrieval, judgement: { fit: NaN, confidence: 0, facets: {} }, reasons: [],
    }));

    const compositionP = compose({
      message, facets, recs: proxy, uncertain: u.uncertain, gift: u.gift, decider: withBudget(rec, STAGE_BUDGET_MS.compose), signal: turnSignal,
    })
      .catch((e): Composition => {
        if (turnSignal.aborted || (e instanceof JevError && e.status === 401)) throw e;
        return { lead: 'general', tone: 'warm', clarify: null, tip: false, followUps: followUpPool(facets, proxy).slice(0, 3) };
      });
    let screening: { screened: number; of: number; batches: number; failedBatches: number } | undefined;
    const rankedP = screen({
      message, facets, fragrances: screenPool.map((c) => c.fragrance), refs, decider: withBudget(rec, STAGE_BUDGET_MS.screenBatch),
      batchSize: this.opts.screenBatch, signal: turnSignal, earlier,
    }).then((sc) => {
      screening = { screened: sc.screened, of: all.length, batches: sc.batches, failedBatches: sc.failedBatches };
      for (const c of screenPool) c.screen = sc.scores.get(c.fragrance.pid);
      // Jev's screening decides the shortlist; a perfume whose batch failed falls back to its vote-data score.
      const ordered = [...screenPool].sort((a, b) => (b.screen ?? b.retrieval) - (a.screen ?? a.retrieval) || b.retrieval - a.retrieval);
      const perBrand = new Map<string, number>();
      // At most three per house - unless the user asked for one house.
      const shortlisted = facets.brands.length ? ordered : ordered.filter((c) => {
        const n = perBrand.get(c.fragrance.brand) ?? 0;
        perBrand.set(c.fragrance.brand, n + 1);
        return n < 3;
      });
      return rank({
        message, facets, candidates: shortlisted, decider: withBudget(rec, STAGE_BUDGET_MS.judge), catalogLookup: (p) => this.catalog.get(p),
        judge, take, signal: turnSignal, earlier,
      }).then((r) => ({ r, shortlisted }));
    });
    // allSettled-then-rethrow so a failure in one never leaves the other as an unhandled rejection.
    const [rankedS, compositionS, namesS] = await Promise.allSettled([rankedP, compositionP, namesP]);
    if (rankedS.status === 'rejected') throw rankedS.reason;
    if (compositionS.status === 'rejected') throw compositionS.reason;
    if (namesS.status === 'rejected') throw namesS.reason;
    const { r: ranked, shortlisted } = rankedS.value;
    const names = namesS.value;

    let recs = ranked.recommendations;
    // Above the stated budget, "good value for money" would read as meeting it: that reason goes.
    if (overBudget && tiers) {
      recs = recs.map((r) => (tiers.includes(r.fragrance.priceTier) ? r : { ...r, reasons: r.reasons.filter((x) => x.kind !== 'value') }));
    }
    const finals = new Map(recs.map((x) => [x.fragrance.pid, x.final]));
    const shortlist = shortlisted.slice(0, judge).map((c) => ({
      name: `${c.fragrance.name} (${c.fragrance.brand})`, screen: c.screen, retrieval: c.retrieval, final: finals.get(c.fragrance.pid),
    }));
    let composition = compositionS.value;
    // A self-contradicting brief gets the two ways out as its first chips.
    if (u.conflicting) {
      const first: string[] = [FOLLOW_UPS.lighter.text, FOLLOW_UPS.stronger.text];
      composition = { ...composition, followUps: [...first, ...composition.followUps.filter((x) => !first.includes(x))].slice(0, 3) };
    }
    // The perfume the user carried on past ("Angel Nova") is not a reference: no "If you love Angel" lead.
    if (variant && composition.lead === 'reference' && !refs.length) composition = { ...composition, lead: 'general' };
    const budgetLine = overBudget?.(recs) ?? '';
    if (budgetLine && composition.lead === 'value') composition = { ...composition, lead: 'general' };
    // Nothing cheaper exists in that house: offering "more affordable" again would loop. Offer other houses instead.
    if (budgetLine && facets.brands.length) {
      const cheaper: string[] = [FOLLOW_UPS.cheaper.text];
      composition = { ...composition, followUps: [FOLLOW_UPS.other_brands.text, ...composition.followUps.filter((x) => !cheaper.includes(x))].slice(0, 3) };
    }
    // For a sensitivity, "lighter, softer" only when the picks are; otherwise say what they are for.
    if (u.requirement) intro ??= requirementBridge(u.requirement, recs.length > 0 && recs.every((r) => features(r.fragrance).sillage < LIGHT_SILLAGE));
    const { applied, ...body } = renderRecommendations({
      message, facets, recs, composition, refs, gift: u.gift, measured: this.measured,
      preface: [...late.map((f) => f()), ...preface, budgetLine], intro, notice,
    });
    return { body, recs, shortlist, candidates, screening, applied };
  }

  /**
   * On an attribute ("which lasts longest?"), code answers from the catalog. Otherwise
   * Jev picks the better perfume for this user, and its probabilities rank three or more.
   */
  private async compare(message: string, u: UnderstandResult, rec: Decider, signal: AbortSignal, names: () => Promise<Names>) {
    const frs = u.focusPids.slice(0, MAX_COMPARE).map((p) => this.catalog.get(p)).filter((x): x is Fragrance => !!x);
    const f = u.facets;
    const season = f.season !== 'any' ? f.season : f.climate === 'cold' ? 'winter' : f.climate === 'hot_dry' || f.climate === 'hot_humid' ? 'summer' : null;
    // "Better for this time of year?" with no season known: Jev judges it, rather than a verdict made of nothing.
    const axis = u.compareOn === 'season' && !season ? 'any' : u.compareOn;
    let winner: ChoiceAnswer | undefined;
    if (axis === 'any') {
      const opts = Object.fromEntries(frs.map((f) => [`p_${f.pid}`, `${f.name} by ${f.brand}`]));
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
    }
    const ranking = winner ? Object.fromEntries(Object.entries(winner.probabilities ?? {}).map(([k, p]) => [k.slice(2), p])) : undefined;
    const missingName = u.compareMissing ? (u.variants[0]?.name ?? (await names()).perfume ?? true) : undefined;
    return renderCompare(frs, winner ? winner.choice.slice(2) : null, winner?.confidence ?? 0, describeFacets(u.facets, 'user'), {
      axis, season, ranking, missing: missingName, measured: this.measured,
    });
  }

  private remember(
    s: Session, message: string, u: UnderstandResult, body: Pick<ChatReply, 'text' | 'recommendations'>, recs: Recommendation[],
    route: string, explained: string | undefined, keepBrief = false,
  ) {
    s.turns.push({ role: 'user', text: message });
    s.turns.push({ role: 'assistant', text: body.text.slice(0, 600), shown: recs.map((r) => r.fragrance.pid) });
    if (s.turns.length > 20) s.turns.splice(0, s.turns.length - 20);
    // Only a request changes what we know about the user: a question about a perfume, a safety
    // answer or a comparison ("which lasts longest?") must not write "strong projection" into
    // an office brief. A requirement we could not meet is still a request ("show me sprays anyway").
    const answered = route.startsWith('safety') || route.startsWith('knowledge') || route === 'two_wearers' || route.startsWith('unresolved');
    if ((REQUEST_INTENTS.has(u.intent) && !answered) || keepBrief) s.facets = u.facets;
    if (recs.length) {
      s.lastShown = recs.map((r) => r.fragrance.pid);
      s.seen = [...new Set([...s.seen, ...s.lastShown])].slice(-60);
      s.lastBullets = Object.fromEntries(body.recommendations.map((c) => [c.pid, c.bullets]));
    }
    s.lastExplained = explained;
    if (u.nonEnglish && recs.length && !s.notices?.includes('english')) s.notices = [...(s.notices ?? []), 'english'];
    s.updatedAt = Date.now();
  }
}

/** Whether the request says enough about taste or use that picks "in that style" would mean something. */
function hasTaste(u: UnderstandResult): boolean {
  const f = u.facets;
  return Object.keys(f.likes).length > 0 || f.likedNotes.length > 0 || f.occasion !== 'any' || f.referencePids.length > 0 || f.gender !== 'any';
}

/** "Tell me more about it" when the previous reply already was that card. */
export function renderRepeat(fr: Fragrance, shown: number): Pick<ChatReply, 'text' | 'recommendations' | 'followUps'> {
  const cheaper = fr.priceTier === 'budget' ? [] : [cheaperAlternatives(fr.name, fr.brand)];
  return {
    text: `That's **${fr.name}** by ${fr.brand}, which I described just above. Would you like more like it${shown >= 2 ? ', a comparison with the others' : ''}, or something different?`,
    recommendations: [],
    followUps: [moreLike(fr.name, fr.brand), ...(shown >= 2 ? [FOLLOW_UPS.compare_top.text] : []), ...cheaper].slice(0, 3),
  };
}

/** A reference we cannot resolve is said plainly - never quietly swapped for another perfume. */
export function unresolvedReply(
  r: Unresolved, intent: Intent, shown: Fragrance[], catalog?: Catalog, name?: string,
): Pick<ChatReply, 'text' | 'recommendations' | 'followUps'> {
  const compare = intent === 'compare';
  const n = shown.length;
  let text: string;
  let followUps: string[] = [...(n >= 1 ? [FOLLOW_UPS.why_top.text] : []), ...(n >= 2 ? [FOLLOW_UPS.compare_top.text] : [])];
  if (r.kind === 'variant') {
    const base = catalog?.get(r.pid);
    if (base) return renderVariant(r.name, base);
    text = `I don't have ${r.name} in my catalog, so I can't describe it reliably.`;
  } else if (r.kind === 'position' && r.position === 0) {
    // "What's the difference between EDP and EDT anyway?" after a list is not about #1: ask, don't guess.
    text = 'Which one do you mean? Pick one below, or ask me anything about how to wear perfume.';
    followUps = shown.slice(0, 4).map((f) => tellMeMore(f.name, f.brand));
  } else if (r.kind === 'position') {
    text = `I only showed ${r.shown} option${r.shown === 1 ? '' : 's'}, so there's no #${r.position}. `
      + (compare ? 'Which two would you like me to compare?' : 'Which one would you like to know more about?');
  } else if (compare) {
    text = `I couldn't find ${name ?? 'one of those perfumes'} in my catalog, so I can't compare them fairly.${n ? ' I can compare any of the ones I suggested.' : ''}`;
  } else {
    text = `I don't have ${name ?? 'that perfume'} in my catalog, so I can't describe it reliably. Tell me what you like about it and I'll suggest similar scents I know well.`;
  }
  return { text, recommendations: [], followUps };
}
