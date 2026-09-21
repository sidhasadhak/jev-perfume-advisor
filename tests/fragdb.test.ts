/**
 * Tests for the FragDB parsers (src/catalog/fragdb.ts) and vote-distribution
 * helpers (src/catalog/dist.ts). Parser tests run against the REAL published
 * FragDB sample so a format drift upstream shows up here first; edge cases the
 * sample does not exercise use small synthetic strings.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FRAGDB_FRAGRANCE_COLUMNS, buildRefTables, inferPriceTier, parseAccords, parseBrand, parseDist, parseGender,
  parsePerfumers, parsePipeCsv, parseProsCons, parsePyramid, parseRating, rowToFragrance,
} from '../src/catalog/fragdb.js';
import type { ParseStats, RawRow } from '../src/catalog/fragdb.js';
import { emptyDist, meanLevel, rel, share, sum, top } from '../src/catalog/dist.js';
import {
  APPRECIATION, DAY_TIMES, GENDER_VOTES, LONGEVITY, PRICE_VALUE, SEASONS, SILLAGE,
} from '../src/types.js';
import type { Fragrance } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const readSample = (file: string): string =>
  readFileSync(new URL(`./fixtures/fragdb-sample/${file}`, import.meta.url), 'utf8');

const rows = parsePipeCsv(readSample('fragrances.csv'));
const refs = buildRefTables(parsePipeCsv(readSample('notes.csv')), parsePipeCsv(readSample('accords.csv')), parsePipeCsv(readSample('brands.csv')));

function rawRow(pid: string): RawRow {
  const row = rows.find((r) => r.pid === pid);
  assert.ok(row, `fixture row ${pid} missing`);
  return row;
}

function fragrance(pid: string): Fragrance {
  const fr = rowToFragrance(rawRow(pid), refs);
  assert.ok(fr, `fixture row ${pid} did not convert`);
  return fr;
}

const newStats = (): ParseStats => ({ unresolvedNotes: 0, unresolvedAccords: 0 });

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

describe('parsePipeCsv', () => {
  const BOM = String.fromCharCode(0xfeff);

  test('reads the 10 sample rows with all 30 FragDB columns', () => {
    assert.equal(rows.length, 10);
    assert.equal(FRAGDB_FRAGRANCE_COLUMNS.length, 30);
    for (const row of rows) assert.deepEqual(Object.keys(row), [...FRAGDB_FRAGRANCE_COLUMNS]);
  });

  test('strips CRLF line endings (the sample uses them)', () => {
    for (const row of rows) {
      assert.ok(!row.news_ids?.endsWith('\r'), `pid ${row.pid} last cell keeps a \\r`);
      assert.ok(!row.pid?.startsWith('\n'));
    }
  });

  test('unwraps quoted cells from the sample and un-doubles embedded quotes', () => {
    // Black Orchid and Eros have their description wrapped in quotes; Eros also embeds "" pairs.
    for (const pid of ['1018', '16657']) {
      const d = rawRow(pid).description ?? '';
      assert.ok(d.startsWith('<p>'), `pid ${pid} still starts with a quote`);
      assert.ok(d.endsWith('</p>'), `pid ${pid} still ends with a quote`);
    }
    const eros = rawRow('16657').description ?? '';
    assert.ok(eros.includes('goals." - stated Donatella Versace'));
    assert.ok(!eros.includes('""'));
  });

  test('handles a UTF-8 BOM, quoted cells and doubled quotes', () => {
    const out = parsePipeCsv(BOM + 'id|name|note\r\n"a1"|"say ""hi"""|plain\r\n');
    assert.deepEqual(out, [{ id: 'a1', name: 'say "hi"', note: 'plain' }]);
    assert.ok(!Object.keys(out[0] ?? {}).some((k) => k.includes(BOM)));
  });

  test('keeps a lone or asymmetric quote verbatim', () => {
    assert.deepEqual(parsePipeCsv('a|b\n"|"x\n'), [{ a: '"', b: '"x' }]);
  });

  test('trims cells and header, skips blank lines, leaves missing trailing cells undefined', () => {
    const out = parsePipeCsv(' id | name |extra\n\n 7 |  Angel \n\n');
    assert.deepEqual(out, [{ id: '7', name: 'Angel', extra: undefined }]);
  });

  test('empty input and header-only input yield no rows', () => {
    assert.deepEqual(parsePipeCsv(''), []);
    assert.deepEqual(parsePipeCsv(BOM), []);
    assert.deepEqual(parsePipeCsv('id|name\r\n'), []);
  });
});

describe('buildRefTables', () => {
  test('indexes the sample notes, accords and brands by id', () => {
    assert.equal(refs.notes.size, 10);
    assert.equal(refs.accords.size, 10);
    assert.equal(refs.brands?.size, 10);
    assert.deepEqual(refs.notes.get('n1985'), { name: 'Cedar', group: 'Woods and mosses' });
    assert.equal(refs.accords.get('a24'), 'citrus');
    assert.deepEqual(refs.brands?.get('b627'), { name: 'Zara', country: 'Spain' });
  });

  test('skips rows without id or name and maps empty optional fields to undefined', () => {
    const t = buildRefTables(
      [{ id: 'n1', name: 'Rose', group: '' }, { id: '', name: 'Ghost' }, { id: 'n2' }],
      [{ id: 'a1', name: 'rose' }, { name: 'orphan' }],
      [{ id: 'b1', name: 'Creed', country: '' }],
    );
    assert.deepEqual([...t.notes.entries()], [['n1', { name: 'Rose', group: undefined }]]);
    assert.deepEqual([...t.accords.entries()], [['a1', 'rose']]);
    assert.deepEqual(t.brands?.get('b1'), { name: 'Creed', country: undefined });
  });

  test('brands table is optional', () => {
    assert.equal(buildRefTables([], []).brands?.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Field parsers
// ---------------------------------------------------------------------------

describe('parseBrand', () => {
  test('splits name;id from the sample (Light Blue)', () => {
    assert.deepEqual(parseBrand(rawRow('485').brand), { name: 'Dolce&Gabbana', id: 'b72' });
  });

  test('uses the LAST ; so a brand name may itself contain one', () => {
    assert.deepEqual(parseBrand('A;B;b5'), { name: 'A;B', id: 'b5' });
  });

  test('keeps the whole string as the name when there is no b<digits> id', () => {
    assert.deepEqual(parseBrand('Chanel'), { name: 'Chanel' });
    assert.deepEqual(parseBrand('Chanel;xyz'), { name: 'Chanel;xyz' });
    assert.deepEqual(parseBrand('Chanel;b'), { name: 'Chanel;b' });
  });

  test('empty or missing -> Unknown', () => {
    assert.deepEqual(parseBrand(undefined), { name: 'Unknown' });
    assert.deepEqual(parseBrand(''), { name: 'Unknown' });
  });
});

describe('parsePerfumers', () => {
  test('reads name;id pairs from the sample', () => {
    assert.deepEqual(parsePerfumers(rawRow('485').perfumers), ['Olivier Cresp']);
    assert.deepEqual(parsePerfumers(rawRow('707').perfumers), ['Dominique Ropion', 'Laurent Bruyere']);
    assert.deepEqual(parsePerfumers(rawRow('25324').perfumers), ['Nathalie Lorson', 'Olivier Cresp', 'Honorine Blanc', 'Marie Salamagne']);
  });

  test('tolerates a truncated trailing id', () => {
    assert.deepEqual(parsePerfumers('A;p2;B;p'), ['A', 'B']);
  });

  test('trims whitespace and accepts names without ids', () => {
    assert.deepEqual(parsePerfumers(' A ; p2 ; B '), ['A', 'B']);
  });

  test('keeps names that merely start with a capital P', () => {
    assert.deepEqual(parsePerfumers('Pierre Negrin;p143'), ['Pierre Negrin']);
  });

  test('empty or missing -> []', () => {
    assert.deepEqual(parsePerfumers(undefined), []);
    assert.deepEqual(parsePerfumers(''), []);
    assert.deepEqual(parsePerfumers(';;'), []);
  });
});

describe('parseGender', () => {
  test('maps the three FragDB labels', () => {
    assert.equal(parseGender('gender_for_women'), 'women');
    assert.equal(parseGender('gender_for_men'), 'men');
    assert.equal(parseGender('gender_for_women_and_men'), 'unisex');
  });

  test('accepts plain labels, case-insensitively', () => {
    assert.equal(parseGender('Women'), 'women');
    assert.equal(parseGender('female'), 'women');
    assert.equal(parseGender('MEN'), 'men');
    assert.equal(parseGender('male'), 'men');
    assert.equal(parseGender('GENDER_FOR_MEN'), 'men');
    assert.equal(parseGender('Unisex'), 'unisex');
  });

  test('unknown, empty or missing -> unisex', () => {
    assert.equal(parseGender('gender_for_kids'), 'unisex');
    assert.equal(parseGender(''), 'unisex');
    assert.equal(parseGender(undefined), 'unisex');
  });
});

describe('parseAccords', () => {
  test('parses the sample accords strongest first', () => {
    const acc = parseAccords(rawRow('485').accords);
    assert.equal(acc.length, 8);
    assert.deepEqual(acc[0], { id: 'a24', strength: 100 });
    for (let i = 1; i < acc.length; i++) assert.ok((acc[i - 1]?.strength ?? 0) >= (acc[i]?.strength ?? 0));
  });

  test('sorts unsorted input and drops malformed entries', () => {
    assert.deepEqual(parseAccords('a1:50;a2:90'), [{ id: 'a2', strength: 90 }, { id: 'a1', strength: 50 }]);
    assert.deepEqual(parseAccords('bad;a3:x;:40;a4:10'), [{ id: 'a4', strength: 10 }]);
  });

  test('empty or missing -> []', () => {
    assert.deepEqual(parseAccords(undefined), []);
    assert.deepEqual(parseAccords(''), []);
  });
});

describe('parsePyramid', () => {
  test('keeps the duplicated n1985 in Light Blue only once', () => {
    const raw = rawRow('485').notes_pyramid ?? '';
    assert.equal(raw.match(/n1985,/g)?.length, 2, 'fixture should contain the duplicate');
    const p = parsePyramid(raw);
    assert.deepEqual(p.top, ['n2415', 'n146', 'n1985', 'n293']);
    assert.deepEqual(p.middle, ['n42', 'n2185', 'n2541']);
    assert.deepEqual(p.base, ['n2260', 'n54']);
    assert.equal([...p.top, ...p.middle, ...p.base].filter((id) => id === 'n1985').length, 1);
  });

  test('a flat notes(...) pyramid folds into middle', () => {
    assert.deepEqual(parsePyramid('notes(n1,1,5;n2,1,5)'), { top: [], middle: ['n1', 'n2'], base: [] });
  });

  test('drops duplicates across tiers, keeping the first occurrence', () => {
    assert.deepEqual(parsePyramid('top(n1,1,5)base(n1,1,5;n2,1,5)'), { top: ['n1'], middle: [], base: ['n2'] });
  });

  test('section names are case-insensitive and ids are trimmed', () => {
    assert.deepEqual(parsePyramid('TOP( n1 ,1,5)Base(n2,1,5)'), { top: ['n1'], middle: [], base: ['n2'] });
  });

  test('empty, missing or empty sections -> empty tiers', () => {
    const empty = { top: [], middle: [], base: [] };
    assert.deepEqual(parsePyramid(undefined), empty);
    assert.deepEqual(parsePyramid(''), empty);
    assert.deepEqual(parsePyramid('top()middle()base()'), empty);
  });
});

describe('parseRating', () => {
  test('parses value;votes from the sample', () => {
    assert.deepEqual(parseRating(rawRow('485').rating), { value: 3.86, votes: 36764 });
  });

  test('missing votes default to 0', () => {
    assert.deepEqual(parseRating('4.2'), { value: 4.2, votes: 0 });
    assert.deepEqual(parseRating('4.2;abc'), { value: 4.2, votes: 0 });
  });

  test('zero, non-numeric, empty or missing -> undefined', () => {
    assert.equal(parseRating('0;100'), undefined);
    assert.equal(parseRating('abc;12'), undefined);
    assert.equal(parseRating(''), undefined);
    assert.equal(parseRating(undefined), undefined);
  });
});

describe('parseDist', () => {
  test('parses the sample season votes and strips the prefix', () => {
    assert.deepEqual(parseDist(rawRow('485').season, SEASONS, ['season_']), { winter: 1800, spring: 9200, summer: 16800, fall: 2000 });
  });

  test('time_of_day uses the season_ prefix in FragDB', () => {
    assert.deepEqual(parseDist('season_day:15900:94.41;season_night:2000:11.62', DAY_TIMES, ['season_', 'time_']), { day: 15900, night: 2000 });
    assert.deepEqual(parseDist('time_day:5:1;time_night:7:1', DAY_TIMES, ['season_', 'time_']), { day: 5, night: 7 });
  });

  test('ignores unknown labels and always returns every key', () => {
    const d = parseDist('season_monsoon:500:10;season_winter:10:1;garbage', SEASONS, ['season_']);
    assert.deepEqual(d, { winter: 10, spring: 0, summer: 0, fall: 0 });
  });

  test('falls back to pct when votes are missing or non-numeric', () => {
    const d = parseDist('season_winter::55.5;season_summer:abc:20;season_fall:0:12', SEASONS, ['season_']);
    assert.deepEqual(d, { winter: 55.5, spring: 0, summer: 20, fall: 12 });
  });

  test('zero votes and zero pct stay 0', () => {
    assert.deepEqual(parseDist('season_winter:0:0', SEASONS, ['season_']), emptyDist(SEASONS));
  });

  test('labels without a prefix still match', () => {
    assert.deepEqual(parseDist('winter:3:1', SEASONS, ['season_']), { winter: 3, spring: 0, summer: 0, fall: 0 });
  });

  test('empty or missing -> all-zero dist', () => {
    assert.deepEqual(parseDist(undefined, LONGEVITY, ['longevity_']), emptyDist(LONGEVITY));
    assert.deepEqual(parseDist('', SILLAGE, ['sillage_']), emptyDist(SILLAGE));
  });
});

describe('parseProsCons', () => {
  test('orders the sample pros/cons by net votes and drops net-negative ones', () => {
    const { pros, cons } = parseProsCons(rawRow('485').pros_cons);
    assert.equal(pros[0], 'Clean and fresh scent'); // 870 - 11: the highest net pro
    assert.equal(pros.length, 9);
    assert.deepEqual(cons, [
      'May not work well with certain body chemistries', // 295 - 83
      'Sharp screechy citrus opening for some', // 325 - 217
      'Short longevity requires frequent reapplication', // 72 - 28
      'Can smell like synthetic cleaning products', // 215 - 190
    ]);
    assert.ok(!cons.includes('Ubiquitous scent that lacks uniqueness')); // 19 - 49
  });

  test('every sample row yields non-empty pros', () => {
    for (const row of rows) assert.ok(parseProsCons(row.pros_cons).pros.length > 0, `pid ${row.pid}`);
  });

  test('text may contain commas: only the last two fields are votes', () => {
    const out = parseProsCons('pros(Fresh, clean, and light,10,2;Nice,3,1)cons(Pricey, but worth it,5,1)');
    assert.deepEqual(out, { pros: ['Fresh, clean, and light', 'Nice'], cons: ['Pricey, but worth it'] });
  });

  test('text may contain parentheses', () => {
    const out = parseProsCons('pros(Great (for summer),5,1)cons(Weak (fades fast),3,1)');
    assert.deepEqual(out, { pros: ['Great (for summer)'], cons: ['Weak (fades fast)'] });
  });

  test('sorts by net votes, not raw up-votes or source order', () => {
    assert.deepEqual(parseProsCons('pros(a,50,49;b,10,1;c,0,0)').pros, ['b', 'a']);
  });

  test('handles pros-only, cons-only and empty sections', () => {
    assert.deepEqual(parseProsCons('pros(a,2,1)'), { pros: ['a'], cons: [] });
    assert.deepEqual(parseProsCons('cons(c,2,1)'), { pros: [], cons: ['c'] });
    assert.deepEqual(parseProsCons('pros()cons(c,2,1)'), { pros: [], cons: ['c'] });
  });

  test('empty or missing -> no pros/cons', () => {
    assert.deepEqual(parseProsCons(undefined), { pros: [], cons: [] });
    assert.deepEqual(parseProsCons(''), { pros: [], cons: [] });
  });
});

describe('inferPriceTier', () => {
  test('brand heuristic tiers', () => {
    assert.equal(inferPriceTier('Creed'), 'niche');
    assert.equal(inferPriceTier('Chanel'), 'luxury');
    assert.equal(inferPriceTier('Tom Ford'), 'luxury');
    assert.equal(inferPriceTier('Zara'), 'budget');
    assert.equal(inferPriceTier("Victoria's Secret"), 'budget');
    assert.equal(inferPriceTier('Some Indie House'), 'mid');
    assert.equal(inferPriceTier('Dolce&Gabbana'), 'mid');
  });

  test('is case- and whitespace-insensitive and handles accents', () => {
    assert.equal(inferPriceTier('  CREED '), 'niche');
    assert.equal(inferPriceTier('dior'), 'luxury');
    assert.equal(inferPriceTier('Hermès'), 'luxury');
    assert.equal(inferPriceTier('Hermes'), 'luxury');
  });

  test('empty brand -> mid', () => {
    assert.equal(inferPriceTier(''), 'mid');
  });
});

// ---------------------------------------------------------------------------
// Row -> Fragrance
// ---------------------------------------------------------------------------

describe('rowToFragrance (sample)', () => {
  test('Light Blue (485) maps every field', () => {
    const lb = fragrance('485');
    assert.equal(lb.pid, '485');
    assert.equal(lb.name, 'Light Blue');
    assert.equal(lb.brand, 'Dolce&Gabbana');
    assert.equal(lb.year, 2001);
    assert.equal(lb.gender, 'women');
    assert.equal(lb.url, 'https://www.fragrantica.com/perfume/Dolce-Gabbana/Light-Blue-485.html');
    assert.equal(lb.photo, 'https://fimgs.net/mdimg/perfume-thumbs/375x500.485.jpg');
    assert.deepEqual(lb.perfumers, ['Olivier Cresp']);
    assert.deepEqual(lb.rating, { value: 3.86, votes: 36764 });
    assert.equal(lb.reviewsCount, 2500);
    assert.equal(lb.priceTier, 'mid');
    assert.deepEqual(lb.tags, []);
  });

  test('Light Blue vote distributions', () => {
    const lb = fragrance('485');
    assert.deepEqual(lb.season, { winter: 1800, spring: 9200, summer: 16800, fall: 2000 });
    assert.equal(lb.season.summer, 16800);
    assert.equal(lb.season.winter, 1800);
    assert.deepEqual(lb.timeOfDay, { day: 15900, night: 2000 });
    assert.deepEqual(lb.longevity, { very_weak: 1200, weak: 3200, moderate: 6600, long_lasting: 1900, eternal: 529 });
    assert.equal(lb.genderVotes.female, 3700);
    assert.deepEqual(lb.genderVotes, { female: 3700, more_female: 2700, unisex: 3400, more_male: 168, male: 105 });
    assert.deepEqual(lb.sillage, { intimate: 3500, moderate: 7100, strong: 1900, enormous: 538 });
    assert.deepEqual(lb.priceValue, { way_overpriced: 443, overpriced: 1800, ok: 4100, good_value: 1700, great_value: 322 });
    assert.deepEqual(lb.appreciation, { love: 11900, like: 15300, ok: 2800, dislike: 6100, hate: 650 });
  });

  test('Light Blue resolves known notes/accords and drops the rest', () => {
    const lb = fragrance('485');
    assert.deepEqual(lb.notes, { top: ['Cedar'], middle: ['Jasmine'], base: ['Musk', 'Amber'] });
    assert.deepEqual(lb.accords, [
      { name: 'citrus', strength: 100 },
      { name: 'woody', strength: 75 },
      { name: 'aromatic', strength: 54 },
      { name: 'musky', strength: 49 },
      { name: 'powdery', strength: 47 },
    ]);
  });

  test('Light Blue pros[0] is the highest net-voted pro', () => {
    assert.equal(fragrance('485').pros[0], 'Clean and fresh scent');
  });

  test('perfumers and gender for other sample rows', () => {
    assert.deepEqual(fragrance('707').perfumers, ['Dominique Ropion', 'Laurent Bruyere']);
    assert.equal(fragrance('1825').gender, 'unisex');
    assert.equal(fragrance('31861').gender, 'men');
    assert.equal(fragrance('16657').gender, 'men');
  });

  test('brand heuristic tiers flow through', () => {
    assert.equal(fragrance('31861').priceTier, 'luxury'); // Dior
    assert.equal(fragrance('611').priceTier, 'luxury'); // Chanel
    assert.equal(fragrance('1825').priceTier, 'luxury'); // Tom Ford
  });

  test('every sample row converts with sane values', () => {
    const all = rows.map((r) => rowToFragrance(r, refs));
    assert.equal(all.length, 10);
    assert.equal(new Set(all.map((f) => f?.pid)).size, 10);
    for (const f of all) {
      assert.ok(f);
      assert.ok(f.rating && f.rating.value > 0 && f.rating.votes > 0, `${f.name} rating`);
      assert.ok(f.year && f.year >= 1990 && f.year <= 2025, `${f.name} year`);
      assert.ok(f.perfumers.length > 0, `${f.name} perfumers`);
      assert.ok(sum(f.season) > 0 && sum(f.timeOfDay) > 0 && sum(f.longevity) > 0, `${f.name} votes`);
      assert.ok(f.accords.length > 0, `${f.name} accords`);
    }
  });

  test('description has HTML stripped and entities decoded', () => {
    const lb = fragrance('485');
    assert.ok(lb.description?.startsWith('Light Blue by Dolce&Gabbana is a Floral Fruity fragrance for women.'));
    assert.ok(lb.description?.endsWith('Launched in 2001.'));
    for (const f of rows.map((r) => rowToFragrance(r, refs))) {
      const d = f?.description ?? '';
      assert.ok(d.length > 0, `${f?.name} description`);
      assert.ok(!/[<>]/.test(d), `${f?.name} still has tags`);
      assert.ok(!d.includes('&amp;'), `${f?.name} still has &amp;`);
      assert.ok(!/\s{2,}/.test(d) && d === d.trim(), `${f?.name} whitespace not collapsed`);
    }
  });

  test('Eros keeps the quote embedded inside its quoted description', () => {
    assert.ok(fragrance('16657').description?.includes('goals." - stated Donatella Versace.'));
  });

  test('counts unresolved notes/accords into stats and accumulates across rows', () => {
    const stats = newStats();
    rowToFragrance(rawRow('485'), refs, undefined, stats);
    // Light Blue: 5 of its 9 unique note ids and 3 of its 8 accord ids are not in the sample tables.
    assert.deepEqual(stats, { unresolvedNotes: 5, unresolvedAccords: 3 });
    rowToFragrance(rawRow('707'), refs, undefined, stats);
    assert.deepEqual(stats, { unresolvedNotes: 7, unresolvedAccords: 5 });
  });

  test('works without a stats object', () => {
    assert.doesNotThrow(() => rowToFragrance(rawRow('485'), refs));
  });
});

describe('rowToFragrance (synthetic)', () => {
  const base: RawRow = { pid: '1', name: 'Test' };

  test('returns null without pid or name', () => {
    assert.equal(rowToFragrance({ name: 'X' }, refs), null);
    assert.equal(rowToFragrance({ pid: '1' }, refs), null);
    assert.equal(rowToFragrance({ pid: '  ', name: 'X' }, refs), null);
    assert.equal(rowToFragrance({ pid: '1', name: '' }, refs), null);
    assert.equal(rowToFragrance({}, refs), null);
  });

  test('trims pid and name', () => {
    const f = rowToFragrance({ pid: ' 9 ', name: ' Angel ' }, refs);
    assert.equal(f?.pid, '9');
    assert.equal(f?.name, 'Angel');
  });

  test('a row with only pid+name gets safe defaults for every field', () => {
    const f = rowToFragrance(base, refs);
    assert.ok(f);
    assert.equal(f.brand, 'Unknown');
    assert.equal(f.year, undefined);
    assert.equal(f.gender, 'unisex');
    assert.equal(f.url, undefined);
    assert.equal(f.photo, undefined);
    assert.equal(f.description, undefined);
    assert.deepEqual(f.perfumers, []);
    assert.deepEqual(f.accords, []);
    assert.deepEqual(f.notes, { top: [], middle: [], base: [] });
    assert.equal(f.rating, undefined);
    assert.equal(f.reviewsCount, undefined);
    assert.deepEqual(f.season, emptyDist(SEASONS));
    assert.deepEqual(f.timeOfDay, emptyDist(DAY_TIMES));
    assert.deepEqual(f.genderVotes, emptyDist(GENDER_VOTES));
    assert.deepEqual(f.longevity, emptyDist(LONGEVITY));
    assert.deepEqual(f.sillage, emptyDist(SILLAGE));
    assert.deepEqual(f.priceValue, emptyDist(PRICE_VALUE));
    assert.deepEqual(f.appreciation, emptyDist(APPRECIATION));
    assert.deepEqual(f.pros, []);
    assert.deepEqual(f.cons, []);
    assert.equal(f.priceTier, 'mid');
    assert.deepEqual(f.tags, []);
  });

  // parsePipeCsv yields '' (not undefined) for an empty cell, so this is the shape real exports produce.
  const allEmpty: RawRow = {
    ...Object.fromEntries(FRAGDB_FRAGRANCE_COLUMNS.map((c) => [c, ''])),
    pid: '2',
    name: 'Blank',
  };

  test('a row with every other cell empty gets the same defaults', () => {
    const f = rowToFragrance(allEmpty, refs);
    assert.ok(f);
    assert.equal(f.brand, 'Unknown');
    assert.equal(f.year, undefined);
    assert.equal(f.url, undefined);
    assert.equal(f.photo, undefined);
    assert.equal(f.description, undefined);
    assert.equal(f.rating, undefined);
    assert.deepEqual(f.notes, { top: [], middle: [], base: [] });
    assert.deepEqual(f.season, emptyDist(SEASONS));
    assert.deepEqual(f.pros, []);
  });

  test('an empty reviews_count cell means unknown, not zero reviews',
    () => {
      assert.equal(rowToFragrance(allEmpty, refs)?.reviewsCount, undefined);
    });

  test('rejects implausible years', () => {
    for (const year of ['1500', '2001.5', 'abc', '0']) {
      assert.equal(rowToFragrance({ ...base, year }, refs)?.year, undefined, `year ${year}`);
    }
  });

  test('stripHtml: tags become spaces, common entities decode, whitespace collapses', () => {
    const f = rowToFragrance({ ...base, description: '<p>Rose&nbsp;&amp; oud</p><p>It&#39;s  &quot;bold&quot;</p>\n' }, refs);
    assert.equal(f?.description, 'Rose & oud It\'s "bold"');
  });

  test('stripHtml: markup-only descriptions become undefined', () => {
    assert.equal(rowToFragrance({ ...base, description: '<p> </p><br/>' }, refs)?.description, undefined);
  });

  test('prefers the brand name from the brands table when the id resolves', () => {
    const f = rowToFragrance({ ...base, brand: 'ZARA OLD NAME;b627' }, refs);
    assert.equal(f?.brand, 'Zara');
    assert.equal(f?.priceTier, 'budget');
  });

  test('falls back to the parsed brand name when the id is unknown', () => {
    assert.equal(rowToFragrance({ ...base, brand: 'Creed;b999999' }, refs)?.brand, 'Creed');
  });

  test('extension sidecar overrides the tier heuristic and supplies tags', () => {
    const f = rowToFragrance({ ...base, brand: 'Zara;b627' }, refs, { priceTier: 'niche', tags: ['office-safe'] });
    assert.equal(f?.priceTier, 'niche');
    assert.deepEqual(f?.tags, ['office-safe']);
    const noTier = rowToFragrance({ ...base, brand: 'Zara;b627' }, refs, { tags: ['x'] });
    assert.equal(noTier?.priceTier, 'budget');
  });

  test('counts unresolved ids even when some resolve', () => {
    const stats = newStats();
    const f = rowToFragrance({ ...base, accords: 'a24:90;a999:50', notes_pyramid: 'top(n75,1,1;n0,1,1)base(n1,1,1)' }, refs, undefined, stats);
    assert.deepEqual(f?.accords, [{ name: 'citrus', strength: 90 }]);
    assert.deepEqual(f?.notes, { top: ['Bergamot'], middle: [], base: [] });
    assert.deepEqual(stats, { unresolvedNotes: 2, unresolvedAccords: 1 });
  });
});

// ---------------------------------------------------------------------------
// dist helpers
// ---------------------------------------------------------------------------

describe('dist helpers', () => {
  const lbSeason = { winter: 1800, spring: 9200, summer: 16800, fall: 2000 };
  const empty = emptyDist(SEASONS);

  test('emptyDist has every key at 0, in order, as a fresh object', () => {
    assert.deepEqual(empty, { winter: 0, spring: 0, summer: 0, fall: 0 });
    assert.deepEqual(Object.keys(empty), [...SEASONS]);
    const a = emptyDist(SEASONS);
    a.winter = 5;
    assert.equal(emptyDist(SEASONS).winter, 0);
  });

  test('sum', () => {
    assert.equal(sum(lbSeason), 29800);
    assert.equal(sum(empty), 0);
  });

  test('share is the fraction of all votes', () => {
    assert.equal(share(lbSeason, 'summer'), 16800 / 29800);
    assert.equal(share<'a' | 'b'>({ a: 1, b: 3 }, 'b'), 0.75);
    assert.equal(share(empty, 'summer'), 0);
  });

  test('share over all keys sums to 1', () => {
    const total = SEASONS.reduce((s, k) => s + share(lbSeason, k), 0);
    assert.ok(Math.abs(total - 1) < 1e-12);
  });

  test('rel is relative to the leading bucket', () => {
    assert.equal(rel(lbSeason, 'summer'), 1);
    assert.equal(rel(lbSeason, 'winter'), 1800 / 16800);
    assert.equal(rel(empty, 'winter'), 0);
  });

  test('meanLevel is the vote-weighted position on the scale, 0..1', () => {
    const d = (over: Partial<Record<(typeof LONGEVITY)[number], number>>) => ({ ...emptyDist(LONGEVITY), ...over });
    assert.equal(meanLevel(d({ very_weak: 10 }), LONGEVITY), 0);
    assert.equal(meanLevel(d({ eternal: 10 }), LONGEVITY), 1);
    assert.equal(meanLevel(d({ moderate: 3 }), LONGEVITY), 0.5);
    assert.equal(meanLevel(d({ moderate: 1, eternal: 1 }), LONGEVITY), 0.75);
    assert.equal(meanLevel(d({ very_weak: 1, eternal: 1 }), LONGEVITY), 0.5);
  });

  test('meanLevel of an empty dist or a single-level scale is NaN', () => {
    assert.ok(Number.isNaN(meanLevel(emptyDist(LONGEVITY), LONGEVITY)));
    assert.ok(Number.isNaN(meanLevel({ a: 5 }, ['a'] as const)));
  });

  test('top picks the leading bucket, first wins a tie, undefined when unvoted', () => {
    assert.equal(top(lbSeason), 'summer');
    assert.equal(top({ day: 15900, night: 2000 }), 'day');
    assert.equal(top({ a: 2, b: 2 }), 'a');
    assert.equal(top(empty), undefined);
  });

  test('helpers agree with the parsed sample', () => {
    const alien = fragrance('707');
    assert.equal(top(alien.season), 'winter');
    assert.equal(top(alien.timeOfDay), 'night');
    assert.ok(meanLevel(alien.longevity, LONGEVITY) > meanLevel(fragrance('485').longevity, LONGEVITY));
  });
});
