/**
 * Follow-up suggestions the bot offers. Because WE write these, their meaning
 * is known exactly - so when a user clicks one, intent and refinement come from
 * this table rather than being re-inferred. Jev still answers every other facet.
 */
import type { Catalog } from '../catalog/catalog.js';
import { normalize } from '../catalog/catalog.js';
import type { Facets, Fragrance, Intent } from '../types.js';
import type { RefineDirection } from './understand.js';

export interface FollowUpDef {
  text: string;
  intent: Intent;
  refine?: RefineDirection;
  /** Facet values the follow-up fixes outright. */
  set?: Partial<Pick<Facets, 'gender' | 'timeOfDay' | 'projection'>>;
  /** Keep everything understood so far, even with no list on screen (a refine of the request itself). */
  keep?: boolean;
}

export const FOLLOW_UPS = {
  why_top: { text: 'Why is #1 the top pick?', intent: 'explain' },
  compare_top: { text: 'Compare #1 and #2', intent: 'compare' },
  cheaper: { text: 'Something more affordable', intent: 'refine', refine: 'cheaper' },
  pricier: { text: 'Show me something more luxurious', intent: 'refine', refine: 'pricier' },
  lighter: { text: 'Something lighter and more subtle', intent: 'refine', refine: 'lighter' },
  stronger: { text: 'Something stronger that lasts longer', intent: 'refine', refine: 'stronger' },
  unisex: { text: 'Only unisex options', intent: 'refine', set: { gender: 'unisex' } },
  less_sweet: { text: 'Less sweet, please', intent: 'refine', refine: 'less_sweet' },
  sweeter: { text: 'Something sweeter', intent: 'refine', refine: 'sweeter' },
  daytime: { text: 'What about for daytime?', intent: 'refine', set: { timeOfDay: 'day' } },
  evenings: { text: 'What about for evenings?', intent: 'refine', set: { timeOfDay: 'night' } },
  unique: { text: 'Something more unique', intent: 'refine', refine: 'more_unique' },
  more_like_top: { text: 'More like #1', intent: 'more_like' },
  different: { text: 'Show me different options', intent: 'refine', refine: 'different_options' },
  sprays_anyway: { text: 'Show me regular sprays in that style', intent: 'refine', keep: true },
  lighter_scents: { text: 'Show me light, subtle scents', intent: 'recommend', set: { projection: 1 } },
} as const satisfies Record<string, FollowUpDef>;

/**
 * Chips that name a perfume. They carry the brand ("More like L'Homme by Prada"):
 * two houses can share a name, and a chip must resolve to exactly one perfume.
 */
const NAMED_CHIPS = {
  more_like: { prefix: 'More like', intent: 'more_like' },
  tell_more: { prefix: 'Tell me more about', intent: 'explain' },
  cheaper_than: { prefix: 'Cheaper alternatives to', intent: 'more_like', refine: 'cheaper' },
} as const satisfies Record<string, { prefix: string; intent: Intent; refine?: RefineDirection }>;

const named = (name: string, brand?: string) => (brand ? `${name} by ${brand}` : name);
/** Pass the brand for any chip shown to a user; a bare name resolves only when no other house uses it. */
export const moreLike = (name: string, brand?: string) => `${NAMED_CHIPS.more_like.prefix} ${named(name, brand)}`;
export const tellMeMore = (name: string, brand?: string) => `${NAMED_CHIPS.tell_more.prefix} ${named(name, brand)}`;
export const cheaperAlternatives = (name: string, brand?: string) => `${NAMED_CHIPS.cheaper_than.prefix} ${named(name, brand)}`;

/** Chips offered under an explanation of one perfume - all anchored to that perfume. */
export function explainFollowUps(fr: Fragrance): string[] {
  // A generic "something more affordable" here would step the budget of an older list instead.
  const cheaper = fr.priceTier === 'budget' ? [] : [cheaperAlternatives(fr.name, fr.brand)];
  return [moreLike(fr.name, fr.brand), ...cheaper, FOLLOW_UPS.different.text];
}

/**
 * Chips offered under a comparison; `winner` is null when it was too close to call or
 * the answer favours no one perfume. Then the chips offer the compared perfumes themselves.
 */
export function compareFollowUps(winner: Fragrance | null, compared: Fragrance[] = []): string[] {
  if (winner) return [tellMeMore(winner.name, winner.brand), moreLike(winner.name, winner.brand)];
  return compared.length ? compared.slice(0, 2).map((f) => tellMeMore(f.name, f.brand)) : [FOLLOW_UPS.different.text];
}

const BY_TEXT = new Map<string, FollowUpDef>(Object.values(FOLLOW_UPS).map((d) => [normalize(d.text), d]));

export interface KnownFollowUp extends FollowUpDef {
  /** Perfume the follow-up is about, for the name-bearing ones. */
  pid?: string;
}

/**
 * Recognise one of our own follow-ups (case- and punctuation-insensitive). Only
 * the EXACT chip text counts: a user who types "more like the first one" or
 * "tell me more about Sauvage and how it compares to Layton" is understood by
 * Jev, not forced into a chip's meaning.
 */
export function matchFollowUp(message: string, catalog: Catalog): KnownFollowUp | undefined {
  const text = normalize(message);
  const exact = BY_TEXT.get(text);
  if (exact) return exact;
  for (const chip of Object.values(NAMED_CHIPS)) {
    const prefix = `${normalize(chip.prefix)} `;
    if (!text.startsWith(prefix)) continue;
    const pid = exactPerfume(text.slice(prefix.length), catalog);
    if (!pid) return undefined;
    return { text: message, intent: chip.intent, ...('refine' in chip ? { refine: chip.refine } : {}), pid };
  }
  return undefined;
}

/** normalized "name by brand" / bare name -> pid, or null when two perfumes share the key. */
interface ExactIndex { full: Map<string, string | null> }
const EXACT = new WeakMap<Catalog, ExactIndex>();

/** The one perfume whose "name by brand" (or unshared bare name) is exactly `text`, if any. */
function exactPerfume(text: string, catalog: Catalog): string | undefined {
  let idx = EXACT.get(catalog);
  if (!idx) {
    idx = { full: new Map() };
    const add = (m: Map<string, string | null>, key: string, pid: string) => m.set(key, m.has(key) ? null : pid);
    for (const fr of catalog.fragrances) {
      add(idx.full, normalize(`${fr.name} by ${fr.brand}`), fr.pid);
    }
    EXACT.set(catalog, idx);
  }
  // Only the exact "<name> by <brand>" our chips produce. A bare name is left to Jev: "tell me more
  // about her" is not a request about Burberry Her.
  return idx.full.get(text) ?? undefined;
}

/** Occasions that only make sense at one time of day, cleared when the user flips it. */
const NIGHT_ONLY: ReadonlySet<Facets['occasion']> = new Set(['evening_party', 'date_night', 'formal_event']);
const DAY_ONLY: ReadonlySet<Facets['occasion']> = new Set(['office', 'outdoor_active']);

export function applyFollowUpFacets(f: Facets, known: KnownFollowUp): Facets {
  if (!known.set) return f;
  const out = { ...f, ...known.set };
  if (known.set.timeOfDay === 'day' && NIGHT_ONLY.has(out.occasion)) out.occasion = 'any';
  if (known.set.timeOfDay === 'night' && DAY_ONLY.has(out.occasion)) out.occasion = 'any';
  return out;
}
