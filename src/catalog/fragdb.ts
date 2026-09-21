/**
 * Parsers for FragDB's pipe-delimited export format (v5.x).
 *
 * Field encodings (verified against the published sample, release v5.16):
 *   brand          "Dolce&Gabbana;b72"                          name;id
 *   perfumers      "Dominique Ropion;p2;Laurent Bruyere;p48"    (name;id)*
 *   gender         gender_for_women | gender_for_men | gender_for_women_and_men
 *   accords        "a24:100;a91:75"                             id:strength(0-100)
 *   notes_pyramid  "top(n2415,1.0,5.0;...)middle(...)base(...)" id,weight,size
 *   rating         "3.86;36764"                                 value;votes
 *   season         "season_winter:1800:10.94;..."               label:votes:pct-of-max
 *   time_of_day    "season_day:15900:94.41;season_night:..."    (note the season_ prefix)
 *   longevity etc. "longevity_moderate:6600:49.0;..."           label:votes:pct
 *   pros_cons      "pros(text,up,down;...)cons(text,up,down;...)"
 */
import type {
  Appreciation, DayTime, Dist, Fragrance, GenderVote, Longevity, PriceTier, PriceValue, Season, Sillage,
} from '../types.js';
import {
  APPRECIATION, DAY_TIMES, GENDER_VOTES, LONGEVITY, PRICE_VALUE, SEASONS, SILLAGE,
} from '../types.js';
import { emptyDist } from './dist.js';

export const FRAGDB_FRAGRANCE_COLUMNS = [
  'pid', 'url', 'brand', 'name', 'year', 'gender', 'collection', 'main_photo', 'info_card', 'user_photoes',
  'video_url', 'accords', 'notes_pyramid', 'perfumers', 'description', 'rating', 'reviews_count',
  'appreciation', 'price_value', 'gender_votes', 'longevity', 'sillage', 'season', 'time_of_day',
  'pros_cons', 'by_designer', 'in_collection', 'reminds_of', 'also_like', 'news_ids',
] as const;

export type RawRow = Record<string, string | undefined>;

export interface RefTables {
  notes: Map<string, { name: string; group?: string }>;
  accords: Map<string, string>;
  brands?: Map<string, { name: string; country?: string }>;
}

export interface ParseStats {
  unresolvedNotes: number;
  unresolvedAccords: number;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Parse a pipe-delimited file with a header row. FragDB fields do not contain
 * raw newlines or pipes, but they may be wrapped in double quotes by some
 * exporters, so strip symmetric quotes and un-double embedded ones.
 */
export function parsePipeCsv(text: string): RawRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines.shift()?.split('|').map((h) => h.trim());
  if (!header) return [];
  return lines.map((line) => {
    const cells = line.split('|');
    const row: RawRow = {};
    header.forEach((h, i) => { row[h] = unquote(cells[i]); });
    return row;
  });
}

function unquote(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"');
  return t;
}

// ---------------------------------------------------------------------------
// Field parsers
// ---------------------------------------------------------------------------

/** "Dolce&Gabbana;b72" -> { name, id } */
export function parseBrand(s: string | undefined): { name: string; id?: string } {
  if (!s) return { name: 'Unknown' };
  const i = s.lastIndexOf(';');
  if (i > 0 && /^b\d+$/.test(s.slice(i + 1))) return { name: s.slice(0, i), id: s.slice(i + 1) };
  return { name: s };
}

/** "A;p2;B;p48" -> ["A", "B"]. Tolerates a trailing truncated id. */
export function parsePerfumers(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(';').map((x) => x.trim()).filter((x) => x && !/^p\d*$/.test(x));
}

export function parseGender(s: string | undefined): Fragrance['gender'] {
  const v = (s ?? '').toLowerCase();
  if (v.includes('women_and_men') || v.includes('unisex')) return 'unisex';
  if (v.endsWith('for_women') || v === 'women' || v === 'female') return 'women';
  if (v.endsWith('for_men') || v === 'men' || v === 'male') return 'men';
  return 'unisex';
}

/** "a24:100;a91:75" -> [{id:"a24", strength:100}, ...] strongest first. */
export function parseAccords(s: string | undefined): { id: string; strength: number }[] {
  if (!s) return [];
  return s.split(';')
    .map((p) => {
      const [id, v] = p.split(':');
      return { id: (id ?? '').trim(), strength: Number(v) };
    })
    .filter((a) => a.id && Number.isFinite(a.strength))
    .sort((a, b) => b.strength - a.strength);
}

/**
 * "top(n1,1.0,5.0;n2,..)middle(..)base(..)" -> { top: [ids], middle, base }.
 * Unknown section names (e.g. a flat "notes(...)" pyramid) fold into middle.
 * Duplicate ids within a record are dropped (the upstream data has some).
 */
export function parsePyramid(s: string | undefined): { top: string[]; middle: string[]; base: string[] } {
  const out = { top: [] as string[], middle: [] as string[], base: [] as string[] };
  if (!s) return out;
  const seen = new Set<string>();
  for (const m of s.matchAll(/([a-z_]+)\(([^)]*)\)/gi)) {
    const section = (m[1] ?? '').toLowerCase();
    const bucket = section === 'top' ? out.top : section === 'base' ? out.base : out.middle;
    for (const entry of (m[2] ?? '').split(';')) {
      const id = entry.split(',')[0]?.trim();
      if (id && !seen.has(id)) { seen.add(id); bucket.push(id); }
    }
  }
  return out;
}

/** "3.86;36764" -> { value, votes } */
export function parseRating(s: string | undefined): Fragrance['rating'] {
  if (!s) return undefined;
  const [v, n] = s.split(';');
  const value = Number(v);
  const votes = Number(n);
  return Number.isFinite(value) && value > 0 ? { value, votes: Number.isFinite(votes) ? votes : 0 } : undefined;
}

/**
 * Parse "prefix_label:votes:pct;..." into a Dist of vote counts over `keys`.
 * `prefixes` are stripped from labels before matching (time_of_day uses
 * "season_day", appreciation uses "like_love", etc.).
 */
export function parseDist<K extends string>(s: string | undefined, keys: readonly K[], prefixes: string[]): Dist<K> {
  const d = emptyDist(keys);
  if (!s) return d;
  for (const part of s.split(';')) {
    const [rawLabel, votes, pct] = part.split(':');
    if (!rawLabel) continue;
    let label = rawLabel.trim();
    for (const p of prefixes) if (label.startsWith(p)) { label = label.slice(p.length); break; }
    if (!(keys as readonly string[]).includes(label)) continue;
    let n = Number(votes);
    // Some exports carry only the percentage; use it as a pseudo-count.
    if (!Number.isFinite(n) || n <= 0) n = Number(pct);
    if (Number.isFinite(n) && n > 0) d[label as K] = n;
  }
  return d;
}

/**
 * "728:4600:1000;44034:1100:111" -> perfumes this one reminds voters of, with the
 * yes/no votes behind each link, strongest agreement first. Malformed parts are skipped.
 */
export function parseRemindsOf(s: string | undefined): Array<{ pid: string; yes: number; no: number }> {
  if (!s) return [];
  return s.split(';').flatMap((part) => {
    const [pid, yes, no] = part.split(':').map((x) => x.trim());
    const y = Number(yes);
    const n = Number(no ?? 0);
    return pid && /^[A-Za-z0-9_-]+$/.test(pid) && Number.isFinite(y) && y > 0 ? [{ pid, yes: y, no: Number.isFinite(n) ? n : 0 }] : [];
  }).sort((a, b) => b.yes - b.no - (a.yes - a.no));
}

/** "pros(text,up,down;..)cons(..)" -> { pros, cons } ordered by net votes. */
export function parseProsCons(s: string | undefined): { pros: string[]; cons: string[] } {
  if (!s) return { pros: [], cons: [] };
  const ci = s.lastIndexOf(')cons(');
  const prosBody = s.startsWith('pros(') ? s.slice(5, ci >= 0 ? ci : s.lastIndexOf(')')) : '';
  const consBody = ci >= 0 ? s.slice(ci + 6, s.endsWith(')') ? -1 : undefined) : s.startsWith('cons(') ? s.slice(5, -1) : '';
  return { pros: parseVotedList(prosBody), cons: parseVotedList(consBody) };
}

function parseVotedList(body: string): string[] {
  if (!body) return [];
  return body.split(';')
    .map((entry) => {
      // The text itself may contain commas; the last two fields are the vote counts.
      const parts = entry.split(',');
      const down = Number(parts.pop());
      const up = Number(parts.pop());
      return { text: parts.join(',').trim(), net: (up || 0) - (down || 0) };
    })
    .filter((x) => x.text && x.net > 0)
    .sort((a, b) => b.net - a.net)
    .map((x) => x.text);
}

// ---------------------------------------------------------------------------
// Row -> Fragrance
// ---------------------------------------------------------------------------

/** Houses whose pricing sits clearly above designer mainstream. Used only when no sidecar tier exists. */
const NICHE_HOUSES = new Set([
  'creed', 'maison francis kurkdjian', 'le labo', 'byredo', 'diptyque', 'frederic malle', 'editions de parfums frederic malle',
  'amouage', 'xerjoff', 'parfums de marly', 'initio parfums prives', 'kilian', 'by kilian', 'roja dove', 'roja parfums',
  'serge lutens', 'nishane', 'tiziana terenzi', 'maison margiela', 'memo paris', 'penhaligon\'s', 'clive christian',
  'mancera', 'montale', 'juliette has a gun', 'escentric molecules', 'kayali', 'bdk parfums', 'ex nihilo',
  'louis vuitton', 'hermes', 'hermès', 'guerlain', 'chanel', 'dior', 'tom ford', 'jo malone london', 'acqua di parma',
]);
const BUDGET_HOUSES = new Set([
  'zara', 'avon', 'nautica', 'adidas', 'playboy', 'bath & body works', 'victoria\'s secret', 'lattafa perfumes',
  'armaf', 'rasasi', 'al haramain perfumes', 'davidoff', 'antonio banderas',
]);

export function inferPriceTier(brand: string): PriceTier {
  const b = brand.toLowerCase().trim();
  if (BUDGET_HOUSES.has(b)) return 'budget';
  if (NICHE_HOUSES.has(b)) {
    return /^(chanel|dior|guerlain|hermes|hermès|tom ford|louis vuitton|jo malone london|acqua di parma)$/.test(b) ? 'luxury' : 'niche';
  }
  return 'mid';
}

export interface Extension {
  priceTier?: PriceTier;
  tags: string[];
}

export function rowToFragrance(row: RawRow, refs: RefTables, ext?: Extension, stats?: ParseStats): Fragrance | null {
  const pid = row.pid?.trim();
  const name = row.name?.trim();
  if (!pid || !name) return null;

  const brandParsed = parseBrand(row.brand);
  const brand = (brandParsed.id && refs.brands?.get(brandParsed.id)?.name) || brandParsed.name;

  const accords = parseAccords(row.accords).flatMap((a) => {
    const n = refs.accords.get(a.id);
    if (!n) { if (stats) stats.unresolvedAccords++; return []; }
    return [{ name: n, strength: a.strength }];
  });

  const ids = parsePyramid(row.notes_pyramid);
  const resolve = (list: string[]) => list.flatMap((id) => {
    const n = refs.notes.get(id);
    if (!n) { if (stats) stats.unresolvedNotes++; return []; }
    return [n.name];
  });

  const { pros, cons } = parseProsCons(row.pros_cons);
  const remindsOf = parseRemindsOf(row.reminds_of);
  const year = Number(row.year);
  const reviews = row.reviews_count?.trim() ? Number(row.reviews_count) : NaN;

  return {
    pid,
    name,
    brand,
    year: Number.isInteger(year) && year > 1700 ? year : undefined,
    gender: parseGender(row.gender),
    url: row.url || undefined,
    photo: row.main_photo || undefined,
    description: stripHtml(row.description),
    perfumers: parsePerfumers(row.perfumers),
    accords,
    notes: { top: resolve(ids.top), middle: resolve(ids.middle), base: resolve(ids.base) },
    rating: parseRating(row.rating),
    reviewsCount: Number.isFinite(reviews) ? reviews : undefined,
    season: parseDist<Season>(row.season, SEASONS, ['season_']),
    timeOfDay: parseDist<DayTime>(row.time_of_day, DAY_TIMES, ['season_', 'time_']),
    genderVotes: parseDist<GenderVote>(row.gender_votes, GENDER_VOTES, ['gvotes_']),
    longevity: parseDist<Longevity>(row.longevity, LONGEVITY, ['longevity_']),
    sillage: parseDist<Sillage>(row.sillage, SILLAGE, ['sillage_']),
    priceValue: parseDist<PriceValue>(row.price_value, PRICE_VALUE, ['price_']),
    appreciation: parseDist<Appreciation>(row.appreciation, APPRECIATION, ['like_']),
    pros,
    cons,
    priceTier: ext?.priceTier ?? inferPriceTier(brand),
    tags: ext?.tags ?? [],
    ...(remindsOf.length ? { remindsOf } : {}),
  };
}

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return t || undefined;
}

// ---------------------------------------------------------------------------
// Reference tables
// ---------------------------------------------------------------------------

export function buildRefTables(notes: RawRow[], accords: RawRow[], brands: RawRow[] = []): RefTables {
  return {
    notes: new Map(notes.filter((r) => r.id && r.name).map((r) => [r.id!, { name: r.name!, group: r.group || undefined }])),
    accords: new Map(accords.filter((r) => r.id && r.name).map((r) => [r.id!, r.name!])),
    brands: new Map(brands.filter((r) => r.id && r.name).map((r) => [r.id!, { name: r.name!, country: r.country || undefined }])),
  };
}
