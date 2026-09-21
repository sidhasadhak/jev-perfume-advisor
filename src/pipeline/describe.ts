/**
 * Turns catalog records and facets into compact, human-readable text.
 *
 * Jev judges whatever it is given as `state`, so the quality of these
 * descriptions directly bounds the quality of its decisions. Everything here is
 * derived from catalog data - nothing is invented.
 */
import type { DayTime, Facets, Family, Fragrance, Season } from '../types.js';
import { LONGEVITY, SEASONS, SILLAGE } from '../types.js';
import { meanLevel, share, sum } from '../catalog/dist.js';
import { FAMILY_DEFS, dominantFamilies } from '../catalog/families.js';

export const OCCASION_PHRASE: Record<Facets['occasion'], string> = {
  evening_party: 'an evening party',
  formal_event: 'a formal event',
  office: 'the office / professional settings',
  date_night: 'a date night',
  wedding: 'a wedding',
  casual_daily: 'casual everyday wear',
  outdoor_active: 'outdoor and active days',
  travel: 'travel',
  special_signature: 'a signature scent',
  any: 'general wear',
};

export const CLIMATE_PHRASE: Record<Facets['climate'], string> = {
  cold: 'cold weather (freezing temperatures, snow, heated indoor spaces)',
  mild: 'mild, temperate weather',
  hot_dry: 'hot, dry heat',
  hot_humid: 'hot and humid heat',
  any: 'any climate',
};

export const REGION_PHRASE: Record<Facets['region'], string> = {
  northern_europe: 'northern Europe / the Nordics', continental_europe: 'continental Europe', mediterranean: 'the Mediterranean',
  middle_east: 'the Middle East / the Gulf', south_asia: 'South Asia', east_asia: 'East Asia', southeast_asia: 'Southeast Asia',
  north_america: 'North America', latin_america: 'Latin America', africa: 'Africa', oceania: 'Oceania', any: '',
};

export const SETTING_PHRASE: Record<Facets['setting'], string> = {
  indoor: 'mostly indoors / close quarters', outdoor: 'mostly outdoors', mixed: 'both indoors and outdoors', any: '',
};

export const AGE_PHRASE: Record<Facets['ageStyle'], string> = {
  youthful: 'a youthful, playful style',
  contemporary: 'a contemporary, modern style',
  mature_elegant: 'a mature, elegant and refined style',
  any: '',
};

const LEVEL_WORDS = ['', 'soft and close to the skin', 'moderate', 'strong', 'very strong / beast-mode'] as const;
const LONGEVITY_WORDS = ['', 'short-lived is fine', 'a few hours', 'long-lasting', 'all day and beyond'] as const;

export function longevityWord(fr: Fragrance): string | undefined {
  const m = meanLevel(fr.longevity, LONGEVITY);
  if (!Number.isFinite(m)) return undefined;
  return m < 0.3 ? 'fleeting' : m < 0.5 ? 'moderate' : m < 0.7 ? 'long-lasting' : 'very long-lasting';
}

export function sillageWord(fr: Fragrance): string | undefined {
  const m = meanLevel(fr.sillage, SILLAGE);
  if (!Number.isFinite(m)) return undefined;
  return m < 0.3 ? 'intimate' : m < 0.5 ? 'moderate' : m < 0.7 ? 'strong' : 'enormous';
}

/**
 * "moderate projection, long-lasting" for user-facing text. A bare "moderate"
 * or "fleeting" after the projection reads as a typo, so those get a noun.
 */
export function performancePhrase(fr: Fragrance): string | undefined {
  const s = sillageWord(fr);
  const l = longevityWord(fr);
  const parts = [
    s ? `${s} projection` : '',
    l === 'moderate' ? 'moderate longevity' : l === 'fleeting' ? 'short-lived' : l ?? '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

/** Seasons sorted by vote share, e.g. [["winter", 0.45], ["fall", 0.37], ...]. */
export function seasonRanking(fr: Fragrance): Array<[Season, number]> {
  return SEASONS.map((s) => [s, share(fr.season, s)] as [Season, number]).sort((a, b) => b[1] - a[1]);
}

export function dayNight(fr: Fragrance): { lean: DayTime | 'both'; night: number } {
  const night = share(fr.timeOfDay, 'night');
  if (sum(fr.timeOfDay) === 0) return { lean: 'both', night: 0.5 };
  return { lean: night > 0.62 ? 'night' : night < 0.38 ? 'day' : 'both', night };
}

export function genderPerception(fr: Fragrance): string {
  const f = share(fr.genderVotes, 'female') + share(fr.genderVotes, 'more_female') * 0.5;
  const m = share(fr.genderVotes, 'male') + share(fr.genderVotes, 'more_male') * 0.5;
  if (sum(fr.genderVotes) === 0) return fr.gender === 'unisex' ? 'unisex' : `marketed for ${fr.gender}`;
  if (Math.abs(f - m) < 0.2) return 'unisex';
  if (f > m) return f > 0.7 ? 'feminine' : 'feminine-leaning';
  return m > 0.7 ? 'masculine' : 'masculine-leaning';
}

export function valueWord(fr: Fragrance): string | undefined {
  const t = sum(fr.priceValue);
  if (t === 0) return undefined;
  const good = share(fr.priceValue, 'good_value') + share(fr.priceValue, 'great_value');
  const over = share(fr.priceValue, 'overpriced') + share(fr.priceValue, 'way_overpriced');
  return good > 0.5 ? 'great value' : good > over + 0.1 ? 'good value' : over > 0.5 ? 'widely seen as overpriced' : 'fair value';
}

const TIER_WORDS: Record<Fragrance['priceTier'], string> = {
  budget: 'budget-friendly',
  mid: 'mid-priced designer',
  luxury: 'luxury / prestige',
  niche: 'niche (premium-priced)',
};

export function tierWord(fr: Fragrance): string {
  return TIER_WORDS[fr.priceTier];
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** A compact profile of a fragrance for Jev's state. */
export function describeFragrance(fr: Fragrance): Record<string, unknown> {
  const seasons = seasonRanking(fr).filter(([, s]) => s > 0);
  const dn = dayNight(fr);
  const out: Record<string, unknown> = {
    name: `${fr.name} by ${fr.brand}`,
    launched: fr.year,
    marketed_for: fr.gender,
    character: fr.description,
    main_accords: fr.accords.slice(0, 6).map((a) => a.name).join(', '),
    scent_families: dominantFamilies(fr, 3).map((f) => FAMILY_DEFS[f].label).join(', '),
    notes: {
      top: fr.notes.top.join(', ') || undefined,
      heart: fr.notes.middle.join(', ') || undefined,
      base: fr.notes.base.join(', ') || undefined,
    },
    community_votes: [
      seasons.length ? `seasons: ${seasons.map(([s, v]) => `${s} ${pct(v)}`).join(', ')}` : undefined,
      sum(fr.timeOfDay) ? `worn at night by ${pct(dn.night)} of voters` : undefined,
      longevityWord(fr) ? `longevity: ${longevityWord(fr)}` : undefined,
      sillageWord(fr) ? `projection: ${sillageWord(fr)}` : undefined,
      `perceived as: ${genderPerception(fr)}`,
      valueWord(fr) ? `value for money: ${valueWord(fr)}` : undefined,
      fr.rating ? `rated ${fr.rating.value.toFixed(2)}/5 by ${fr.rating.votes.toLocaleString('en-US')} people` : undefined,
    ].filter(Boolean).join('; '),
    price_positioning: tierWord(fr),
    liked_for: fr.pros.slice(0, 3).join('; ') || undefined,
    criticised_for: fr.cons.slice(0, 2).join('; ') || undefined,
  };
  return prune(out);
}

/**
 * A one-line summary of the request as understood, for Jev's state (family
 * labels such as "Rose & peony" for precision). `audience: 'user'` returns
 * describeNeeds() instead: this summary is internal vocabulary, not prose.
 */
export function describeFacets(f: Facets, audience: 'jev' | 'user' = 'jev'): string {
  if (audience === 'user') return describeNeeds(f);
  const fam = (k: Family) => FAMILY_DEFS[k].label.toLowerCase();
  const parts: string[] = [];
  if (f.occasion !== 'any') parts.push(`occasion: ${OCCASION_PHRASE[f.occasion]}`);
  if (f.region !== 'any') parts.push(`location: ${REGION_PHRASE[f.region]}`);
  if (f.setting !== 'any') parts.push(`setting: ${SETTING_PHRASE[f.setting]}`);
  if (f.climate !== 'any') parts.push(`climate: ${CLIMATE_PHRASE[f.climate]}`);
  if (f.season !== 'any') parts.push(`season: ${f.season}`);
  if (f.timeOfDay !== 'any') parts.push(`time: ${f.timeOfDay === 'night' ? 'evening/night' : 'daytime'}`);
  if (f.gender !== 'any') parts.push(`style: ${f.gender}`);
  if (f.ageStyle !== 'any') parts.push(AGE_PHRASE[f.ageStyle]);
  if (f.budget !== 'any') parts.push(`budget: ${f.budget}`);
  if (f.projection) parts.push(`projection: ${LEVEL_WORDS[f.projection]}`);
  if (f.longevity) parts.push(`longevity: ${LONGEVITY_WORDS[f.longevity]}`);
  const likes = topKeys(f.likes);
  if (likes.length) parts.push(`likes: ${likes.map(fam).join(', ')}`);
  const avoids = topKeys(f.avoids);
  if (avoids.length) parts.push(`avoid: ${avoids.map(fam).join(', ')}`);
  if (f.likedNotes.length) parts.push(`wants notes: ${f.likedNotes.join(', ')}`);
  if (f.avoidedNotes.length) parts.push(`avoid notes: ${f.avoidedNotes.join(', ')}`);
  if (f.persona) parts.push(`about the wearer: "${f.persona}"`);
  return parts.join('; ') || 'no specific constraints yet';
}

const OCCASION_NEED: Record<Facets['occasion'], string> = {
  evening_party: 'an evening party', formal_event: 'a formal event', office: 'the office', date_night: 'a date night',
  wedding: 'a wedding', casual_daily: 'everyday wear', outdoor_active: 'active days outdoors', travel: 'travel',
  special_signature: 'a signature scent', any: '',
};
const CLIMATE_NEED: Record<Facets['climate'], string> = {
  cold: 'cold weather', mild: 'mild weather', hot_dry: 'dry heat', hot_humid: 'humid heat', any: '',
};

/**
 * What the user asked for as a clause a reply can build on ("an evening party
 * in cold weather"): at most two needs in plain words, never the wearer's
 * description quoted back, and '' when nothing specific was asked.
 */
export function describeNeeds(f: Facets): string {
  const occasion = f.occasion === 'date_night' && f.timeOfDay === 'day' ? 'a date' : OCCASION_NEED[f.occasion];
  const when = occasion || (f.timeOfDay === 'night' ? 'evening wear' : f.timeOfDay === 'day' ? 'daytime wear' : '');
  const where = CLIMATE_NEED[f.climate] || (f.season === 'any' ? '' : f.season === 'fall' ? 'autumn' : f.season);
  if (when && where) return `${when} in ${where}`;
  const liked = topKeys(f.likes)[0];
  const taste = liked ? `a love of ${FAMILY_DEFS[liked].phrase} scents` : '';
  return [when || where, taste].filter(Boolean).join(' and ');
}

export function topKeys(m: Partial<Record<Family, number>>, min = 0.5): Family[] {
  return (Object.entries(m) as [Family, number][]).filter(([, v]) => v >= min).sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

function prune(o: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete o[k];
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      prune(v as Record<string, unknown>);
      if (Object.keys(v).length === 0) delete o[k];
    }
  }
  return o;
}
