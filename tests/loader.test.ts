import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { Fragrance } from '../src/types.js';
import { loadFromApi } from '../src/catalog/fragdbApi.js';
import { FRAGDB_FRAGRANCE_COLUMNS, parsePipeCsv } from '../src/catalog/fragdb.js';
import { loadCatalog, parseExtensions } from '../src/catalog/loader.js';
import { canonicalNote, convertSeed } from '../src/catalog/seedConvert.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fragdb-sample', import.meta.url));

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'parfume-loader-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

function collector(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
}

// ---------------------------------------------------------------------------
// Real FragDB sample
// ---------------------------------------------------------------------------

describe('loadCatalog csv (real FragDB sample)', () => {
  test('loads all 10 rows and resolves Light Blue', async () => {
    const { log } = collector();
    const cat = await loadCatalog({ source: 'csv', csvDir: FIXTURE, log });

    assert.equal(cat.source, 'csv');
    assert.equal(cat.size, 10);
    assert.equal(cat.stats.fragrances, 10);
    assert.equal(cat.stats.dropped, 0);
    assert.equal(cat.stats.brands, 8); // Mugler and Tom Ford have two each
    // The sample's reference tables only cover 10 notes / 10 accords, so most references are unresolved.
    assert.ok(cat.stats.unresolvedNotes > 0);
    assert.ok(cat.stats.unresolvedAccords > 0);

    const lb = cat.get('485');
    assert.ok(lb);
    assert.equal(lb.name, 'Light Blue');
    assert.equal(lb.brand, 'Dolce&Gabbana'); // b72 is not in the sample brands.csv -> name from the field itself
    assert.equal(lb.year, 2001);
    assert.equal(lb.gender, 'women');
    assert.deepEqual(lb.perfumers, ['Olivier Cresp']);
    assert.deepEqual(lb.rating, { value: 3.86, votes: 36764 });
    assert.deepEqual(lb.accords[0], { name: 'citrus', strength: 100 });
    assert.deepEqual(lb.notes.base, ['Musk', 'Amber']);
    assert.equal(lb.season.summer, 16800);
    assert.equal(lb.priceTier, 'mid');
  });
});

// ---------------------------------------------------------------------------
// Seed conversion round trip
// ---------------------------------------------------------------------------

function seedRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Rose Garden',
    brand: 'Maison Test',
    brand_country: 'France',
    year: 2015,
    gender: 'women',
    perfumers: ['Anne Nose', 'Bob Blender'],
    accords: [{ name: 'powdery', strength: 72.5 }, { name: 'rose', strength: 100 }, { name: 'musky', strength: 40 }],
    notes: { top: ['pink pepper', 'Bergamot'], middle: ['turkish rose', 'peony'], base: ['white musk', 'Cedar'] },
    description: 'A soft & romantic rose - "pink", powdery; elegant.',
    rating: 4.21,
    rating_votes: 1532,
    season_votes: { winter: 120, spring: 900, summer: 410, fall: 300 },
    time_votes: { day: 800, night: 350 },
    gender_votes: { female: 700, more_female: 200, unisex: 90, more_male: 5, male: 0 },
    longevity_votes: { very_weak: 10, weak: 40, moderate: 300, long_lasting: 250, eternal: 60 },
    sillage_votes: { intimate: 50, moderate: 400, strong: 120, enormous: 15 },
    price_value_votes: { way_overpriced: 5, overpriced: 30, ok: 200, good_value: 150, great_value: 60 },
    appreciation_votes: { love: 600, like: 400, ok: 100, dislike: 30, hate: 10 },
    pros: ['Elegant rose, never sharp', 'Great for spring days', 'Compliment magnet'],
    cons: ['Pricey', 'Fades on dry skin'],
    price_tier: 'niche',
    tags: ['romantic', 'pink'],
    confidence: 0.8,
    ...over,
  };
}

const ROSE = seedRecord();
const TOBACCO = seedRecord({
  name: 'Night Tobacco',
  brand: 'Atelier Noir',
  brand_country: 'Italy',
  year: 2019,
  gender: 'men',
  perfumers: ['Carl Smoke'],
  accords: [{ name: 'tobacco', strength: 100 }, { name: 'leather', strength: 80 }, { name: 'warm spicy', strength: 64 }],
  notes: { top: ['Pink Pepper'], middle: ['tobacco leaf'], base: ['leather', 'vanilla'] },
  season_votes: { winter: 950, spring: 100, summer: 20, fall: 700 },
  time_votes: { day: 150, night: 900 },
  pros: ['Beast mode projection'],
  cons: [],
  price_tier: 'luxury',
  tags: ['evening'],
});
const CITRUS = seedRecord({
  name: 'Citrus Kit',
  brand: 'Budget Co',
  brand_country: '',
  year: 2022,
  gender: 'unisex',
  perfumers: [],
  accords: [{ name: 'citrus', strength: 100 }, { name: 'fresh', strength: 55 }],
  notes: { top: ['lemon', 'grapefruit'], middle: [], base: ['white musk'] },
  description: '',
  pros: [],
  cons: ['Weak longevity'],
  price_tier: 'budget',
  tags: [],
});
/** Same fragrance as ROSE (different case), fewer notes: ROSE must win and tags must union. */
const ROSE_DUP = seedRecord({ name: 'rose garden', brand: 'MAISON TEST', notes: { top: ['Bergamot'], middle: [], base: [] }, tags: ['office-safe', 'pink'] });
const INVALID = seedRecord({ name: 'Broken', accords: [{ name: 'glitter', strength: 50 }], year: 1700 });

type Seed = ReturnType<typeof seedRecord>;

function expectRoundTrip(fr: Fragrance | undefined, src: Seed, tags: string[]): void {
  assert.ok(fr, `${String(src.name)} missing after round trip`);
  const accords = (src.accords as { name: string; strength: number }[]).slice().sort((a, b) => b.strength - a.strength);
  const notes = src.notes as { top: string[]; middle: string[]; base: string[] };
  const votes = src.rating_votes as number;

  assert.equal(fr.name, src.name);
  assert.equal(fr.brand, src.brand);
  assert.equal(fr.year, src.year);
  assert.equal(fr.gender, src.gender);
  assert.deepEqual(fr.perfumers, src.perfumers);
  assert.deepEqual(fr.accords, accords);
  assert.deepEqual(fr.notes, {
    top: notes.top.map(canonicalNote), middle: notes.middle.map(canonicalNote), base: notes.base.map(canonicalNote),
  });
  assert.deepEqual(fr.season, src.season_votes);
  assert.deepEqual(fr.timeOfDay, src.time_votes);
  assert.deepEqual(fr.genderVotes, src.gender_votes);
  assert.deepEqual(fr.longevity, src.longevity_votes);
  assert.deepEqual(fr.sillage, src.sillage_votes);
  assert.deepEqual(fr.priceValue, src.price_value_votes);
  assert.deepEqual(fr.appreciation, src.appreciation_votes);
  assert.deepEqual(fr.rating, { value: src.rating, votes });
  assert.equal(fr.reviewsCount, Math.round(votes * 0.07));
  assert.deepEqual(fr.pros, src.pros);
  assert.deepEqual(fr.cons, src.cons);
  assert.equal(fr.description, (src.description as string) || undefined);
  assert.equal(fr.priceTier, src.price_tier);
  assert.deepEqual(fr.tags, tags);
}

describe('seed conversion', () => {
  test('canonicalNote Title Cases so spellings share one id', () => {
    assert.equal(canonicalNote(' pink  pepper '), 'Pink Pepper');
    assert.equal(canonicalNote('Pink Pepper'), 'Pink Pepper');
    assert.equal(canonicalNote('lily-of-the-valley'), 'Lily-of-the-Valley');
    assert.equal(canonicalNote('ROSE DE MAI'), 'Rose de Mai');
  });

  test('round trips through genuine FragDB files and loadCatalog', async () => {
    const { log, lines } = collector();
    const { files, report } = convertSeed([ROSE, TOBACCO, INVALID, ROSE_DUP, CITRUS], { log });

    assert.deepEqual(report, {
      recordsIn: 5, invalidSkipped: 1, duplicatesMerged: 1, recordsWritten: 3,
      notes: 11, accords: 8, brands: 3, perfumers: 3,
    });
    const skip = lines.find((l) => l.startsWith('skip'));
    assert.ok(skip?.includes('"glitter" is not in ACCORD_VOCAB') && skip.includes('year must be'), skip);
    assert.ok(lines.some((l) => l.startsWith('duplicate "MAISON TEST - rose garden"')), lines.join('\n'));

    // Genuine FragDB layout: 30 columns in order, FragDB field encodings.
    const rows = parsePipeCsv(files['fragrances.csv']!);
    assert.equal(files['fragrances.csv']!.split('\n')[0], FRAGDB_FRAGRANCE_COLUMNS.join('|'));
    assert.deepEqual(rows.map((r) => [r.pid, r.name]), [
      ['900001', 'Night Tobacco'], ['900002', 'Citrus Kit'], ['900003', 'Rose Garden'], // sorted by brand, then name
    ]);
    const rose = rows[2]!;
    assert.equal(Object.keys(rose).length, 30);
    assert.equal(rose.brand, 'Maison Test;b3');
    assert.equal(rose.gender, 'gender_for_women');
    assert.equal(rose.perfumers, 'Anne Nose;p2;Bob Blender;p3');
    assert.equal(rose.rating, '4.21;1532');
    assert.equal(rose.season, 'season_winter:120:13.33;season_spring:900:100.0;season_summer:410:45.56;season_fall:300:33.33');
    assert.equal(rose.time_of_day, 'season_day:800:100.0;season_night:350:43.75');
    assert.equal(rose.sillage, 'sillage_intimate:50:8.5;sillage_moderate:400:68.4;sillage_strong:120:20.5;sillage_enormous:15:2.6');
    assert.match(rose.notes_pyramid!, /^top\(n1,1\.0,5\.0;n\d+,0\.95,4\.75\)middle\(n\d+,1\.0,5\.0;n\d+,0\.95,4\.75\)base\(/);
    assert.match(rose.pros_cons!, /^pros\(Elegant rose, never sharp,\d+,\d+;.*\)cons\(Pricey,\d+,\d+;Fades on dry skin,\d+,\d+\)$/);
    assert.equal(rose.url, '');
    // "pink pepper" (Rose) and "Pink Pepper" (Tobacco) share one note id.
    assert.equal(parsePipeCsv(files['notes.csv']!).filter((n) => n.name === 'Pink Pepper').length, 1);

    const dir = await tmp();
    await writeFiles(dir, files);
    const cat = await loadCatalog({ source: 'seed', seedDir: dir, log });
    assert.equal(cat.source, 'seed');
    assert.deepEqual(cat.stats, { fragrances: 3, brands: 3, dropped: 0, unresolvedNotes: 0, unresolvedAccords: 0 });
    expectRoundTrip(cat.get('900001'), TOBACCO, ['evening']);
    expectRoundTrip(cat.get('900002'), CITRUS, []);
    expectRoundTrip(cat.get('900003'), ROSE, ['romantic', 'pink', 'office-safe']);
  });

  test('is deterministic', () => {
    const quiet = { log: () => {} };
    assert.deepEqual(convertSeed([ROSE, TOBACCO, CITRUS], quiet).files, convertSeed([ROSE, TOBACCO, CITRUS], quiet).files);
  });
});

// ---------------------------------------------------------------------------
// Loader behaviour
// ---------------------------------------------------------------------------

describe('loadCatalog errors and filtering', () => {
  test('a missing required file names the path and the setting to fix', async () => {
    const dir = await tmp();
    await assert.rejects(loadCatalog({ source: 'seed', seedDir: dir, log: () => {} }), (err: Error) => {
      assert.ok(err.message.includes(join(dir, 'fragrances.csv')), err.message);
      assert.ok(err.message.includes('SEED_DIR'), err.message);
      return true;
    });
    await writeFile(join(dir, 'fragrances.csv'), `${FRAGDB_FRAGRANCE_COLUMNS.join('|')}\n`);
    await assert.rejects(loadCatalog({ source: 'csv', csvDir: dir, log: () => {} }), (err: Error) => {
      assert.ok(err.message.includes(join(dir, 'notes.csv')), err.message);
      assert.ok(err.message.includes('FRAGDB_CSV_DIR'), err.message);
      return true;
    });
  });

  test('drops unusable records and says why', async () => {
    const { files } = convertSeed([ROSE, TOBACCO], { log: () => {} });
    const bare = FRAGDB_FRAGRANCE_COLUMNS.map((c) => (c === 'pid' ? '555' : c === 'name' ? 'Empty Shell' : '')).join('|');
    const dir = await tmp();
    await writeFiles(dir, { ...files, 'fragrances.csv': `${files['fragrances.csv']}${bare}\n` });

    const { log, lines } = collector();
    const cat = await loadCatalog({ source: 'seed', seedDir: dir, log });
    assert.equal(cat.size, 2);
    assert.equal(cat.stats.dropped, 1);
    assert.equal(cat.get('555'), undefined);
    assert.ok(lines.some((l) => l.includes('dropped 1 of 3') && l.includes('unusable for matching') && l.includes('Empty Shell')), lines.join('\n'));
  });

  test('extensions: an unknown price_tier falls back and is logged', () => {
    const { log, lines } = collector();
    const ext = parseExtensions('pid|price_tier|tags\n1|premium|a; b\n2|luxury|\n', log);
    assert.deepEqual(ext.get('1'), { priceTier: undefined, tags: ['a', 'b'] });
    assert.deepEqual(ext.get('2'), { priceTier: 'luxury', tags: [] });
    assert.ok(lines.some((l) => l.includes('unknown price_tier')));
  });
});

// ---------------------------------------------------------------------------
// FragDB API (mocked fetch)
// ---------------------------------------------------------------------------

describe('fragdbApi', () => {
  const PIPE_RECORD = {
    pid: '485', name: 'Light Blue', brand: 'Dolce&Gabbana;b72', year: '2001', gender: 'gender_for_women',
    accords: 'a24:100;a91:75',
    notes_pyramid: 'top(n75,1.0,5.0)base(n2260,0.85,3.05;n999,0.74,2.52)',
    perfumers: 'Olivier Cresp;p39',
    rating: '3.86;36764',
    season: 'season_winter:1800:10.94;season_spring:9200:54.6;season_summer:16800:100.0;season_fall:2000:12.2',
    time_of_day: 'season_day:15900:94.41;season_night:2000:11.62',
    pros_cons: 'pros(Clean and fresh,870,11)cons(Short longevity,200,20)',
  };
  const STRUCTURED_RECORD = {
    id: 1001,
    name: 'Structured Rose',
    brand: { id: 7, name: 'Maison Structure' },
    year: 2019,
    gender: 'women',
    perfumers: [{ id: 3, name: 'Jane Nose' }, 'John Nose'],
    accords: [{ name: 'Rose', strength: 100 }, { id: 'a91', name: 'woody', strength: 60 }],
    notes: { top: [{ id: 'n75', name: 'Bergamot' }], heart: ['Rose'], base: [2260] },
    rating: { value: 4.1, votes: 1200 },
    season: { winter: 10, spring: 80, summer: 40, fall: 30 },
    time_of_day: [{ label: 'day', votes: 90 }, { label: 'night', votes: 20 }],
    longevity: { 'long lasting': 50, moderate: { votes: 30, pct: 37.5 } },
    pros: ['Elegant', 'Long lasting'],
    cons: [{ text: 'Pricey', up: 5, down: 1 }],
  };
  const INDEX = [
    JSON.stringify(PIPE_RECORD),
    JSON.stringify(STRUCTURED_RECORD),
    JSON.stringify({ pid: 3, name: 'Weird Accords', accords: 42 }),
    JSON.stringify([1, 2, 3]),
    '{not json',
  ].join('\n');

  function mockApi(indexStatus = 200) {
    const calls: string[] = [];
    const auth = new Set<string>();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      auth.add(new Headers(init?.headers).get('authorization') ?? '');
      if (url.endsWith('/v1/index')) {
        return indexStatus === 200
          ? new Response(gzipSync(INDEX), { headers: { 'content-type': 'application/gzip' } })
          : new Response('upstream down', { status: indexStatus });
      }
      if (url.endsWith('/v1/notes/n2260')) return Response.json({ data: { id: 'n2260', name: 'Musk', group: 'Musk, amber, animalic smells' } });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, calls, auth };
  }

  test('converts structured and pipe-encoded records, caches the index and note names', async () => {
    const cacheDir = await tmp();
    // FragDB's own accords.csv in the cache dir is preferred for accord names.
    await writeFile(join(cacheDir, 'accords.csv'), 'id|name\na24|citrus\na91|woody\n');
    const now = new Date('2026-09-21T10:00:00Z');
    const api = mockApi();
    const { log, lines } = collector();

    const cat = await loadFromApi({ apiKey: 'fk_test', apiBase: 'https://fragdb.test/api/', cacheDir, log, fetchImpl: api.fetchImpl, now });

    assert.equal(cat.source, 'api');
    assert.equal(cat.size, 2);
    assert.equal(cat.stats.dropped, 3);
    assert.ok(lines.some((l) => l.includes('unrecognised shape for "accords"')), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('record is an array')), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('not valid JSON')), lines.join('\n'));
    assert.deepEqual([...api.auth], ['Bearer fk_test']);
    assert.ok(api.calls.every((u) => u.startsWith('https://fragdb.test/api/v1/')));

    const pipe = cat.get('485');
    assert.ok(pipe);
    assert.equal(pipe.brand, 'Dolce&Gabbana');
    assert.equal(pipe.year, 2001);
    assert.deepEqual(pipe.accords, [{ name: 'citrus', strength: 100 }, { name: 'woody', strength: 75 }]);
    // n75 is named by the structured record, n2260 fetched from /v1/notes, n999 is a 404 and stays unresolved.
    assert.deepEqual(pipe.notes, { top: ['Bergamot'], middle: [], base: ['Musk'] });
    assert.equal(pipe.season.summer, 16800);
    assert.deepEqual(pipe.pros, ['Clean and fresh']);

    const structured = cat.get('1001');
    assert.ok(structured);
    assert.equal(structured.brand, 'Maison Structure');
    assert.equal(structured.gender, 'women');
    assert.deepEqual(structured.perfumers, ['Jane Nose', 'John Nose']);
    assert.deepEqual(structured.accords, [{ name: 'rose', strength: 100 }, { name: 'woody', strength: 60 }]);
    assert.deepEqual(structured.notes, { top: ['Bergamot'], middle: ['Rose'], base: ['Musk'] });
    assert.deepEqual(structured.rating, { value: 4.1, votes: 1200 });
    assert.deepEqual(structured.season, { winter: 10, spring: 80, summer: 40, fall: 30 });
    assert.deepEqual(structured.timeOfDay, { day: 90, night: 20 });
    assert.equal(structured.longevity.long_lasting, 50);
    assert.equal(structured.longevity.moderate, 30);
    assert.deepEqual(structured.pros, ['Elegant', 'Long lasting']);
    assert.deepEqual(structured.cons, ['Pricey']);

    assert.ok(existsSync(join(cacheDir, 'index-2026-09-21.jsonl.gz')));
    const notesJson = JSON.parse(await readFile(join(cacheDir, 'notes.json'), 'utf8'));
    assert.deepEqual(notesJson.n2260, { name: 'Musk', group: 'Musk, amber, animalic smells' });
    assert.equal(notesJson.n999, null);

    // Second load the same day: no index download and no note lookups.
    const before = api.calls.length;
    const again = await loadFromApi({ apiKey: 'fk_test', apiBase: 'https://fragdb.test/api', cacheDir, log, fetchImpl: api.fetchImpl, now });
    assert.equal(again.size, 2);
    assert.equal(api.calls.length, before);
    assert.equal(api.calls.filter((u) => u.endsWith('/v1/index')).length, 1);
    assert.deepEqual(again.get('485')?.notes.base, ['Musk']);

    // Next day with the API failing: fall back to the older cache rather than failing the start.
    const failing = mockApi(503);
    const stale = await loadFromApi({
      apiKey: 'fk_test', cacheDir, log, fetchImpl: failing.fetchImpl, now: new Date('2026-09-22T10:00:00Z'),
    });
    assert.equal(stale.size, 2);
    assert.ok(lines.some((l) => l.includes('using older cache')), lines.join('\n'));
  });

  test('never caches a non-JSONL index response as today\'s index', async () => {
    const cacheDir = await tmp();
    const fetchImpl = (async () => new Response('<html>maintenance</html>', { status: 200 })) as typeof fetch;
    await assert.rejects(
      loadFromApi({ apiKey: 'fk_test', cacheDir, log: () => {}, fetchImpl, now: new Date('2026-09-21T10:00:00Z') }),
      /did not return JSONL/,
    );
    assert.equal(existsSync(join(cacheDir, 'index-2026-09-21.jsonl.gz')), false);
  });

  test('refuses to start without a key', async () => {
    await assert.rejects(loadFromApi({ apiKey: '', cacheDir: await tmp(), log: () => {} }), /FRAGDB_API_KEY/);
    // loadCatalog delegates 'api' to fragdbApi.ts.
    await assert.rejects(loadCatalog({ source: 'api', cacheDir: await tmp(), log: () => {} }), /FRAGDB_API_KEY/);
  });
});
