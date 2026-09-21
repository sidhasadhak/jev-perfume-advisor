/**
 * Integrity of the SHIPPED seed catalog (data/catalog), plus the converter's
 * duplicate handling. These guard the data the bot actually serves.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { Catalog } from '../src/catalog/catalog.js';
import { normalize } from '../src/catalog/catalog.js';
import { share } from '../src/catalog/dist.js';
import { ACCORD_VOCAB, dominantFamilies } from '../src/catalog/families.js';
import { loadCatalog } from '../src/catalog/loader.js';
import { variantKeyOf } from '../src/catalog/seedConvert.js';
import { PerfumeBot } from '../src/pipeline/orchestrator.js';
import { features } from '../src/pipeline/retrieve.js';
import { scriptedJev, type Script } from './helpers.js';

let catalog: Catalog;
before(async () => {
  catalog = await loadCatalog({ source: 'seed', seedDir: 'data/catalog', log: () => {} });
});

describe('shipped seed catalog', () => {
  it('loads completely: every note/accord id resolves and nothing is dropped', () => {
    assert.ok(catalog.size >= 150, `only ${catalog.size} fragrances`);
    assert.equal(catalog.stats.dropped, 0);
    assert.equal(catalog.stats.unresolvedNotes, 0);
    assert.equal(catalog.stats.unresolvedAccords, 0);
  });

  it('has no duplicate products (including brand-prefixed or EDP/EDT naming variants)', () => {
    const seen = new Map<string, string>();
    for (const f of catalog.fragrances) {
      const k = variantKeyOf({ brand: f.brand, name: f.name, year: f.year ?? 0 });
      assert.ok(!seen.has(k), `${f.brand} ${f.name} duplicates ${seen.get(k)}`);
      seen.set(k, `${f.brand} ${f.name}`);
      const exact = `${normalize(f.brand)}|${normalize(f.name)}`;
      assert.equal([...catalog.fragrances].filter((g) => `${normalize(g.brand)}|${normalize(g.name)}` === exact).length, 1, exact);
    }
  });

  it('every record is usable for matching', () => {
    const vocab = new Set<string>(ACCORD_VOCAB);
    for (const f of catalog.fragrances) {
      const where = `${f.brand} ${f.name}`;
      assert.ok(f.accords.length >= 3, `${where}: too few accords`);
      assert.equal(f.accords[0]!.strength, 100, `${where}: leading accord must be 100`);
      for (const a of f.accords) assert.ok(vocab.has(a.name), `${where}: unknown accord ${a.name}`);
      // At least one: single-molecule scents (Molecule 01 is only Iso E Super) are legitimately minimal.
      assert.ok(f.notes.top.length + f.notes.middle.length + f.notes.base.length >= 1, `${where}: no notes`);
      assert.ok(f.year && f.year >= 1880 && f.year <= 2026, `${where}: year ${f.year}`);
      assert.ok(f.rating && f.rating.value >= 1 && f.rating.value <= 5, `${where}: rating`);
      assert.ok(f.description && f.description.length > 30, `${where}: description`);
      assert.ok(Object.values(f.season).some((v) => v > 0), `${where}: no season votes`);
      assert.ok(Number(f.pid) >= 900001, `${where}: seed pids start at 900001`);
    }
  });

  it('covers the spectrum the example requests need', () => {
    const count = (pred: (f: (typeof catalog.fragrances)[number]) => boolean) => catalog.fragrances.filter(pred).length;
    assert.ok(count((f) => share(f.season, 'winter') > 0.35) >= 15, 'winter scents');
    assert.ok(count((f) => share(f.season, 'summer') > 0.35) >= 15, 'summer scents');
    assert.ok(count((f) => share(f.timeOfDay, 'night') > 0.6) >= 15, 'night scents');
    assert.ok(count((f) => f.tags.includes('office-safe')) >= 15, 'office scents');
    assert.ok(count((f) => dominantFamilies(f, 3).includes('floral_rose')) >= 10, 'rose scents');
    assert.ok(count((f) => f.priceTier === 'budget') >= 10, 'budget scents');
    for (const g of ['women', 'men', 'unisex'] as const) assert.ok(count((f) => f.gender === g) >= 25, `${g} scents`);
  });
});

describe('example requests against the shipped catalog', () => {
  const run = async (msg: string, script: Script) =>
    (await new PerfumeBot(catalog, scriptedJev(script)).chat(undefined, msg)).reply.recommendations.map((r) => catalog.get(r.pid)!);

  it('Nordic winters -> winter-leaning, warm scents', async () => {
    const recs = await run('Something for Nordic winters', { climate: 'cold', season: 'winter' });
    for (const f of recs.slice(0, 3)) {
      assert.ok(features(f).season.winter > 0.6, `${f.name} winter fit ${features(f).season.winter}`);
      assert.ok(features(f).heaviness > 0.3, `${f.name} is not a warm scent`);
    }
  });

  it('summer in Turkey -> summer-leaning, not heavy', async () => {
    const recs = await run('What should I wear for a summer in Turkey?', { climate: 'hot_humid', season: 'summer', occasion: 'travel' });
    for (const f of recs.slice(0, 3)) {
      assert.ok(features(f).season.summer > 0.6, `${f.name} summer fit`);
      assert.ok(features(f).heaviness < 0.5, `${f.name} is too heavy for humid heat (${features(f).heaviness})`);
    }
  });

  it('evening party -> night scents with presence', async () => {
    const recs = await run('Suggest me a perfume for an evening party', { occasion: 'evening_party', time_of_day: 'night' });
    for (const f of recs.slice(0, 3)) {
      assert.ok(features(f).night > 0.55, `${f.name} night share ${features(f).night}`);
      assert.ok(features(f).sillage > 0.45, `${f.name} projection ${features(f).sillage}`);
    }
  });

  it('working professional -> office-appropriate projection', async () => {
    const recs = await run('Best perfume for a working professional', { occasion: 'office', age_style: 'contemporary' });
    for (const f of recs.slice(0, 3)) assert.ok(features(f).sillage < 0.62, `${f.name} projects too much for an office (${features(f).sillage})`);
  });

  it('65-year-old lady who loves pink -> feminine, rosy or powdery, elegant', async () => {
    const recs = await run('A suitable perfume for a 65 year-old lady who loves the colour pink', {
      gender: 'feminine', age_style: 'mature_elegant', persona: 0.95, like_floral_rose: 0.9, like_floral_soft_powdery: 0.7,
    });
    for (const f of recs) {
      assert.ok(features(f).femininity > 0.55, `${f.name} is not feminine`);
      const fams = dominantFamilies(f, 3);
      assert.ok(fams.includes('floral_rose') || fams.includes('floral_soft_powdery'), `${f.name}: ${fams}`);
    }
  });
});

describe('seed converter duplicate keys', () => {
  it('treats brand-prefixed and EDP/EDT-suffixed names of the same year as one product', () => {
    assert.equal(variantKeyOf({ brand: 'Prada', name: "Prada L'Homme", year: 2016 }), variantKeyOf({ brand: 'Prada', name: "L'Homme", year: 2016 }));
    assert.equal(variantKeyOf({ brand: 'Givenchy', name: "L'Interdit Eau de Parfum", year: 2018 }), variantKeyOf({ brand: 'Givenchy', name: "L'Interdit", year: 2018 }));
  });
  it('keeps different releases that share a stem apart', () => {
    assert.notEqual(variantKeyOf({ brand: 'Narciso Rodriguez', name: 'For Her', year: 2003 }), variantKeyOf({ brand: 'Narciso Rodriguez', name: 'For Her Eau de Parfum', year: 2006 }));
    assert.notEqual(variantKeyOf({ brand: 'Dior', name: 'Sauvage', year: 2015 }), variantKeyOf({ brand: 'Dior', name: 'Sauvage Elixir', year: 2021 }));
  });
});
