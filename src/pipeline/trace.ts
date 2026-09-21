/**
 * Turns the raw Jev calls of one turn into the "How Jev decided" panel: every
 * classifier Jev answered, grouped by the lever it pulls, with its confidence,
 * runner-up options, and whether the answer was actually used.
 */
import type { Catalog } from '../catalog/catalog.js';
import { FAMILY_DEFS } from '../catalog/families.js';
import type { Answer, ChoiceAnswer, NoulAnswer, Question, ScoreAnswer } from '../jev/types.js';
import type { Facets, Family } from '../types.js';
import { EMPTY_FACETS, FAMILIES } from '../types.js';
import type { DecisionLog } from './recorder.js';
import { ASK_THRESHOLD, TIP_THRESHOLD, TOPIC_CERTAINTY } from './compose.js';
import type { AppliedShape } from './render.js';
import type { UnderstandResult } from './understand.js';
import { AVOID_THRESHOLD, LIKE_THRESHOLD, LONGEVITY_LEVEL, MIN_CONFIDENCE, PROJECTION_LEVEL } from './understand.js';

export type TraceStatus = 'used' | 'not mentioned' | 'low confidence' | 'from earlier' | 'overridden' | 'not used';

export interface TraceItem {
  key: string;
  label: string;
  kind: Question['type'];
  /** Human-readable answer: the chosen option, "yes"/"no", or "3.1 / 4". */
  answer: string;
  /**
   * Probability of the shown answer: for a choice, P(chosen option) - the same
   * scale as the runner-ups; for a noul, P(yes). Comparable across the panel.
   */
  probability: number;
  /**
   * Jev's separate certainty score (choice/score only). It is NOT the chosen
   * option's probability and is usually lower; low certainty is what makes the
   * pipeline ignore an answer.
   */
  certainty?: number;
  alternatives?: Array<{ label: string; p: number }>;
  status: TraceStatus;
}

export interface TraceGroup {
  lever: string;
  items: TraceItem[];
}

export interface Trace {
  levers: TraceGroup[];
  screening?: { screened: number; top: Array<{ name: string; brand: string; p: number }> };
  judging?: Array<{ name: string; fit: number; confidence: number; checks: Record<string, number> }>;
}

/** Plain-language names for option keys that do not read well on their own. */
const DISPLAY: Record<string, string> = {
  any: 'not stated', unspecified: 'not stated', none: 'none',
  hot_dry: 'hot & dry', hot_humid: 'hot & humid', mature_elegant: 'mature & elegant', crowd_pleaser: 'crowd-pleaser',
  evening_party: 'evening party', formal_event: 'formal event', date_night: 'date night', casual_daily: 'everyday',
  outdoor_active: 'outdoor & active', special_signature: 'signature scent', more_like: 'more like a perfume',
  out_of_scope: 'not about perfume', less_sweet: 'less sweet', more_unique: 'more unique', more_classic: 'more classic',
  more_modern: 'more modern', different_options: 'different options', very_long: 'very long',
  northern_europe: 'northern Europe', continental_europe: 'continental Europe', mediterranean: 'the Mediterranean',
  middle_east: 'the Middle East / Gulf', south_asia: 'South Asia', east_asia: 'East Asia', southeast_asia: 'Southeast Asia',
  north_america: 'North America', latin_america: 'Latin America', africa: 'Africa', oceania: 'Oceania',
  not_a_note: 'not about a note', incidental: 'just mentioned',
};
const human = (k: string) => DISPLAY[k] ?? k.replace(/_/g, ' ');
const REPLY_SHAPE = new Set(['lead', 'tone', 'ask', 'clarify_topic', 'tip', 'next']);

/** Which facet each understand classifier feeds, and how its answer maps onto the facet value. */
const FACET_OF: Record<string, { facet: keyof Facets; value?: (choice: string) => unknown; none: string }> = {
  occasion: { facet: 'occasion', none: 'any' },
  region: { facet: 'region', none: 'any' },
  setting: { facet: 'setting', none: 'any' },
  climate: { facet: 'climate', none: 'any' },
  season: { facet: 'season', none: 'any' },
  time_of_day: { facet: 'timeOfDay', none: 'any' },
  gender: { facet: 'gender', none: 'any' },
  age_style: { facet: 'ageStyle', none: 'any' },
  budget: { facet: 'budget', none: 'any' },
  vibe: { facet: 'vibe', none: 'any' },
  projection: { facet: 'projection', value: (c) => PROJECTION_LEVEL[c as keyof typeof PROJECTION_LEVEL], none: 'unspecified' },
  longevity: { facet: 'longevity', value: (c) => LONGEVITY_LEVEL[c as keyof typeof LONGEVITY_LEVEL], none: 'unspecified' },
  favourite_colour: { facet: 'favouriteColour', none: 'none' },
};

const LABELS: Record<string, string> = {
  intent: 'What you want', refine: 'Change requested', focus: 'Perfume referred to', same_wearer: 'Same wearer as before',
  unknown_perfume: 'Names a perfume not in my list',
  occasion: 'Occasion', time_of_day: 'Time of day',
  region: 'Location', setting: 'Indoors / outdoors', climate: 'Climate',
  season: 'Season',
  gender: 'Style', age_style: 'Age / style', persona: 'Describes the wearer', favourite_colour: 'Favourite colour', gift: 'A gift',
  vibe: 'Character', projection: 'Projection', longevity: 'Longevity',
  budget: 'Budget',
  lead: 'Lead with', tone: 'Tone', ask: 'Ask a follow-up question', clarify_topic: 'Question topic', tip: 'Add a wearing tip',
  next: 'Suggested follow-ups', winner: 'Better match',
};

const GROUPS: Array<[string, (k: string) => boolean]> = [
  ['Conversation', (k) => ['intent', 'refine', 'focus', 'same_wearer', 'unknown_perfume'].includes(k)],
  ['Occasion', (k) => k === 'occasion'],
  ['Location & climate', (k) => ['region', 'setting', 'climate'].includes(k)],
  ['Season & time', (k) => ['season', 'time_of_day'].includes(k)],
  ['Wearer', (k) => ['gender', 'age_style', 'persona', 'favourite_colour', 'gift'].includes(k)],
  ['Preferences', (k) => ['vibe', 'projection', 'longevity'].includes(k) || /^(like|avoid|ref|note)_/.test(k)],
  ['Budget', (k) => k === 'budget'],
  ['Reply shape', (k) => ['lead', 'tone', 'ask', 'clarify_topic', 'tip', 'next'].includes(k)],
];

function optionLabel(q: Question, key: string): string {
  if (q.type !== 'choice') return human(key);
  const desc = (q.criteria as Record<string, string | null>)[key];
  // Option keys are readable on their own; descriptions are only needed for generated keys (f0, p_123).
  return /^(f\d+|p_.+)$/.test(key) && desc ? desc : human(key);
}

function choiceItem(key: string, label: string, q: Question, a: ChoiceAnswer, status: TraceStatus, altCount = 2): TraceItem {
  const alternatives = Object.entries(a.probabilities ?? {})
    .filter(([k]) => k !== a.choice)
    .sort((x, y) => y[1] - x[1])
    .slice(0, altCount)
    .filter(([, p]) => p >= 0.01)
    .map(([k, p]) => ({ label: optionLabel(q, k), p: round(p) }));
  const probability = a.probabilities?.[a.choice] ?? a.confidence;
  return { key, label, kind: 'choice', answer: optionLabel(q, a.choice), probability: round(probability), certainty: round(a.confidence), alternatives, status };
}

function noulItem(key: string, label: string, a: NoulAnswer, status: TraceStatus): TraceItem {
  return { key, label, kind: 'noul', answer: a.noul >= 0.5 ? 'yes' : 'no', probability: round(a.noul), status };
}

/** Status of an understand classifier, judged against the facets the turn actually used. */
function facetStatus(key: string, a: ChoiceAnswer, facets: Facets): TraceStatus {
  const spec = FACET_OF[key];
  if (!spec) return 'used';
  if (a.choice === spec.none) return facets[spec.facet] === EMPTY_FACETS[spec.facet] ? 'not mentioned' : 'from earlier';
  const mapped = spec.value ? spec.value(a.choice) : a.choice;
  if (facets[spec.facet] === mapped) return a.confidence < MIN_CONFIDENCE ? 'low confidence' : 'used';
  return a.confidence < MIN_CONFIDENCE ? 'low confidence' : 'overridden';
}

/**
 * Reply-shape answers are Jev's suggestions; the app then applies its own gates (a question needs a
 * confident topic, a tip needs one that fits, a lead needs data behind it). Label against what was shown.
 */
function replyShapeStatus(key: string, a: Answer, applied: AppliedShape | undefined): { status: TraceStatus; answer?: string } | undefined {
  if (!applied) return undefined;
  if (key === 'lead' && a.type === 'choice') return { status: a.choice === applied.lead ? 'used' : 'overridden' };
  if (key === 'ask' && a.type === 'noul') {
    const wanted = a.noul >= ASK_THRESHOLD;
    return { answer: wanted ? 'yes' : 'no', status: !wanted || applied.clarify ? 'used' : 'not used' };
  }
  if (key === 'clarify_topic' && a.type === 'choice') {
    if (applied.clarify === a.choice) return { status: 'used' };
    const lowCertainty = a.choice !== 'none' && a.confidence < TOPIC_CERTAINTY;
    return { status: lowCertainty ? 'low confidence' : 'not used' };
  }
  if (key === 'tip' && a.type === 'noul') {
    const wanted = a.noul >= TIP_THRESHOLD;
    // A wanted tip is only shown when one fits the request (weather, office, date) and no question took its place.
    return { answer: wanted ? 'yes' : 'no', status: !wanted || applied.tip ? 'used' : 'not used' };
  }
  return undefined;
}

export function buildTrace(log: DecisionLog[], u: UnderstandResult, catalog: Catalog, applied?: AppliedShape): Trace {
  const items = new Map<string, TraceItem[]>(GROUPS.map(([g]) => [g, []]));
  const push = (key: string, item: TraceItem) => {
    const group = GROUPS.find(([, match]) => match(key))?.[0];
    if (group) items.get(group)!.push(item);
  };

  for (const call of log) {
    if (!call.answers || !(call.label === 'understand' || call.label === 'compose' || call.label === 'compare')) continue;
    const likes: TraceItem[] = [];
    for (const [key, q] of Object.entries(call.questions)) {
      const a = call.answers[key];
      if (!a) continue;
      const label = LABELS[key];
      if (a.type === 'choice') {
        if (/^ref_\d+$/.test(key)) {
          const name = u.proposed.perfumes[Number(key.slice(4))] ?? 'a perfume';
          push(key, choiceItem(key, `You mentioned ${name}`, q, a as ChoiceAnswer, a.choice === 'incidental' ? 'not used' : 'used'));
        } else if (/^note_\d+$/.test(key)) {
          const note = u.proposed.notes[Number(key.slice(5))] ?? 'a note';
          const used = u.facets.likedNotes.includes(note) || u.facets.avoidedNotes.includes(note);
          push(key, choiceItem(key, `You mentioned "${note}"`, q, a as ChoiceAnswer, used ? 'used' : 'not used'));
        } else if (key === 'next') {
          push(key, choiceItem(key, label!, q, a as ChoiceAnswer, 'used', 2));
        } else {
          const shaped = call.label === 'compose' ? replyShapeStatus(key, a, applied) : undefined;
          const status = shaped?.status ?? (call.label === 'understand' ? facetStatus(key, a as ChoiceAnswer, u.facets) : 'used');
          push(key, choiceItem(key, label ?? human(key), q, a as ChoiceAnswer, status));
        }
      } else if (a.type === 'noul') {
        const m = /^(like|avoid)_(.+)$/.exec(key);
        if (m) {
          const fam = m[2] as Family;
          if (!FAMILIES.includes(fam)) continue;
          const liked = m[1] === 'like';
          const threshold = liked ? LIKE_THRESHOLD : AVOID_THRESHOLD;
          const kept = liked ? fam in u.facets.likes : fam in u.facets.avoids;
          if ((a as NoulAnswer).noul < 0.2 && !kept) continue; // keep the panel to families Jev gave real weight
          likes.push(noulItem(key, `${liked ? 'Likes' : 'Avoids'}: ${FAMILY_DEFS[fam].label}`, a as NoulAnswer,
            kept ? 'used' : (a as NoulAnswer).noul >= threshold ? 'overridden' : 'not used'));
        } else {
          const yes = (a as NoulAnswer).noul >= 0.5;
          const shaped = call.label === 'compose' ? replyShapeStatus(key, a, applied) : undefined;
          // Reply-shape decisions take effect either way ("no tip" is applied); a "no" elsewhere changes nothing.
          const status: TraceStatus = shaped?.status ?? (REPLY_SHAPE.has(key) ? 'used'
            : key === 'persona' ? (u.facets.persona ? 'used' : yes ? 'not used' : 'not mentioned')
            : key === 'unknown_perfume' ? (u.unresolved?.kind === 'perfume' ? 'used' : yes ? 'not used' : 'not mentioned')
            : yes ? 'used' : 'not mentioned');
          const item = noulItem(key, label ?? human(key), a as NoulAnswer, status);
          if (shaped?.answer) item.answer = shaped.answer;
          push(key, item);
        }
      } else {
        const sa = a as ScoreAnswer;
        const top = Math.max(0, ...Object.values(sa.probabilities ?? {}));
        push(key, { key, label: label ?? human(key), kind: 'score', answer: `${sa.score.toFixed(1)} / ${(q as { criteria: string[] }).criteria.length - 1}`, probability: round(top), certainty: round(sa.confidence), status: 'used' });
      }
    }
    likes.sort((x, y) => y.probability - x.probability).forEach((it) => push(it.key, it));
  }

  const trace: Trace = {
    levers: GROUPS.map(([lever]) => ({ lever, items: items.get(lever)! })).filter((g) => g.items.length),
  };

  const screenScores: Array<{ name: string; brand: string; p: number }> = [];
  for (const call of log.filter((c) => c.label.startsWith('screen') && c.answers)) {
    for (const [key, a] of Object.entries(call.answers!)) {
      const fr = catalog.get(key.replace(/^p\d+_/, ''));
      if (fr && a.type === 'noul') screenScores.push({ name: fr.name, brand: fr.brand, p: round((a as NoulAnswer).noul) });
    }
  }
  if (screenScores.length) {
    trace.screening = { screened: screenScores.length, top: screenScores.sort((x, y) => y.p - x.p).slice(0, 10) };
  }

  const judged = log.filter((c) => c.label.startsWith('judge:') && c.answers);
  if (judged.length) {
    trace.judging = judged.map((c) => {
      const fit = c.answers!.fit as ScoreAnswer | undefined;
      const checks: Record<string, number> = {};
      for (const [k, a] of Object.entries(c.answers!)) if (a.type === 'noul') checks[k] = round((a as NoulAnswer).noul);
      return { name: c.label.slice('judge:'.length), fit: round(fit?.score ?? NaN), confidence: round(fit?.confidence ?? 0), checks };
    }).sort((x, y) => y.fit - x.fit);
  }
  return trace;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export type { Answer };
