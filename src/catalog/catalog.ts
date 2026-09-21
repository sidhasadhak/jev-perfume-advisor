/**
 * In-memory catalog with deterministic lookup. Loaders (loader.ts) build one of
 * these from the seed files, a FragDB CSV export, or the FragDB API.
 */
import type { Fragrance } from '../types.js';

export type CatalogSource = 'seed' | 'csv' | 'api';

export interface CatalogStats {
  fragrances: number;
  brands: number;
  /** Records dropped during load, with why - never truncate silently. */
  dropped: number;
  unresolvedNotes: number;
  unresolvedAccords: number;
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STOP = new Set(['the', 'de', 'of', 'le', 'la', 'eau', 'parfum', 'toilette', 'edp', 'edt', 'for', 'by', 'pour', 'and', 'a']);
/**
 * Brand words too generic to count as naming the brand on their own: connector
 * words, and everyday words or first names ("a scent for my boss" is not Hugo
 * Boss, "my husband Tom" is not Tom Ford). The full brand name still counts.
 */
const GENERIC_BRAND_WORDS = new Set(['parfums', 'parfum', 'perfumes', 'perfume', 'fragrances', 'maison', 'house', 'paris', 'london',
  'new', 'york', 'collection', 'les', 'des', 'du', 'di', 'et', 'co', 'company', 'beauty', 'cosmetics', 'prives', 'prive',
  'cologne', 'boss', 'secret', 'has', 'gun', 'tom', 'jean', 'paul']);

/**
 * Abbreviations and spellings people use for brands, both sides normalized
 * ("D&G" normalizes to "d and g"). They count as naming the brand, which is
 * what lets short names like "Y" or "Le Male" match at all.
 */
const BRAND_ALIASES: ReadonlyMap<string, string> = new Map([
  ['ysl', 'yves saint laurent'],
  ['d and g', 'dolce and gabbana'], ['dg', 'dolce and gabbana'],
  ['ck', 'calvin klein'],
  ['mfk', 'maison francis kurkdjian'],
  ['pdm', 'parfums de marly'],
  ['jpg', 'jean paul gaultier'],
  ['tf', 'tom ford'],
  ['el', 'estee lauder'],
  ['vca', 'van cleef and arpels'],
  ['lv', 'louis vuitton'],
  ['ch', 'carolina herrera'],
  ['v and r', 'viktor and rolf'],
  ['bulgari', 'bvlgari'],
]);

/**
 * Everyday words that are also perfume names: "a first date", "a trip to
 * Paris", "fresh as a daisy", "100 Fahrenheit", "light blue is her colour".
 * A name made only of these (or of note and accord names) still matches -
 * Jev decides whether the user meant the perfume - but without its brand it
 * ranks below any distinctive name, so "Aventus for a first date" leads with Aventus.
 */
const EVERYDAY_WORDS = new Set([
  'black', 'white', 'red', 'blue', 'green', 'pink', 'grey', 'gray', 'gold', 'silver', 'light', 'dark', 'bright', 'crystal',
  'first', 'day', 'night', 'morning', 'afternoon', 'evening', 'sunday', 'summer', 'winter', 'spring', 'autumn', 'fall',
  'fresh', 'cool', 'cloud', 'rain', 'sun', 'water', 'sea', 'beach', 'fahrenheit',
  'paris', 'london', 'rome', 'roma', 'naxos', 'portofino', 'dubai', 'nile',
  'man', 'men', 'woman', 'her', 'him', 'lady', 'girl', 'boy', 'son', 'do', 'in', 'one', 'not', 'perfume', 'scent', 'love', 'good', 'lost',
  'legend', 'explorer', 'fantasy', 'candy', 'bloom', 'daisy', 'flower', 'linen', 'tea', 'door', 'club', 'walk', 'swim', 'jazz', 'lazy',
  'fireplace', 'wood', 'sport', 'youth', 'irresistible',
]);

/** Concentration suffixes people leave off: "Bleu de Chanel" is "Bleu de Chanel Eau de Parfum". */
const CONCENTRATION_SUFFIX = / (?:eau de parfum|eau de toilette|eau de cologne|edp|edt)$/;

function tokens(s: string): string[] {
  return foldNumbers(normalize(s)).split(' ').filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * "N°5", "Nº5", "No. 5", "N5" and "Number 5" all name the same perfume, but
 * normalize() leaves them as "n 5", "no5", "no 5"... Fold them into one token,
 * in names and in text alike, so "Chanel No 5" finds "N°5 Eau de Parfum" and a
 * bare "19" ("I'm 19") no longer reads as Chanel "N°19".
 */
function foldNumbers(normalized: string): string {
  return normalized.replace(/(^| )(?:n|no|nr|num|number) ?(\d+)(?= |$)/g, '$1no$2');
}

/** The text as mentionedIn/brandsIn search it: normalized, numbers folded, padded for whole-word checks. */
function haystack(text: string): string {
  return ` ${foldNumbers(normalize(text))} `;
}

/** Distinctive words of a brand name - connector and generic words excluded. */
function brandWords(brand: string): string[] {
  return normalize(brand).split(' ').filter((t) => t.length > 2 && !STOP.has(t) && !GENERIC_BRAND_WORDS.has(t));
}

/** Normalized brands named in the haystack through an alias ("YSL" -> Yves Saint Laurent). */
function aliasedBrands(hay: string): Set<string> {
  const out = new Set<string>();
  for (const [alias, brand] of BRAND_ALIASES) if (hay.includes(` ${alias} `)) out.add(brand);
  return out;
}

/** Every note and accord name in the catalog, normalized - the words that make "Vetiver" or "Green Tea" ambiguous. */
function noteVocabulary(fragrances: Fragrance[]): Set<string> {
  const raw = new Set<string>();
  for (const fr of fragrances) {
    for (const n of fr.notes.top) raw.add(n);
    for (const n of fr.notes.middle) raw.add(n);
    for (const n of fr.notes.base) raw.add(n);
    for (const a of fr.accords) raw.add(a.name);
  }
  return new Set([...raw].map(normalize));
}

export interface NameMatch {
  fragrance: Fragrance;
  /**
   * 0..1. 1: the exact name and its brand. 0.8: the exact name, or all its
   * words plus the brand. 0.6: its words as a phrase. 0.5 / 0.3: the exact
   * name / phrase, but the name is only everyday words, places or notes
   * ("First", "Paris", "Vetiver") and the brand is not named, so the text may
   * not mean the perfume at all.
   */
  score: number;
}

interface IndexEntry {
  fr: Fragrance;
  /** Normalized, numbers folded. */
  name: string;
  /** `name` without a concentration suffix. */
  core: string;
  brand: string;
  full: string;
  nameTokens: string[];
  brandTokens: string[];
  phrase: string;
  /** Every name word is an everyday word, stop word or note, e.g. "First", "Green Tea". */
  everyday: boolean;
}

/** How many same-name ties mentionedIn may return beyond its limit. */
const MAX_TIED_EXTRA = 2;

export class Catalog {
  readonly byPid: Map<string, Fragrance>;
  private readonly index: IndexEntry[];

  constructor(
    readonly fragrances: Fragrance[],
    readonly source: CatalogSource,
    readonly stats: CatalogStats,
  ) {
    this.byPid = new Map(fragrances.map((f) => [f.pid, f]));
    const notes = noteVocabulary(fragrances);
    this.index = fragrances.map((fr) => {
      const name = foldNumbers(normalize(fr.name));
      const words = name.split(' ').filter(Boolean);
      const sig = words.filter((t) => t.length > 1 && !STOP.has(t));
      // Names of single letters ("Y Eau de Parfum") keep the letter, never the stop
      // words around it - nobody types "eau de parfum" - and lean on the brand.
      const short = words.filter((t) => !STOP.has(t));
      const nameTokens = sig.length ? sig : short.length ? short : words;
      const phrase = nameTokens.join(' ');
      const isEveryday = (t: string) => EVERYDAY_WORDS.has(t) || STOP.has(t) || notes.has(t);
      return {
        fr,
        name,
        core: name.replace(CONCENTRATION_SUFFIX, ''),
        brand: normalize(fr.brand),
        full: foldNumbers(normalize(`${fr.brand} ${fr.name}`)),
        nameTokens,
        brandTokens: brandWords(fr.brand),
        phrase,
        everyday: nameTokens.every(isEveryday) || notes.has(phrase),
      };
    });
  }

  get size(): number {
    return this.fragrances.length;
  }

  get(pid: string): Fragrance | undefined {
    return this.byPid.get(pid);
  }

  /**
   * Find fragrances whose name appears in free text, e.g. "something like
   * Aventus but cheaper" -> Creed Aventus. Deterministic: this is the "deck of
   * cards" Jev later picks from - Jev never has to spell a perfume name.
   *
   * Requires every significant token of the fragrance name to appear in the
   * text as a whole word, so "blue" alone will not match "Light Blue".
   *
   * `limit` counts distinct names. Perfumes that share a name and a score
   * (Prada's and YSL's "L'Homme" when neither brand is named) are returned
   * together even past the limit: that is an ambiguity for the caller to
   * resolve, and picking one by catalog order would hide it.
   */
  mentionedIn(text: string, limit = 5): NameMatch[] {
    const hay = haystack(text);
    const aliased = aliasedBrands(hay);
    const found: Array<NameMatch & { name: string; matched: number }> = [];
    for (const e of this.index) {
      if (e.nameTokens.length === 0) continue;
      if (!e.nameTokens.every((t) => hay.includes(` ${t} `))) continue;
      const exact = hay.includes(` ${e.name} `) ? e.name : hay.includes(` ${e.core} `) ? e.core : '';
      const contiguous = exact !== '' || hay.includes(` ${e.phrase} `);
      const brandHit = hay.includes(` ${e.brand} `) || aliased.has(e.brand) || e.brandTokens.some((b) => hay.includes(` ${b} `));
      // Short names ("Y", "N°5", "Le Male") are ordinary words or numbers: require the brand,
      // unless the whole catalog name of three or more words is typed out ("Y Eau de Parfum",
      // as in our own "More like N°5 Eau de Parfum" chip). Length counts significant tokens
      // only, so stop words cannot inflate it.
      const sigChars = e.nameTokens.join('').length;
      const fullNameTyped = exact === e.name && e.name.split(' ').length >= 3;
      if (e.nameTokens.length === 1 && sigChars < 5 && !brandHit && !fullNameTyped) continue;
      // Multi-word names must appear as a phrase unless the brand is named too
      // ("light" and "blue" scattered through a sentence are not Light Blue).
      if (e.nameTokens.length > 1 && !contiguous && !brandHit) continue;
      const score = brandHit ? (exact ? 1 : 0.8) : e.everyday ? (exact ? 0.5 : 0.3) : exact ? 0.8 : 0.6;
      const matched = exact ? exact.length : contiguous ? e.phrase.length : 0;
      found.push({ fragrance: e.fr, score, name: e.name, matched });
    }
    // The longest matched name is the most specific ("Aventus for Her" beats "Aventus");
    // then the name closest to what was typed ("For Her" before "For Her Eau de Parfum");
    // then the better-known perfume, never catalog order.
    found.sort((a, b) => b.score - a.score || b.matched - a.matched || a.name.length - b.name.length
      || (b.fragrance.rating?.votes ?? 0) - (a.fragrance.rating?.votes ?? 0));
    const head = found.slice(0, limit);
    // Same-name perfumes from other houses that tie with a returned one are included so the caller
    // sees the ambiguity - but capped, since every result becomes a Jev question.
    const tied = found.slice(limit).filter((m) => head.some((h) => h.name === m.name && h.score === m.score)).slice(0, MAX_TIED_EXTRA);
    return [...head, ...tied].map(({ fragrance, score }) => ({ fragrance, score }));
  }

  /** Brands mentioned in free text, by full name or a common alias ("YSL", "D&G"). */
  brandsIn(text: string): string[] {
    const hay = haystack(text);
    const aliased = aliasedBrands(hay);
    const seen = new Set<string>();
    for (const e of this.index) {
      if (seen.has(e.fr.brand)) continue;
      if (aliased.has(e.brand) || (e.brandTokens.length && hay.includes(` ${e.brand} `))) seen.add(e.fr.brand);
    }
    return [...seen];
  }

  /** Fuzzy search by name/brand for lookups like "/api/search?q=". */
  search(query: string, limit = 10): NameMatch[] {
    const q = tokens(query);
    if (q.length === 0) return [];
    return this.index
      .map((e) => {
        const hay = e.full.split(' ');
        // An exact token counts fully; a prefix ("black" -> "blackberry") only partly.
        const hit = q.reduce((s, t) => s + (hay.includes(t) ? 1 : t.length > 3 && hay.some((h) => h.startsWith(t)) ? 0.6 : 0), 0);
        return { fragrance: e.fr, score: hit / q.length };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || (b.fragrance.rating?.votes ?? 0) - (a.fragrance.rating?.votes ?? 0))
      .slice(0, limit);
  }
}
