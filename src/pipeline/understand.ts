/**
 * Stage 1 - understand the user's message.
 *
 * One Jev request with many independent typed questions ("speculative
 * fan-out"): intent, occasion, climate, season, gender, age/style, budget,
 * per-family likes/avoids, and the polarity of any perfume or note the user
 * named. Code then merges the answers into typed Facets, gating on confidence.
 */
import type { Catalog } from '../catalog/catalog.js';
import { normalize as normalizeName } from '../catalog/catalog.js';
import { FAMILY_DEFS } from '../catalog/families.js';
import type { Answer, ChoiceAnswer, Decider, NoulAnswer, QuestionSet } from '../jev/types.js';
import { choice, noul } from '../jev/types.js';
import type {
  AgeStyle, Fragrance, Budget, Climate, DayTime, Facets, Family, FavouriteColour, GenderPref, Intent, Level, Occasion, Region, Season,
  Session, Setting, Understanding, Vibe,
} from '../types.js';
import { EMPTY_FACETS, FAMILIES } from '../types.js';
import { describeFacets } from './describe.js';
import { applyFollowUpFacets, matchFollowUp } from './followups.js';
import type { NoteLexicon } from './lexicon.js';
import { candidateSpans, concentrationTerms, mayExpressDislike, mentionsColour, ordinalRefs } from './lexicon.js';

// ---------------------------------------------------------------------------
// Question vocabularies. Descriptions are what Jev reads - keep them concrete.
// ---------------------------------------------------------------------------

const INTENT = {
  recommend: 'Asks for perfume suggestions, or describes a need, occasion, climate, person or taste - a fresh request',
  refine: 'Reacts to the perfumes just suggested and wants them adjusted: cheaper, stronger, lighter, sweeter, other options, for a man instead, etc.',
  more_like: 'Wants perfumes similar to one specific perfume they name or point to',
  explain: 'Asks for more detail about one particular perfume, or why it was suggested',
  compare: 'Asks which of two or more specific perfumes is better, how they differ, or to rank them',
  knowledge: 'Asks a general question about perfume rather than for suggestions: how to apply, store or layer it, what a term or note means, EDP vs EDT, safety, fakes, prices, who made or wears something',
  greeting: 'Only says hello or asks what the assistant can do',
  thanks: 'Thanks the assistant or says goodbye, with no new request',
  out_of_scope: 'Is clearly unrelated to perfume or fragrance (e.g. asks for directions, news or maths). Asking what to "wear" for an occasion, place or season IS about perfume here',
} satisfies Record<Intent, string>;

const OCCASION = {
  evening_party: 'Evening parties, nights out, clubbing, celebrations, cocktail events',
  formal_event: 'Galas, black-tie, opera, formal dinners, ceremonies',
  office: 'Work, the office, meetings, business settings, interviews, being a working professional',
  date_night: 'A date, romance, seduction, a dinner for two',
  wedding: 'Attending or having a wedding',
  casual_daily: 'Everyday casual wear, errands, weekends, a daily go-to',
  outdoor_active: 'Sport, the gym, hiking, beach days, being active outdoors',
  travel: 'Travelling, holidays, a vacation or trip somewhere',
  special_signature: 'A personal signature scent to be known by, or a unique statement scent',
  any: 'No particular occasion or setting is mentioned',
} satisfies Record<Occasion, string>;

export const REGION = {
  northern_europe: 'Scandinavia, Finland, Iceland, the Baltics, the UK and Ireland',
  continental_europe: 'Mainland western and central Europe: France, Germany, the Benelux, Switzerland, Austria, Poland',
  mediterranean: 'Southern Europe and the Mediterranean: Spain, Portugal, Italy, Greece, Turkey, Croatia, the Riviera, Cyprus',
  middle_east: 'The Gulf and Middle East: UAE, Dubai, Saudi Arabia, Qatar, Oman, Kuwait, Jordan, Egypt, Morocco',
  south_asia: 'India, Pakistan, Sri Lanka, Bangladesh, Nepal, the Maldives',
  east_asia: 'Japan, South Korea, China, Taiwan, Hong Kong',
  southeast_asia: 'Thailand, Singapore, Malaysia, Indonesia, Bali, Vietnam, the Philippines',
  north_america: 'The USA and Canada',
  latin_america: 'Mexico, the Caribbean, Central and South America',
  africa: 'Sub-Saharan Africa',
  oceania: 'Australia, New Zealand, the Pacific islands',
  any: 'No place, city or country is mentioned',
} satisfies Record<Region, string>;

export const SETTING = {
  indoor: 'Mostly indoors or in close quarters: office, meetings, restaurant, plane, dinner party at home',
  outdoor: 'Mostly outdoors or in open air: beach, garden party, hiking, sightseeing, an outdoor wedding',
  mixed: 'A mix of indoors and outdoors, e.g. a day of travel or city exploring',
  any: 'Not indicated',
} satisfies Record<Setting, string>;

const CLIMATE = {
  cold: 'Cold weather: winter, snow, Nordic / Scandinavian / Canadian / Russian winters, freezing temperatures',
  mild: 'Mild or temperate weather: spring, autumn, cool breezy days, moderate climates',
  hot_dry: 'Dry heat: deserts, the Gulf, dry inland Mediterranean or continental summers',
  hot_humid: 'Humid heat: tropics, coastal and beach summers, muggy weather, monsoon',
  any: 'No weather, climate, place or season is mentioned or implied',
} satisfies Record<Climate, string>;

const SEASON = {
  winter: 'Winter - the cold months',
  spring: 'Spring',
  summer: 'Summer - the hot months',
  fall: 'Autumn / fall',
  any: 'No season is mentioned or implied',
} satisfies Record<Season | 'any', string>;

const TIME = {
  day: 'Daytime: work hours, brunch, errands, outdoors in daylight',
  night: 'Evening or night: parties, dinners, dates, going out',
  any: 'Time of day is not indicated',
} satisfies Record<DayTime | 'any', string>;

const GENDER = {
  feminine: 'For a woman (her, wife, mother, lady, girlfriend) or an explicitly feminine style',
  masculine: 'For a man (him, husband, father, boyfriend) or an explicitly masculine style',
  unisex: 'Explicitly wants something unisex or gender-neutral',
  any: 'The wearer\'s gender or style is not indicated',
} satisfies Record<GenderPref, string>;

const AGE = {
  child: 'A baby, toddler or child under about 12',
  youthful: 'A teen, student or twenty-something, or a playful, fun, young vibe',
  contemporary: 'An adult with a modern, current style (roughly 25-50), e.g. a working professional',
  mature_elegant: 'An older wearer (roughly 50+), a grandparent, or a classic, refined, timeless taste',
  any: 'Age or personal style is not indicated',
} satisfies Record<AgeStyle | 'child', string>;

const FAVOURITE_COLOUR = {
  pink: 'Pink, rose-pink, blush or fuchsia',
  red: 'Red, crimson, scarlet or burgundy',
  purple: 'Purple, lilac or violet',
  blue: 'Blue, navy, turquoise or teal',
  green: 'Green',
  yellow: 'Yellow',
  orange: 'Orange',
  white: 'White or cream',
  black: 'Black',
  gold: 'Gold or golden',
  silver: 'Silver',
  brown: 'Brown or beige',
  none: 'No colour is said to be loved. A disliked colour ("she hates pink") or a colour word inside a note, flower, perfume name '
    + 'or phrase ("orange blossom", "white musk", "Black Orchid", "her golden years", "a navy officer") does not count',
} satisfies Record<FavouriteColour, string>;

const BUDGET = {
  budget: 'Cheap or affordable, around $60 or less, a student budget, great value',
  mid: 'A moderate budget, roughly $60-150, typical designer prices',
  luxury: 'Money is no object: luxury, high-end, niche, a special splurge or luxurious gift',
  any: 'Budget is not mentioned',
} satisfies Record<Budget, string>;

const VIBE = {
  crowd_pleaser: 'Something safe, popular and widely liked - a compliment-getter or a safe blind buy',
  unique: 'Something unique, unusual, niche or not mainstream - not smelled on everyone',
  classic: 'Something timeless, classic, traditional or iconic',
  modern: 'Something modern, trendy, current or new',
  any: 'No preference about popularity or style is expressed',
} satisfies Record<Vibe, string>;

const PROJECTION = {
  unspecified: 'No preference is stated about how strong or noticeable the scent should be',
  soft: 'Subtle, discreet, close to the skin, not overpowering, nothing loud',
  moderate: 'Noticeable but polite, within arm\'s length',
  strong: 'Clearly noticeable, projects well, fills a room, gets compliments from a distance',
  beast: 'As loud and powerful as possible, beast-mode',
};
export const PROJECTION_LEVEL: Record<keyof typeof PROJECTION, Level> = { unspecified: 0, soft: 1, moderate: 2, strong: 3, beast: 4 };

const LONGEVITY = {
  unspecified: 'No preference is stated about how long it lasts',
  short: 'Fine if it fades after an hour or two, or wants something light and fleeting',
  moderate: 'A few hours is enough',
  long: 'Wants it to last all day / all evening',
  very_long: 'Wants it to last as long as possible, into the next day',
};
export const LONGEVITY_LEVEL: Record<keyof typeof LONGEVITY, Level> = { unspecified: 0, short: 1, moderate: 2, long: 3, very_long: 4 };

export const REFINE = {
  none: 'Not reacting to the previous suggestions, no change requested, or only removes a requirement (e.g. "any season is fine")',
  cheaper: 'Wants cheaper or more affordable options',
  pricier: 'Wants more luxurious or high-end options',
  lighter: 'Wants something lighter, softer, less intense',
  stronger: 'Wants something stronger, longer-lasting or louder',
  sweeter: 'Wants something sweeter',
  less_sweet: 'Wants something less sweet',
  fresher: 'Wants something fresher, cleaner or more airy',
  warmer: 'Wants something warmer, cosier or richer',
  more_unique: 'Wants something more unusual or less mainstream - e.g. complains the picks are too common, generic, basic or what everyone wears',
  more_classic: 'Wants something more classic or timeless',
  more_modern: 'Wants something more modern or trendy',
  different_options: 'Wants different options than the ones already shown',
};
export type RefineDirection = keyof typeof REFINE;

/**
 * General perfume questions the app answers from vetted fixed text (render/knowledge.ts)
 * instead of recommending. Asked every turn: a question about a named perfume ("is my
 * Sauvage fake?") is otherwise read as "tell me about Sauvage".
 */
export const TOPIC = {
  none: 'Not a general question: the user wants perfume suggestions (including a dupe or cheaper alternative to a perfume), reacts to suggestions, asks what a specific perfume smells like, how it performs or why it was suggested, or asks whether the assistant has or knows a particular perfume',
  concentration: 'What EDP, EDT, parfum, extrait or cologne mean, or how the versions or concentrations of one perfume differ',
  longevity_tips: 'How to make the perfume they already have last longer or project more (application tips, not a request for long-lasting perfumes)',
  application: 'Where or how to apply or spray perfume, or how many sprays to use',
  storage_expiry: 'How to store perfume, or whether it expires or goes off',
  nose_fatigue: 'Why they cannot smell their own perfume, or stop noticing it after a while',
  notes_pyramid: 'What top, middle (heart) and base notes are',
  note_description: 'What a particular note or ingredient smells like, e.g. "what does oud smell like?"',
  layering: 'Whether or how to layer or combine perfumes',
  authenticity: 'How to tell whether a perfume is fake or genuine',
  dupe: 'Whether a perfume is a dupe or clone of another, or what a perfume is a clone of',
  creator_year: 'Who made or created a perfume (the perfumer or house) or when it was released',
  reformulation: 'Whether a perfume has been reformulated or discontinued',
  celebrity: 'What perfume a celebrity or other famous person wears',
  price_where: 'What a perfume costs, bottle sizes, where to buy it or where to find the best price',
  new_releases: 'The newest or latest perfume releases, or what came out this year',
  skin_type: 'How skin type or body chemistry affects perfume, or which perfume suits their skin type',
  other_question: 'Some other general question about perfume that is not a request for suggestions',
};
export type Topic = Exclude<keyof typeof TOPIC, 'none'>;

/** Messages that need a careful non-answer, never a list of products. */
export const SAFETY = {
  none: 'No health or safety question, and the wearer is a person aged about 12 or older',
  pregnancy: 'Asks about wearing perfume while pregnant or breastfeeding, or which perfumes are safe then',
  child: 'The perfume is for, or would be put on, a baby or young child (under about 12), or asks whether perfume is safe for one',
  pet: 'The perfume is for, or would be sprayed on, a pet or other animal',
  medical: 'Asks whether perfume, or a specific perfume, is safe or harmful for a health condition: allergies, asthma, eczema, migraines, sensitive skin',
  sensitive: 'Wants suggestions they can wear despite a sensitivity (migraines, allergies, asthma, sensitive or rash-prone skin), rather than asking whether something is safe',
};
/** The safety answers that replace the reply. "sensitive" instead becomes a caveat on light picks (a requirement). */
export type SafetyKind = Exclude<keyof typeof SAFETY, 'none' | 'sensitive'>;

/** Product requirements the catalog has no data on, so it can never claim to meet them. */
export const REQUIREMENT = {
  none: 'No such requirement is stated. A health sensitivity on its own (migraines, allergies) is not a product requirement',
  alcohol_free: 'It must be alcohol-free or halal, or an attar, perfume oil or other oil-based perfume',
  format: 'A product other than a perfume spray: a body mist or body spray, deodorant, roll-on, solid perfume, hair mist, candle or lotion',
  vegan_cruelty_free: 'It must be vegan or cruelty-free (not tested on animals)',
  natural: 'It must be all-natural or organic, made only from essential oils, or free of synthetic ingredients',
  hypoallergenic: 'It must be hypoallergenic, allergen-free or suitable for sensitive, allergy-prone skin',
};
/** `sensitivity` is not asked for directly: it comes from the safety question's "sensitive" answer. */
export type RequirementKind = Exclude<keyof typeof REQUIREMENT, 'none'> | 'sensitivity';

/** What a comparison is about. Everything but `any` is answered from catalog data, not a Jev verdict. */
export const COMPARE_ON = {
  any: 'Nothing specific: which is better overall, which suits the user best, or how they differ in general',
  longevity: 'Which lasts longest on the skin',
  projection: 'Which is strongest, loudest or projects the most',
  price: 'Which is cheaper or more expensive',
  season: 'Which suits a particular season or weather best (summer, winter, heat, cold)',
  daytime: 'Which is best for daytime or the office',
  evening: 'Which is best for evenings or nights out',
  similarity: 'Whether they smell alike, or whether one is a dupe or clone of the other',
};
export type CompareAxis = keyof typeof COMPARE_ON;

/**
 * Constraints a later message can take back ("actually, one I can wear all year
 * round"). Asked only for facets that are set; each resets its facets to "any".
 */
const DROPPABLE: Array<{ key: string; what: string; set: (f: Facets) => boolean; reset: (f: Facets) => void }> = [
  { key: 'drop_season', what: 'the season or weather requirement (e.g. "all year round", "any season", "not just for summer")',
    set: (f) => f.season !== 'any' || f.climate !== 'any', reset: (f) => { f.season = 'any'; f.climate = 'any'; } },
  { key: 'drop_occasion', what: 'the occasion (e.g. "for any occasion", "not just for work", "something versatile")',
    set: (f) => f.occasion !== 'any', reset: (f) => { f.occasion = 'any'; f.setting = 'any'; } },
  { key: 'drop_time', what: 'the time of day (e.g. "day or night", "any time")', set: (f) => f.timeOfDay !== 'any', reset: (f) => { f.timeOfDay = 'any'; } },
  { key: 'drop_gender', what: 'the feminine / masculine style (e.g. "any gender is fine")', set: (f) => f.gender !== 'any', reset: (f) => { f.gender = 'any'; } },
  { key: 'drop_budget', what: 'the budget (e.g. "price doesn\'t matter", "any budget")', set: (f) => f.budget !== 'any', reset: (f) => { f.budget = 'any'; } },
  { key: 'drop_strength', what: 'the strength or longevity requirement (e.g. "strength doesn\'t matter")',
    set: (f) => f.projection > 0 || f.longevity > 0, reset: (f) => { f.projection = 0; f.longevity = 0; } },
  { key: 'drop_brand', what: 'the brand requirement (e.g. "any brand is fine", "not only Chanel")', set: (f) => f.brands.length > 0, reset: (f) => { f.brands = []; } },
];

const REF_POLARITY = {
  similar: 'Loves it or wants perfumes similar to it',
  different: 'Dislikes it or wants something different from it',
  asking: 'Is asking about it or wants to compare it',
  incidental: 'Mentions it without expressing a preference',
};

const NOTE_POLARITY = {
  wants: 'Wants this note, likes it, or asks for it',
  avoids: 'Dislikes this note or wants to avoid it',
  not_a_note: 'The word is not about a perfume note here (e.g. a colour, a name) or no feeling is expressed',
};

// ---------------------------------------------------------------------------

export interface UnderstandInput {
  message: string;
  session: Session;
  catalog: Catalog;
  lexicon: NoteLexicon;
  decider: Decider;
  signal?: AbortSignal;
}

export interface UnderstandResult extends Understanding {
  refine: RefineDirection;
  /** pids the user explicitly does not want to see (disliked references, or "other options"). */
  exclude: string[];
  gift: boolean;
  /** What deterministic pre-pass proposed, for the debug panel. */
  proposed: { perfumes: string[]; notes: string[]; ordinals: number[] };
  /**
   * Set when an explain/compare points at something we cannot resolve - a position
   * beyond what was shown, a perfume that is not in the catalog, or a flanker of one
   * that is. The reply must say so rather than quietly describing a different perfume.
   */
  unresolved?: Unresolved;
  /** A health or safety question, or a wearer who is a child or an animal: answered without picks. */
  safety?: SafetyKind;
  /** A product requirement the catalog cannot check (alcohol-free, vegan, body mist...): never implied as met. */
  requirement?: RequirementKind;
  /** A general perfume question, answered from vetted text rather than with picks. */
  knowledge?: { topic: Topic; pids: string[]; notes: string[] };
  /** What a compare is about; `any` asks Jev which suits the user better. */
  compareOn: CompareAxis;
  /** Named perfumes the catalog only has another version of ("Coco Noir" when we have Coco). */
  variants: Array<{ pid: string; name: string }>;
  /** The user named a brand the catalog does not carry. */
  brandNotCarried: boolean;
  /** Jev says the user named a perfume the catalog does not carry (whatever the route). */
  unknownPerfume: boolean;
  /** ... in a request, where no catalog perfume the user named stands in for it. */
  perfumeNotCarried: boolean;
  /** A compare where one of the named perfumes is missing from the catalog and was left out. */
  compareMissing: boolean;
  /** Set when the message asks for two people at once; holds the phrase for each, when found. */
  twoWearers?: string[];
  /** The request contradicts itself ("fresh and light" but "beast-mode gourmand"). */
  conflicting: boolean;
  /** The message is not in English (replies are). */
  nonEnglish: boolean;
}

export type Unresolved =
  | { kind: 'position'; /** 1-based, as the user said it */ position: number; shown: number }
  | { kind: 'perfume'; /** How the user named it, when Jev could point at the words. */ name?: string }
  | { kind: 'variant'; /** The catalog perfume it is a version of. */ pid: string; name: string };

/** Minimum Jev confidence before a facet choice is trusted. */
export const MIN_CONFIDENCE = 0.45;
export const LIKE_THRESHOLD = 0.55;
export const AVOID_THRESHOLD = 0.6;
/** How sure Jev must be that a refine states an absolute level before that level overrides the one-step change. */
const EXPLICIT_LEVEL_SURE = 0.6;
/** Below this confidence, "out of scope" is overridden when the message carried perfume facets. */
const OUT_OF_SCOPE_SURE = 0.85;
const MAX_LIKES = 5;
const MAX_AVOIDS = 4;
/**
 * A refine ("now one for my son") switches to a new wearer when Jev thinks a
 * different wearer is more likely than not - the same bar a fresh request uses
 * to keep the wearer - so a leaning-different answer never carries "pink" over.
 */
export const DIFFERENT_WEARER_BELOW = 0.5;
/** How sure Jev must be that the user named a perfume we do not have before we say so. */
const UNKNOWN_PERFUME_SURE = 0.6;
/**
 * Probability, against "none", above which a safety or requirement answer takes over the
 * reply. Deliberately at even odds: wrongly adding a caveat costs little, wrongly
 * recommending products for a baby or as "halal" does not.
 */
export const SAFETY_SURE = 0.5;
export const REQUIREMENT_SURE = 0.5;
/** A general-question topic routes to the knowledge answer at this probability, or TOPIC_SURE_WITH_INTENT when the intent agrees. */
export const TOPIC_SURE = 0.6;
export const TOPIC_SURE_WITH_INTENT = 0.45;
/** How sure Jev must be that a name the user carried on ("Coco Noir") is a different perfume. */
export const VARIANT_SURE = 0.5;
/** For the yes/no checks on brands, two wearers, contradictions, language and dropped constraints. */
export const CHECK_SURE = 0.6;
/** Most perfumes in one comparison or ranking. */
export const MAX_COMPARE = 5;
/** Topics a compare of two named perfumes answers better than a general answer can. */
const COMPARE_TOPICS: ReadonlySet<string> = new Set(['dupe', 'price_where', 'creator_year']);

export async function understand(inp: UnderstandInput): Promise<UnderstandResult> {
  const { message, session, catalog, lexicon, decider, signal } = inp;
  const lastShown = session.lastShown.map((pid) => catalog.get(pid)).filter((f) => f !== undefined);
  const hasHistory = session.turns.length > 0;

  // --- Deterministic pre-pass: deal the cards --------------------------------
  // One of our own follow-up chips: we wrote it, so we know what it means.
  const known = matchFollowUp(message, catalog);
  const matches = catalog.mentionedIn(message, MAX_COMPARE);
  const refs = matches.map((m) => m.fragrance);
  // A perfume's name is not a note request: "layer with Tobacco Vanille" does not ask for tobacco.
  const notes = lexicon.find(catalog.maskNames(message, matches.filter((m) => m.score >= 0.8).map((m) => m.fragrance.pid)), 6);
  // A chip that names its perfume ("Tell me more about First by Van Cleef & Arpels") is not a list position.
  const positions = known?.pid ? [] : ordinalRefs(message).map((i) => (i < 0 ? lastShown.length - 1 : i));
  const ordinals = positions.filter((i) => i >= 0 && i < lastShown.length);
  const outOfRange = lastShown.length ? positions.filter((i) => i >= lastShown.length) : [];
  const negation = mayExpressDislike(message);
  const brandsNamed = catalog.brandsIn(message);
  const concentrations = concentrationTerms(message);

  // --- One Jev request ------------------------------------------------------
  const qs: QuestionSet = {
    intent: choice('What does the user want with their LATEST message?', INTENT),
    occasion: choice('What occasion or setting is the perfume for?', OCCASION),
    region: choice('Where in the world will the perfume be worn? Use any city, country or region mentioned.', REGION),
    setting: choice('Will the perfume be worn mostly indoors or outdoors?', SETTING),
    climate: choice(
      'What climate or weather will the perfume be worn in? Infer it from places and seasons mentioned: a Nordic winter is cold; a summer in Dubai is dry heat; a summer in Thailand is humid heat.',
      CLIMATE,
    ),
    season: choice('Which season is the perfume for?', SEASON),
    time_of_day: choice('Is the perfume for daytime or evening wear?', TIME),
    gender: choice('Whose style should the perfume suit?', GENDER),
    age_style: choice('What is the age or personal style of the wearer?', AGE),
    budget: choice('What budget does the user have in mind?', BUDGET),
    vibe: choice('What overall character is the user after?', VIBE),
    projection: choice('How strong or noticeable does the user EXPLICITLY say the scent should be?', PROJECTION),
    longevity: choice('How long does the user EXPLICITLY say the scent should last?', LONGEVITY),
    persona: noul(
      'Does the LATEST message describe the person who will wear the perfume - their age, personality, lifestyle, profession, looks or a favourite colour?',
      {
        true: 'It says something about who the wearer is, e.g. "my 65-year-old mum who loves pink", "a busy lawyer", "my sporty teenage son"',
        false: 'It does not describe the wearer as a person. Scent likes or dislikes alone ("I love citrus"), occasions, places and requests to adjust suggestions do not count',
      },
    ),
    gift: noul('Is the perfume a gift for someone other than the user?'),
  };
  if (!known && mentionsColour(message)) {
    qs.favourite_colour = choice('Which colour does the user say the WEARER loves or has as a favourite colour?', FAVOURITE_COLOUR);
  }

  // Tastes are read from the LATEST message only. Carrying them across turns is mergeFacets' job (it keeps
  // them for the same wearer and drops them for a new one); asked about "the user" in general, Jev re-reads
  // earlier turns and brings the mum's love of roses along to a request for the son.
  for (const f of FAMILIES) {
    const def = FAMILY_DEFS[f];
    qs[`like_${f}`] = noul(`Does the LATEST message ask for, or say the wearer would love, ${def.label.toLowerCase()} scents? (${def.description})`, {
      true: 'The latest message asks for it, says the wearer loves it, or mentions something personal that strongly evokes it - a favourite colour, flower, food, place or memory',
      false: 'Nothing in the latest message points to this family. Tastes mentioned in earlier messages, or for a different person, do not count; nor does the occasion or weather alone',
    });
    if (negation) {
      qs[`avoid_${f}`] = noul(`Does the LATEST message say to AVOID ${def.label.toLowerCase()} scents? (${def.description})`, {
        true: 'The latest message says the wearer dislikes it, wants less of it, or wants something without it',
        false: 'No aversion to it is expressed in the latest message',
      });
    }
  }

  if (!known) {
    // Our own chips never raise these; for everything the user types, they decide whether the
    // reply may recommend at all.
    qs.topic = choice('Is the LATEST message a general question about perfume rather than a request for suggestions? If so, what is it about?', TOPIC);
    qs.safety = choice('Does the LATEST message involve health or safety, or a wearer who is not a teenager or adult?', SAFETY);
    qs.requirement = choice('Does the user explicitly say the product itself must have one of these properties?', REQUIREMENT);
    qs.other_brand = noul(
      brandsNamed.length
        ? `Does the LATEST message name a perfume brand or house other than ${brandsNamed.join(', ')}?`
        : 'Does the LATEST message name a perfume brand or house (e.g. Chanel, Kayali, Bath & Body Works)?',
      {
        true: 'It names a company that makes perfume, body mists or other fragrance products',
        false: 'It names no brand - perfume names, notes, places and people are not brands',
      },
    );
    if (brandsNamed.length) {
      qs.wants_brand = noul(`Does the user want perfumes made BY ${brandsNamed.join(' or ')} specifically?`, {
        true: 'They ask for that house\'s perfumes, e.g. "the best Chanel perfume", "something by Tom Ford"',
        false: 'Any brand will do. Naming a perfume as a reference or asking about one ("like Sauvage by Dior", "tell me about Dior Sauvage") does not count',
      });
    }
    qs.two_wearers = noul('Does the LATEST message ask for perfumes for two or more different people at once?', {
      true: 'It asks for separate scents for different people in one go, e.g. one for me and one for my husband',
      false: 'It is about one wearer, even if it asks for more than one perfume',
    });
    qs.conflicting = noul('Does the LATEST message ask for things that clearly contradict each other?', {
      true: 'Two requirements pull in opposite directions, e.g. "fresh and light" but also "a heavy, sweet, beast-mode scent"',
      false: 'The requirements fit together',
    });
    qs.non_english = noul('Is the LATEST message written mainly in a language other than English?');
    if (lastShown.length || refs.length) qs.compare_on = choice('If the user is comparing or ranking perfumes, what are they comparing them on?', COMPARE_ON);
  }

  if (lastShown.length) {
    qs.refine = choice('If the user is reacting to the perfumes just suggested, how should the next suggestions change?', REFINE);
    // Jev's budget/projection answers cannot tell "more affordable" (relative) from "under $40" (absolute).
    if (!known) {
      qs.explicit_level = noul('Does the latest message state an ABSOLUTE level rather than just "more" or "less" than before?', {
        true: 'It gives a price limit or range ("under $40", "as cheap as possible") or an extreme strength ("full beast mode", "barely there")',
        false: 'It only asks for a relative change: cheaper, pricier, stronger, lighter than the previous suggestions',
      });
    }
  }
  if (hasHistory) qs.same_wearer = noul('Is the user still shopping for the same wearer as earlier in the conversation?');
  if (hasHistory && !known) {
    for (const d of DROPPABLE) {
      if (d.set(session.facets)) qs[d.key] = noul(`Does the LATEST message remove or relax ${d.what}?`);
    }
  }
  refs.forEach((fr, i) => {
    qs[`ref_${i}`] = choice(`How does the user feel about the perfume "${fr.name}" by ${fr.brand}?`, REF_POLARITY);
    const cont = matches[i]!.continuation;
    if (cont) {
      qs[`variant_${i}`] = noul(
        `The user wrote "${cont.display}". Is that a different perfume from "${fr.name}" by ${fr.brand}${fr.year ? `, launched ${fr.year}` : ''}?`,
        {
          true: 'A different perfume: a flanker, edition or other concentration of it (e.g. Coco Noir is not Coco; Sauvage Elixir is not Sauvage)',
          false: 'The same perfume, just named more fully, or the extra words are not part of the name',
        },
      );
    }
  });
  if (!known) {
    // The catalog lookup can only find perfumes we have. This asks about the rest, so "tell me about
    // <a perfume we don't carry>" is answered honestly instead of by describing #1.
    const listed = unique([...lastShown, ...refs]).map((f) => `${f.name} by ${f.brand}`);
    qs.unknown_perfume = noul(
      listed.length
        ? `Does the LATEST message name a specific perfume other than these: ${listed.join('; ')}?`
        : 'Does the LATEST message name a specific perfume?',
      {
        true: 'It names a particular fragrance product by its own name',
        false: 'It names no perfume (only a brand, a note, a colour, an occasion or a position such as "the second one"), or only perfumes from that list',
      },
    );
  }
  notes.forEach((n, i) => {
    qs[`note_${i}`] = choice(`In this message, how does the user feel about "${n.note}" as a perfume note?`, NOTE_POLARITY);
  });
  if (lastShown.length && positions.length === 0 && !known?.pid) {
    const opts: Record<string, string> = {};
    lastShown.forEach((fr, i) => { opts[`p_${fr.pid}`] = `#${i + 1}: ${fr.name} by ${fr.brand}`; });
    opts.none = 'None of them in particular';
    qs.focus = choice('Which of the perfumes just suggested is the user referring to, if any?', opts);
  }

  const state = {
    // Jev only knows what is in its state: without this, "What should I wear for a summer in
    // Turkey?" reads as a clothing question and is classified out of scope.
    context: 'The user is chatting with a perfume recommendation assistant. Everything they ask to "wear", "smell like" or "try" refers to fragrance.',
    latest_message: message,
    earlier_conversation: session.turns.slice(-6).map((t) => `${t.role}: ${t.text.slice(0, 300)}`),
    understood_so_far: hasHistory ? describeFacets(session.facets) : undefined,
    perfumes_just_suggested: lastShown.length ? lastShown.map((f, i) => `#${i + 1} ${f.name} by ${f.brand}`) : undefined,
  };

  const { answers } = await decider.decide(state, qs, { signal, label: 'understand' });
  const a = answers as Record<string, Answer>;

  // --- Code combines the typed answers ---------------------------------------
  const uncertain: (keyof Facets)[] = [];
  const pick = <K extends string>(key: string, facet: keyof Facets, anyKey: K): K => {
    const ans = a[key] as ChoiceAnswer<K> | undefined;
    if (!ans) return anyKey;
    if (ans.choice !== anyKey && ans.confidence < MIN_CONFIDENCE) {
      uncertain.push(facet);
      return anyKey;
    }
    return ans.choice;
  };
  const p = (key: string) => (a[key] as NoulAnswer | undefined)?.noul ?? 0;
  const ageAnswer = pick<AgeStyle | 'child'>('age_style', 'ageStyle', 'any');

  const fresh: Facets = {
    ...EMPTY_FACETS,
    occasion: pick<Occasion>('occasion', 'occasion', 'any'),
    region: pick<Region>('region', 'region', 'any'),
    setting: pick<Setting>('setting', 'setting', 'any'),
    climate: pick<Climate>('climate', 'climate', 'any'),
    season: pick<Season | 'any'>('season', 'season', 'any'),
    timeOfDay: pick<DayTime | 'any'>('time_of_day', 'timeOfDay', 'any'),
    gender: pick<GenderPref>('gender', 'gender', 'any'),
    // A child is not a style to shop for: that turn is answered by the safety reply instead.
    ageStyle: ageAnswer === 'child' ? 'any' : ageAnswer,
    budget: pick<Budget>('budget', 'budget', 'any'),
    vibe: pick<Vibe>('vibe', 'vibe', 'any'),
    projection: PROJECTION_LEVEL[pick<keyof typeof PROJECTION>('projection', 'projection', 'unspecified')],
    longevity: LONGEVITY_LEVEL[pick<keyof typeof LONGEVITY>('longevity', 'longevity', 'unspecified')],
    likes: {},
    avoids: {},
    likedNotes: [],
    avoidedNotes: [],
    referencePids: [],
    // Our chips never describe the wearer, whatever Jev reads into them.
    persona: !known && p('persona') > 0.5 ? message.trim().slice(0, 400) : '',
    favouriteColour: pick<FavouriteColour>('favourite_colour', 'favouriteColour', 'none'),
    brands: brandsNamed.length && p('wants_brand') >= CHECK_SURE ? brandsNamed : [],
    refinedLikes: [],
  };

  for (const f of FAMILIES) {
    const like = p(`like_${f}`);
    const avoid = p(`avoid_${f}`);
    if (avoid >= AVOID_THRESHOLD && avoid > like) fresh.avoids[f] = round(avoid);
    else if (like >= LIKE_THRESHOLD) fresh.likes[f] = round(like);
  }
  // Liking every family is no preference at all: keep only the strongest few, so a noisy
  // decider cannot flatten the taste signal.
  fresh.likes = strongest(fresh.likes, MAX_LIKES);
  fresh.avoids = strongest(fresh.avoids, MAX_AVOIDS);

  notes.forEach((n, i) => {
    const ans = a[`note_${i}`] as ChoiceAnswer | undefined;
    if (!ans) return;
    const need = n.ambiguous ? 0.6 : MIN_CONFIDENCE;
    if (ans.confidence < need) return;
    if (ans.choice === 'wants') fresh.likedNotes.push(n.note);
    else if (ans.choice === 'avoids') fresh.avoidedNotes.push(n.note);
  });

  // A name the user carried on past ("Coco Noir", "Angel Nova") that Jev says is another perfume
  // is not the catalog record: it must never be described, compared or used as a reference.
  const variants: Array<{ pid: string; name: string }> = [];
  refs.forEach((fr, i) => {
    const cont = matches[i]!.continuation;
    if (cont && p(`variant_${i}`) >= VARIANT_SURE) variants.push({ pid: fr.pid, name: cont.display });
  });
  const isVariant = (pid: string) => variants.some((v) => v.pid === pid);

  const exclude: string[] = [];
  const asked: string[] = [];
  /** Named perfumes Jev confirmed the user means (asking about or liking) - never merely "incidental" ones. */
  const pointed: string[] = [];
  refs.forEach((fr, i) => {
    if (isVariant(fr.pid)) return;
    const ans = a[`ref_${i}`] as ChoiceAnswer | undefined;
    if (!ans || ans.confidence < MIN_CONFIDENCE) return;
    if (ans.choice === 'similar') fresh.referencePids.push(fr.pid);
    else if (ans.choice === 'different') exclude.push(fr.pid);
    else if (ans.choice === 'asking') asked.push(fr.pid);
    if (ans.choice === 'similar' || ans.choice === 'asking') pointed.push(fr.pid);
  });

  // "Tell me about Eros": short common-word names are too risky for the pre-pass without their brand,
  // so they were never proposed. Once Jev says the user names a perfume we have not listed, an exact
  // catalog name in the message is safe to use - rather than wrongly saying we do not carry it. The
  // first such name counts even if it is an everyday word; for a list ("rank Sauvage, Aventus and
  // Eros") every further distinctive one does too.
  const namedExact: Fragrance[] = [];
  if (p('unknown_perfume') >= UNKNOWN_PERFUME_SURE) {
    const listed = new Set([...lastShown, ...refs].map((f) => f.pid));
    const extra = catalog.namedExactly(message).filter((x) => !listed.has(x.fragrance.pid));
    // More than one only for a comparison, where the user is listing perfumes: elsewhere a name that
    // is also a word ("Joy", "Beautiful") is far likelier to be just a word.
    const listing = (a.intent as ChoiceAnswer | undefined)?.choice === 'compare';
    extra.forEach((x, i) => { if (i === 0 || (listing && !x.everyday)) namedExact.push(x.fragrance); });
    namedExact.slice(0, MAX_COMPARE).reverse().forEach((f) => { asked.unshift(f.pid); pointed.unshift(f.pid); });
  }

  // Seasons and climates imply each other when only one is given.
  if (fresh.season === 'any') {
    if (fresh.climate === 'cold') fresh.season = 'winter';
    else if (fresh.climate === 'hot_dry' || fresh.climate === 'hot_humid') fresh.season = 'summer';
  }

  // --- Intent, with corrections for impossible combinations ------------------
  const intentAns = a.intent as ChoiceAnswer<Intent>;
  let intent: Intent = known?.intent ?? intentAns.choice;
  const jevRefine = ((a.refine as ChoiceAnswer<RefineDirection> | undefined)?.choice ?? 'none') as RefineDirection;
  const refine: RefineDirection = known ? (known.refine ?? 'none') : jevRefine;
  if (known?.pid) {
    if (known.intent === 'more_like') fresh.referencePids = [known.pid];
    else if (!asked.includes(known.pid)) asked.unshift(known.pid);
  }

  const focusChoice = (a.focus as ChoiceAnswer | undefined);
  const focusConfident = !!focusChoice && focusChoice.confidence >= MIN_CONFIDENCE;
  const focusFromJev = focusConfident && focusChoice!.choice !== 'none' ? [focusChoice!.choice.slice(2)] : [];
  const focusPids = unique([
    ...ordinals.map((i) => lastShown[i]!.pid),
    ...asked,
    ...(ordinals.length ? [] : focusFromJev),
  ]);

  if (intent === 'refine' && lastShown.length === 0 && !known?.keep) intent = 'recommend';
  // Safety net: a not-very-sure "out of scope" that still yielded several perfume facets is a request.
  if (intent === 'out_of_scope' && !known && intentAns.confidence < OUT_OF_SCOPE_SURE && specifiedFacets(fresh) >= 2) intent = 'recommend';
  // A name the pre-pass found but Jev did not confirm ("a trip to Paris", "the first two") is never
  // used as a reference: `pointed` already holds every confirmed one, in referencePids or focusPids.
  if (intent === 'more_like') {
    if (fresh.referencePids.length === 0 && focusPids.length) fresh.referencePids.push(focusPids[0]!);
    if (fresh.referencePids.length === 0) intent = lastShown.length ? 'refine' : 'recommend';
  }
  if (intent === 'recommend' && fresh.referencePids.length) intent = 'more_like';

  // --- Routes that answer instead of recommending ----------------------------
  const safetyAnswer = gated<SafetyKind | 'sensitive'>(a.safety, SAFETY_SURE);
  // "Perfume gives me migraines - is there anything I can wear?" asks for picks, with care: light ones, with a caveat.
  const safety = safetyAnswer === 'sensitive' ? undefined : safetyAnswer ?? (ageAnswer === 'child' ? 'child' : undefined);
  let requirement = gated<RequirementKind>(a.requirement, REQUIREMENT_SURE);
  // Jev can infer "alcohol-free" from a sensitivity ("alcohol triggers migraines"); only the user's own words
  // may block every spray.
  if (requirement === 'alcohol_free' && !ALCOHOL_WORDS.test(message)) requirement = undefined;
  if (safetyAnswer === 'sensitive' && (!requirement || requirement === 'alcohol_free' && !ALCOHOL_WORDS.test(message))) requirement = 'sensitivity';
  const topicAns = a.topic as ChoiceAnswer | undefined;
  const topicP = topicAns && topicAns.choice !== 'none' ? (topicAns.probabilities?.[topicAns.choice] ?? topicAns.confidence) : 0;
  let topic: Topic | undefined = topicP >= (intent === 'knowledge' ? TOPIC_SURE_WITH_INTENT : TOPIC_SURE) ? topicAns!.choice as Topic : undefined;
  // "Sauvage EDT vs EDP": two concentrations of one perfume line is a concentration question, whatever
  // else it looks like - comparing Sauvage with Eau Sauvage instead is how the old reply misled.
  const lines = new Set([...focusPids, ...variants.map((v) => v.pid)].map((pid) => catalog.get(pid)?.name.split(' ')[0]?.toLowerCase()));
  if (concentrations.length >= 2 && lines.size <= 1 && (intent === 'compare' || intent === 'explain' || intent === 'knowledge')) topic = 'concentration';
  // "How many hours does Sauvage Elixir last?": no specific topic, but a perfume we have - its card answers that.
  // "Do you have Kayali Vanilla 28?": no specific topic, and a perfume we lack - say so (an unresolved explain).
  const named = unique([...focusPids, ...pointed]).length > 0;
  const unknownNamed = p('unknown_perfume') >= UNKNOWN_PERFUME_SURE && namedExact.length === 0;
  if ((intent === 'knowledge' || topic === 'other_question') && (!topic || topic === 'other_question') && (named || unknownNamed || variants.length)) {
    topic = undefined;
    intent = 'explain';
  }
  if (intent === 'knowledge' && !topic) topic = 'other_question';
  const compareOn: CompareAxis = (() => {
    const c = a.compare_on as ChoiceAnswer<CompareAxis> | undefined;
    if (c && c.choice !== 'any' && c.confidence >= MIN_CONFIDENCE) return c.choice;
    if (topic === 'dupe') return 'similarity';
    if (topic === 'price_where') return 'price';
    return 'any';
  })();
  // Two named perfumes and a dupe / price / who-made-it question is a comparison of those two.
  const comparable = unique([...focusPids, ...pointed]).length >= 2;
  if (intent === 'compare' && comparable && topic && COMPARE_TOPICS.has(topic)) topic = undefined;
  const knowledge = topic ? { topic, pids: unique([...focusPids, ...pointed]), notes: notes.map((n) => n.note) } : undefined;
  if (knowledge) intent = 'knowledge';

  // Something the user pointed at that we cannot resolve: say so, never swap in another perfume.
  const unknownPerfume = p('unknown_perfume') >= UNKNOWN_PERFUME_SURE && namedExact.length === 0;
  // A named perfume wins over a position: in "tell me about Chanel No 5", "No 5" is part of the name.
  const cannotResolve = (): Unresolved | undefined => (variants.length ? { kind: 'variant', pid: variants[0]!.pid, name: variants[0]!.name }
    : unknownPerfume ? { kind: 'perfume' }
    : outOfRange.length ? { kind: 'position', position: outOfRange[0]! + 1, shown: lastShown.length }
    : undefined);
  let unresolved: Unresolved | undefined;
  let compareMissing = false;
  if (intent === 'explain' && focusPids.length === 0) {
    unresolved = cannotResolve();
    if (!unresolved) {
      // Only a perfume the user named, or one Jev says they mean. "What's the difference between EDP and
      // EDT anyway?" after a list is not about #1, and repeating #1's card answers nothing.
      const fallback = pointed[0] ?? (focusConfident ? undefined : lastShown.length === 1 ? lastShown[0]!.pid : undefined);
      if (fallback) focusPids.push(fallback);
      else if (lastShown.length) unresolved = { kind: 'position', position: 0, shown: lastShown.length };
      else intent = 'recommend';
    }
  }
  if (intent === 'compare') {
    const named = unique([...focusPids, ...pointed]);
    if (named.length >= 2) {
      focusPids.splice(0, focusPids.length, ...named.slice(0, MAX_COMPARE));
      // "Rank Sauvage, Aventus and Kayali Vanilla 28": compare what we have and say what is missing.
      compareMissing = unknownPerfume || variants.length > 0;
    } else {
      unresolved = cannotResolve();
      if (!unresolved) {
        // "Which of these lasts longest?", "compare all four": every perfume just shown, not just #1 and #2.
        for (const pid of [...named, ...lastShown.map((f) => f.pid)]) if (focusPids.length < MAX_COMPARE && !focusPids.includes(pid)) focusPids.push(pid);
        if (focusPids.length < 2) intent = focusPids.length === 1 ? 'explain' : 'recommend';
      }
    }
  }

  // --- Merge with what we already knew --------------------------------------
  const pSame = hasHistory ? p('same_wearer') : 0;
  // Our own chips never change the wearer. A refine keeps them unless Jev is fairly sure they changed
  // ("now something for my son"); a fresh request needs Jev to say it is the same person.
  const sameWearer = !!known || (intent === 'refine' ? pSame >= DIFFERENT_WEARER_BELOW : pSame >= 0.5);
  // "Cheaper alternatives to X" steps down from X's own price, not from an earlier budget or list.
  const anchor = known?.pid && known.refine ? catalog.get(known.pid) : undefined;
  const prev = clone(anchor ? { ...session.facets, budget: 'any' as const } : session.facets);
  // "Actually, one I can wear all year round": a constraint the user takes back is cleared, not kept.
  for (const d of DROPPABLE) if (p(d.key) >= CHECK_SURE) d.reset(prev);
  const tiers = (anchor ? [anchor] : lastShown).map((f) => f.priceTier);
  const explicitLevel = !known && p('explicit_level') >= EXPLICIT_LEVEL_SURE;
  let facets = mergeFacets(prev, fresh, intent, sameWearer, refine, tiers, explicitLevel);
  if (known) facets = applyFollowUpFacets(facets, known);
  if (refine === 'different_options') exclude.push(...session.seen);

  const request = intent === 'recommend' || intent === 'more_like' || intent === 'refine';
  const twoWearers = request && p('two_wearers') >= CHECK_SURE ? wearerPhrases(message) : undefined;

  return {
    intent,
    intentConfidence: round(intentAns.confidence),
    facets,
    uncertain: unique(uncertain),
    focusPids,
    refine,
    // "I love Angel Nova": we said Angel is a different scent, so it is not offered as a pick either.
    exclude: unique([...exclude, ...(request ? variants.map((v) => v.pid) : [])]),
    gift: p('gift') >= 0.5,
    proposed: { perfumes: refs.map((f) => `${f.name} (${f.brand})`), notes: notes.map((n) => n.note), ordinals },
    ...(unresolved ? { unresolved } : {}),
    ...(safety ? { safety } : {}),
    ...(requirement ? { requirement } : {}),
    ...(knowledge ? { knowledge } : {}),
    compareOn,
    variants,
    brandNotCarried: p('other_brand') >= CHECK_SURE && !catalog.mayNameOtherBrand(message, brandsNamed),
    unknownPerfume,
    perfumeNotCarried: request && unknownPerfume && pointed.length === 0,
    compareMissing,
    ...(twoWearers ? { twoWearers } : {}),
    conflicting: request && p('conflicting') >= CHECK_SURE,
    nonEnglish: p('non_english') >= CHECK_SURE,
  };
}

/** The user's own words for an alcohol-free need, in the languages people commonly ask in. */
const ALCOHOL_WORDS = /alcoh|alcool|alkohol|halal|haram|attar|ittar|\boils?\b|oil-based|non-?alcoholic|sin alcohol|sans alcool|ohne alkohol/i;

/** How sure Jev must be about which words name the brand or perfume before a reply quotes them. */
const NAME_SURE = 0.4;

/**
 * Which words of the message name a brand or perfume we do not carry, so the reply can
 * say "I don't carry Kayali" rather than "that brand". Jev points at one of the word
 * runs the pre-pass offers - it never spells a name - and "none" leaves the reply generic.
 */
export async function nameTheUnknown(
  message: string, decider: Decider, want: { brand: boolean; perfume: boolean }, signal?: AbortSignal, budgetMs?: number,
  /** Names the catalog does have: a span containing one is not the missing perfume. */
  known: string[] = [],
): Promise<{ brand?: string; perfume?: string }> {
  const knownNames = known.map((k) => ` ${normalizeName(k)} `);
  const spans = candidateSpans(message).filter((x) => !knownNames.some((k) => ` ${normalizeName(x)} `.includes(k)));
  if (!spans.length || (!want.brand && !want.perfume)) return {};
  const opts: Record<string, string> = Object.fromEntries(spans.map((x, i) => [`s${i}`, x]));
  opts.none = 'None of these';
  const qs: QuestionSet = {};
  if (want.brand) qs.brand_name = choice('Which words in the message are the name of the perfume brand or house the user mentions?', opts);
  if (want.perfume) qs.perfume_name = choice('Which words in the message are the name of the specific perfume the user mentions, including its brand if they gave one?', opts);
  const { answers } = await decider.decide({ latest_message: message }, qs, { signal, label: 'name', budgetMs });
  const span = (key: string): string | undefined => {
    const ans = (answers as Record<string, Answer>)[key] as ChoiceAnswer | undefined;
    if (!ans || ans.choice === 'none' || ans.confidence < NAME_SURE) return undefined;
    return spans[Number(ans.choice.slice(1))];
  };
  return { brand: span('brand_name'), perfume: span('perfume_name') };
}

/**
 * The strongest non-"none" option of a choice whose probability of "none" is below
 * 1 - `sure` - i.e. Jev leans at least `sure` towards SOME option other than none.
 */
function gated<K extends string>(ans: Answer | undefined, sure: number): K | undefined {
  if (!ans || ans.type !== 'choice') return undefined;
  const probs = ans.probabilities ?? { [ans.choice]: ans.confidence };
  const pNone = probs.none ?? (ans.choice === 'none' ? ans.confidence : 0);
  if (1 - pNone <= sure) return undefined;
  // Mass spread thinly over every option is doubt, not a finding: one option must stand out.
  const best = Object.entries(probs).filter(([k]) => k !== 'none').sort((x, y) => y[1] - x[1])[0];
  if (!best || best[1] < GATED_OPTION_FLOOR) return undefined;
  return best[0] as K;
}

/** The least probability the leading option of a gated choice needs on its own. */
const GATED_OPTION_FLOOR = 0.3;

/**
 * The phrase for each person in "a floral one for me and something woody for my
 * husband" -> ["a floral one for me", "something woody for my husband"], for chips
 * that let the user pick who to start with. Empty when the split is not clear.
 */
export function wearerPhrases(message: string): string[] {
  const parts = message
    .replace(/^[^:]*\b(?:two|2|both|couple of)\b[^:]*:\s*/i, '')
    .split(/\s*(?:[,;.!?]|\band\b|\bbut\b|\bplus\b|\balso\b)\s*/i)
    .map((x) => x.trim())
    .filter((x) => /\bfor\s+(?:me|myself|my|him|her|them|us|our|the)\b/i.test(x) && x.split(/\s+/).length <= 10);
  return parts.length >= 2 ? parts.slice(0, 3).map((x) => x.charAt(0).toLowerCase() + x.slice(1)) : [];
}

// ---------------------------------------------------------------------------
// Facet merging
// ---------------------------------------------------------------------------

const BUDGET_STEPS: Budget[] = ['budget', 'mid', 'luxury'];

/**
 * Combines this turn's facets with the session's. `sameWearer` false means a new
 * person: a fresh request then starts clean, a refine keeps only the situation.
 */
export function mergeFacets(
  prev: Facets,
  fresh: Facets,
  intent: Intent,
  sameWearer: boolean,
  refine: RefineDirection,
  lastTiers: string[],
  /** The user stated an absolute level (Jev's explicit_level): it may override the one-step refine. */
  explicitLevel = false,
): Facets {
  let base: Facets;
  if (intent === 'refine' && !sameWearer) {
    // Same situation, different person ("now one for my son"): the previous wearer's
    // age, style, persona and tastes must not follow the request over.
    base = overlay(withoutWearer(prev), withoutStepped(fresh, refine));
  } else if (intent === 'refine' || intent === 'explain' || intent === 'compare' || intent === 'knowledge' || (intent === 'more_like' && sameWearer)) {
    base = overlay(prev, withoutStepped(fresh, refine));
  } else if (intent === 'recommend' && sameWearer) {
    // Same person, new situation: keep who they are, reset where they are going.
    const wearer = {
      ...EMPTY_FACETS,
      gender: prev.gender, ageStyle: prev.ageStyle, budget: prev.budget, vibe: prev.vibe, persona: prev.persona,
      likes: prev.likes, avoids: prev.avoids, likedNotes: prev.likedNotes, avoidedNotes: prev.avoidedNotes,
      favouriteColour: prev.favouriteColour, refinedLikes: prev.refinedLikes,
    };
    base = overlay(wearer, fresh);
  } else {
    base = clone(fresh);
  }
  const stepped = applyRefinement(base, refine, lastTiers);
  return explicitLevel ? honourExplicit(stepped, fresh, refine) : stepped;
}

/**
 * A relative refine steps ONE level. When the user also stated an absolute level
 * (Jev's explicit_level), a value further in the same direction wins: "too
 * expensive - something under $40" after a luxury list means budget, not mid;
 * "full beast mode" means 4, not +1.
 */
function honourExplicit(stepped: Facets, fresh: Facets, dir: RefineDirection): Facets {
  const out = clone(stepped);
  const tier = (b: Facets['budget']) => BUDGET_STEPS.indexOf(b);
  if (dir === 'cheaper' && fresh.budget !== 'any' && tier(fresh.budget) < tier(out.budget)) out.budget = fresh.budget;
  if (dir === 'pricier' && fresh.budget !== 'any' && tier(fresh.budget) > tier(out.budget)) out.budget = fresh.budget;
  if (dir === 'stronger') {
    if (fresh.projection > out.projection) out.projection = fresh.projection;
    if (fresh.longevity > out.longevity) out.longevity = fresh.longevity;
  }
  if (dir === 'lighter' && fresh.projection && fresh.projection < out.projection) out.projection = fresh.projection;
  return out;
}

/**
 * The wearer's facets reset; the situation (occasion, place, weather, season, time
 * of day, budget) and the request's own dials (vibe, strength, references) stay.
 */
function withoutWearer(f: Facets): Facets {
  return {
    ...clone(f),
    gender: 'any', ageStyle: 'any', persona: '', favouriteColour: 'none', likes: {}, avoids: {}, likedNotes: [], avoidedNotes: [],
    refinedLikes: [],
  };
}

/**
 * When the previous facets carry over, a relative refine steps its facet ONE level
 * from the previous value. Jev's absolute reading of the same words ("stronger" ->
 * projection strong) is dropped first, or the step would land twice and "something
 * stronger" would jump to beast-mode.
 */
function withoutStepped(fresh: Facets, dir: RefineDirection): Facets {
  const f = clone(fresh);
  if (dir === 'cheaper' || dir === 'pricier') f.budget = 'any';
  if (dir === 'lighter' || dir === 'stronger') f.projection = 0;
  if (dir === 'stronger') f.longevity = 0;
  return f;
}

/** Fresh values win wherever they are specified; likes/avoids merge and cancel each other. */
function overlay(prev: Facets, fresh: Facets): Facets {
  const out = clone(prev);
  for (const k of ['occasion', 'region', 'setting', 'climate', 'season', 'timeOfDay', 'gender', 'ageStyle', 'budget', 'vibe'] as const) {
    if (fresh[k] !== 'any') (out as unknown as Record<string, string>)[k] = fresh[k];
  }
  if (fresh.projection) out.projection = fresh.projection;
  if (fresh.longevity) out.longevity = fresh.longevity;
  for (const [f, v] of Object.entries(fresh.likes) as [Family, number][]) { out.likes[f] = v; delete out.avoids[f]; }
  for (const [f, v] of Object.entries(fresh.avoids) as [Family, number][]) { out.avoids[f] = v; delete out.likes[f]; }
  // A family the user now asks for themselves is their taste, not a refinement's; one they now avoid is gone.
  out.refinedLikes = out.refinedLikes.filter((f) => f in out.likes && !(f in fresh.likes));
  if (fresh.brands.length) out.brands = [...fresh.brands];
  out.likedNotes = unique([...out.likedNotes.filter((n) => !fresh.avoidedNotes.includes(n)), ...fresh.likedNotes]);
  out.avoidedNotes = unique([...out.avoidedNotes.filter((n) => !fresh.likedNotes.includes(n)), ...fresh.avoidedNotes]);
  if (fresh.referencePids.length) out.referencePids = fresh.referencePids;
  if (fresh.favouriteColour !== 'none') out.favouriteColour = fresh.favouriteColour;
  // Truncate the end, not the start: the original description of the wearer is the part to keep.
  if (fresh.persona) out.persona = prev.persona && !prev.persona.includes(fresh.persona)
    ? `${prev.persona} / ${fresh.persona}`.slice(0, 400)
    : fresh.persona;
  return out;
}

function applyRefinement(f: Facets, dir: RefineDirection, lastTiers: string[]): Facets {
  const out = clone(f);
  /** Marks a family the refinement adds, unless the user already asked for it themselves. */
  const refined = (fam: Family) => { if (!(fam in out.likes) && !out.refinedLikes.includes(fam)) out.refinedLikes.push(fam); };
  const step = (delta: number) => {
    let i = BUDGET_STEPS.indexOf(out.budget);
    if (i < 0) {
      // No budget yet: step relative to what we just showed.
      const premium = lastTiers.filter((t) => t === 'luxury' || t === 'niche').length;
      i = premium > lastTiers.length / 2 ? 2 : lastTiers.includes('budget') ? 0 : 1;
    }
    out.budget = BUDGET_STEPS[Math.max(0, Math.min(2, i + delta))]!;
  };
  switch (dir) {
    case 'cheaper': step(-1); break;
    case 'pricier': step(+1); break;
    case 'lighter': out.projection = Math.max(1, (out.projection || 3) - 1) as Level; break;
    case 'stronger':
      out.projection = Math.min(4, (out.projection || 2) + 1) as Level;
      out.longevity = Math.min(4, (out.longevity || 2) + 1) as Level;
      break;
    case 'sweeter': refined('gourmand_sweet'); out.likes.gourmand_sweet = 0.8; delete out.avoids.gourmand_sweet; break;
    case 'less_sweet': out.avoids.gourmand_sweet = 0.8; delete out.likes.gourmand_sweet; break;
    case 'fresher':
      refined('fresh_aquatic'); refined('citrus');
      out.likes.fresh_aquatic = Math.max(out.likes.fresh_aquatic ?? 0, 0.7);
      out.likes.citrus = Math.max(out.likes.citrus ?? 0, 0.7);
      delete out.avoids.fresh_aquatic; delete out.avoids.citrus;
      break;
    case 'warmer':
      refined('amber_oriental'); refined('spicy');
      out.likes.amber_oriental = Math.max(out.likes.amber_oriental ?? 0, 0.7);
      out.likes.spicy = Math.max(out.likes.spicy ?? 0, 0.6);
      delete out.avoids.amber_oriental; delete out.avoids.spicy;
      break;
    case 'more_unique': out.vibe = 'unique'; break;
    case 'more_classic': out.vibe = 'classic'; break;
    case 'more_modern': out.vibe = 'modern'; break;
    default: break;
  }
  return out;
}

function clone(f: Facets): Facets {
  return {
    ...f,
    likes: { ...f.likes },
    avoids: { ...f.avoids },
    likedNotes: [...f.likedNotes],
    avoidedNotes: [...f.avoidedNotes],
    referencePids: [...f.referencePids],
    brands: [...f.brands],
    refinedLikes: [...f.refinedLikes],
  };
}

function specifiedFacets(f: Facets): number {
  const choices = [f.occasion, f.region, f.setting, f.climate, f.season, f.timeOfDay, f.gender, f.ageStyle, f.budget, f.vibe]
    .filter((v) => v !== 'any').length;
  return choices + (f.projection ? 1 : 0) + (f.longevity ? 1 : 0) + Object.keys(f.likes).length + f.likedNotes.length + f.brands.length;
}

function strongest(m: Partial<Record<Family, number>>, n: number): Partial<Record<Family, number>> {
  return Object.fromEntries((Object.entries(m) as [Family, number][]).sort((a, b) => b[1] - a[1]).slice(0, n));
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
