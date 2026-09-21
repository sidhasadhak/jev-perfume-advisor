/**
 * Shared domain contract. Every module builds against these types.
 *
 * Two families of types live here:
 *   1. Catalog types  - a normalized view of a FragDB fragrance record.
 *   2. Facet types    - the typed "understanding" of a user's request, produced
 *                       by Jev decisions and consumed by retrieval / ranking.
 */

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const SEASONS = ['winter', 'spring', 'summer', 'fall'] as const;
export type Season = (typeof SEASONS)[number];

export const DAY_TIMES = ['day', 'night'] as const;
export type DayTime = (typeof DAY_TIMES)[number];

export const GENDER_VOTES = ['female', 'more_female', 'unisex', 'more_male', 'male'] as const;
export type GenderVote = (typeof GENDER_VOTES)[number];

export const LONGEVITY = ['very_weak', 'weak', 'moderate', 'long_lasting', 'eternal'] as const;
export type Longevity = (typeof LONGEVITY)[number];

export const SILLAGE = ['intimate', 'moderate', 'strong', 'enormous'] as const;
export type Sillage = (typeof SILLAGE)[number];

export const PRICE_VALUE = ['way_overpriced', 'overpriced', 'ok', 'good_value', 'great_value'] as const;
export type PriceValue = (typeof PRICE_VALUE)[number];

export const APPRECIATION = ['love', 'like', 'ok', 'dislike', 'hate'] as const;
export type Appreciation = (typeof APPRECIATION)[number];

/** Absolute price positioning. Not in FragDB - comes from the extensions sidecar or a brand heuristic. */
export const PRICE_TIERS = ['budget', 'mid', 'luxury', 'niche'] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

/**
 * A vote distribution holding raw FragDB vote COUNTS per bucket. Season and
 * time-of-day are multi-select on Fragrantica, the rest single-choice, so compare
 * via `share()` / `rel()` in catalog/dist.ts rather than raw counts.
 */
export type Dist<K extends string> = Record<K, number>;

export interface Fragrance {
  pid: string;
  name: string;
  brand: string;
  year?: number;
  /** FragDB's editorial gender label. */
  gender: 'women' | 'men' | 'unisex';
  url?: string;
  photo?: string;
  description?: string;
  perfumers: string[];
  /** Resolved accord names with strength 0-100, strongest first. */
  accords: { name: string; strength: number }[];
  notes: { top: string[]; middle: string[]; base: string[] };
  rating?: { value: number; votes: number };
  reviewsCount?: number;

  season: Dist<Season>;
  timeOfDay: Dist<DayTime>;
  genderVotes: Dist<GenderVote>;
  longevity: Dist<Longevity>;
  sillage: Dist<Sillage>;
  priceValue: Dist<PriceValue>;
  appreciation: Dist<Appreciation>;

  pros: string[];
  cons: string[];

  priceTier: PriceTier;
  /** Free-form tags from the extensions sidecar (e.g. "signature-scent", "office-safe"). */
  tags: string[];
  /**
   * FragDB "reminds_of": perfumes voters say this one smells like, with the yes/no
   * votes behind each link. In the seed catalog these are a short curated list of
   * widely cited alternatives (e.g. a budget clone of a niche original).
   */
  remindsOf?: Array<{ pid: string; yes: number; no: number }>;
}

// ---------------------------------------------------------------------------
// Facets - the typed understanding of a request
// ---------------------------------------------------------------------------

export const INTENTS = [
  'recommend',      // a fresh request for suggestions
  'refine',         // adjust the previous suggestions ("cheaper", "more floral")
  'more_like',      // "something like X"
  'explain',        // "why that one?" / "tell me more about #2"
  'compare',        // "which is better for me, A or B?"
  'knowledge',      // a general perfume question: "how do I make it last?", "EDP vs EDT?"
  'greeting',
  'thanks',
  'out_of_scope',
] as const;
export type Intent = (typeof INTENTS)[number];

export const OCCASIONS = [
  'evening_party', 'formal_event', 'office', 'date_night', 'wedding',
  'casual_daily', 'outdoor_active', 'travel', 'special_signature', 'any',
] as const;
export type Occasion = (typeof OCCASIONS)[number];

export const CLIMATES = ['cold', 'mild', 'hot_dry', 'hot_humid', 'any'] as const;
export type Climate = (typeof CLIMATES)[number];

export const GENDER_PREFS = ['feminine', 'masculine', 'unisex', 'any'] as const;
export type GenderPref = (typeof GENDER_PREFS)[number];

export const AGE_STYLES = ['youthful', 'contemporary', 'mature_elegant', 'any'] as const;
export type AgeStyle = (typeof AGE_STYLES)[number];

export const BUDGETS = ['budget', 'mid', 'luxury', 'any'] as const;
export type Budget = (typeof BUDGETS)[number];

/**
 * Where the perfume will be worn. Region feeds Jev's judgement as context and
 * helps it infer climate; it is deliberately NOT turned into region-based scent
 * stereotypes in the deterministic scoring.
 */
export const REGIONS = [
  'northern_europe', 'continental_europe', 'mediterranean', 'middle_east', 'south_asia', 'east_asia',
  'southeast_asia', 'north_america', 'latin_america', 'africa', 'oceania', 'any',
] as const;
export type Region = (typeof REGIONS)[number];

/** Indoors a scent concentrates; outdoors it disperses - a real lever on projection. */
export const SETTINGS = ['indoor', 'outdoor', 'mixed', 'any'] as const;
export type Setting = (typeof SETTINGS)[number];

/**
 * A favourite colour the user says the WEARER loves, as judged by Jev ("she
 * hates pink" or "orange blossom" are not a favourite colour). 'none' = no such statement.
 */
export const FAVOURITE_COLOURS = [
  'pink', 'red', 'purple', 'blue', 'green', 'yellow', 'orange', 'white', 'black', 'gold', 'silver', 'brown', 'none',
] as const;
export type FavouriteColour = (typeof FAVOURITE_COLOURS)[number];

/** Overall character the user is after, independent of scent family. */
export const VIBES = ['crowd_pleaser', 'unique', 'classic', 'modern', 'any'] as const;
export type Vibe = (typeof VIBES)[number];

/**
 * Olfactive families. The recommender maps these onto FragDB accord names in
 * `catalog/families.ts`; Jev only ever picks among these keys.
 */
export const FAMILIES = [
  'citrus', 'fresh_aquatic', 'green', 'aromatic_herbal', 'fruity',
  'floral_rose', 'floral_white', 'floral_soft_powdery', 'gourmand_sweet',
  'amber_oriental', 'spicy', 'woody', 'oud_smoky', 'leather', 'musky_clean',
  'chypre_mossy', 'aldehydic_classic',
] as const;
export type Family = (typeof FAMILIES)[number];

/** 0 = no preference expressed. 1..4 = soft/intimate .. loud/beast-mode. */
export type Level = 0 | 1 | 2 | 3 | 4;

export interface Facets {
  occasion: Occasion;
  region: Region;
  setting: Setting;
  climate: Climate;
  season: Season | 'any';
  timeOfDay: DayTime | 'any';
  gender: GenderPref;
  ageStyle: AgeStyle;
  budget: Budget;
  vibe: Vibe;
  /** Desired projection, 0 = unspecified. */
  projection: Level;
  /** Desired longevity, 0 = unspecified. */
  longevity: Level;
  /** Families the user leans toward, with weight 0-1 (Jev probability). */
  likes: Partial<Record<Family, number>>;
  /** Families the user wants to avoid. */
  avoids: Partial<Record<Family, number>>;
  /** Specific notes mentioned positively / negatively (resolved by lexicon, polarity by Jev). */
  likedNotes: string[];
  avoidedNotes: string[];
  /** pids of fragrances the user referenced as reference points ("like Aventus"). */
  referencePids: string[];
  /** Free text of the persona, kept verbatim so Jev can judge fit against it. */
  persona: string;
  favouriteColour: FavouriteColour;
  /** Catalog brands the user asked perfumes FROM ("the best Chanel perfume"); empty = any house. */
  brands: string[];
  /**
   * Families in `likes` that a refinement added ("something warmer"), not the user's
   * stated taste - replies must not say "since you're drawn to" them.
   */
  refinedLikes: Family[];
}

export const EMPTY_FACETS: Facets = Object.freeze({
  occasion: 'any',
  region: 'any',
  setting: 'any',
  climate: 'any',
  season: 'any',
  timeOfDay: 'any',
  gender: 'any',
  ageStyle: 'any',
  budget: 'any',
  vibe: 'any',
  projection: 0,
  longevity: 0,
  likes: {},
  avoids: {},
  likedNotes: [],
  avoidedNotes: [],
  referencePids: [],
  persona: '',
  favouriteColour: 'none',
  brands: [],
  refinedLikes: [],
}) as Facets;

// ---------------------------------------------------------------------------
// Pipeline artifacts
// ---------------------------------------------------------------------------

export interface Understanding {
  intent: Intent;
  intentConfidence: number;
  facets: Facets;
  /** Facet keys Jev was unsure about - candidates for a clarifying question. */
  uncertain: (keyof Facets)[];
  /** pid the user is asking about (explain / compare), when resolvable. */
  focusPids: string[];
}

export interface Candidate {
  fragrance: Fragrance;
  /** Deterministic retrieval score, 0-1. */
  retrieval: number;
  /** Jev's screening probability that this is a strong pick (stage 2), when screened. */
  screen?: number;
  /** Per-signal breakdown behind `retrieval`, for explanations and debugging. */
  signals: Record<string, number>;
}

export interface FitJudgement {
  /** Jev score 0-4 on "how well does this suit the request". */
  fit: number;
  confidence: number;
  /** Jev noul probabilities for individual facets (e.g. occasion, climate, persona). */
  facets: Record<string, number>;
}

export interface Recommendation {
  fragrance: Fragrance;
  final: number;
  retrieval: number;
  judgement: FitJudgement;
  /** Ordered reasons, most compelling first - all grounded in catalog data. */
  reasons: Reason[];
}

export type ReasonKind =
  | 'season' | 'time_of_day' | 'occasion' | 'climate' | 'projection' | 'longevity'
  | 'family' | 'note' | 'persona' | 'gender' | 'value' | 'popularity' | 'reference';

export interface Reason {
  kind: ReasonKind;
  /** 0-1 strength - used to pick which reasons to verbalize. */
  weight: number;
  /** Structured payload for the template renderer. Never free-generated text. */
  data: Record<string, string | number | string[]>;
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  /** pids shown in an assistant turn, in display order. */
  shown?: string[];
}

export interface Session {
  id: string;
  turns: Turn[];
  facets: Facets;
  lastShown: string[];
  /** pids already recommended in this session - used to avoid repeats on refine. */
  seen: string[];
  /** The bullets shown for each of `lastShown`, so "why that one?" can answer consistently. */
  lastBullets: Record<string, string[]>;
  /** The perfume the previous reply described in full, so the same card is never repeated word for word. */
  lastExplained?: string;
  /** One-off notices already given in this conversation (e.g. "I reply in English"). */
  notices?: string[];
  updatedAt: number;
}

export interface ChatReply {
  text: string;
  recommendations: Array<{
    pid: string;
    name: string;
    brand: string;
    year?: number;
    photo?: string;
    url?: string;
    accords: string[];
    headline: string;
    bullets: string[];
    match: number;
  }>;
  followUps: string[];
  debug?: unknown;
}
