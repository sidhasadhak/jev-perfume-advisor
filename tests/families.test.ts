/**
 * Tests for the family <-> accord/note bridge (src/catalog/families.ts).
 * Fragrances are hand-built so each test controls exactly which accords and
 * notes are present.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCORD_VOCAB, FAMILY_CRITERIA, FAMILY_DEFS, dominantFamilies, familyAffinity, familyProfile,
} from '../src/catalog/families.js';
import { emptyDist } from '../src/catalog/dist.js';
import {
  APPRECIATION, DAY_TIMES, FAMILIES, GENDER_VOTES, LONGEVITY, PRICE_VALUE, SEASONS, SILLAGE,
} from '../src/types.js';
import type { Family, Fragrance } from '../src/types.js';

type Accords = Record<string, number>;

/** A minimal valid Fragrance; tests only override what they care about. */
function makeFragrance(over: Partial<Fragrance> = {}): Fragrance {
  return {
    pid: 'test-1',
    name: 'Test Scent',
    brand: 'Test House',
    gender: 'unisex',
    perfumers: [],
    accords: [],
    notes: { top: [], middle: [], base: [] },
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
    ...over,
  };
}

/** Accords as { name: strength }, strongest first like the parser emits them. */
function withAccords(accords: Accords, notes: string[] = []): Fragrance {
  return makeFragrance({
    accords: Object.entries(accords).map(([name, strength]) => ({ name, strength })).sort((a, b) => b.strength - a.strength),
    notes: { top: notes, middle: [], base: [] },
  });
}

const near = (actual: number, expected: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, msg ?? `expected ${expected}, got ${actual}`);

function strongest(fr: Fragrance): Family {
  const [best] = (Object.entries(familyProfile(fr)) as [Family, number][]).sort((a, b) => b[1] - a[1]);
  assert.ok(best);
  return best[0];
}

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

describe('FAMILY_DEFS', () => {
  test('every family key has a complete FamilyDef and there are no extras', () => {
    assert.deepEqual(Object.keys(FAMILY_DEFS).sort(), [...FAMILIES].sort());
    for (const f of FAMILIES) {
      const def = FAMILY_DEFS[f];
      assert.ok(def, `${f} missing`);
      assert.ok(def.label.trim().length > 0, `${f} label`);
      assert.ok(def.description.trim().length > 0, `${f} description`);
      assert.ok(def.phrase.trim().length > 0, `${f} phrase`);
      assert.ok(Object.keys(def.accords).length > 0, `${f} has no accords`);
      assert.ok(def.notes.length > 0, `${f} has no notes`);
    }
  });

  test('labels are unique', () => {
    const labels = FAMILIES.map((f) => FAMILY_DEFS[f].label);
    assert.equal(new Set(labels).size, labels.length);
  });

  test('every referenced accord is in ACCORD_VOCAB', () => {
    const vocab = new Set<string>(ACCORD_VOCAB);
    for (const f of FAMILIES) {
      for (const accord of Object.keys(FAMILY_DEFS[f].accords)) {
        assert.ok(vocab.has(accord), `${f} references unknown accord "${accord}"`);
      }
    }
  });

  test('accord weights are in (0, 1]', () => {
    for (const f of FAMILIES) {
      for (const [accord, w] of Object.entries(FAMILY_DEFS[f].accords)) {
        assert.ok(w > 0 && w <= 1, `${f}.${accord} = ${w}`);
      }
    }
  });

  // familyAffinity lowercases the fragrance side only, so the definitions must already be lowercase.
  test('accord keys and note fragments are lowercase and trimmed', () => {
    for (const f of FAMILIES) {
      for (const k of Object.keys(FAMILY_DEFS[f].accords)) assert.equal(k, k.toLowerCase().trim(), `${f} accord "${k}"`);
      for (const n of FAMILY_DEFS[f].notes) assert.equal(n, n.toLowerCase().trim(), `${f} note "${n}"`);
    }
  });

  test('note fragments are unique within a family', () => {
    for (const f of FAMILIES) assert.equal(new Set(FAMILY_DEFS[f].notes).size, FAMILY_DEFS[f].notes.length, f);
  });
});

describe('FAMILY_CRITERIA', () => {
  test('has one entry per family, in FAMILIES order, carrying the description', () => {
    assert.deepEqual(Object.keys(FAMILY_CRITERIA), [...FAMILIES]);
    for (const f of FAMILIES) assert.equal(FAMILY_CRITERIA[f], FAMILY_DEFS[f].description);
  });
});

describe('ACCORD_VOCAB', () => {
  test('has no duplicates', () => {
    const dupes = ACCORD_VOCAB.filter((a, i) => ACCORD_VOCAB.indexOf(a) !== i);
    assert.deepEqual(dupes, []);
  });

  test('entries are lowercase, trimmed and non-empty', () => {
    for (const a of ACCORD_VOCAB) {
      assert.ok(a.length > 0);
      assert.equal(a, a.toLowerCase().trim());
    }
  });
});

// ---------------------------------------------------------------------------
// familyAffinity / familyProfile
// ---------------------------------------------------------------------------

describe('familyAffinity', () => {
  test('a citrus-100 fragrance scores citrus highest', () => {
    const fr = withAccords({ citrus: 100 }, ['Bergamot', 'Lemon']);
    const profile = familyProfile(fr);
    assert.equal(profile.citrus, 1);
    for (const f of FAMILIES) if (f !== 'citrus') assert.ok(profile[f] < profile.citrus, `${f} >= citrus`);
  });

  test('citrus accord alone still wins, from accords only', () => {
    const fr = withAccords({ citrus: 100 });
    near(familyAffinity(fr, 'citrus'), 0.7);
    assert.equal(strongest(fr), 'citrus');
  });

  test('a rose-heavy fragrance scores floral_rose above gourmand_sweet', () => {
    const fr = withAccords({ rose: 100, floral: 60, sweet: 30 }, ['Damask Rose', 'Peony', 'Vanilla']);
    const rose = familyAffinity(fr, 'floral_rose');
    const gourmand = familyAffinity(fr, 'gourmand_sweet');
    assert.ok(rose > gourmand, `rose ${rose} <= gourmand ${gourmand}`);
    near(rose, 1);
    near(gourmand, 0.7 * 0.3 + 0.3 * 0.5);
    assert.equal(strongest(fr), 'floral_rose');
  });

  test('accord names are matched case-insensitively', () => {
    near(familyAffinity(withAccords({ Citrus: 80 }), 'citrus'), 0.7 * 0.8);
    near(familyAffinity(withAccords({ 'White Floral': 100 }), 'floral_white'), 0.7);
  });

  test('uses the strongest matching accord, not the sum', () => {
    near(familyAffinity(withAccords({ aquatic: 50, marine: 50, ozonic: 50 }), 'fresh_aquatic'), 0.7 * 0.5);
  });

  test('applies per-family accord weights', () => {
    near(familyAffinity(withAccords({ fresh: 100 }), 'fresh_aquatic'), 0.7 * 0.6);
    near(familyAffinity(withAccords({ floral: 100 }), 'floral_rose'), 0.7 * 0.35);
    // A weaker direct accord can beat a stronger weighted one.
    near(familyAffinity(withAccords({ fresh: 100, aquatic: 70 }), 'fresh_aquatic'), 0.7 * 0.7);
  });

  test('note hits add 0.15 each, capped at two, across all tiers', () => {
    const notes = (top: string[], middle: string[] = [], base: string[] = []) => makeFragrance({ notes: { top, middle, base } });
    near(familyAffinity(notes(['Vetiver']), 'woody'), 0.15);
    near(familyAffinity(notes(['Vetiver'], [], ['Sandalwood']), 'woody'), 0.3);
    near(familyAffinity(notes(['Vetiver'], ['Cedar'], ['Sandalwood']), 'woody'), 0.3);
  });

  test('note fragments match inside longer note names, case-insensitively', () => {
    const fr = makeFragrance({ notes: { top: ['Sicilian Lemon'], middle: ['Bulgarian ROSE'], base: [] } });
    near(familyAffinity(fr, 'citrus'), 0.15);
    near(familyAffinity(fr, 'floral_rose'), 0.15);
  });

  test('accords outside every family (and unknown accords) contribute nothing', () => {
    const fr = withAccords({ metallic: 100, savory: 100, 'not a real accord': 100 });
    for (const f of FAMILIES) assert.equal(familyAffinity(fr, f), 0, f);
  });

  test('an empty fragrance scores 0 for every family', () => {
    const profile = familyProfile(makeFragrance());
    assert.deepEqual(Object.keys(profile), [...FAMILIES]);
    for (const f of FAMILIES) assert.equal(profile[f], 0, f);
  });

  test('affinity is always within [0, 1], including out-of-range strengths', () => {
    const allNotes = FAMILIES.flatMap((f) => FAMILY_DEFS[f].notes);
    const everything = makeFragrance({
      accords: ACCORD_VOCAB.map((name) => ({ name, strength: 100 })),
      notes: { top: allNotes, middle: allNotes, base: allNotes },
    });
    const extremes = [
      makeFragrance(),
      everything,
      withAccords({ citrus: 250, rose: 1e6 }, allNotes),
      withAccords({ citrus: -50, woody: -100 }),
      withAccords({ citrus: Number.MAX_VALUE }),
    ];
    for (const fr of extremes) {
      for (const f of FAMILIES) {
        const a = familyAffinity(fr, f);
        assert.ok(a >= 0 && a <= 1, `${f} = ${a}`);
      }
    }
    for (const f of FAMILIES) assert.equal(familyAffinity(everything, f), 1, `${f} should saturate`);
  });

  test('affinity stays within [0, 1] over many random fragrances', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 42;
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const noteVocab = FAMILIES.flatMap((f) => FAMILY_DEFS[f].notes).concat(['Unobtainium', 'Rain']);
    for (let i = 0; i < 300; i++) {
      const accords: Accords = {};
      for (let j = 0; j < 1 + Math.floor(rand() * 8); j++) accords[pick(ACCORD_VOCAB)] = Math.round(rand() * 100);
      const notes = Array.from({ length: Math.floor(rand() * 10) }, () => pick(noteVocab));
      const fr = withAccords(accords, notes);
      for (const f of FAMILIES) {
        const a = familyAffinity(fr, f);
        assert.ok(Number.isFinite(a) && a >= 0 && a <= 1, `iteration ${i}: ${f} = ${a}`);
      }
    }
  });

  test('note fragments match whole words only (rosemary is not rose, pineapple is not pine)',
    () => {
      const cases: [note: string, family: Family][] = [
        ['Rosemary', 'floral_rose'],
        ['Rosewood', 'floral_rose'],
        ['Pineapple', 'woody'],
        ['Peppermint', 'spicy'],
        ['Licorice', 'floral_soft_powdery'],
      ];
      for (const [note, family] of cases) {
        const fr = makeFragrance({ notes: { top: [note], middle: [], base: [] } });
        assert.equal(familyAffinity(fr, family), 0, `"${note}" counted toward ${family}`);
      }
      // The practical consequence: an aromatic fougere with rosemary + rosewood reads as a rose scent.
      const fougere = withAccords({ aromatic: 100, lavender: 80 }, ['Rosemary', 'Lavender', 'Rosewood']);
      assert.ok(!dominantFamilies(fougere).includes('floral_rose'));
    });
});

// ---------------------------------------------------------------------------
// dominantFamilies
// ---------------------------------------------------------------------------

describe('dominantFamilies', () => {
  // citrus 0.7, woody 0.56, gourmand 0.42, leather 0.28, aquatic 0.14 (from accords alone)
  const layered = withAccords({ citrus: 100, woody: 80, sweet: 60, leather: 40, aquatic: 20 });

  test('returns the strongest families first, default n=3 and min=0.25', () => {
    assert.deepEqual(dominantFamilies(layered), ['citrus', 'woody', 'gourmand_sweet']);
  });

  test('respects n', () => {
    assert.deepEqual(dominantFamilies(layered, 1), ['citrus']);
    assert.deepEqual(dominantFamilies(layered, 2), ['citrus', 'woody']);
    assert.deepEqual(dominantFamilies(layered, 10), ['citrus', 'woody', 'gourmand_sweet', 'leather']);
    assert.deepEqual(dominantFamilies(layered, 0), []);
  });

  test('respects min (inclusive)', () => {
    assert.deepEqual(dominantFamilies(layered, 10, 0.5), ['citrus', 'woody']);
    assert.deepEqual(dominantFamilies(layered, 10, 0.7), ['citrus']);
    assert.deepEqual(dominantFamilies(layered, 10, 0.71), []);
    assert.deepEqual(dominantFamilies(layered, 10, 0.1), ['citrus', 'woody', 'gourmand_sweet', 'leather', 'fresh_aquatic']);
  });

  test('min=0 with n=all returns every family', () => {
    assert.equal(dominantFamilies(layered, FAMILIES.length, 0).length, FAMILIES.length);
  });

  test('results are sorted by affinity', () => {
    const fr = withAccords({ amber: 90, oud: 100, rose: 70 }, ['Oud', 'Rose', 'Amber', 'Incense']);
    const fams = dominantFamilies(fr, 5, 0);
    for (let i = 1; i < fams.length; i++) {
      assert.ok(familyAffinity(fr, fams[i - 1] as Family) >= familyAffinity(fr, fams[i] as Family));
    }
    assert.equal(fams[0], 'oud_smoky');
  });

  test('an empty fragrance has no dominant families', () => {
    assert.deepEqual(dominantFamilies(makeFragrance()), []);
  });
});
