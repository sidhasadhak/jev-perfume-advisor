/**
 * Stage 2 - deterministic retrieval. No AI.
 *
 * Scores every fragrance against the typed facets using FragDB's community
 * vote data (seasons, day/night, longevity, sillage, gender perception, value)
 * plus accord/note families, and returns a diverse shortlist for Jev to judge.
 * Only facets the user actually expressed contribute; the rest stay silent.
 */
import type { Catalog } from '../catalog/catalog.js';
import { normalize } from '../catalog/catalog.js';
import { meanLevel, rel, share, sum } from '../catalog/dist.js';
import { familyProfile } from '../catalog/families.js';
import type { Candidate, Facets, Family, Fragrance, Level, Occasion, Season } from '../types.js';
import { FAMILIES, LONGEVITY, SEASONS, SILLAGE } from '../types.js';

// ---------------------------------------------------------------------------
// Per-fragrance features (computed once, cached)
// ---------------------------------------------------------------------------

export interface Features {
  fam: Record<Family, number>;
  season: Record<Season, number>;
  night: number;
  day: number;
  sillage: number;
  longevity: number;
  /** Expected femininity 0 (masculine) .. 1 (feminine) from community votes. */
  femininity: number;
  heaviness: number;
  freshness: number;
  elegance: number;
  sensual: number;
  clean: number;
  romanticFloral: number;
  youthful: number;
  versatility: number;
  popularity: number;
  goodValue: number;
  tags: Set<string>;
}

const cache = new WeakMap<Fragrance, Features>();

export function features(fr: Fragrance): Features {
  let f = cache.get(fr);
  if (f) return f;
  const fam = familyProfile(fr);
  const season = Object.fromEntries(SEASONS.map((s) => [s, seasonFit(fr, s)])) as Record<Season, number>;
  const hasTime = sum(fr.timeOfDay) > 0;
  const night = hasTime ? share(fr.timeOfDay, 'night') : 0.5;
  const sil = meanLevel(fr.sillage, SILLAGE);
  const lon = meanLevel(fr.longevity, LONGEVITY);
  const seasonShares = SEASONS.map((s) => share(fr.season, s));
  const spread = Math.max(...seasonShares) - Math.min(...seasonShares);
  const votes = fr.rating?.votes ?? 0;
  const ratingQ = fr.rating ? clamp01((fr.rating.value - 3.4) / 1.0) : 0.4;

  f = {
    fam,
    season,
    night,
    day: 1 - night,
    sillage: Number.isFinite(sil) ? sil : 0.45,
    longevity: Number.isFinite(lon) ? lon : 0.5,
    femininity: femininity(fr),
    heaviness: Math.max(fam.amber_oriental, fam.gourmand_sweet * 0.9, fam.oud_smoky, fam.leather * 0.9, fam.spicy * 0.6),
    freshness: Math.max(fam.citrus, fam.fresh_aquatic, fam.green, fam.aromatic_herbal * 0.85, fam.musky_clean * 0.6),
    elegance: Math.max(fam.chypre_mossy, fam.aldehydic_classic, fam.floral_soft_powdery, fam.floral_rose * 0.85, fam.woody * 0.7, fam.floral_white * 0.7),
    sensual: Math.max(fam.amber_oriental, fam.gourmand_sweet * 0.85, fam.floral_white * 0.85, fam.spicy * 0.8, fam.musky_clean * 0.6, fam.leather * 0.7),
    clean: Math.max(fam.musky_clean, fam.citrus * 0.8, fam.aromatic_herbal * 0.75, fam.green * 0.75, fam.woody * 0.7, fam.floral_soft_powdery * 0.7),
    romanticFloral: Math.max(fam.floral_rose, fam.floral_white, fam.floral_soft_powdery * 0.9),
    youthful: Math.max(fam.fruity, fam.gourmand_sweet * 0.8) * 0.6 + (fr.year && fr.year >= 2012 ? 0.4 : fr.year && fr.year >= 2000 ? 0.2 : 0),
    versatility: clamp01(1 - spread * 1.6) * 0.7 + (1 - Math.abs(night - 0.45) * 2) * 0.3,
    popularity: ratingQ * 0.65 + clamp01(Math.log10(votes + 1) / 4.4) * 0.35,
    goodValue: sum(fr.priceValue) ? share(fr.priceValue, 'good_value') + share(fr.priceValue, 'great_value') : 0.35,
    tags: new Set(fr.tags),
  };
  cache.set(fr, f);
  return f;
}

/** How well a season suits the fragrance, mixing "best seasons for it" and "share of its votes". */
function seasonFit(fr: Fragrance, s: Season): number {
  if (sum(fr.season) === 0) return 0.5;
  return 0.6 * rel(fr.season, s) + 0.4 * clamp01(share(fr.season, s) / 0.45);
}

function femininity(fr: Fragrance): number {
  if (sum(fr.genderVotes) > 0) {
    const g = fr.genderVotes;
    const t = sum(g);
    return (g.female * 1 + g.more_female * 0.75 + g.unisex * 0.5 + g.more_male * 0.25) / t;
  }
  return fr.gender === 'women' ? 0.85 : fr.gender === 'men' ? 0.15 : 0.5;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const tagHits = (f: Features, tags: string[]) => Math.min(1, tags.filter((t) => f.tags.has(t)).length / 1.5);
/** Peaks at `target`, falling off linearly. */
const near = (x: number, target: number, width = 0.6) => clamp01(1 - Math.abs(x - target) / width);

type OccasionProfile = Array<[number, (f: Features, fr: Fragrance) => number]>;

const OCCASION_PROFILES: Record<Exclude<Occasion, 'any'>, OccasionProfile> = {
  evening_party: [
    [0.32, (f) => clamp01(f.night / 0.7)],
    [0.18, (f) => near(f.sillage, 0.75, 0.55)],
    [0.12, (f) => f.longevity],
    [0.23, (f) => f.sensual],
    [0.15, (f) => tagHits(f, ['party', 'evening', 'compliment-getter', 'statement', 'date-night'])],
  ],
  formal_event: [
    [0.2, (f) => clamp01(f.night / 0.65)],
    [0.35, (f) => f.elegance],
    [0.15, (f) => near(f.sillage, 0.55)],
    [0.1, (f) => f.longevity],
    [0.2, (f) => tagHits(f, ['formal', 'classic', 'mature-elegant', 'evening', 'wedding'])],
  ],
  office: [
    [0.2, (f) => clamp01(f.day / 0.65)],
    [0.25, (f) => near(f.sillage, 0.35, 0.45)],
    [0.25, (f) => f.clean],
    [0.2, (f) => tagHits(f, ['office-safe', 'understated', 'clean', 'versatile', 'skin-scent'])],
    [0.1, (f) => 1 - f.heaviness],
  ],
  date_night: [
    [0.28, (f) => clamp01(f.night / 0.7)],
    [0.35, (f) => f.sensual],
    [0.15, (f) => near(f.sillage, 0.6)],
    [0.22, (f) => tagHits(f, ['date-night', 'sensual', 'compliment-getter', 'romantic'])],
  ],
  wedding: [
    [0.4, (f) => f.romanticFloral],
    [0.12, (f) => clamp01(f.day / 0.6)],
    [0.18, (f) => near(f.sillage, 0.5)],
    [0.3, (f) => tagHits(f, ['wedding', 'romantic', 'formal'])],
  ],
  casual_daily: [
    [0.35, (f) => f.versatility],
    [0.15, (f) => near(f.sillage, 0.45)],
    [0.3, (f) => tagHits(f, ['casual', 'versatile', 'blind-buy-safe', 'crowd-pleaser'])],
    [0.2, (f) => f.freshness],
  ],
  outdoor_active: [
    [0.45, (f) => f.freshness],
    [0.2, (f) => clamp01(f.day / 0.65)],
    [0.2, (f) => 1 - f.heaviness],
    [0.15, (f) => tagHits(f, ['sporty', 'hot-weather', 'casual'])],
  ],
  travel: [
    [0.35, (f) => f.versatility],
    [0.3, (f) => tagHits(f, ['travel-friendly', 'versatile', 'casual'])],
    [0.15, (f) => f.freshness],
    [0.2, (f) => f.longevity],
  ],
  special_signature: [
    [0.3, (_f, fr) => (fr.priceTier === 'niche' ? 1 : fr.priceTier === 'luxury' ? 0.6 : 0.3)],
    [0.35, (f) => f.popularity],
    [0.15, (f) => f.longevity],
    [0.2, (f) => tagHits(f, ['signature', 'statement'])],
  ],
};

function occasionFit(occ: Occasion, f: Features, fr: Fragrance): number {
  if (occ === 'any') return 0;
  return OCCASION_PROFILES[occ].reduce((s, [w, fn]) => s + w * fn(f, fr), 0);
}

function climateFit(c: Facets['climate'], f: Features): number {
  const warmth = Math.max(f.fam.amber_oriental, f.fam.gourmand_sweet, f.fam.spicy, f.fam.oud_smoky, f.fam.leather, f.fam.woody * 0.7);
  switch (c) {
    case 'cold': return 0.5 * f.season.winter + 0.15 * f.season.fall + 0.35 * warmth;
    case 'hot_dry': return clamp01(0.55 * f.season.summer + 0.45 * f.freshness - 0.25 * f.heaviness);
    case 'hot_humid': return clamp01(0.5 * f.season.summer + 0.35 * f.freshness + 0.15 * (1 - f.sillage) - 0.45 * f.heaviness);
    case 'mild': return Math.max(f.season.spring, f.season.fall) * 0.7 + f.versatility * 0.3;
    default: return 0;
  }
}

function genderFit(g: Facets['gender'], f: Features): number {
  switch (g) {
    case 'feminine': return f.femininity;
    case 'masculine': return 1 - f.femininity;
    case 'unisex': return near(f.femininity, 0.5, 0.5);
    default: return 1;
  }
}

function ageFit(a: Facets['ageStyle'], f: Features, fr: Fragrance): number {
  const year = fr.year ?? 2010;
  switch (a) {
    case 'mature_elegant':
      return 0.45 * f.elegance + 0.2 * (year < 2000 ? 1 : year < 2012 ? 0.6 : 0.35)
        + 0.25 * tagHits(f, ['classic', 'mature-elegant']) + 0.1 * (1 - f.youthful);
    case 'youthful':
      return 0.55 * f.youthful + 0.45 * tagHits(f, ['youthful', 'modern']);
    case 'contemporary':
      return 0.4 * (year >= 2005 ? 1 : 0.4) + 0.3 * f.versatility + 0.3 * tagHits(f, ['modern', 'versatile', 'signature']);
    default: return 0;
  }
}

const TIER_FIT: Record<Facets['budget'], Record<Fragrance['priceTier'], number>> = {
  budget: { budget: 1, mid: 0.45, luxury: 0.08, niche: 0 },
  mid: { budget: 0.75, mid: 1, luxury: 0.45, niche: 0.15 },
  luxury: { budget: 0.1, mid: 0.45, luxury: 1, niche: 1 },
  any: { budget: 1, mid: 1, luxury: 1, niche: 1 },
};

function budgetFit(b: Facets['budget'], f: Features, fr: Fragrance): number {
  return 0.8 * TIER_FIT[b][fr.priceTier] + 0.2 * f.goodValue;
}

function vibeFit(v: Facets['vibe'], f: Features, fr: Fragrance): number {
  const votes = fr.rating?.votes ?? 0;
  switch (v) {
    case 'crowd_pleaser': return 0.5 * f.popularity + 0.5 * tagHits(f, ['crowd-pleaser', 'blind-buy-safe', 'compliment-getter']);
    case 'unique':
      return 0.4 * (fr.priceTier === 'niche' ? 1 : 0.3) + 0.3 * clamp01(1 - Math.log10(votes + 1) / 4.6)
        + 0.3 * tagHits(f, ['statement', 'signature', 'polarizing']);
    case 'classic': return 0.55 * ((fr.year ?? 2010) < 2000 ? 1 : (fr.year ?? 2010) < 2010 ? 0.5 : 0.15) + 0.45 * tagHits(f, ['classic']);
    case 'modern': return 0.55 * ((fr.year ?? 2000) >= 2012 ? 1 : 0.3) + 0.45 * tagHits(f, ['modern']);
    default: return 0;
  }
}

function levelFit(level: Level, actual: number): number {
  return near(actual, (level - 1) / 3, 0.6);
}

function likesFit(likes: Facets['likes'], f: Features): number {
  const entries = Object.entries(likes) as [Family, number][];
  const wsum = entries.reduce((s, [, w]) => s + w, 0);
  if (wsum === 0) return 0;
  // Reward the best-matching liked family most: a pink rose lover is happy with a rose OR a soft powdery scent.
  const best = Math.max(...entries.map(([fam, w]) => f.fam[fam] * w));
  const mean = entries.reduce((s, [fam, w]) => s + f.fam[fam] * w, 0) / wsum;
  return clamp01(0.6 * best / Math.max(...entries.map(([, w]) => w)) + 0.4 * mean);
}

/** Words after a note name that make it another material: an orange blossom is not an orange. */
const OTHER_MATERIAL = new Set(['blossom', 'flower']);
/**
 * Compound names for a different plant that happen to contain a note word:
 * rock rose is cistus (labdanum), lily of the valley is muguet, sea lily/water lily are not lilies.
 */
const DIFFERENT_PLANT: Record<string, string[][]> = {
  rose: [['rock', 'rose']],
  lily: [['lily', 'of', 'the', 'valley'], ['water', 'lily']],
};

function isDifferentPlant(n: string[], start: number, w: string[]): boolean {
  if (w.length !== 1) return false;
  return (DIFFERENT_PLANT[w[0]!] ?? []).some((compound) => {
    const at = compound.indexOf(w[0]!);
    const from = start - at;
    return from >= 0 && compound.every((x, k) => n[from + k] === x);
  });
}

/** Singular of a note word, so "roses" is "rose" and "berries" is "berry". */
function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(ch|sh|x)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

const noteWords = (s: string) => normalize(s).split(' ').filter(Boolean).map(singular);

/**
 * Whether a record's note is the note a user named. Whole words only, so "rose"
 * is not Rosemary, Rosewood or Tuberose, "apple" is not Pineapple and "honey" is
 * not Honeysuckle. A qualified name still counts ("Turkish Rose" is a rose), a
 * different part of the plant does not ("Orange Blossom" is not an orange), and
 * a longer name never matches a shorter note ("pink pepper" is not "Pepper").
 */
export function noteMatches(note: string, wanted: string): boolean {
  const n = noteWords(note);
  const w = noteWords(wanted);
  if (!w.length) return false;
  for (let i = 0; i + w.length <= n.length; i++) {
    if (w.every((x, j) => n[i + j] === x) && !OTHER_MATERIAL.has(n[i + w.length] ?? '') && !isDifferentPlant(n, i, w)) return true;
  }
  return false;
}

/** The record's notes, top to base. */
export function allNotes(fr: Fragrance): string[] {
  return [...fr.notes.top, ...fr.notes.middle, ...fr.notes.base];
}

/** The wanted note names this record contains. */
function noteHits(fr: Fragrance, wanted: string[]): string[] {
  const ns = allNotes(fr);
  return wanted.filter((w) => ns.some((n) => noteMatches(n, w)));
}

/** Similarity of two fragrances: family profile cosine + weighted accord overlap. */
export function similarity(a: Fragrance, b: Fragrance): number {
  const fa = features(a).fam;
  const fb = features(b).fam;
  let dot = 0, na = 0, nb = 0;
  for (const k of FAMILIES) { dot += fa[k] * fb[k]; na += fa[k] ** 2; nb += fb[k] ** 2; }
  const cos = na && nb ? dot / Math.sqrt(na * nb) : 0;
  const am = new Map(a.accords.map((x) => [x.name, x.strength / 100]));
  let inter = 0, uni = 0;
  for (const x of b.accords) {
    const s = x.strength / 100;
    const t = am.get(x.name) ?? 0;
    inter += Math.min(s, t);
    uni += Math.max(s, t);
    am.delete(x.name);
  }
  for (const v of am.values()) uni += v;
  const jac = uni ? inter / uni : 0;
  return 0.6 * cos + 0.4 * jac;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

const W = {
  season: 0.8, climate: 1.1, timeOfDay: 0.6, occasion: 1.2, setting: 0.4, gender: 0.8, ageStyle: 0.9, budget: 0.9, vibe: 0.6,
  projection: 0.6, longevity: 0.5, likes: 1.3, notes: 0.8, reference: 1.6, popularity: 0.35,
};

export interface RetrieveOptions {
  limit?: number;
  exclude?: Iterable<string>;
  /** Down-weight (not exclude) things already shown this session. */
  seen?: Iterable<string>;
  maxPerBrand?: number;
  /** false: never drop a perfume on the gender gate (used when Jev screens everything). */
  hardGate?: boolean;
}

/** `hardGate: false` keeps clearly wrong-gender scents (heavily penalised) instead of dropping them. */
export function scoreFragrance(fr: Fragrance, facets: Facets, refs: Fragrance[], hardGate = true): Candidate | null {
  const f = features(fr);
  const signals: Record<string, number> = {};
  let num = 0;
  let den = 0;
  const add = (name: keyof typeof W, value: number) => {
    signals[name] = round(value);
    num += W[name] * value;
    den += W[name];
  };

  if (facets.season !== 'any') add('season', f.season[facets.season]);
  if (facets.climate !== 'any') add('climate', climateFit(facets.climate, f));
  if (facets.timeOfDay !== 'any') add('timeOfDay', clamp01((facets.timeOfDay === 'night' ? f.night : f.day) / 0.65));
  if (facets.occasion !== 'any') add('occasion', occasionFit(facets.occasion, f, fr));
  // Scent concentrates indoors and disperses outdoors, so the ideal projection differs.
  if (facets.setting === 'indoor') add('setting', near(f.sillage, 0.4, 0.5));
  else if (facets.setting === 'outdoor') add('setting', near(f.sillage, 0.62, 0.55));
  if (facets.ageStyle !== 'any') add('ageStyle', ageFit(facets.ageStyle, f, fr));
  if (facets.budget !== 'any') add('budget', budgetFit(facets.budget, f, fr));
  if (facets.vibe !== 'any') add('vibe', vibeFit(facets.vibe, f, fr));
  if (facets.projection) add('projection', levelFit(facets.projection, f.sillage));
  if (facets.longevity) add('longevity', levelFit(facets.longevity, f.longevity));
  if (Object.keys(facets.likes).length) add('likes', likesFit(facets.likes, f));
  if (facets.likedNotes.length) add('notes', noteHits(fr, facets.likedNotes).length / facets.likedNotes.length);
  if (refs.length) add('reference', Math.max(...refs.map((r) => similarity(fr, r))));
  add('popularity', f.popularity);

  let penalty = 1;
  if (facets.gender !== 'any') {
    const g = genderFit(facets.gender, f);
    signals.gender = round(g);
    // Below 0.25 the community clearly wears it as the other gender. Shared unisex scents sit near 0.5.
    if (g < 0.25 && hardGate) return null;
    penalty *= 0.3 + 0.7 * g;
    num += W.gender * g;
    den += W.gender;
  }
  for (const [fam, w] of Object.entries(facets.avoids) as [Family, number][]) {
    penalty *= 1 - 0.85 * f.fam[fam] * w;
  }
  const badNotes = noteHits(fr, facets.avoidedNotes);
  if (badNotes.length) penalty *= 0.35 ** badNotes.length;
  signals.penalty = round(penalty);

  return { fragrance: fr, retrieval: round(clamp01((num / den) * penalty)), signals };
}

export function retrieve(catalog: Catalog, facets: Facets, opts: RetrieveOptions = {}): Candidate[] {
  const limit = opts.limit ?? 24;
  const maxPerBrand = opts.maxPerBrand ?? 3;
  const exclude = new Set(opts.exclude ?? []);
  const seen = new Set(opts.seen ?? []);
  const refs = facets.referencePids.map((p) => catalog.get(p)).filter((x): x is Fragrance => !!x);
  for (const r of refs) exclude.add(r.pid);

  const scored: Candidate[] = [];
  for (const fr of catalog.fragrances) {
    if (exclude.has(fr.pid)) continue;
    const c = scoreFragrance(fr, facets, refs, opts.hardGate ?? true);
    if (!c) continue;
    if (seen.has(fr.pid)) c.retrieval = round(c.retrieval * 0.85);
    scored.push(c);
  }
  scored.sort((a, b) => b.retrieval - a.retrieval);

  const perBrand = new Map<string, number>();
  const out: Candidate[] = [];
  for (const c of scored) {
    const n = perBrand.get(c.fragrance.brand) ?? 0;
    if (n >= maxPerBrand) continue;
    perBrand.set(c.fragrance.brand, n + 1);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
