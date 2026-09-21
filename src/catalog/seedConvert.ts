/**
 * Seed converter: turns the curated records in data/seed-src/*.json into genuine
 * FragDB-format pipe-delimited files in data/catalog/.
 *
 * Why go through FragDB's wire format instead of loading the JSON directly: the
 * seed catalog then runs through exactly the same parsers (fragdb.ts) as a
 * licensed FragDB export, so switching CATALOG_SOURCE=seed -> csv changes the
 * data, not the code path - and every seed file doubles as a parser test.
 *
 *   npx tsx src/catalog/seedConvert.ts [srcDir=data/seed-src] [outDir=data/catalog]
 *
 * Output: fragrances.csv (all 30 FragDB columns), notes.csv, accords.csv,
 * brands.csv, and extensions.csv (price tier + tags, which FragDB does not carry).
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Appreciation, DayTime, Dist, GenderVote, Longevity, PriceTier, PriceValue, Season, Sillage,
} from '../types.js';
import {
  APPRECIATION, DAY_TIMES, GENDER_VOTES, LONGEVITY, PRICE_TIERS, PRICE_VALUE, SEASONS, SILLAGE,
} from '../types.js';
import { normalize } from './catalog.js';
import { ACCORD_VOCAB } from './families.js';
import { FRAGDB_FRAGRANCE_COLUMNS } from './fragdb.js';

export interface SeedRecord {
  name: string;
  brand: string;
  brand_country: string;
  year: number;
  gender: 'women' | 'men' | 'unisex';
  perfumers: string[];
  accords: { name: string; strength: number }[];
  notes: { top: string[]; middle: string[]; base: string[] };
  description: string;
  rating: number;
  rating_votes: number;
  season_votes: Dist<Season>;
  time_votes: Dist<DayTime>;
  gender_votes: Dist<GenderVote>;
  longevity_votes: Dist<Longevity>;
  sillage_votes: Dist<Sillage>;
  price_value_votes: Dist<PriceValue>;
  appreciation_votes: Dist<Appreciation>;
  pros: string[];
  cons: string[];
  price_tier: PriceTier;
  tags: string[];
  /**
   * Curated "widely seen as an alternative to" links, by brand and name. Only links that
   * fragrance communities cite constantly (a budget clone of a niche original) belong here.
   */
  reminds_of?: Array<{ brand: string; name: string }>;
}

/** Vote counts written for a curated reminds_of link: the seed has no real votes, so a fixed strong majority. */
const CURATED_LINK_VOTES = { yes: 1000, no: 100 };

export interface SeedReport {
  recordsIn: number;
  invalidSkipped: number;
  duplicatesMerged: number;
  recordsWritten: number;
  notes: number;
  accords: number;
  brands: number;
  perfumers: number;
}

export interface SeedConversion {
  /** File name -> file contents, ready to write into data/catalog/. */
  files: Record<string, string>;
  report: SeedReport;
}

export interface ConvertOptions {
  /** Defaults to console.log - skips and merges must never be silent. */
  log?: (msg: string) => void;
  /** Per-record provenance for log lines (e.g. "women.json#3"); defaults to "#<n>". */
  origins?: readonly string[];
}

/** First seed pid - well above current FragDB/Fragrantica pids, so seed and real records never collide. */
export const SEED_PID_START = 900001;

const GENDER_CODE: Record<SeedRecord['gender'], string> = {
  women: 'gender_for_women',
  men: 'gender_for_men',
  unisex: 'gender_for_women_and_men',
};

/**
 * Seed vote field -> FragDB column. Season and time-of-day are multi-select on
 * Fragrantica, so FragDB expresses them relative to the leading bucket; the
 * single-choice polls use share of total.
 */
const VOTE_FIELDS = [
  { field: 'season_votes', column: 'season', keys: SEASONS, prefix: 'season_', pct: 'max' },
  { field: 'time_votes', column: 'time_of_day', keys: DAY_TIMES, prefix: 'season_', pct: 'max' },
  { field: 'gender_votes', column: 'gender_votes', keys: GENDER_VOTES, prefix: 'gvotes_', pct: 'share' },
  { field: 'longevity_votes', column: 'longevity', keys: LONGEVITY, prefix: 'longevity_', pct: 'share' },
  { field: 'sillage_votes', column: 'sillage', keys: SILLAGE, prefix: 'sillage_', pct: 'share' },
  { field: 'price_value_votes', column: 'price_value', keys: PRICE_VALUE, prefix: 'price_', pct: 'share' },
  { field: 'appreciation_votes', column: 'appreciation', keys: APPRECIATION, prefix: 'like_', pct: 'share' },
] as const;

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Validate, de-duplicate and encode seed records. Pure apart from logging: the
 * CLI below does the file I/O, so tests can round-trip without touching data/.
 */
const CONCENTRATION_SUFFIX = / (eau de parfum|eau de toilette|edp|edt)$/;

/** brand | name without a leading brand prefix or a trailing EDP/EDT | year. */
export function variantKeyOf(r: Pick<SeedRecord, 'brand' | 'name' | 'year'>): string {
  const brand = normalize(r.brand);
  let name = normalize(r.name);
  if (name.startsWith(`${brand} `)) name = name.slice(brand.length + 1);
  name = name.replace(CONCENTRATION_SUFFIX, '');
  return `${brand}|${name}|${r.year}`;
}

function brandPrefixed(name: string, brand: string): number {
  return normalize(name).startsWith(`${normalize(brand)} `) ? 1 : 0;
}

export function convertSeed(records: readonly unknown[], opts: ConvertOptions = {}): SeedConversion {
  const log = opts.log ?? console.log;
  const origin = (i: number) => opts.origins?.[i] ?? `#${i + 1}`;
  let invalidSkipped = 0;
  let duplicatesMerged = 0;

  const byKey = new Map<string, { record: SeedRecord; origin: string }>();
  // Second-tier key catching naming variants of one product ("Prada L'Homme" vs "L'Homme",
  // "L'Interdit Eau de Parfum" vs "L'Interdit"). Year is part of it so genuinely different
  // releases that share a stem (For Her 2003 vs For Her EDP 2006) stay separate.
  const variants = new Map<string, string>();
  records.forEach((raw, i) => {
    const check = validateSeedRecord(raw);
    if (!check.ok) {
      invalidSkipped++;
      log(`skip ${origin(i)}${describeRaw(raw)}: ${check.errors.join('; ')}`);
      return;
    }
    const exactKey = `${normalize(check.record.brand)}|${normalize(check.record.name)}`;
    const variantKey = variantKeyOf(check.record);
    const key = byKey.has(exactKey) ? exactKey : (variants.get(variantKey) ?? exactKey);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { record: check.record, origin: origin(i) });
      variants.set(variantKey, key);
      return;
    }
    // Segments overlap (a classic can be both "office" and "over-50"): keep the richer pyramid, union the tags.
    duplicatesMerged++;
    const keepNew = noteCount(check.record) > noteCount(prev.record);
    const kept = keepNew ? { record: check.record, origin: origin(i) } : prev;
    const tags = [...new Set([...prev.record.tags, ...check.record.tags])];
    const links = [...(prev.record.reminds_of ?? []), ...(check.record.reminds_of ?? [])]
      .filter((l, j, xs) => xs.findIndex((x) => normalize(x.brand) === normalize(l.brand) && normalize(x.name) === normalize(l.name)) === j);
    // Prefer the official product name over a brand-prefixed variant.
    const name = [prev.record.name, check.record.name].sort((a, b) => brandPrefixed(a, kept.record.brand) - brandPrefixed(b, kept.record.brand) || a.length - b.length)[0]!;
    byKey.set(key, { origin: kept.origin, record: { ...kept.record, name, tags, ...(links.length ? { reminds_of: links } : {}) } });
    const how = key === exactKey ? 'duplicate' : 'naming variant';
    log(`${how} "${check.record.brand} - ${check.record.name}" in ${origin(i)} and "${prev.record.name}" in ${prev.origin}: `
      + `kept ${kept.origin} (${noteCount(kept.record)} notes) as "${name}", tags unioned`);
  });

  const sorted = [...byKey.values()].map((e) => e.record).sort(compareBrandName);
  const { files, counts } = encodeCatalog(sorted);
  return {
    files,
    report: { recordsIn: records.length, invalidSkipped, duplicatesMerged, recordsWritten: sorted.length, ...counts },
  };
}

/** Stable pid order: by normalized brand, then name. Plain code-unit compare so it is locale-independent. */
function compareBrandName(a: SeedRecord, b: SeedRecord): number {
  const ka = [normalize(a.brand), normalize(a.name)];
  const kb = [normalize(b.brand), normalize(b.name)];
  for (let i = 0; i < 2; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
  return 0;
}

/** Hands out FragDB-style ids ("n1", "n2", ...) in first-seen order, keyed by a canonical form. */
class IdPool<T> {
  readonly entries = new Map<string, { id: string; value: T }>();

  constructor(private readonly prefix: string) {}

  get(key: string, value: T): { id: string; value: T } {
    let e = this.entries.get(key);
    if (!e) {
      e = { id: `${this.prefix}${this.entries.size + 1}`, value };
      this.entries.set(key, e);
    }
    return e;
  }
}

function encodeCatalog(records: SeedRecord[]): { files: Record<string, string>; counts: Pick<SeedReport, 'notes' | 'accords' | 'brands' | 'perfumers'> } {
  const notes = new IdPool<string>('n');
  const accords = new IdPool<string>('a');
  const brands = new IdPool<{ name: string; country: string }>('b');
  const perfumers = new IdPool<string>('p');
  const fragranceRows: string[] = [];
  const extensionRows: string[] = [];
  const pidOf = new Map(records.map((r, i) => [`${normalize(r.brand)}|${normalize(r.name)}`, String(SEED_PID_START + i)]));

  records.forEach((r, i) => {
    const pid = String(SEED_PID_START + i);
    const brand = brands.get(normalize(r.brand), { name: r.brand, country: r.brand_country });
    if (!brand.value.country) brand.value.country = r.brand_country;

    // FragDB lists accords strongest first; a stable sort keeps the seed order for ties.
    const accordList = [...r.accords].sort((a, b) => b.strength - a.strength)
      .map((a) => `${accords.get(a.name, a.name).id}:${a.strength}`);
    const tierIds = (tier: string[]) => tier.map((n) => notes.get(n, n).id);
    const perfumerList = r.perfumers.map((p) => {
      const e = perfumers.get(normalize(p), p);
      return `${e.value};${e.id}`;
    });
    const votesBase = Math.max(20, Math.round(r.rating_votes * 0.02));

    const row: Record<string, string> = {
      pid,
      brand: `${brand.value.name};${brand.id}`,
      name: r.name,
      year: String(r.year),
      gender: GENDER_CODE[r.gender],
      accords: accordList.join(';'),
      notes_pyramid: encodePyramid({ top: tierIds(r.notes.top), middle: tierIds(r.notes.middle), base: tierIds(r.notes.base) }),
      perfumers: perfumerList.join(';'),
      description: r.description ? `<p>${r.description.replace(/[<>]/g, '').replace(/&/g, '&amp;')}</p>` : '',
      rating: `${round(r.rating, 2)};${r.rating_votes}`,
      reviews_count: String(Math.round(r.rating_votes * 0.07)),
      pros_cons: encodeProsCons(rankVotes(r.pros, votesBase), rankVotes(r.cons, Math.round(votesBase / 2))),
      reminds_of: (r.reminds_of ?? []).flatMap((l) => {
        const target = pidOf.get(`${normalize(l.brand)}|${normalize(l.name)}`);
        if (!target) throw new Error(`${r.brand} ${r.name}: reminds_of "${l.brand} ${l.name}" is not in the seed catalog`);
        return [`${target}:${CURATED_LINK_VOTES.yes}:${CURATED_LINK_VOTES.no}`];
      }).join(';'),
    };
    for (const v of VOTE_FIELDS) row[v.column] = encodeDist(v.prefix, v.keys, r[v.field], v.pct);

    fragranceRows.push(FRAGDB_FRAGRANCE_COLUMNS.map((c) => cell(row[c] ?? '')).join('|'));
    extensionRows.push([pid, r.price_tier, r.tags.join(';')].join('|'));
  });

  const table = (header: string, rows: string[]) => `${[header, ...rows].join('\n')}\n`;
  const values = <T>(pool: IdPool<T>) => [...pool.entries.values()];
  return {
    files: {
      'fragrances.csv': table(FRAGDB_FRAGRANCE_COLUMNS.join('|'), fragranceRows),
      // Seed notes carry no FragDB note group; leave it empty rather than invent one.
      'notes.csv': table('id|name|group', values(notes).map((e) => `${e.id}|${cell(e.value)}|`)),
      'accords.csv': table('id|name', values(accords).map((e) => `${e.id}|${cell(e.value)}`)),
      'brands.csv': table('id|name|country', values(brands).map((e) => `${e.id}|${cell(e.value.name)}|${cell(e.value.country)}`)),
      'extensions.csv': table('pid|price_tier|tags', extensionRows),
    },
    counts: { notes: notes.entries.size, accords: accords.entries.size, brands: brands.entries.size, perfumers: perfumers.entries.size },
  };
}

// ---------------------------------------------------------------------------
// FragDB field encoders (also used by fragdbApi.ts for structured API records)
// ---------------------------------------------------------------------------

export interface VotedText {
  text: string;
  up: number;
  down: number;
}

/** "top(n1,1.0,5.0;n2,0.95,4.75)middle(...)base(...)" - weight falls 0.05 per position (min 0.5), size = weight*5. */
export function encodePyramid(tiers: { top: string[]; middle: string[]; base: string[] }): string {
  return (['top', 'middle', 'base'] as const)
    .filter((t) => tiers[t].length > 0)
    .map((t) => {
      const entries = tiers[t].map((id, i) => {
        const weight = round(Math.max(0.5, 1 - 0.05 * i), 2);
        return `${id},${pyFloat(weight)},${pyFloat(round(weight * 5, 2))}`;
      });
      return `${t}(${entries.join(';')})`;
    })
    .join('');
}

/**
 * "prefix_key:votes:pct;..." over `keys` in FragDB's bucket order.
 * pct 'max' = relative to the leading bucket (2 dp), 'share' = share of total (1 dp).
 */
export function encodeDist(prefix: string, keys: readonly string[], votes: Record<string, number>, pct: 'max' | 'share'): string {
  const counts = keys.map((k) => votes[k] ?? 0);
  const denom = pct === 'max' ? Math.max(0, ...counts) : counts.reduce((s, v) => s + v, 0);
  return keys.map((k, i) => {
    const p = denom > 0 ? (counts[i]! / denom) * 100 : 0;
    return `${prefix}${k}:${counts[i]}:${pyFloat(round(p, pct === 'max' ? 2 : 1))}`;
  }).join(';');
}

/** "pros(text,up,down;...)cons(...)". Empty when both lists are empty. */
export function encodeProsCons(pros: VotedText[], cons: VotedText[]): string {
  if (pros.length === 0 && cons.length === 0) return '';
  const list = (items: VotedText[]) => items.map((x) => `${voteText(x.text)},${x.up},${x.down}`).join(';');
  return `pros(${list(pros)})cons(${list(cons)})`;
}

/**
 * Synthesize up/down votes for an ordered list. parseProsCons ranks by net
 * votes, so net must strictly decrease with position (and stay > 0) for the
 * curated order to survive the round trip.
 */
export function rankVotes(texts: string[], base: number): VotedText[] {
  const b = Math.max(2, Math.round(base));
  const step = Math.max(1, Math.round(b * 0.1));
  const down = Math.max(1, Math.round(b * 0.05));
  return texts.map((text, i) => ({ text, up: b + (texts.length - 1 - i) * step, down }));
}

/** Pros/cons text sits inside "(...;...)" with trailing ",up,down" - a ';' would split the item. */
function voteText(s: string): string {
  return clean(s).replace(/;/g, ',');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
export type SeedCheck = { ok: true; record: SeedRecord } | { ok: false; errors: string[] };

const ACCORDS = new Set<string>(ACCORD_VOCAB);
const GENDERS = ['women', 'men', 'unisex'] as const;

/**
 * Strict validation. Returns every problem at once so a bad record needs one
 * fix, not five reruns. On success the record is canonicalised: text cleaned of
 * pipes/newlines, accord names lowercased, note names Title Cased and de-duplicated
 * across tiers (FragDB's pyramid parser keeps only the first occurrence anyway).
 */
export function validateSeedRecord(raw: unknown): SeedCheck {
  if (!isObj(raw)) return { ok: false, errors: ['record is not an object'] };
  const errors: string[] = [];

  const text = (key: string, required: boolean): string => {
    const v = raw[key];
    if (typeof v !== 'string' || (required && !clean(v))) {
      errors.push(`${key} must be a ${required ? 'non-empty ' : ''}string (got ${show(v)})`);
      return '';
    }
    return clean(v);
  };
  const texts = (key: string, v: unknown = raw[key]): string[] => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !clean(x))) {
      errors.push(`${key} must be an array of non-empty strings`);
      return [];
    }
    return v.map((x: string) => clean(x));
  };
  const count = (key: string, v: unknown): number => {
    if (!Number.isInteger(v) || (v as number) < 0) errors.push(`${key} must be a non-negative integer (got ${show(v)})`);
    return v as number;
  };

  const name = text('name', true);
  const brand = text('brand', true);
  const brandCountry = text('brand_country', false);
  const description = text('description', false);

  const year = raw.year;
  if (!Number.isInteger(year) || (year as number) < 1880 || (year as number) > 2026) {
    errors.push(`year must be an integer 1880-2026 (got ${show(year)})`);
  }
  const gender = raw.gender;
  if (!GENDERS.includes(gender as SeedRecord['gender'])) errors.push(`gender must be one of ${GENDERS.join('|')} (got ${show(gender)})`);
  const rating = raw.rating;
  if (typeof rating !== 'number' || !(rating >= 1 && rating <= 5)) errors.push(`rating must be a number 1-5 (got ${show(rating)})`);
  const ratingVotes = count('rating_votes', raw.rating_votes);
  const priceTier = raw.price_tier;
  if (!PRICE_TIERS.includes(priceTier as PriceTier)) errors.push(`price_tier must be one of ${PRICE_TIERS.join('|')} (got ${show(priceTier)})`);

  // FragDB separates perfumers (and their ids) with ';', so a ';' inside a name would split it.
  const perfumers = dedupe(texts('perfumers').map((p) => p.replace(/;/g, ',')), normalize);
  const pros = texts('pros');
  const cons = texts('cons');
  const tags = dedupe(texts('tags').map((t) => t.replace(/;/g, ',')), (t) => t);
  const remindsOf: Array<{ brand: string; name: string }> = [];
  if (raw.reminds_of !== undefined) {
    if (!Array.isArray(raw.reminds_of)) errors.push('reminds_of must be a list of { brand, name }');
    else {
      for (const l of raw.reminds_of as unknown[]) {
        if (isObj(l) && typeof l.brand === 'string' && clean(l.brand) && typeof l.name === 'string' && clean(l.name)) {
          remindsOf.push({ brand: clean(l.brand), name: clean(l.name) });
        } else errors.push(`reminds_of entry ${show(l)} needs a brand and a name`);
      }
    }
  }

  const accords: SeedRecord['accords'] = [];
  if (!Array.isArray(raw.accords)) errors.push('accords must be an array of {name, strength}');
  else {
    for (const a of raw.accords as unknown[]) {
      const accordName = isObj(a) && typeof a.name === 'string' ? a.name.trim().toLowerCase() : undefined;
      const strength = isObj(a) ? a.strength : undefined;
      if (!accordName || !ACCORDS.has(accordName)) errors.push(`accord ${show(isObj(a) ? a.name : a)} is not in ACCORD_VOCAB`);
      else if (typeof strength !== 'number' || !(strength > 0 && strength <= 100)) {
        errors.push(`accord "${accordName}" strength must be a number in (0, 100] (got ${show(strength)})`);
      } else if (!accords.some((x) => x.name === accordName)) accords.push({ name: accordName, strength });
    }
  }

  const notes: SeedRecord['notes'] = { top: [], middle: [], base: [] };
  if (!isObj(raw.notes)) errors.push('notes must be an object {top, middle, base}');
  else {
    const seen = new Set<string>();
    for (const tier of ['top', 'middle', 'base'] as const) {
      for (const n of texts(`notes.${tier}`, raw.notes[tier]).map(canonicalNote)) {
        if (!seen.has(n)) { seen.add(n); notes[tier].push(n); }
      }
    }
    if (seen.size === 0) errors.push('notes must contain at least one note');
  }

  const votes: Partial<Record<(typeof VOTE_FIELDS)[number]['field'], Record<string, number>>> = {};
  for (const v of VOTE_FIELDS) {
    const obj = raw[v.field];
    if (!isObj(obj)) { errors.push(`${v.field} must be an object with keys ${v.keys.join(', ')}`); continue; }
    const missing = v.keys.filter((k) => !(k in obj));
    if (missing.length) errors.push(`${v.field} is missing ${missing.join(', ')}`);
    else votes[v.field] = Object.fromEntries(v.keys.map((k) => [k, count(`${v.field}.${k}`, obj[k])]));
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    record: {
      name, brand, brand_country: brandCountry, year: year as number, gender: gender as SeedRecord['gender'],
      perfumers, accords, notes, description, rating: rating as number, rating_votes: ratingVotes,
      season_votes: votes.season_votes as Dist<Season>,
      time_votes: votes.time_votes as Dist<DayTime>,
      gender_votes: votes.gender_votes as Dist<GenderVote>,
      longevity_votes: votes.longevity_votes as Dist<Longevity>,
      sillage_votes: votes.sillage_votes as Dist<Sillage>,
      price_value_votes: votes.price_value_votes as Dist<PriceValue>,
      appreciation_votes: votes.appreciation_votes as Dist<Appreciation>,
      pros, cons, price_tier: priceTier as PriceTier, tags,
      ...(remindsOf.length ? { reminds_of: remindsOf } : {}),
    },
  };
}

const MINOR_WORDS = new Set(['of', 'the', 'and', 'de', 'du', 'des', 'la', 'le', 'en']);

/**
 * "pink pepper" / "Pink  Pepper" -> "Pink Pepper"; "lily-of-the-valley" -> "Lily-of-the-Valley".
 * One spelling per note means one note id, so family matching sees one note, not two.
 */
export function canonicalNote(name: string): string {
  return clean(name).toLowerCase().split(' ')
    .map((word, i) => word.split('-')
      .map((part, j) => (i + j > 0 && MINOR_WORDS.has(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('-'))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Pipes and newlines would break the row/field structure of a pipe-delimited file. */
function clean(s: string): string {
  return s.replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** parsePipeCsv strips one pair of wrapping quotes, so a value that itself starts and ends with '"' must be quoted. */
function cell(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? `"${v.replace(/"/g, '""')}"` : v;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** FragDB writes floats the way Python prints them: "100.0", "54.6", "10.94". */
function pyFloat(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

function noteCount(r: SeedRecord): number {
  return r.notes.top.length + r.notes.middle.length + r.notes.base.length;
}

function dedupe(items: string[], key: (s: string) => string): string[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? 'nothing' : s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

function describeRaw(raw: unknown): string {
  if (!isObj(raw)) return '';
  const brand = typeof raw.brand === 'string' ? raw.brand : '?';
  const name = typeof raw.name === 'string' ? raw.name : '?';
  return ` "${brand} - ${name}"`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Read every segment file, convert, write data/catalog/. Returns the process exit code. */
async function main(argv: string[]): Promise<number> {
  const srcDir = resolve(argv[0] ?? 'data/seed-src');
  const outDir = resolve(argv[1] ?? 'data/catalog');

  let names: string[];
  try {
    names = (await readdir(srcDir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    console.error(`seed source directory not found: ${srcDir}`);
    return 1;
  }
  if (names.length === 0) {
    console.error(`no *.json seed files in ${srcDir}`);
    return 1;
  }

  const records: unknown[] = [];
  const origins: string[] = [];
  let filesRead = 0;
  for (const file of names) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(srcDir, file), 'utf8'));
    } catch (err) {
      console.log(`skip file ${file}: not valid JSON (${(err as Error).message})`);
      continue;
    }
    // Tolerate a bare array; the agreed shape is {"segment": string, "fragrances": [...]}.
    const list = Array.isArray(parsed) ? parsed : isObj(parsed) && Array.isArray(parsed.fragrances) ? parsed.fragrances : undefined;
    if (!list) {
      console.log(`skip file ${file}: expected {"segment": string, "fragrances": [...]}`);
      continue;
    }
    const segment = isObj(parsed) && typeof parsed.segment === 'string' ? parsed.segment : file;
    filesRead++;
    list.forEach((r: unknown, i: number) => {
      records.push(r);
      origins.push(`${file}#${i + 1} [${segment}]`);
    });
  }

  const { files, report } = convertSeed(records, { log: console.log, origins });
  if (report.recordsWritten === 0) {
    console.error('no valid seed records - nothing written');
    return 1;
  }
  await mkdir(outDir, { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(join(outDir, file), text);

  console.log([
    '',
    `seed conversion -> ${outDir}`,
    `  files read        ${filesRead} of ${names.length}`,
    `  records in        ${report.recordsIn}`,
    `  duplicates merged ${report.duplicatesMerged}`,
    `  invalid skipped   ${report.invalidSkipped}`,
    `  records written   ${report.recordsWritten}`,
    `  distinct notes ${report.notes}, accords ${report.accords}, brands ${report.brands}, perfumers ${report.perfumers}`,
  ].join('\n'));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => { console.error(err); process.exitCode = 1; },
  );
}
