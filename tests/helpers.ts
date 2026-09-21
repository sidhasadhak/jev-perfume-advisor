/** Shared test fixtures: a synthetic catalog of archetypes and a scriptable Jev. */
import { Catalog } from '../src/catalog/catalog.js';
import { MockJev } from '../src/jev/mock.js';
import type { Answer, Question } from '../src/jev/types.js';
import type { Fragrance } from '../src/types.js';

type Votes<K extends string> = Partial<Record<K, number>>;

export function makeFragrance(p: Partial<Fragrance> & {
  pid: string; name: string; brand: string;
  seasonV?: Votes<'winter' | 'spring' | 'summer' | 'fall'>;
  nightShare?: number;
  sillageV?: Votes<'intimate' | 'moderate' | 'strong' | 'enormous'>;
  longevityV?: Votes<'very_weak' | 'weak' | 'moderate' | 'long_lasting' | 'eternal'>;
  genderV?: Votes<'female' | 'more_female' | 'unisex' | 'more_male' | 'male'>;
  valueV?: Votes<'way_overpriced' | 'overpriced' | 'ok' | 'good_value' | 'great_value'>;
}): Fragrance {
  const n = 10_000;
  const night = p.nightShare ?? 0.5;
  return {
    pid: p.pid,
    name: p.name,
    brand: p.brand,
    year: p.year ?? 2015,
    gender: p.gender ?? 'unisex',
    perfumers: p.perfumers ?? [],
    accords: p.accords ?? [],
    notes: p.notes ?? { top: [], middle: [], base: [] },
    description: p.description,
    rating: p.rating ?? { value: 4.0, votes: 8000 },
    season: { winter: 0, spring: 0, summer: 0, fall: 0, ...p.seasonV },
    timeOfDay: { day: Math.round(n * (1 - night)), night: Math.round(n * night) },
    genderVotes: { female: 0, more_female: 0, unisex: 0, more_male: 0, male: 0, ...p.genderV },
    longevity: { very_weak: 0, weak: 0, moderate: 0, long_lasting: 0, eternal: 0, ...p.longevityV },
    sillage: { intimate: 0, moderate: 0, strong: 0, enormous: 0, ...p.sillageV },
    priceValue: { way_overpriced: 0, overpriced: 0, ok: 0, good_value: 0, great_value: 0, ...p.valueV },
    appreciation: { love: 5000, like: 3000, ok: 1000, dislike: 500, hate: 100 },
    pros: p.pros ?? ['Pleasant'],
    cons: p.cons ?? [],
    priceTier: p.priceTier ?? 'mid',
    tags: p.tags ?? [],
  };
}

const A = (pairs: Array<[string, number]>) => pairs.map(([name, strength]) => ({ name, strength }));

export const FIXTURES: Fragrance[] = [
  makeFragrance({
    pid: 'A', name: 'Ember Nocturne', brand: 'Maison Test', gender: 'unisex', priceTier: 'luxury', year: 2012,
    accords: A([['amber', 100], ['warm spicy', 80], ['vanilla', 60], ['woody', 45]]),
    notes: { top: ['Cinnamon', 'Cardamom'], middle: ['Labdanum', 'Tobacco Leaf'], base: ['Vanilla', 'Benzoin', 'Tonka Bean'] },
    seasonV: { winter: 9000, fall: 7000, spring: 1200, summer: 400 }, nightShare: 0.78,
    sillageV: { moderate: 2000, strong: 5000, enormous: 2000 }, longevityV: { long_lasting: 5000, eternal: 3000, moderate: 1500 },
    genderV: { unisex: 5000, more_male: 2000, more_female: 2000 }, tags: ['cold-weather', 'evening', 'cosy'],
  }),
  makeFragrance({
    pid: 'L', name: 'Ember Nocturne Intense', brand: 'Maison Test', gender: 'unisex', priceTier: 'luxury', year: 2016,
    accords: A([['amber', 100], ['warm spicy', 85], ['vanilla', 65], ['woody', 50]]),
    notes: { top: ['Cinnamon'], middle: ['Labdanum'], base: ['Vanilla', 'Benzoin'] },
    seasonV: { winter: 9500, fall: 7000, spring: 1000, summer: 300 }, nightShare: 0.8,
    sillageV: { strong: 5000, enormous: 3000 }, longevityV: { long_lasting: 4000, eternal: 4000 },
    genderV: { unisex: 5000, more_male: 2500, more_female: 1500 }, tags: ['cold-weather', 'evening'],
  }),
  makeFragrance({
    pid: 'B', name: 'Citrus Riviera', brand: 'Atelier Sud', gender: 'unisex', priceTier: 'mid',
    accords: A([['citrus', 100], ['aquatic', 70], ['fresh', 60], ['green', 40]]),
    notes: { top: ['Bergamot', 'Lemon', 'Grapefruit'], middle: ['Sea Notes', 'Rosemary'], base: ['White Musk', 'Cedar'] },
    seasonV: { summer: 15000, spring: 8000, fall: 1500, winter: 600 }, nightShare: 0.12,
    sillageV: { intimate: 2000, moderate: 6000, strong: 1000 }, longevityV: { weak: 3000, moderate: 5000 },
    genderV: { unisex: 5000, more_male: 2500, male: 1000 }, tags: ['hot-weather', 'humid-safe', 'travel-friendly', 'casual'],
  }),
  makeFragrance({
    pid: 'C', name: 'Quiet Musk', brand: 'Studio Clean', gender: 'unisex', priceTier: 'mid', year: 2019,
    accords: A([['musky', 100], ['woody', 70], ['soapy', 50], ['iris', 40]]),
    notes: { top: ['Pear'], middle: ['Iris', 'Ambrette'], base: ['White Musk', 'Cashmeran', 'Sandalwood'] },
    seasonV: { spring: 7000, fall: 6000, summer: 5000, winter: 4000 }, nightShare: 0.2,
    sillageV: { intimate: 5000, moderate: 4500, strong: 500 }, longevityV: { moderate: 6000, long_lasting: 3000 },
    genderV: { unisex: 5000, more_female: 3000, female: 1000 }, tags: ['office-safe', 'clean', 'understated', 'versatile'],
  }),
  makeFragrance({
    pid: 'D', name: 'Sugar Velvet', brand: 'Rouge Maison', gender: 'women', priceTier: 'mid', year: 2016,
    accords: A([['sweet', 100], ['vanilla', 85], ['warm spicy', 60], ['caramel', 50]]),
    notes: { top: ['Pink Pepper', 'Pear'], middle: ['Coffee', 'Jasmine'], base: ['Vanilla', 'Praline', 'Patchouli'] },
    seasonV: { fall: 8000, winter: 8500, spring: 2000, summer: 600 }, nightShare: 0.82,
    sillageV: { moderate: 2000, strong: 6000, enormous: 2000 }, longevityV: { long_lasting: 6000, eternal: 2000 },
    genderV: { female: 7000, more_female: 2000, unisex: 800 }, tags: ['party', 'compliment-getter', 'evening', 'date-night'],
  }),
  makeFragrance({
    pid: 'E', name: 'Rose Imperiale', brand: 'Grande Parfumerie', gender: 'women', priceTier: 'luxury', year: 1985,
    accords: A([['rose', 100], ['powdery', 80], ['aldehydic', 60], ['iris', 45]]),
    notes: { top: ['Aldehydes', 'Bergamot'], middle: ['Rose', 'Iris', 'Violet'], base: ['Sandalwood', 'Musk'] },
    seasonV: { spring: 8000, fall: 6000, winter: 4000, summer: 2500 }, nightShare: 0.42,
    sillageV: { moderate: 6000, strong: 3000 }, longevityV: { long_lasting: 6000, moderate: 3000 },
    genderV: { female: 8000, more_female: 1500 }, tags: ['classic', 'mature-elegant', 'pink-coded', 'formal'],
  }),
  makeFragrance({
    pid: 'F', name: 'Peony Blush', brand: 'Petal & Co', gender: 'women', priceTier: 'mid', year: 2019,
    accords: A([['floral', 100], ['fruity', 85], ['rose', 70], ['sweet', 55]]),
    notes: { top: ['Raspberry', 'Lychee'], middle: ['Peony', 'Rose'], base: ['Musk'] },
    seasonV: { spring: 12000, summer: 7000, fall: 2000, winter: 1000 }, nightShare: 0.25,
    sillageV: { intimate: 2000, moderate: 6000, strong: 1500 }, longevityV: { weak: 2000, moderate: 6000 },
    genderV: { female: 9000, more_female: 1000 }, tags: ['youthful', 'pink-coded', 'romantic'],
  }),
  makeFragrance({
    pid: 'G', name: 'Blue Current', brand: 'Homme Moderne', gender: 'men', priceTier: 'mid',
    accords: A([['citrus', 100], ['aromatic', 80], ['woody', 60], ['fresh spicy', 50]]),
    notes: { top: ['Grapefruit', 'Mint'], middle: ['Ginger', 'Lavender'], base: ['Cedar', 'Vetiver'] },
    seasonV: { spring: 9000, summer: 9000, fall: 5000, winter: 2500 }, nightShare: 0.3,
    sillageV: { moderate: 6000, strong: 3000 }, longevityV: { moderate: 5000, long_lasting: 3500 },
    genderV: { male: 7000, more_male: 2500 }, tags: ['office-safe', 'versatile', 'crowd-pleaser'],
  }),
  makeFragrance({
    pid: 'H', name: 'Black Oud Leather', brand: 'Niche Noir', gender: 'men', priceTier: 'niche',
    accords: A([['oud', 100], ['leather', 90], ['smoky', 70], ['woody', 60]]),
    notes: { top: ['Saffron'], middle: ['Oud', 'Leather'], base: ['Birch Tar', 'Labdanum'] },
    seasonV: { winter: 9000, fall: 6000, spring: 800, summer: 300 }, nightShare: 0.85,
    sillageV: { strong: 5000, enormous: 4000 }, longevityV: { long_lasting: 4000, eternal: 5000 },
    genderV: { male: 6000, more_male: 3000, unisex: 800 }, tags: ['statement', 'cold-weather', 'evening'],
  }),
  makeFragrance({
    pid: 'I', name: 'Ocean Voyage', brand: 'Budget Blue', gender: 'men', priceTier: 'budget',
    accords: A([['aquatic', 100], ['citrus', 70], ['fresh', 60]]),
    notes: { top: ['Lemon', 'Sea Notes'], middle: ['Lotus'], base: ['Musk', 'Cedar'] },
    seasonV: { summer: 12000, spring: 7000, fall: 1500, winter: 500 }, nightShare: 0.15,
    sillageV: { intimate: 3000, moderate: 5000 }, longevityV: { weak: 4000, moderate: 4000 },
    genderV: { male: 5000, more_male: 3000, unisex: 1500 }, valueV: { great_value: 6000, good_value: 3000, ok: 1000 },
    tags: ['hot-weather', 'casual', 'sporty'],
  }),
  makeFragrance({
    pid: 'J', name: 'Neroli Azzurro', brand: 'Casa Mediterranea', gender: 'unisex', priceTier: 'luxury',
    accords: A([['citrus', 100], ['white floral', 70], ['fresh', 60], ['aromatic', 40]]),
    notes: { top: ['Bergamot', 'Lemon', 'Mandarin'], middle: ['Neroli', 'Orange Blossom'], base: ['Amber', 'Musk'] },
    seasonV: { summer: 14000, spring: 9000, fall: 1500, winter: 500 }, nightShare: 0.15,
    sillageV: { intimate: 2000, moderate: 6000, strong: 1000 }, longevityV: { weak: 3000, moderate: 5000 },
    genderV: { unisex: 6000, more_female: 1500, more_male: 1500 }, tags: ['hot-weather', 'humid-safe', 'travel-friendly'],
  }),
  makeFragrance({
    pid: 'K', name: 'Tuberose Midnight', brand: 'Fleur Fatale', gender: 'women', priceTier: 'luxury',
    accords: A([['tuberose', 100], ['white floral', 90], ['sweet', 60]]),
    notes: { top: ['Orange Blossom'], middle: ['Tuberose', 'Jasmine'], base: ['Vanilla', 'Musk'] },
    seasonV: { spring: 6000, fall: 5000, winter: 4000, summer: 3000 }, nightShare: 0.75,
    sillageV: { strong: 3000, enormous: 6000 }, longevityV: { long_lasting: 4000, eternal: 4000 },
    genderV: { female: 8000, more_female: 1500 }, tags: ['statement', 'evening', 'sensual'],
  }),
];

export function fixtureCatalog(): Catalog {
  return new Catalog(FIXTURES, 'seed', { fragrances: FIXTURES.length, brands: 11, dropped: 0, unresolvedNotes: 0, unresolvedAccords: 0 });
}

// ---------------------------------------------------------------------------
// Scripted Jev
// ---------------------------------------------------------------------------

export type Spec = string | number;
export type Script = Record<string, Spec> | ((key: string, state: any, q: Question) => Spec | undefined);

const NEUTRAL_FACET_NOULS = new Set(['occasion_fit', 'climate_fit', 'persona_fit', 'taste_fit', 'reference_fit']);

/** Default answers: every facet unspecified, no likes, neutral fit - so tests only script what matters. */
export function defaultSpec(key: string, q: Question): Spec {
  if (q.type === 'noul') {
    if (key === 'same_wearer') return 0.9;
    if (NEUTRAL_FACET_NOULS.has(key)) return 0.7;
    return 0.05;
  }
  if (q.type === 'score') return (q.criteria.length - 1) / 2 + 0.5;
  const keys = Object.keys(q.criteria);
  for (const d of ['any', 'unspecified', 'none', 'incidental', 'not_a_note', 'general', 'warm']) if (keys.includes(d)) return d;
  return keys[0]!;
}

export function toAnswer(q: Question, v: Spec, confidence = 0.9): Answer {
  if (q.type === 'noul') return { type: 'noul', noul: Number(v) };
  if (q.type === 'score') {
    const s = Number(v);
    const probs: Record<string, number> = {};
    q.criteria.forEach((_, i) => { probs[String(i)] = Math.max(0, 1 - Math.abs(i - s)) || 0; });
    return { type: 'score', score: s, confidence: 0.8, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), probabilities: probs };
  }
  const keys = Object.keys(q.criteria);
  const k = String(v);
  const rest = keys.length > 1 ? (1 - confidence) / (keys.length - 1) : 0;
  return { type: 'choice', choice: k, confidence, probabilities: Object.fromEntries(keys.map((x) => [x, x === k ? confidence : rest])) };
}

export function scriptedJev(script: Script = {}, confidence = 0.9): MockJev {
  return new MockJev({
    resolver: (state, key, q) => {
      const v = typeof script === 'function' ? script(key, state, q) : script[key];
      return toAnswer(q, v ?? defaultSpec(key, q), confidence);
    },
  });
}
