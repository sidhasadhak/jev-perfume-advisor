/**
 * Stage 4 - Jev decides the SHAPE of the reply; it never writes the words.
 *
 * What to lead with, which tone fits, whether one clarifying question would
 * help (and about what), whether a wearing tip is useful, and which follow-up
 * suggestions this user most likely wants - ranked by Jev's probabilities.
 */
import type { Answer, ChoiceAnswer, Decider, NoulAnswer, QuestionSet } from '../jev/types.js';
import { choice, noul } from '../jev/types.js';
import type { Facets, Family, Recommendation } from '../types.js';
import { describeFacets } from './describe.js';
import { FOLLOW_UPS as F } from './followups.js';

export const LEADS = {
  occasion: 'The occasion or setting they described',
  climate: 'The weather or climate they will be in',
  persona: 'The person who will wear it (their age, personality or favourite things)',
  taste: 'The scent style or notes they said they like',
  reference: 'The perfume they said they love, as a reference point',
  value: 'Their budget and getting good value',
  general: 'Nothing specific - a general introduction',
};
export type Lead = keyof typeof LEADS;

export const TONES = {
  warm: 'Warm and friendly',
  enthusiastic: 'Enthusiastic - the request is fun or exciting',
  reassuring: 'Reassuring - the user seems unsure, overwhelmed or is buying a gift',
  crisp: 'Crisp and efficient - the user was brief and to the point',
  apologetic: 'Owning the miss - the user is unhappy, frustrated or sarcastic about the previous suggestions',
};
export type Tone = keyof typeof TONES;

const CLARIFY_TOPICS = {
  gender: 'Who it is for (feminine, masculine or unisex style)',
  budget: 'Their budget',
  occasion: 'Where or when they will wear it',
  climate: 'The climate or season',
  taste: 'Scent families or notes they love or dislike',
  strength: 'How strong or subtle they want it',
  none: 'Nothing - the request is clear enough',
};
export type ClarifyTopic = keyof typeof CLARIFY_TOPICS;

export interface Composition {
  lead: Lead;
  tone: Tone;
  clarify: ClarifyTopic | null;
  tip: boolean;
  followUps: string[];
}

export interface ComposeInput {
  message: string;
  facets: Facets;
  recs: Recommendation[];
  uncertain: string[];
  gift: boolean;
  decider: Decider;
  signal?: AbortSignal;
}

/** Jev must say "ask a question" with at least this probability... */
export const ASK_THRESHOLD = 0.6;
/** ...and be at least this certain about the topic, or no question is asked. */
export const TOPIC_CERTAINTY = 0.4;
/** Probability at which a wearing tip is wanted (one is shown only if a tip fits the request). */
export const TIP_THRESHOLD = 0.6;

export async function compose(inp: ComposeInput): Promise<Composition> {
  const { facets: f, recs } = inp;
  const pool = followUpPool(f, recs);
  const clarifyOpts = Object.fromEntries(
    Object.entries(CLARIFY_TOPICS).filter(([k]) => k === 'none' || !alreadyKnown(k as ClarifyTopic, f)),
  );

  const qs: QuestionSet = {
    lead: choice('When introducing these perfume picks, what should the reply connect them to first?', LEADS),
    tone: choice('What tone best fits a reply to this user?', TONES),
    ask: noul('Would asking ONE short follow-up question noticeably improve the next suggestions?', {
      true: 'The request is vague or missing something important (e.g. who it is for) that would change the picks',
      false: 'The request is specific enough; a question would feel like an unnecessary hurdle',
    }),
    tip: noul('Would a one-line practical tip on how to wear or apply perfume be genuinely useful for this request (e.g. extreme weather, the office, a first date)?'),
  };
  if (Object.keys(clarifyOpts).length >= 2) {
    qs.clarify_topic = choice('If asking one follow-up question, which missing detail would most improve the suggestions?', clarifyOpts);
  }
  if (pool.length >= 2) {
    qs.next = choice(
      'Which of these is the user most likely to want to ask next?',
      Object.fromEntries(pool.map((text, i) => [`f${i}`, text])),
    );
  }

  const state = {
    user_request: inp.message,
    what_we_know: describeFacets(f),
    is_gift: inp.gift,
    unclear_details: inp.uncertain,
    picks: recs.map((r) => `${r.fragrance.name} by ${r.fragrance.brand} (${r.fragrance.priceTier})`),
  };
  const { answers } = await inp.decider.decide(state, qs, { signal: inp.signal, label: 'compose' });
  const a = answers as Record<string, Answer>;

  const lead = (a.lead as ChoiceAnswer<Lead>).choice;
  const topic = a.clarify_topic as ChoiceAnswer<ClarifyTopic> | undefined;
  const ask = (a.ask as NoulAnswer).noul >= ASK_THRESHOLD && topic && topic.choice !== 'none' && topic.confidence >= TOPIC_CERTAINTY;
  const next = a.next as ChoiceAnswer | undefined;
  // Ties keep the pool's own order (f0, f1, ...), never the order Jev happened to list its keys in.
  const ranked = next
    ? Object.entries(next.probabilities).sort((x, y) => y[1] - x[1] || Number(x[0].slice(1)) - Number(y[0].slice(1)))
      .map(([k]) => pool[Number(k.slice(1))]!)
    : pool;

  return {
    lead: validLead(lead, f),
    tone: (a.tone as ChoiceAnswer<Tone>).choice,
    clarify: ask ? topic!.choice : null,
    tip: (a.tip as NoulAnswer).noul >= TIP_THRESHOLD,
    followUps: ranked.filter(Boolean).slice(0, 3),
  };
}

/** Jev may pick a lead we cannot back with data (e.g. "climate" when none was given). */
function validLead(lead: Lead, f: Facets): Lead {
  const ok: Record<Lead, boolean> = {
    occasion: f.occasion !== 'any',
    climate: f.climate !== 'any' || f.season !== 'any',
    persona: !!f.persona || f.ageStyle !== 'any',
    taste: statedLikes(f).length > 0 || f.likedNotes.length > 0,
    reference: f.referencePids.length > 0,
    value: f.budget === 'budget' || f.budget === 'mid',
    general: true,
  };
  if (ok[lead]) return lead;
  const fallback = (['reference', 'persona', 'climate', 'occasion', 'taste', 'value'] as Lead[]).find((l) => ok[l]);
  return fallback ?? 'general';
}

/** The families the user asked for themselves - not ones a refinement ("warmer") added. */
export function statedLikes(f: Facets): Family[] {
  return (Object.keys(f.likes) as Family[]).filter((k) => !f.refinedLikes.includes(k));
}

function alreadyKnown(t: ClarifyTopic, f: Facets): boolean {
  switch (t) {
    case 'gender': return f.gender !== 'any';
    case 'budget': return f.budget !== 'any';
    case 'occasion': return f.occasion !== 'any';
    case 'climate': return f.climate !== 'any' || f.season !== 'any';
    case 'taste': return Object.keys(f.likes).length > 0 || f.likedNotes.length > 0;
    case 'strength': return f.projection > 0;
    default: return false;
  }
}

/** Candidate follow-ups that make sense given what we know. Jev ranks them. */
export function followUpPool(f: Facets, recs: Recommendation[]): string[] {
  const pool: string[] = [];
  if (recs.length) pool.push(F.why_top.text);
  if (recs.length >= 2) pool.push(F.compare_top.text);
  if (f.budget !== 'budget') pool.push(F.cheaper.text);
  if (f.budget !== 'luxury') pool.push(F.pricier.text);
  if (f.projection !== 1) pool.push(F.lighter.text);
  if (f.projection < 3) pool.push(F.stronger.text);
  if (f.gender === 'any') pool.push(F.unisex.text);
  const sweet = recs.filter((r) => r.fragrance.accords.slice(0, 3).some((a) => a.name === 'sweet' || a.name === 'vanilla')).length;
  pool.push(sweet >= recs.length / 2 && recs.length ? F.less_sweet.text : F.sweeter.text);
  if (f.timeOfDay === 'night' || f.occasion === 'evening_party') pool.push(F.daytime.text);
  else pool.push(F.evenings.text);
  if (f.vibe !== 'unique') pool.push(F.unique.text);
  if (recs.length) pool.push(F.more_like_top.text);
  pool.push(F.different.text);
  return pool;
}
