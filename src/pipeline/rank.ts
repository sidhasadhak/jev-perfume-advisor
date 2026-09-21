/**
 * Stage 3 - Jev judges the shortlist.
 *
 * One request per candidate (they run concurrently), each asking a calibrated
 * 5-level fit score plus narrow yes/no facet checks against the same state.
 * Code blends Jev's judgement with the deterministic retrieval score, applies
 * diversity, and builds grounded reasons for the renderer.
 */
import { dominantFamilies, FAMILY_DEFS } from '../catalog/families.js';
import type { Answer, Decider, NoulAnswer, QuestionSet, ScoreAnswer } from '../jev/types.js';
import { JevError } from '../jev/client.js';
import { noul, score, score01 } from '../jev/types.js';
import type { Candidate, Facets, FitJudgement, Fragrance, Reason, Recommendation } from '../types.js';
import {
  AGE_PHRASE, CLIMATE_PHRASE, OCCASION_PHRASE, dayNight, describeFacets, describeFragrance, longevityWord,
  seasonRanking, sillageWord, topKeys, valueWord,
} from './describe.js';
import { allNotes, features, noteMatches, similarity } from './retrieve.js';

const FIT_LEVELS = [
  'A poor match - it conflicts with what the user asked for',
  'A weak match with clear mismatches',
  'A reasonable match',
  'A strong match',
  'An excellent, near-ideal match',
];

export interface RankInput {
  message: string;
  facets: Facets;
  candidates: Candidate[];
  decider: Decider;
  catalogLookup: (pid: string) => Fragrance | undefined;
  /** How many candidates Jev judges (the rest are dropped). */
  judge?: number;
  /** How many recommendations to return. */
  take?: number;
  signal?: AbortSignal;
  /** The user's earlier messages, for a refine - see ScreenInput.earlier. */
  earlier?: string[];
}

export interface RankResult {
  recommendations: Recommendation[];
  judged: number;
  failedJudgements: number;
}

export async function rank(inp: RankInput): Promise<RankResult> {
  const { facets, decider, signal } = inp;
  const pool = inp.candidates.slice(0, inp.judge ?? 14);
  const refs = facets.referencePids.map(inp.catalogLookup).filter((x): x is Fragrance => !!x);
  const request = {
    user_request: inp.message,
    ...(inp.earlier?.length ? { earlier_requests_in_this_conversation: inp.earlier } : {}),
    what_we_know: describeFacets(facets),
    ...(refs.length ? { reference_perfumes_the_user_likes: refs.map((r) => `${r.name} by ${r.brand}`) } : {}),
  };
  const questions = buildQuestions(facets, refs);

  let failed = 0;
  let authError: JevError | undefined;
  const judged = await Promise.all(pool.map(async (c) => {
    try {
      const d = await decider.decide({ ...request, candidate_perfume: describeFragrance(c.fragrance) }, questions, {
        signal, label: `judge:${c.fragrance.name}`,
      });
      return { c, j: toJudgement(d.answers as Record<string, Answer>) };
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e instanceof JevError && e.status === 401) authError = e;
      failed++;
      return { c, j: null };
    }
  }));
  // A bad key fails every call - surface that instead of silently serving retrieval-only results.
  if (authError && failed === pool.length) throw authError;

  const scored = judged.map(({ c, j }) => ({ c, j, final: blend(c.retrieval, j, c.screen) }));
  scored.sort((a, b) => b.final - a.final);

  const picks = diversify(scored, inp.take ?? 4);
  return {
    recommendations: picks.map(({ c, j, final }) => {
      const judgement = j ?? { fit: NaN, confidence: 0, facets: {} };
      return {
        fragrance: c.fragrance,
        final: round(final),
        retrieval: c.retrieval,
        judgement,
        reasons: buildReasons(c, judgement, facets, refs),
      };
    }),
    judged: pool.length,
    failedJudgements: failed,
  };
}

function buildQuestions(f: Facets, refs: Fragrance[]): QuestionSet {
  const qs: QuestionSet = {
    fit: score('Overall, how well does the candidate perfume suit this user\'s request?', FIT_LEVELS),
    conflict: noul('Does anything about the candidate perfume clearly conflict with what the user asked for?', {
      true: 'Yes - e.g. wrong season or setting, far too heavy or too light, wrong style for the wearer, or a note they want to avoid',
      false: 'No clear conflict',
    }),
  };
  if (f.occasion !== 'any') qs.occasion_fit = noul(`Would this perfume be appropriate and appealing for ${OCCASION_PHRASE[f.occasion]}?`);
  if (f.climate !== 'any') qs.climate_fit = noul(`Would this perfume smell good and perform well in ${CLIMATE_PHRASE[f.climate]}?`);
  else if (f.season !== 'any') qs.climate_fit = noul(`Is this perfume well suited to ${f.season}?`);
  if (f.persona || f.ageStyle !== 'any') {
    const who = f.persona ? `the wearer described as: "${f.persona}"` : `someone with ${AGE_PHRASE[f.ageStyle]}`;
    qs.persona_fit = noul(`Would this perfume suit ${who}?`);
  }
  const likes = topKeys(f.likes);
  if (likes.length) {
    qs.taste_fit = noul(`Does this perfume deliver the scent style the user wants: ${likes.map((k) => FAMILY_DEFS[k].label.toLowerCase()).join(' or ')}?`);
  }
  if (refs.length) {
    qs.reference_fit = noul(`Would someone who loves ${refs.map((r) => `${r.name} by ${r.brand}`).join(' and ')} enjoy this perfume for similar reasons?`);
  }
  return qs;
}

function toJudgement(a: Record<string, Answer>): FitJudgement {
  const fit = a.fit as ScoreAnswer;
  const facets: Record<string, number> = {};
  for (const [k, v] of Object.entries(a)) if (v.type === 'noul') facets[k] = (v as NoulAnswer).noul;
  return { fit: fit.score, confidence: fit.confidence, facets };
}

/**
 * Final score. Jev's calibrated fit carries more weight the more confident it
 * is; the deterministic retrieval score anchors it to the community data.
 */
export function blend(retrieval: number, j: FitJudgement | null, screen?: number): number {
  const hasScreen = screen !== undefined && Number.isFinite(screen);
  if (!j || !Number.isFinite(j.fit)) return hasScreen ? 0.6 * screen! + 0.3 * retrieval : retrieval * 0.9;
  const fit01 = score01({ type: 'score', score: j.fit, confidence: j.confidence, legend: {}, probabilities: {} }, FIT_LEVELS.length);
  const facetVals = Object.entries(j.facets).filter(([k]) => k !== 'conflict').map(([, v]) => v);
  const facetMean = facetVals.length ? facetVals.reduce((s, v) => s + v, 0) / facetVals.length : fit01;
  const wJev = 0.45 + 0.15 * j.confidence;
  // With a screen score, the community-vote retrieval signal gives up weight to Jev's screening.
  let s = hasScreen
    ? wJev * fit01 + 0.2 * screen! + (0.7 - wJev) * retrieval + 0.1 * facetMean
    : wJev * fit01 + (0.9 - wJev) * retrieval + 0.1 * facetMean;
  const conflict = j.facets.conflict ?? 0;
  if (conflict > 0.5) s *= 1 - (conflict - 0.5);
  return Math.max(0, Math.min(1, s));
}

/** Greedy MMR: avoid showing three flankers of the same line or near-identical scents. */
function diversify<T extends { c: Candidate; final: number }>(scored: T[], take: number): T[] {
  const out: T[] = [];
  const rest = [...scored];
  while (out.length < take && rest.length) {
    let bestI = 0;
    let bestV = -Infinity;
    rest.forEach((x, i) => {
      const redundancy = out.length ? Math.max(...out.map((o) => overlap(o.c.fragrance, x.c.fragrance))) : 0;
      const v = x.final - 0.25 * redundancy;
      if (v > bestV) { bestV = v; bestI = i; }
    });
    out.push(rest.splice(bestI, 1)[0]!);
  }
  return out;
}

function overlap(a: Fragrance, b: Fragrance): number {
  const firstWord = (s: string) => s.toLowerCase().split(/\s+/)[0];
  if (a.brand === b.brand && firstWord(a.name) === firstWord(b.name)) return 1;
  const sim = similarity(a, b);
  return Math.max(a.brand === b.brand ? 0.4 : 0, sim > 0.85 ? sim : 0);
}

// ---------------------------------------------------------------------------
// Reasons - structured, grounded in catalog data and Jev's facet answers.
// ---------------------------------------------------------------------------

function buildReasons(c: Candidate, j: FitJudgement, f: Facets, refs: Fragrance[]): Reason[] {
  const fr = c.fragrance;
  const s = c.signals;
  const feat = features(fr);
  const jf = j.facets;
  const reasons: Reason[] = [];
  const push = (r: Reason) => { if (r.weight > 0.15) reasons.push(r); };

  const seasons = seasonRanking(fr);
  const dn = dayNight(fr);
  const target = seasonTarget(f);
  if (target) {
    const rankIdx = seasons.findIndex(([x]) => x === target);
    const sh = seasons[rankIdx]?.[1] ?? 0;
    // sh > 0: a record nobody has voted on ranks every season 0% in SEASONS order - "first" would be invented.
    if (sh > 0 && (rankIdx === 0 || sh >= 0.3)) {
      push({ kind: 'season', weight: (s.season ?? s.climate ?? 0.5) * (jf.climate_fit ?? 0.7), data: { season: target, share: Math.round(sh * 100), rank: rankIdx + 1 } });
    }
  }
  if (f.climate !== 'any' && (jf.climate_fit ?? 0) > 0.55) {
    push({ kind: 'climate', weight: (jf.climate_fit ?? 0) * (s.climate ?? 0.5), data: { climate: f.climate, heavy: round(feat.heaviness), fresh: round(feat.freshness) } });
  }
  const when = wantedTime(f);
  if (when === 'night' && dn.night > 0.5) {
    push({ kind: 'time_of_day', weight: dn.night, data: { when: 'night', share: Math.round(dn.night * 100) } });
  } else if (when === 'day' && dn.night < 0.5) {
    push({ kind: 'time_of_day', weight: 1 - dn.night, data: { when: 'day', share: Math.round((1 - dn.night) * 100) } });
  }
  if (f.occasion !== 'any') {
    push({ kind: 'occasion', weight: (jf.occasion_fit ?? 0.6) * (s.occasion ?? 0.5) * 1.2, data: { occasion: f.occasion } });
  }
  const lw = longevityWord(fr);
  const sw = sillageWord(fr);
  if (sw && (f.projection || f.occasion === 'evening_party' || f.occasion === 'office' || f.climate === 'hot_humid')) {
    push({ kind: 'projection', weight: f.projection ? (s.projection ?? 0.5) : 0.45, data: { sillage: sw } });
  }
  if (lw && (f.longevity || f.occasion === 'evening_party' || f.occasion === 'office' || f.climate === 'cold')) {
    push({ kind: 'longevity', weight: f.longevity ? (s.longevity ?? 0.5) : 0.4, data: { longevity: lw } });
  }
  const fams = dominantFamilies(fr, 2);
  if (fams.length) {
    // "The X style you're after" only for a family this perfume is actually built on - one of the two
    // families its headline shows - not a third-place trace of it.
    const dominant = fams;
    const liked = topKeys(f.likes).filter((k) => dominant.includes(k));
    push({
      kind: 'family',
      weight: liked.length ? 0.9 * (jf.taste_fit ?? 0.8) : 0.35,
      data: { families: (liked.length ? liked : fams).slice(0, 2), accords: fr.accords.slice(0, 3).map((a) => a.name), liked: liked.length ? 1 : 0 },
    });
  }
  // The record's own note names ("Turkish Rose" for a wanted "rose"), so the claim quotes the catalog.
  const notes = allNotes(fr);
  const wanted = [...new Set(f.likedNotes.map((w) => notes.find((n) => noteMatches(n, w))).filter((n): n is string => !!n))];
  const signature = [...fr.notes.middle.slice(0, 2), ...fr.notes.base.slice(0, 2)];
  if (wanted.length || signature.length) {
    push({ kind: 'note', weight: wanted.length ? 0.85 : 0.3, data: { notes: wanted.length ? wanted : signature.slice(0, 3), wanted: wanted.length ? 1 : 0 } });
  }
  // Only when there is something concrete to say about the wearer ("a good match for the wearer" is filler).
  if (f.ageStyle !== 'any' && (jf.persona_fit ?? 0) > 0.55) {
    push({ kind: 'persona', weight: jf.persona_fit ?? 0, data: { ageStyle: f.ageStyle, families: fams.slice(0, 2) } });
  }
  if (f.gender !== 'any' && fr.gender === 'unisex' && (s.gender ?? 0) > 0.4) {
    push({ kind: 'gender', weight: 0.3, data: { gender: f.gender } });
  }
  const vw = valueWord(fr);
  // Only a positive value verdict is a reason to recommend something.
  if ((vw === 'great value' || vw === 'good value') && (f.budget === 'budget' || f.budget === 'mid' || vw === 'great value')) {
    push({ kind: 'value', weight: f.budget === 'budget' ? 0.75 : 0.4, data: { value: vw, tier: fr.priceTier } });
  }
  if (fr.rating && fr.rating.votes >= 1000 && fr.rating.value >= 3.9) {
    push({ kind: 'popularity', weight: f.vibe === 'crowd_pleaser' ? 0.8 : 0.25, data: { rating: fr.rating.value.toFixed(1), votes: fr.rating.votes } });
  }
  if (refs.length) {
    const best = refs.map((r) => ({ r, sim: similarity(fr, r) })).sort((a, b) => b.sim - a.sim)[0]!;
    const shared = best.r.accords.map((a) => a.name).filter((n) => fr.accords.slice(0, 5).some((x) => x.name === n)).slice(0, 3);
    push({ kind: 'reference', weight: best.sim * (jf.reference_fit ?? 0.7) * 1.3, data: { name: best.r.name, brand: best.r.brand, shared } });
  }

  return reasons.sort((a, b) => b.weight - a.weight);
}

/**
 * The season a season reason is about: the one asked for, else the one a climate
 * implies. Mild weather implies no season (it is not summer), so it gets none.
 */
function seasonTarget(f: Facets): Facets['season'] | null {
  if (f.season !== 'any') return f.season;
  if (f.climate === 'cold') return 'winter';
  if (f.climate === 'hot_dry' || f.climate === 'hot_humid') return 'summer';
  return null;
}

/** Day or night as the user asked; an occasion only implies it when they did not say ("a lunch date" is daytime). */
function wantedTime(f: Facets): 'day' | 'night' | null {
  if (f.timeOfDay !== 'any') return f.timeOfDay;
  if (f.occasion === 'evening_party' || f.occasion === 'date_night') return 'night';
  if (f.occasion === 'office') return 'day';
  return null;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
