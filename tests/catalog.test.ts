/**
 * Tests for the in-memory catalog (src/catalog/catalog.ts): normalization and
 * the deterministic name/brand lookups the chat pipeline relies on to resolve
 * "something like Aventus" without asking Jev to spell perfume names.
 *
 * The catalog is the real FragDB sample plus a few hand-built records for
 * names the sample lacks (Aventus, a short name like "You"). The matching rules
 * are also checked against the shipped seed catalog, where real names collide
 * with everyday words ("First", "Paris") and with each other ("L'Homme").
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Catalog, normalize } from '../src/catalog/catalog.js';
import type { CatalogStats, NameMatch } from '../src/catalog/catalog.js';
import { buildRefTables, parsePipeCsv, rowToFragrance } from '../src/catalog/fragdb.js';
import { emptyDist } from '../src/catalog/dist.js';
import { loadCatalog } from '../src/catalog/loader.js';
import {
  APPRECIATION, DAY_TIMES, GENDER_VOTES, LONGEVITY, PRICE_VALUE, SEASONS, SILLAGE,
} from '../src/types.js';
import type { Fragrance } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const readSample = (file: string): string =>
  readFileSync(new URL(`./fixtures/fragdb-sample/${file}`, import.meta.url), 'utf8');

function loadSample(): Fragrance[] {
  const refs = buildRefTables(parsePipeCsv(readSample('notes.csv')), parsePipeCsv(readSample('accords.csv')));
  return parsePipeCsv(readSample('fragrances.csv')).flatMap((row) => rowToFragrance(row, refs) ?? []);
}

/** A minimal valid Fragrance for names the sample does not contain. */
function makeFragrance(pid: string, name: string, brand: string, votes = 1000): Fragrance {
  return {
    pid,
    name,
    brand,
    gender: 'unisex',
    perfumers: [],
    accords: [],
    notes: { top: [], middle: [], base: [] },
    rating: { value: 4, votes },
    season: emptyDist(SEASONS),
    timeOfDay: emptyDist(DAY_TIMES),
    genderVotes: emptyDist(GENDER_VOTES),
    longevity: emptyDist(LONGEVITY),
    sillage: emptyDist(SILLAGE),
    priceValue: emptyDist(PRICE_VALUE),
    appreciation: emptyDist(APPRECIATION),
    pros: [],
    cons: [],
    priceTier: 'mid',
    tags: [],
  };
}

const STATS: CatalogStats = { fragrances: 0, brands: 0, dropped: 0, unresolvedNotes: 0, unresolvedAccords: 0 };

const catalogOf = (frs: Fragrance[]) => new Catalog(frs, 'seed', { ...STATS, fragrances: frs.length });

const sample = loadSample();
const catalog = catalogOf([
  ...sample,
  makeFragrance('c-aventus', 'Aventus', 'Creed', 25000),
  makeFragrance('c-aventus-her', 'Aventus for Her', 'Creed', 8000),
  makeFragrance('g-you', 'You', 'Glossier', 3000),
]);

/** The catalog the bot ships with (data/catalog). */
const shipped = await loadCatalog({ source: 'seed', seedDir: fileURLToPath(new URL('../data/catalog/', import.meta.url)), log: () => {} });

const names = (ms: NameMatch[]) => ms.map((m) => m.fragrance.name);
const pids = (ms: NameMatch[]) => ms.map((m) => m.fragrance.pid);
const scoreOf = (ms: NameMatch[], name: string) => ms.find((m) => m.fragrance.name === name)?.score;

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

describe('normalize', () => {
  test('strips diacritics', () => {
    assert.equal(normalize('Lancôme'), 'lancome');
    assert.equal(normalize('Hermès'), 'hermes');
    assert.equal(normalize('Chloé'), 'chloe');
    assert.equal(normalize('Aurélien Guichard'), 'aurelien guichard');
  });

  test('handles a decomposed (NFD) input the same as a composed one', () => {
    assert.equal(normalize(`Lanco${String.fromCharCode(0x302)}me`), 'lancome'); // o + combining circumflex
    assert.equal(normalize('Lancôme'.normalize('NFD')), normalize('Lancôme'.normalize('NFC')));
  });

  test('turns & into " and "', () => {
    assert.equal(normalize('Dolce&Gabbana'), 'dolce and gabbana');
    assert.equal(normalize('Dolce & Gabbana'), 'dolce and gabbana');
    assert.equal(normalize('Bath & Body Works'), 'bath and body works');
  });

  test('drops apostrophes instead of splitting words on them', () => {
    assert.equal(normalize("Penhaligon's"), 'penhaligons');
    assert.equal(normalize('L’Homme'), 'lhomme');
    assert.equal(normalize('Kiehl`s'), 'kiehls');
  });

  test('lowercases, keeps digits, turns other punctuation into single spaces', () => {
    assert.equal(normalize('  Eau-de-Parfum!!  (EDP) '), 'eau de parfum edp');
    assert.equal(normalize('No. 5'), 'no 5');
    assert.equal(normalize('212 VIP\tMen\n'), '212 vip men');
  });

  test('empty and punctuation-only strings normalize to ""', () => {
    assert.equal(normalize(''), '');
    assert.equal(normalize(' -!?- '), '');
  });

  test('is idempotent', () => {
    const inputs = [...sample.flatMap((f) => [f.name, f.brand]), "Penhaligon's", 'Dolce & Gabbana', 'L’Homme Idéal'];
    for (const s of inputs) assert.equal(normalize(normalize(s)), normalize(s), s);
  });
});

// ---------------------------------------------------------------------------
// Catalog basics
// ---------------------------------------------------------------------------

describe('Catalog basics', () => {
  test('size and get', () => {
    assert.equal(sample.length, 10);
    assert.equal(catalog.size, 13);
    assert.equal(catalog.get('485')?.name, 'Light Blue');
    assert.equal(catalog.get('c-aventus')?.brand, 'Creed');
    assert.equal(catalog.get('nope'), undefined);
    assert.equal(catalog.byPid.size, 13);
  });

  test('keeps the source and stats it was built with', () => {
    const c = new Catalog([], 'csv', { ...STATS, dropped: 3 });
    assert.equal(c.source, 'csv');
    assert.equal(c.stats.dropped, 3);
  });

  test('an empty catalog answers every lookup with nothing', () => {
    const c = catalogOf([]);
    assert.equal(c.size, 0);
    assert.deepEqual(c.mentionedIn('something like aventus'), []);
    assert.deepEqual(c.brandsIn('tom ford'), []);
    assert.deepEqual(c.search('aventus'), []);
  });
});

// ---------------------------------------------------------------------------
// mentionedIn
// ---------------------------------------------------------------------------

describe('Catalog.mentionedIn', () => {
  test('"something like aventus but cheaper" finds Creed Aventus', () => {
    const ms = catalog.mentionedIn('something like aventus but cheaper');
    assert.equal(ms[0]?.fragrance.pid, 'c-aventus');
    assert.equal(ms[0]?.score, 0.8);
    assert.ok(!names(ms).includes('Aventus for Her'), 'Aventus for Her needs "her" too');
  });

  test('mentioning the brand boosts the score to 1', () => {
    assert.equal(scoreOf(catalog.mentionedIn('I own Creed Aventus'), 'Aventus'), 1);
  });

  test('"light blue" finds Light Blue, regardless of case and punctuation', () => {
    for (const text of ['light blue', 'I loved Light Blue last summer', 'LIGHT-BLUE!!']) {
      assert.deepEqual(names(catalog.mentionedIn(text)), ['Light Blue'], text);
    }
  });

  test('the word "blue" alone does not match "Light Blue"', () => {
    assert.deepEqual(catalog.mentionedIn('blue'), []);
    assert.deepEqual(catalog.mentionedIn('something blue for a summer in Turkey'), []);
  });

  test('tokens must be whole words', () => {
    assert.deepEqual(catalog.mentionedIn('lightblue'), []);
    assert.deepEqual(catalog.mentionedIn('blues lighting'), []);
    assert.deepEqual(catalog.mentionedIn('angelic aliens'), []);
  });

  test('a multi-word name must appear as a phrase: scattered tokens are not a mention', () => {
    assert.ok(scoreOf(catalog.mentionedIn('light blue'), 'Light Blue') !== undefined);
    assert.equal(scoreOf(catalog.mentionedIn('blue sky, light jacket'), 'Light Blue'), undefined);
    // ...unless the brand is named too, which makes the intent unambiguous.
    assert.ok(scoreOf(catalog.mentionedIn('the blue Dolce & Gabbana one, light and fresh'), 'Light Blue') !== undefined);
  });

  test('stop words in the name are not required ("La Vie Est Belle")', () => {
    assert.ok(names(catalog.mentionedIn('like vie est belle but lighter')).includes('La Vie Est Belle'));
    assert.ok(names(catalog.mentionedIn('La Vie Est Belle')).includes('La Vie Est Belle'));
  });

  test('a short one-word name only matches when its brand is mentioned', () => {
    assert.deepEqual(catalog.mentionedIn('can you suggest something for you know, a party'), []);
    const you = catalog.mentionedIn('I wore Glossier You yesterday');
    assert.deepEqual(names(you), ['You']);
    assert.equal(you[0]?.score, 1);
    // Same rule on real data: "Eros" is only four letters.
    assert.deepEqual(catalog.mentionedIn('an eros statue in the garden'), []);
    assert.deepEqual(names(catalog.mentionedIn('something like Versace Eros')), ['Eros']);
  });

  test('a single-letter name ("Y" by YSL) matches when the brand is mentioned',
    () => {
      const c = catalogOf([makeFragrance('ysl-y', 'Y', 'Yves Saint Laurent')]);
      assert.deepEqual(names(c.mentionedIn('I love Y by Yves Saint Laurent')), ['Y']);
      assert.deepEqual(names(c.mentionedIn('why not a fresh scent, y know')), []);
    });

  test('prefers the longer, more specific name', () => {
    assert.deepEqual(names(catalog.mentionedIn('something like aventus for her')), ['Aventus for Her', 'Aventus']);
    assert.deepEqual(names(catalog.mentionedIn('Creed Aventus for Her')), ['Aventus for Her', 'Aventus']);
  });

  test('finds several mentioned fragrances', () => {
    assert.deepEqual(new Set(names(catalog.mentionedIn('compare angel with alien'))), new Set(['Angel', 'Alien']));
  });

  test('a brand mention ranks above a bare name', () => {
    const ms = catalog.mentionedIn('sauvage or tom ford black orchid?');
    assert.deepEqual(names(ms), ['Black Orchid', 'Sauvage']);
    assert.equal(ms[0]?.score, 1);
    assert.equal(ms[1]?.score, 0.8);
  });

  test('respects limit (default 5)', () => {
    const text = 'angel, alien, sauvage, black opium, coco mademoiselle or light blue';
    assert.equal(catalog.mentionedIn(text, 10).length, 6);
    assert.equal(catalog.mentionedIn(text).length, 5);
    assert.equal(catalog.mentionedIn(text, 2).length, 2);
  });

  test('scores are within (0, 1]', () => {
    for (const m of catalog.mentionedIn('creed aventus for her, tom ford black orchid, angel, light blue', 20)) {
      assert.ok(m.score > 0 && m.score <= 1, `${m.fragrance.name} = ${m.score}`);
    }
  });

  test('the persona-style requests from the brief mention no fragrance', () => {
    for (const text of [
      'suggest me a perfume for an evening party',
      'something for Nordic winters',
      'a summer in Turkey',
      'best perfume for a working professional',
      'a suitable perfume for a 65 year-old lady who loves the colour pink',
    ]) {
      assert.deepEqual(catalog.mentionedIn(text), [], text);
    }
  });

  test('a generic word does not match a name whose other words are stop words ("The One", "Le Male")',
    () => {
      const c = catalogOf([makeFragrance('dg-one', 'The One', 'Dolce&Gabbana'), makeFragrance('jpg-lm', 'Le Male', 'Jean Paul Gaultier')]);
      assert.deepEqual(names(c.mentionedIn('can you suggest one perfume for an evening party')), []);
      assert.deepEqual(names(c.mentionedIn('a fresh scent for a male colleague')), []);
      // Still found when named properly.
      assert.deepEqual(names(c.mentionedIn('something like the one by dolce & gabbana')), ['The One']);
    });

  test('connector words in a brand ("&" -> "and", "The") do not count as a brand mention',
    () => {
      const c = catalogOf([makeFragrance('tbs-musk', 'Musk', 'The Body Shop'), makeFragrance('ce-rose', 'Rose', 'Crabtree & Evelyn')]);
      assert.deepEqual(names(c.mentionedIn('something with musk for the office')), []);
      assert.deepEqual(names(c.mentionedIn('rose and vanilla please')), []);
    });
});

describe('Catalog.mentionedIn: short and numbered names', () => {
  const c = catalogOf([
    makeFragrance('ch-5', 'N°5 Eau de Parfum', 'Chanel'),
    makeFragrance('ch-19', 'N°19', 'Chanel'),
    makeFragrance('ysl-y', 'Y Eau de Parfum', 'Yves Saint Laurent'),
  ]);

  test('"Chanel No 5" in any spelling finds "N°5 Eau de Parfum" without typing "eau de parfum"', () => {
    for (const text of ['I love Chanel No 5, something similar?', 'something like Chanel N°5', 'Chanel No. 5', 'Chanel Nº5',
      'Chanel Number 5', 'chanel no5', 'Chanel N5']) {
      const ms = c.mentionedIn(text);
      assert.deepEqual(pids(ms), ['ch-5'], text);
      assert.equal(ms[0]?.score, 1, text);
    }
  });

  test('a numbered name still needs its brand: "No 5" alone is a list position, not a perfume', () => {
    for (const text of ['No. 5', 'N°5', 'something like No 5', 'the 5th one please']) assert.deepEqual(c.mentionedIn(text), [], text);
  });

  test('a bare number is not a numbered name: "I\'m 19" is not "N°19"', () => {
    assert.deepEqual(c.mentionedIn("I'm 19 and I love Chanel"), []);
    assert.deepEqual(pids(c.mentionedIn('Chanel No 19 or Chanel N°5?')).sort(), ['ch-19', 'ch-5']);
  });

  test('"YSL Y" and "Y by Yves Saint Laurent" find "Y Eau de Parfum"', () => {
    for (const text of ['I like YSL Y', 'something like Y by Yves Saint Laurent']) assert.deepEqual(pids(c.mentionedIn(text)), ['ysl-y'], text);
    assert.deepEqual(c.mentionedIn('why not a fresh scent, y know'), []);
  });

  test('the full catalog name typed out still counts without the brand (our own "More like ..." chips)', () => {
    assert.deepEqual(pids(c.mentionedIn('More like N°5 Eau de Parfum')), ['ch-5']);
    assert.deepEqual(pids(c.mentionedIn('Tell me more about Y Eau de Parfum')), ['ysl-y']);
  });

  test('on the shipped catalog', () => {
    assert.equal(shipped.mentionedIn('I love Chanel No 5, something similar?')[0]?.fragrance.name, 'N°5 Eau de Parfum');
    assert.equal(shipped.mentionedIn('something like YSL Y')[0]?.fragrance.name, 'Y Eau de Parfum');
    assert.deepEqual(shipped.mentionedIn("I'm 19, what should I wear? I like Chanel"), []);
  });
});

describe('Catalog.mentionedIn: brand aliases', () => {
  test('common abbreviations name the brand, which lets short names match', () => {
    const c = catalogOf([
      makeFragrance('jpg-lm', 'Le Male', 'Jean Paul Gaultier'),
      makeFragrance('dg-lb', 'Light Blue', 'Dolce&Gabbana'),
      makeFragrance('mfk-br', 'Baccarat Rouge 540', 'Maison Francis Kurkdjian'),
      makeFragrance('tf-ow', 'Oud Wood', 'Tom Ford'),
    ]);
    const top = (text: string) => c.mentionedIn(text)[0];
    assert.equal(top('jpg le male')?.fragrance.pid, 'jpg-lm');
    for (const [text, pid] of [['D&G Light Blue', 'dg-lb'], ['MFK Baccarat Rouge 540', 'mfk-br'], ['TF Oud Wood', 'tf-ow']] as const) {
      assert.equal(top(text)?.fragrance.pid, pid, text);
      assert.equal(top(text)?.score, 1, `${text}: the alias counts as the brand`);
    }
  });

  test('brandsIn resolves aliases to the catalog spelling', () => {
    assert.deepEqual(catalog.brandsIn('anything from YSL?'), ['Yves Saint Laurent']);
    assert.deepEqual(catalog.brandsIn('D&G please'), ['Dolce&Gabbana']);
    assert.deepEqual(shipped.brandsIn('CK or MFK or PDM or JPG or VCA').sort(),
      ['Calvin Klein', 'Jean Paul Gaultier', 'Maison Francis Kurkdjian', 'Parfums de Marly', 'Van Cleef & Arpels']);
  });

  test('every perfume in the shipped catalog is found when named with its brand', () => {
    for (const fr of shipped.fragrances) {
      for (const text of [`something like ${fr.brand} ${fr.name}`, `something like ${fr.name} by ${fr.brand}`]) {
        const ms = shipped.mentionedIn(text, 1);
        assert.ok(ms.some((m) => m.fragrance.pid === fr.pid && m.score === ms[0]!.score), `${text} -> ${names(ms)}`);
      }
    }
  });
});

describe('Catalog.mentionedIn: two perfumes with the same name', () => {
  // Prada is listed first so a catalog-order pick would choose it.
  const prada = makeFragrance('prada-lh', "L'Homme", 'Prada', 5000);
  const ysl = makeFragrance('ysl-lh', "L'Homme", 'Yves Saint Laurent', 9000);

  test('with neither brand named, both come back with equal scores, even at limit 1', () => {
    const c = catalogOf([prada, ysl]);
    for (const text of ["More like L'Homme", "Tell me more about L'Homme"]) {
      const ms = c.mentionedIn(text, 1);
      assert.deepEqual(new Set(pids(ms)), new Set(['prada-lh', 'ysl-lh']), text);
      assert.equal(ms[0]?.score, ms[1]?.score, text);
    }
  });

  test('the tie is ordered by popularity, never by catalog order', () => {
    assert.deepEqual(pids(catalogOf([prada, ysl]).mentionedIn("L'Homme")), ['ysl-lh', 'prada-lh']);
    assert.deepEqual(pids(catalogOf([ysl, prada]).mentionedIn("L'Homme")), ['ysl-lh', 'prada-lh']);
  });

  test('the one whose brand (or brand alias) is named wins outright', () => {
    const c = catalogOf([prada, ysl]);
    assert.deepEqual(pids(c.mentionedIn("YSL L'Homme", 1)), ['ysl-lh']);
    assert.deepEqual(pids(c.mentionedIn("L'Homme by Yves Saint Laurent", 1)), ['ysl-lh']);
    assert.deepEqual(pids(c.mentionedIn("Prada L'Homme", 1)), ['prada-lh']);
  });

  test('on the shipped catalog', () => {
    const ms = shipped.mentionedIn("More like L'Homme", 1);
    assert.deepEqual(new Set(ms.map((m) => m.fragrance.brand)), new Set(['Prada', 'Yves Saint Laurent']));
    assert.equal(shipped.mentionedIn("YSL L'Homme", 1)[0]?.fragrance.brand, 'Yves Saint Laurent');
  });
});

describe('Catalog.mentionedIn: names that are everyday words', () => {
  test('everyday-word names still match, but below 0.6 when the brand is not named', () => {
    for (const [text, name] of [
      ['perfume for a first date', 'First'], ['it gets to 100 Fahrenheit', 'Fahrenheit'], ['a trip to Paris', 'Paris'],
      ['when the flowers bloom', 'Bloom'], ['fresh as a daisy', 'Daisy'], ['nothing candy sweet', 'Candy'],
      ['something with vetiver', 'Vetiver'], ['light blue is her favourite colour', 'Light Blue'], ['a summer holiday on Naxos', 'Naxos'],
    ] as const) {
      const score = scoreOf(shipped.mentionedIn(text), name);
      assert.ok(score !== undefined && score < 0.6, `${text} -> ${name} = ${score}`);
    }
  });

  test('...and a distinctive name in the same message ranks first, however long the everyday one', () => {
    assert.deepEqual(names(shipped.mentionedIn('something like Aventus for a first date')), ['Aventus', 'First']);
    assert.deepEqual(names(shipped.mentionedIn('something like Layton that survives 100 Fahrenheit')), ['Layton', 'Fahrenheit']);
  });

  test('naming the brand restores the full score', () => {
    assert.equal(scoreOf(shipped.mentionedIn('something like Van Cleef & Arpels First'), 'First'), 1);
    assert.equal(scoreOf(shipped.mentionedIn('Guerlain Vetiver'), 'Vetiver'), 1);
  });

  test('a note name is an everyday word too, taken from the catalog itself', () => {
    const c = catalogOf([
      { ...makeFragrance('x-vet', 'Vetiver', 'Some House'), notes: { top: [], middle: [], base: ['Vetiver'] } },
      makeFragrance('x-mitsouko', 'Mitsouko', 'Other House'),
    ]);
    assert.equal(scoreOf(c.mentionedIn('something with vetiver'), 'Vetiver'), 0.5);
    assert.equal(scoreOf(c.mentionedIn('something like mitsouko'), 'Mitsouko'), 0.8);
  });

  test('genuine lookups keep their score', () => {
    assert.equal(scoreOf(shipped.mentionedIn('something like Aventus'), 'Aventus'), 0.8);
    assert.equal(scoreOf(shipped.mentionedIn('more like Baccarat Rouge 540 but cheaper'), 'Baccarat Rouge 540'), 0.8);
  });

  test('an everyday word or first name in a brand does not name the brand on its own', () => {
    assert.deepEqual(shipped.mentionedIn('a scent for my boss'), []);
    assert.deepEqual(shipped.mentionedIn('my husband Tom wants oud and wood'), []);
    assert.equal(scoreOf(shipped.mentionedIn('Hugo Boss The Scent'), 'Boss The Scent'), 1);
    assert.equal(scoreOf(shipped.mentionedIn('Tom Ford Oud Wood'), 'Oud Wood'), 1);
  });
});

// ---------------------------------------------------------------------------
// brandsIn
// ---------------------------------------------------------------------------

describe('Catalog.brandsIn', () => {
  test('finds "Tom Ford" and "Dior", once each', () => {
    const brands = catalog.brandsIn('I usually wear Tom Ford and sometimes Dior');
    assert.deepEqual([...brands].sort(), ['Dior', 'Tom Ford']);
  });

  test('matches through normalization and returns the catalog spelling', () => {
    assert.deepEqual(catalog.brandsIn('dolce & gabbana please'), ['Dolce&Gabbana']);
    assert.deepEqual(catalog.brandsIn('something from lancome'), ['Lancôme']);
    assert.deepEqual(catalog.brandsIn('YVES SAINT-LAURENT'), ['Yves Saint Laurent']);
  });

  test('brands must be whole words', () => {
    assert.deepEqual(catalog.brandsIn('a diorama of versaces'), []);
  });

  test('no brand -> []', () => {
    assert.deepEqual(catalog.brandsIn('something fresh for the office'), []);
    assert.deepEqual(catalog.brandsIn(''), []);
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('Catalog.search', () => {
  test('ties on matched tokens break by rating votes', () => {
    const ms = catalog.search('black');
    assert.deepEqual(names(ms), ['Black Opium', 'Black Orchid']); // 34845 vs 32512 votes
    assert.deepEqual(ms.map((m) => m.score), [1, 1]);
  });

  test('matching more of the query outranks more votes', () => {
    const ms = catalog.search('black orchid');
    assert.deepEqual(names(ms), ['Black Orchid', 'Black Opium']);
    assert.equal(ms[0]?.score, 1);
    assert.equal(ms[1]?.score, 0.5);
  });

  test('matches brand tokens too', () => {
    assert.deepEqual(names(catalog.search('tom ford')), ['Black Orchid', 'Tobacco Vanille']);
    assert.equal(catalog.search('dior sauvage')[0]?.fragrance.pid, '31861');
    assert.equal(catalog.search('dior sauvage')[0]?.score, 1);
  });

  test('prefix matching applies to query tokens longer than 3 chars', () => {
    assert.deepEqual(names(catalog.search('aven')), ['Aventus', 'Aventus for Her']);
    assert.deepEqual(names(catalog.search('sauv')), ['Sauvage']);
    assert.deepEqual(catalog.search('bla'), []);
  });

  test('normalizes the query', () => {
    assert.deepEqual(names(catalog.search('Lancôme')), ['La Vie Est Belle']);
    assert.deepEqual(names(catalog.search('LANCOME')), ['La Vie Est Belle']);
    assert.deepEqual(names(catalog.search('dolce & gabbana')), ['Light Blue']);
  });

  test('stop-word-only, empty and unmatched queries return []', () => {
    assert.deepEqual(catalog.search('the eau de parfum'), []);
    assert.deepEqual(catalog.search(''), []);
    assert.deepEqual(catalog.search('zzzz'), []);
  });

  test('respects limit (default 10)', () => {
    const wide = catalogOf(Array.from({ length: 15 }, (_, i) => makeFragrance(`p${i}`, `Nuit ${i}`, 'House', i)));
    assert.equal(wide.search('nuit').length, 10);
    assert.equal(wide.search('nuit', 3).length, 3);
    assert.deepEqual(names(wide.search('nuit', 3)), ['Nuit 14', 'Nuit 13', 'Nuit 12']);
  });

  test('scores are the matched fraction of query tokens, within (0, 1]', () => {
    for (const m of catalog.search('creed black vanille oud', 20)) {
      assert.ok(m.score > 0 && m.score <= 1);
      assert.equal(m.score * 4, Math.round(m.score * 4));
    }
  });

  test('an exact token match ranks above a prefix-only match',
    () => {
      const c = catalogOf([...sample, makeFragrance('jm-bb', 'Blackberry & Bay', 'Jo Malone London', 40000)]);
      assert.deepEqual(names(c.search('black')), ['Black Opium', 'Black Orchid', 'Blackberry & Bay']);
    });
});

describe('mentionedIn tie cap (review follow-up)', () => {
  test('returns at most two same-name ties beyond the limit', () => {
    const many = Array.from({ length: 8 }, (_, i) => makeFragrance(`dup-${i}`, 'Nocturne Rouge', `House ${String.fromCharCode(65 + i)}`, 1000));
    const c = catalogOf(many);
    assert.equal(c.mentionedIn('something like nocturne rouge', 1).length, 3);
  });
});
