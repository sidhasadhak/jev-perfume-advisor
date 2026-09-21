/**
 * FragDB Data API client (https://fragdb.net/api) and the CATALOG_SOURCE=api loader.
 *
 * ============================================================================
 *  NOT YET EXERCISED AGAINST A LIVE KEY. This file is written against FragDB's
 *  public API documentation and tested only with a mocked fetch. The docs do
 *  not publish the JSON shape of index records, so recordToRow() accepts both
 *  FragDB pipe-encoded strings and plausible structured shapes, and drops
 *  anything else with a logged reason. If a real index produces "unrecognised
 *  shape" drops, recordToRow() is the one place to adjust.
 * ============================================================================
 *
 * Documented facts relied on:
 *   auth     Authorization: Bearer fk_...
 *   GET  /v1/index              gzipped JSONL, one record per line - max 5 downloads/day
 *   GET  /v1/fragrances/{id}    POST /v1/fragrances/batch (max 100 ids)
 *   GET  /v1/notes/{id}   /v1/brands/{id}   /v1/perfumers/{id}   /v1/account
 *   limits   10 req/s and 300 req/min per key
 *
 * Assumptions (not in the docs): the batch body is {"ids": [...]}; a note lookup
 * answers with an object carrying `name` (possibly under `data`); a note id may
 * be wanted with or without its "n" prefix, so both are tried. There is no
 * documented accord endpoint - accord names come from accords.csv in the cache
 * dir or from names carried inside the records.
 */
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { constants as zlibConstants, createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import type { Catalog } from './catalog.js';
import {
  buildRefTables, parseAccords, parsePipeCsv, parsePyramid, type RawRow, type RefTables,
} from './fragdb.js';
import { assembleCatalog, defaultLog, DropTally, readExtensions, type Log } from './loader.js';
import { encodeProsCons, encodePyramid, rankVotes, type VotedText } from './seedConvert.js';

export const DEFAULT_API_BASE = 'https://fragdb.net/api';
export const DEFAULT_CACHE_DIR = './data/fragdb/cache';

/** Below FragDB's 10 req/s and 300 req/min, leaving headroom for anything else using the same key. */
const REQUESTS_PER_SECOND = 8;
const REQUESTS_PER_MINUTE = 280;
const BATCH_MAX = 100;
/** A 429 asking for a longer wait than this (e.g. the daily index quota) is reported, not slept through. */
const MAX_RETRY_WAIT_MS = 10_000;
const MAX_ATTEMPTS = 3;
/** Parallel note lookups; the rate limiter, not this, sets the pace. */
const NOTE_WORKERS = 4;

export class FragDbError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FragDbError';
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Spaces request starts so both FragDB limits hold: a minimum gap, and a cap per sliding minute. */
export class RateLimiter {
  private chain: Promise<void> = Promise.resolve();
  private readonly starts: number[] = [];

  constructor(private readonly perSecond: number, private readonly perMinute: number) {}

  acquire(): Promise<void> {
    const turn = this.chain.then(() => this.waitForSlot());
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  private async waitForSlot(): Promise<void> {
    const last = this.starts.at(-1);
    let wait = last === undefined ? 0 : last + 1000 / this.perSecond - Date.now();
    if (this.starts.length >= this.perMinute) wait = Math.max(wait, this.starts[0]! + 60_000 - Date.now());
    if (wait > 0) await delay(wait);
    this.starts.push(Date.now());
    if (this.starts.length > this.perMinute) this.starts.shift();
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface FragDbApiOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Request starts per second; keep it under FragDB's 10. */
  requestsPerSecond?: number;
}

export class FragDbApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;

  constructor(private readonly opts: FragDbApiOptions) {
    if (!opts.apiKey) throw new FragDbError('FragDB API key is empty - set FRAGDB_API_KEY (it starts with fk_).');
    this.base = (opts.baseUrl || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = new RateLimiter(opts.requestsPerSecond ?? REQUESTS_PER_SECOND, REQUESTS_PER_MINUTE);
  }

  /** The full index as downloaded: gzipped JSONL, or plain JSONL if the transport already decoded it. Max 5/day. */
  async index(): Promise<Buffer> {
    const res = await this.request('GET', '/v1/index');
    return Buffer.from(await res.arrayBuffer());
  }

  fragrance(id: string | number): Promise<unknown> {
    return this.json('GET', `/v1/fragrances/${encodeURIComponent(String(id))}`);
  }

  /** POST /v1/fragrances/batch, split into chunks of 100 (the documented maximum). */
  async fragrances(ids: (string | number)[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < ids.length; i += BATCH_MAX) {
      const body = await this.json('POST', '/v1/fragrances/batch', { ids: ids.slice(i, i + BATCH_MAX) });
      const list = Array.isArray(body) ? body : isObj(body) ? [body.data, body.fragrances, body.results].find(Array.isArray) : undefined;
      if (!list) throw new FragDbError('FragDB batch response has no list of fragrances');
      out.push(...list);
    }
    return out;
  }

  note(id: string | number): Promise<unknown> {
    return this.json('GET', `/v1/notes/${encodeURIComponent(String(id))}`);
  }

  brand(id: string | number): Promise<unknown> {
    return this.json('GET', `/v1/brands/${encodeURIComponent(String(id))}`);
  }

  perfumer(id: string | number): Promise<unknown> {
    return this.json('GET', `/v1/perfumers/${encodeURIComponent(String(id))}`);
  }

  account(): Promise<unknown> {
    return this.json('GET', '/v1/account');
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    return (await this.request(method, path, body)).json();
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      await this.limiter.acquire();
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            Accept: 'application/json, application/gzip, */*',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        throw new FragDbError(`FragDB ${method} ${path} failed: ${(err as Error).message}`);
      }
      if (res.ok) return res;
      const wait = retryAfterMs(res.headers.get('retry-after'));
      if (res.status === 429 && attempt < MAX_ATTEMPTS && wait <= MAX_RETRY_WAIT_MS) {
        await res.body?.cancel();
        await delay(wait);
        continue;
      }
      throw httpError(res.status, method, path, await res.text().catch(() => ''));
    }
  }
}

function retryAfterMs(header: string | null): number {
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 1000;
}

function httpError(status: number, method: string, path: string, body: string): FragDbError {
  const hint = status === 401 || status === 403 ? ' - check FRAGDB_API_KEY'
    : status === 429 ? ' - rate limited (10 req/s, 300 req/min, 5 index downloads/day)'
      : '';
  const detail = body.trim() ? `: ${body.trim().slice(0, 200)}` : '';
  return new FragDbError(`FragDB ${method} ${path} failed with HTTP ${status}${hint}${detail}`, status);
}

// ---------------------------------------------------------------------------
// Index download + cache
// ---------------------------------------------------------------------------

export interface IndexFile {
  path: string;
  fromCache: boolean;
  /** True when today's download failed and an older cached index was used instead. */
  stale?: boolean;
}

const INDEX_FILE = /^index-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/;

/**
 * Today's index, downloaded at most once per (UTC) day: the API allows only 5
 * index downloads a day, and a dev server restarts far more often than that.
 * If the download fails but an older cache exists, that is used (with a log line).
 */
export async function fetchIndex(api: FragDbApi, opts: { cacheDir?: string; now?: Date; log?: Log } = {}): Promise<IndexFile> {
  const dir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const log = opts.log ?? defaultLog;
  const path = join(dir, `index-${(opts.now ?? new Date()).toISOString().slice(0, 10)}.jsonl.gz`);
  if (existsSync(path)) {
    log(`using today's cached FragDB index ${path} (not re-downloading: 5 index downloads/day)`);
    return { path, fromCache: true };
  }

  await mkdir(dir, { recursive: true });
  let gz: Buffer;
  try {
    const body = await api.index();
    if (!looksLikeJsonl(body)) {
      throw new FragDbError(`FragDB /v1/index did not return JSONL (starts with ${JSON.stringify(head(body, 60))})`);
    }
    gz = isGzip(body) ? body : gzipSync(body);
  } catch (err) {
    const older = (await cachedIndexes(dir)).at(-1);
    if (!older) throw err;
    log(`index download failed (${(err as Error).message}); using older cache ${older}`);
    return { path: join(dir, older), fromCache: true, stale: true };
  }

  // Write-then-rename: an interrupted write must never leave a truncated "today" file that later runs would trust.
  await writeFile(`${path}.part`, gz);
  await rename(`${path}.part`, path);
  for (const old of await cachedIndexes(dir)) if (join(dir, old) !== path) await rm(join(dir, old), { force: true });
  log(`downloaded FragDB index (${(gz.length / 1e6).toFixed(1)} MB gzipped) -> ${path}`);
  return { path, fromCache: false };
}

/** Stream-decompress the cached index line by line; the full index is too big to hold as one string. */
export async function* readIndexLines(path: string): AsyncGenerator<string> {
  const gunzip = createGunzip();
  gunzip.setEncoding('utf8');
  const file = createReadStream(path);
  file.on('error', (err) => gunzip.destroy(err));
  file.pipe(gunzip);
  let rest = '';
  for await (const chunk of gunzip as AsyncIterable<string>) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    yield* lines;
  }
  if (rest) yield rest;
}

async function cachedIndexes(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => INDEX_FILE.test(f)).sort();
  } catch {
    return [];
  }
}

function isGzip(b: Buffer): boolean {
  return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/** Peek at the first bytes (decompressing just the head of a gzip) - never cache an HTML error page as today's index. */
function looksLikeJsonl(body: Buffer): boolean {
  return /^\s*\{/.test(head(body, 64));
}

function head(body: Buffer, chars: number): string {
  try {
    const bytes = isGzip(body)
      ? gunzipSync(body.subarray(0, 64 * 1024), { finishFlush: zlibConstants.Z_SYNC_FLUSH })
      : body.subarray(0, 4 * chars);
    return bytes.toString('utf8').slice(0, chars);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Index record -> RawRow
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
type NoteRef = { name: string; group?: string };

class ShapeError extends Error {}

/** Names carried inside structured records, keyed by the id written into the row. */
export interface Learned {
  notes: Map<string, NoteRef>;
  accords: Map<string, string>;
  brands: Map<string, { name: string }>;
}

export function emptyLearned(): Learned {
  return { notes: new Map(), accords: new Map(), brands: new Map() };
}

/** RawRow column -> keys a structured record might use for it, FragDB's own column name first. */
const ALIASES: Record<string, string[]> = {
  pid: ['pid', 'id', 'fragrance_id'],
  name: ['name', 'title'],
  brand: ['brand', 'designer', 'brand_name'],
  year: ['year', 'release_year', 'launch_year'],
  main_photo: ['main_photo', 'photo', 'image_url'],
  accords: ['accords', 'main_accords'],
  notes_pyramid: ['notes_pyramid', 'notes', 'pyramid'],
  perfumers: ['perfumers', 'noses'],
  season: ['season', 'seasons'],
};

/** Columns that are a single value. Anything else in these is ignored rather than fatal - they are cosmetic. */
const SCALAR_COLUMNS = ['pid', 'name', 'year', 'gender', 'url', 'main_photo', 'description', 'reviews_count'] as const;
const DIST_COLUMNS = ['season', 'time_of_day', 'gender_votes', 'longevity', 'sillage', 'price_value', 'appreciation'] as const;

/**
 * Convert one index record into the RawRow that rowToFragrance() parses.
 * Pipe-encoded strings pass straight through; structured values (arrays and
 * objects) are re-encoded into the equivalent FragDB strings. An unrecognised
 * shape in a field that matching depends on throws, so the record is dropped
 * with that reason instead of silently loading half-empty.
 */
export function recordToRow(record: unknown, learned: Learned): RawRow {
  let r = record;
  if (isObj(r) && !('name' in r)) r = [r.data, r.fragrance, r.record].find(isObj) ?? r;
  if (!isObj(r)) throw new ShapeError(`record is ${kindOf(r)}, not an object`);
  const rec = r;
  const get = (col: string) => pick(rec, ALIASES[col] ?? [col]);

  const row: RawRow = {};
  for (const col of SCALAR_COLUMNS) row[col] = scalar(get(col));
  if (!row.pid || !row.name) throw new ShapeError('record has no pid/id or name');
  // parseGender expects FragDB's "gender_for_women" style; "for women" / "Women and Men" should map the same way.
  row.gender = row.gender?.trim().toLowerCase().replace(/[\s-]+/g, '_');

  row.brand = field('brand', () => brandField(get('brand'), learned));
  row.perfumers = field('perfumers', () => perfumersField(get('perfumers')));
  row.accords = field('accords', () => accordsField(get('accords'), learned));
  row.notes_pyramid = field('notes_pyramid', () => pyramidField(get('notes_pyramid') ?? topLevelTiers(rec), learned));
  row.rating = field('rating', () => ratingField(get('rating'), pick(rec, ['rating_votes', 'votes', 'rating_count'])));
  for (const col of DIST_COLUMNS) row[col] = field(col, () => distField(get(col)));
  const prosCons = get('pros_cons') ?? ('pros' in rec || 'cons' in rec ? { pros: rec.pros, cons: rec.cons } : undefined);
  row.pros_cons = field('pros_cons', () => prosConsField(prosCons));
  return row;
}

/** Run one field converter; strings pass through untouched, unknown shapes become a named ShapeError. */
function field(col: string, convert: () => string | undefined): string | undefined {
  try {
    return convert();
  } catch (err) {
    if (err instanceof ShapeError) throw new ShapeError(`unrecognised shape for "${col}": ${err.message}`);
    throw err;
  }
}

function scalar(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function brandField(v: unknown, learned: Learned): string | undefined {
  if (v === undefined || typeof v === 'string') return v;
  if (typeof v === 'number') return `Unknown;b${v}`;
  if (!isObj(v)) throw new ShapeError(kindOf(v));
  const name = str(v.name ?? v.title);
  const id = prefixedId('b', v.id ?? v.brand_id);
  if (name && id) learned.brands.set(id, { name });
  if (!name && !id) throw new ShapeError('brand object has neither name nor id');
  // parseBrand needs "name;id"; an id-only brand still resolves through brands.csv in the cache dir.
  return id ? `${name ?? 'Unknown'};${id}` : name;
}

function perfumersField(v: unknown): string | undefined {
  if (v === undefined || typeof v === 'string') return v;
  if (!Array.isArray(v)) throw new ShapeError(kindOf(v));
  return v.map((p) => {
    if (typeof p === 'string') return p.replace(/;/g, ',');
    if (!isObj(p)) throw new ShapeError(`perfumer entry is ${kindOf(p)}`);
    const name = str(p.name)?.replace(/;/g, ',');
    if (!name) throw new ShapeError('perfumer entry has no name');
    const id = prefixedId('p', p.id);
    return id ? `${name};${id}` : name;
  }).join(';');
}

/**
 * Accords as [{id?, name?, strength?}], [[key, strength]], ["citrus", ...] or {key: strength}.
 * Without strengths the list order is taken as strongest-first (how Fragrantica shows main accords).
 */
function accordsField(v: unknown, learned: Learned): string | undefined {
  if (v === undefined || typeof v === 'string') return v;
  let entries: { key: unknown; name?: string; strength: unknown }[];
  if (Array.isArray(v)) {
    entries = v.map((e) => {
      if (typeof e === 'string' || typeof e === 'number') return { key: e, strength: undefined };
      if (Array.isArray(e)) return { key: e[0], strength: e[1] };
      if (!isObj(e)) throw new ShapeError(`accord entry is ${kindOf(e)}`);
      const name = str(e.name ?? e.accord);
      return { key: e.id ?? e.accord_id ?? name, name, strength: e.strength ?? e.value ?? e.percent ?? e.percentage ?? e.score };
    });
  } else if (isObj(v)) {
    entries = Object.entries(v).map(([key, s]) => ({ key, strength: isObj(s) ? s.strength ?? s.value : s }));
  } else {
    throw new ShapeError(kindOf(v));
  }

  const strengths = entries.map((e, i) => num(e.strength) ?? Math.max(10, 100 - 10 * i));
  // Some APIs express strength as a 0-1 fraction; FragDB (and families.ts) use 0-100.
  const scale = strengths.every((s) => s <= 1) ? 100 : 1;
  return entries.map((e, i) => {
    const id = prefixedId('a', e.key);
    const name = e.name ?? (id ? undefined : str(e.key));
    if (!id && !name) throw new ShapeError('accord entry has neither id nor name');
    const key = id ?? syntheticId(name!);
    if (name) learned.accords.set(key, name.toLowerCase());
    return `${key}:${Math.round(strengths[i]! * scale * 100) / 100}`;
  }).join(';');
}

/** A pyramid as {top, middle|heart, base} (or a flat list); entries are ids, names or {id?, name?}. */
function pyramidField(v: unknown, learned: Learned): string | undefined {
  if (v === undefined || typeof v === 'string') return v;
  const tiers = { top: [] as string[], middle: [] as string[], base: [] as string[] };
  const add = (tier: keyof typeof tiers, list: unknown) => {
    if (list === undefined || list === null) return;
    if (!Array.isArray(list)) throw new ShapeError(`${tier} notes are ${kindOf(list)}`);
    for (const n of list) tiers[tier].push(noteId(n, learned));
  };
  if (Array.isArray(v)) add('middle', v);
  else if (isObj(v)) {
    add('top', v.top ?? v.top_notes);
    add('middle', v.middle ?? v.heart ?? v.middle_notes ?? v.heart_notes);
    add('base', v.base ?? v.base_notes);
    add('middle', v.notes ?? v.all);
  } else {
    throw new ShapeError(kindOf(v));
  }
  return encodePyramid(tiers);
}

function topLevelTiers(r: Obj): Obj | undefined {
  const keys = ['top_notes', 'middle_notes', 'heart_notes', 'base_notes'];
  return keys.some((k) => k in r) ? Object.fromEntries(keys.map((k) => [k, r[k]])) : undefined;
}

function noteId(n: unknown, learned: Learned): string {
  if (typeof n === 'number' || typeof n === 'string') {
    const id = prefixedId('n', n);
    if (id) return id;
    const name = String(n).trim();
    if (!name) throw new ShapeError('empty note name');
    learned.notes.set(syntheticId(name), { name });
    return syntheticId(name);
  }
  if (!isObj(n)) throw new ShapeError(`note entry is ${kindOf(n)}`);
  const name = str(n.name ?? n.title);
  const id = prefixedId('n', n.id ?? n.note_id) ?? (name ? syntheticId(name) : undefined);
  if (!id) throw new ShapeError('note entry has neither id nor name');
  if (name) learned.notes.set(id, { name, group: str(n.group ?? n.family) });
  return id;
}

function ratingField(v: unknown, votesAlt: unknown): string | undefined {
  if (v === undefined || typeof v === 'string') return v;
  if (typeof v === 'number') return `${v};${num(votesAlt) ?? 0}`;
  if (!isObj(v)) throw new ShapeError(kindOf(v));
  const value = num(v.value ?? v.average ?? v.score ?? v.rating);
  if (value === undefined) throw new ShapeError('rating object has no value');
  return `${value};${num(v.votes ?? v.count ?? v.rating_votes ?? votesAlt) ?? 0}`;
}

/**
 * A vote distribution as {winter: 1800}, {winter: {votes, pct}}, {winter: [votes, pct]}
 * or [{label, votes, pct}]. Labels are emitted bare - parseDist strips FragDB's
 * prefixes only when present - so "long lasting" and "season_winter" both work.
 */
function distField(v: unknown): string | undefined {
  if (v === undefined || typeof v === 'string') return v;
  let entries: [unknown, unknown][];
  if (Array.isArray(v)) {
    entries = v.map((e) => {
      if (!isObj(e)) throw new ShapeError(`vote entry is ${kindOf(e)}`);
      return [e.label ?? e.name ?? e.key ?? e.type, e];
    });
  } else if (isObj(v)) {
    entries = Object.entries(v);
  } else {
    throw new ShapeError(kindOf(v));
  }
  return entries.map(([rawLabel, val]) => {
    const label = str(rawLabel)?.toLowerCase().replace(/[\s-]+/g, '_');
    if (!label) throw new ShapeError('vote entry has no label');
    let votes: number | undefined;
    let pct: number | undefined;
    if (typeof val === 'number' || typeof val === 'string') votes = num(val);
    else if (Array.isArray(val)) [votes, pct] = [num(val[0]), num(val[1])];
    else if (isObj(val)) {
      votes = num(val.votes ?? val.count ?? val.value);
      pct = num(val.pct ?? val.percent ?? val.percentage);
    } else throw new ShapeError(`votes for "${label}" are ${kindOf(val)}`);
    return `${label}:${votes ?? ''}:${pct ?? ''}`;
  }).join(';');
}

function prosConsField(v: unknown): string | undefined {
  if (v === undefined || typeof v === 'string') return v;
  if (!isObj(v)) throw new ShapeError(kindOf(v));
  return encodeProsCons(votedList(v.pros, 'pros'), votedList(v.cons, 'cons'));
}

/** Entries as strings or {text, up, down}; without vote counts the list order is kept by synthesizing them. */
function votedList(v: unknown, which: string): VotedText[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ShapeError(`${which} is ${kindOf(v)}`);
  const items = v.map((e): { text: string; up?: number; down?: number } => {
    if (typeof e === 'string') return { text: e };
    if (!isObj(e)) throw new ShapeError(`${which} entry is ${kindOf(e)}`);
    return {
      text: str(e.text ?? e.title ?? e.name ?? e.value) ?? '',
      up: num(e.up ?? e.upvotes ?? e.likes ?? e.votes_up),
      down: num(e.down ?? e.downvotes ?? e.dislikes ?? e.votes_down),
    };
  }).filter((x) => x.text);
  if (items.every((x) => x.up !== undefined)) return items.map((x) => ({ text: x.text, up: x.up!, down: x.down ?? 0 }));
  return rankVotes(items.map((x) => x.text), 20);
}

// ---------------------------------------------------------------------------
// Reference tables
// ---------------------------------------------------------------------------

/**
 * Names for every note / accord id the rows reference. Sources, lowest
 * precedence first: earlier API lookups (notes.json / accords.json), FragDB's
 * own CSVs if dropped into the cache dir, names carried by the records. Note ids
 * still unknown are fetched from GET /v1/notes/{id} and cached, so each note
 * costs one request ever, not one per start.
 */
async function resolveRefs(rows: RawRow[], learned: Learned, ctx: { api: FragDbApi; cacheDir: string; log: Log }): Promise<RefTables> {
  const { api, cacheDir, log } = ctx;
  const [noteRows, accordRows, brandRows] = await Promise.all(
    ['notes.csv', 'accords.csv', 'brands.csv'].map((f) => readCsvIfPresent(join(cacheDir, f))),
  );
  const csv = buildRefTables(noteRows!, accordRows!, brandRows!);
  const notesPath = join(cacheDir, 'notes.json');
  const accordsPath = join(cacheDir, 'accords.json');
  const cachedNotes = await readJson<Record<string, NoteRef | null>>(notesPath, log);
  const cachedAccords = await readJson<Record<string, string>>(accordsPath, log);

  const knownNotes = Object.entries(cachedNotes).filter((e): e is [string, NoteRef] => e[1] !== null);
  const refs = {
    notes: new Map<string, NoteRef>([...knownNotes, ...csv.notes, ...learned.notes]),
    accords: new Map<string, string>([...Object.entries(cachedAccords), ...csv.accords, ...learned.accords]),
    brands: new Map([...(csv.brands ?? []), ...learned.brands]),
  };

  const ids = referencedIds(rows);
  const missing = [...ids.notes].filter((id) => !refs.notes.has(id) && !(id in cachedNotes));
  const newNotes: Record<string, NoteRef | null> = realIds(learned.notes);
  if (missing.length) {
    const minutes = Math.max(missing.length / REQUESTS_PER_SECOND / 60, missing.length / REQUESTS_PER_MINUTE);
    log(`fetching ${missing.length} note names from FragDB (rate-limited, ~${Math.ceil(minutes)} min; cached afterwards)`);
    const { found, error } = await fetchNotes(api, missing, log);
    for (const [id, note] of found) {
      newNotes[id] = note;
      if (note) refs.notes.set(id, note);
    }
    const unknown = [...found.values()].filter((n) => n === null).length;
    if (unknown) log(`${unknown} note ids are unknown to FragDB (404); they stay unresolved`);
    // Save before rethrowing so a failure part-way keeps the lookups already paid for.
    await writeJsonIfNew(notesPath, cachedNotes, newNotes);
    if (error) throw error;
  } else {
    await writeJsonIfNew(notesPath, cachedNotes, newNotes);
  }
  await writeJsonIfNew(accordsPath, cachedAccords, realIds(learned.accords));

  const unresolvedAccords = [...ids.accords].filter((id) => !refs.accords.has(id));
  if (unresolvedAccords.length) {
    log(`${unresolvedAccords.length} accord ids have no name (e.g. ${unresolvedAccords.slice(0, 3).join(', ')}): FragDB `
      + `documents no accord endpoint, so put FragDB's accords.csv in ${cacheDir} to resolve them`);
  }
  return refs;
}

/** GET /v1/notes/{id} for each id, a few in flight, paced by the client's rate limiter. 404 -> null. */
async function fetchNotes(api: FragDbApi, ids: string[], log: Log): Promise<{ found: Map<string, NoteRef | null>; error?: unknown }> {
  const found = new Map<string, NoteRef | null>();
  let next = 0;
  let error: unknown;
  // Undocumented whether the API wants "n75" or "75"; learn it from the first hit instead of doubling every request.
  let bareFirst = false;

  const lookup = async (id: string): Promise<NoteRef | null> => {
    const forms = /^n\d+$/.test(id) ? [id, id.slice(1)] : [id];
    if (bareFirst) forms.reverse();
    for (const form of forms) {
      try {
        const note = noteFromBody(await api.note(form));
        bareFirst = form !== id;
        return note;
      } catch (err) {
        if (!(err instanceof FragDbError && err.status === 404)) throw err;
      }
    }
    return null;
  };

  const worker = async () => {
    while (next < ids.length && error === undefined) {
      const id = ids[next++]!;
      try {
        found.set(id, await lookup(id));
        if (found.size % 250 === 0) log(`  ${found.size}/${ids.length} note names fetched`);
      } catch (err) {
        error ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(NOTE_WORKERS, ids.length) }, worker));
  return { found, error };
}

function noteFromBody(body: unknown): NoteRef | null {
  const n = isObj(body) ? [body.data, body.note, body].find(isObj) : undefined;
  const name = n && str(n.name ?? n.title);
  return n && name ? { name, group: str(n.group ?? n.family ?? n.category) } : null;
}

function referencedIds(rows: RawRow[]): { notes: Set<string>; accords: Set<string> } {
  const notes = new Set<string>();
  const accords = new Set<string>();
  for (const row of rows) {
    const p = parsePyramid(row.notes_pyramid);
    for (const id of [...p.top, ...p.middle, ...p.base]) if (/^n\d+$/.test(id)) notes.add(id);
    for (const a of parseAccords(row.accords)) if (/^a\d+$/.test(a.id)) accords.add(a.id);
  }
  return { notes, accords };
}

/** Only real FragDB ids are worth caching; synthetic "@name" ids are rebuilt from the records every load. */
function realIds<V>(m: Map<string, V>): Record<string, V> {
  return Object.fromEntries([...m].filter(([id]) => !id.startsWith('@')));
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface ApiLoadOptions {
  apiKey: string;
  apiBase?: string;
  cacheDir?: string;
  log?: Log;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: Date;
  requestsPerSecond?: number;
}

export async function loadFromApi(opts: ApiLoadOptions): Promise<Catalog> {
  const log = opts.log ?? defaultLog;
  if (!opts.apiKey) {
    throw new Error('CATALOG_SOURCE=api needs FRAGDB_API_KEY (a key starting with fk_). Set it in .env, '
      + 'or use CATALOG_SOURCE=seed for the bundled catalog.');
  }
  if (!opts.apiKey.startsWith('fk_')) log('warning: FRAGDB_API_KEY does not start with "fk_" - FragDB keys normally do');

  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const api = new FragDbApi({
    apiKey: opts.apiKey, baseUrl: opts.apiBase, fetchImpl: opts.fetchImpl, requestsPerSecond: opts.requestsPerSecond,
  });
  const index = await fetchIndex(api, { cacheDir, now: opts.now, log });

  const learned = emptyLearned();
  const rejected = new DropTally();
  const rows: RawRow[] = [];
  let lineNo = 0;
  for await (const line of readIndexLines(index.path)) {
    lineNo++;
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      rejected.add('index lines that are not valid JSON', `line ${lineNo}`);
      continue;
    }
    try {
      rows.push(recordToRow(record, learned));
    } catch (err) {
      if (!(err instanceof ShapeError)) throw err;
      rejected.add(`records with ${err.message}`, `line ${lineNo}`);
    }
  }

  const refs = await resolveRefs(rows, learned, { api, cacheDir, log });
  const extensions = await readExtensions(join(cacheDir, 'extensions.csv'), log);
  return assembleCatalog({ rows, refs, extensions, source: 'api', log, rejected });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function readCsvIfPresent(path: string): Promise<RawRow[]> {
  try {
    return parsePipeCsv(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readJson<T extends object>(path: string, log: Log): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {} as T;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    log(`ignoring unreadable cache file ${path}; it will be rebuilt`);
    return {} as T;
  }
}

async function writeJsonIfNew<V>(path: string, existing: Record<string, V>, additions: Record<string, V>): Promise<void> {
  if (Object.keys(additions).every((k) => k in existing && JSON.stringify(existing[k]) === JSON.stringify(additions[k]))) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...existing, ...additions }));
}

/** "a24" / 24 / "24" -> "a24"; anything else (a name) -> undefined. */
function prefixedId(prefix: string, v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return `${prefix}${v}`;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^\d+$/.test(s)) return `${prefix}${s}`;
  return new RegExp(`^${prefix}\\d+$`).test(s) ? s : undefined;
}

/** Id for a name-only entry: must avoid the characters FragDB's encodings split on. */
function syntheticId(name: string): string {
  return `@${name.replace(/[:;,()|]/g, ' ').trim()}`;
}

function pick(r: Obj, keys: string[]): unknown {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
  return undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function kindOf(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'an array' : `a ${typeof v}`;
}
