/**
 * Builds the in-memory Catalog from one of three sources:
 *   seed - the bundled curated catalog (data/catalog, produced by seedConvert.ts)
 *   csv  - a licensed FragDB pipe-delimited export
 *   api  - the FragDB Data API (fragdbApi.ts)
 * All three end in the same FragDB parsers (fragdb.ts) and the same usability
 * filter, so the rest of the app never needs to know which one it runs on.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Fragrance, PriceTier } from '../types.js';
import { PRICE_TIERS } from '../types.js';
import { Catalog, normalize, type CatalogSource } from './catalog.js';
import { sum } from './dist.js';
import {
  buildRefTables, parsePipeCsv, rowToFragrance, type Extension, type ParseStats, type RawRow, type RefTables,
} from './fragdb.js';

export type Log = (msg: string) => void;

export interface LoadOptions {
  source: CatalogSource;
  /** seed: folder produced by seedConvert.ts (default ./data/catalog). */
  seedDir?: string;
  /** csv: folder holding a licensed FragDB export (default ./data/fragdb). */
  csvDir?: string;
  /** api: FragDB key (fk_...), base URL, and where the index + note names are cached. */
  apiKey?: string;
  apiBase?: string;
  cacheDir?: string;
  log?: Log;
}

export const DEFAULT_SEED_DIR = './data/catalog';
export const DEFAULT_CSV_DIR = './data/fragdb';

export const defaultLog: Log = (msg) => console.log(`[catalog] ${msg}`);

/** Where each file-based source is configured, so a missing file names the knob to turn. */
const SOURCE_HINT: Record<'seed' | 'csv', string> = {
  seed: 'CATALOG_SOURCE=seed reads SEED_DIR (default ./data/catalog). Generate the seed files with '
    + '`npx tsx src/catalog/seedConvert.ts`, or point SEED_DIR at a folder that has them.',
  csv: 'CATALOG_SOURCE=csv reads FRAGDB_CSV_DIR (default ./data/fragdb). Point FRAGDB_CSV_DIR at your licensed '
    + 'FragDB export, or set CATALOG_SOURCE=seed to use the bundled catalog.',
};

const REQUIRED_FILES = ['fragrances.csv', 'notes.csv', 'accords.csv', 'brands.csv'] as const;

export async function loadCatalog(opts: LoadOptions): Promise<Catalog> {
  const log = opts.log ?? defaultLog;
  if (opts.source === 'api') {
    // Lazy: keeps the API client off the seed/csv startup path and avoids an import cycle.
    const { loadFromApi } = await import('./fragdbApi.js');
    return loadFromApi({ apiKey: opts.apiKey ?? '', apiBase: opts.apiBase, cacheDir: opts.cacheDir, log });
  }

  const source = opts.source;
  const dir = source === 'seed' ? opts.seedDir ?? DEFAULT_SEED_DIR : opts.csvDir ?? DEFAULT_CSV_DIR;
  // Sequential so the error always names the first missing file, not whichever read lost a race.
  const tables: RawRow[][] = [];
  for (const file of REQUIRED_FILES) tables.push(parsePipeCsv(await readRequired(join(dir, file), source)));
  const [fragrances, notes, accords, brands] = tables;
  const extensions = await readExtensions(join(dir, 'extensions.csv'), log);
  log(`loading ${source} catalog from ${resolve(dir)}`);
  return assembleCatalog({
    rows: fragrances!,
    refs: buildRefTables(notes!, accords!, brands!),
    extensions,
    source,
    log,
  });
}

async function readRequired(path: string, source: 'seed' | 'csv'): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Catalog file not found: ${resolve(path)}. ${SOURCE_HINT[source]}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Extensions sidecar (price tier + tags - not part of FragDB)
// ---------------------------------------------------------------------------

/** Optional file: a missing extensions.csv just means every tier comes from the brand heuristic. */
export async function readExtensions(path: string, log: Log): Promise<Map<string, Extension>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
  return parseExtensions(text, log);
}

/** "pid|price_tier|tags" with tags separated by ';'. An unknown tier is ignored, not fatal. */
export function parseExtensions(text: string, log: Log): Map<string, Extension> {
  const out = new Map<string, Extension>();
  let badTiers = 0;
  for (const row of parsePipeCsv(text)) {
    const pid = row.pid?.trim();
    if (!pid) continue;
    const tier = row.price_tier?.trim().toLowerCase() ?? '';
    const priceTier = (PRICE_TIERS as readonly string[]).includes(tier) ? (tier as PriceTier) : undefined;
    if (tier && !priceTier) badTiers++;
    const tags = (row.tags ?? '').split(';').map((t) => t.trim()).filter(Boolean);
    out.set(pid, { priceTier, tags });
  }
  if (badTiers) {
    log(`extensions.csv: ${badTiers} row(s) had an unknown price_tier (expected ${PRICE_TIERS.join('/')}); `
      + 'using the brand heuristic for those');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rows -> Catalog
// ---------------------------------------------------------------------------

/** Counts dropped records by reason, with a few examples so the log line is actionable. */
export class DropTally {
  private readonly byReason = new Map<string, { count: number; examples: string[] }>();

  add(reason: string, example: string): void {
    const e = this.byReason.get(reason) ?? { count: 0, examples: [] };
    e.count++;
    if (e.examples.length < 3) e.examples.push(example);
    this.byReason.set(reason, e);
  }

  get total(): number {
    let n = 0;
    for (const e of this.byReason.values()) n += e.count;
    return n;
  }

  summary(): string {
    return [...this.byReason].map(([reason, e]) => `${e.count} ${reason} (e.g. ${e.examples.join(', ')})`).join('; ');
  }
}

export interface AssembleInput {
  rows: RawRow[];
  refs: RefTables;
  extensions?: Map<string, Extension>;
  source: CatalogSource;
  log: Log;
  /** Records rejected before they became rows (e.g. unreadable API lines); they count toward stats.dropped. */
  rejected?: DropTally;
}

/**
 * The one place rows become the Catalog, shared by every source. Drops records
 * the recommender cannot match on and says so - a catalog that quietly shrinks
 * looks exactly like a bad recommender.
 */
export function assembleCatalog(input: AssembleInput): Catalog {
  const { rows, refs, extensions, source, log } = input;
  const drops = input.rejected ?? new DropTally();
  const recordsIn = rows.length + drops.total;
  const parse: ParseStats = { unresolvedNotes: 0, unresolvedAccords: 0 };
  const byPid = new Map<string, Fragrance>();

  for (const row of rows) {
    const fr = rowToFragrance(row, refs, extensions?.get(row.pid?.trim() ?? ''), parse);
    if (!fr) {
      drops.add('missing pid or name', `pid ${row.pid || '?'} "${row.name || '?'}"`);
    } else if (byPid.has(fr.pid)) {
      drops.add('duplicate pid', label(fr));
    } else if (!isMatchable(fr)) {
      drops.add('unusable for matching - no accords, notes or season votes', label(fr));
    } else {
      byPid.set(fr.pid, fr);
    }
  }

  const fragrances = [...byPid.values()];
  const stats = {
    fragrances: fragrances.length,
    brands: new Set(fragrances.map((f) => normalize(f.brand))).size,
    dropped: drops.total,
    unresolvedNotes: parse.unresolvedNotes,
    unresolvedAccords: parse.unresolvedAccords,
  };

  log(`${source} catalog: ${stats.fragrances} fragrances from ${stats.brands} brands`);
  if (drops.total) log(`dropped ${drops.total} of ${recordsIn} records: ${drops.summary()}`);
  if (parse.unresolvedNotes || parse.unresolvedAccords) {
    log(`${parse.unresolvedNotes} note and ${parse.unresolvedAccords} accord references have no entry in the `
      + 'reference tables (notes.csv / accords.csv); those notes and accords are left out of matching');
  }
  const orphans = extensions ? [...extensions.keys()].filter((pid) => !byPid.has(pid)).length : 0;
  if (orphans) log(`extensions.csv: ${orphans} row(s) refer to pids not in the catalog; ignored`);

  if (fragrances.length === 0) {
    throw new Error(`The ${source} catalog has no usable fragrances (${recordsIn} records read`
      + `${drops.total ? `; ${drops.summary()}` : ''}).`);
  }
  return new Catalog(fragrances, source, stats);
}

/** Needs at least one signal the recommender scores on: accords, notes, or season votes. */
function isMatchable(fr: Fragrance): boolean {
  const notes = fr.notes.top.length + fr.notes.middle.length + fr.notes.base.length;
  return fr.accords.length > 0 || notes > 0 || sum(fr.season) > 0;
}

function label(fr: Fragrance): string {
  return `${fr.pid} "${fr.brand} - ${fr.name}"`;
}
