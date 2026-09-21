/**
 * Grounding of the rendered text: every perfume fact must come from the record,
 * nothing may be claimed that the record (or the request) does not support, and
 * the seed catalog's estimated votes are never quoted as statistics.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Catalog } from '../src/catalog/catalog.js';
import { dominantFamilies, familyPhrase, FAMILY_DEFS } from '../src/catalog/families.js';
import { loadCatalog } from '../src/catalog/loader.js';
import type { Composition } from '../src/pipeline/compose.js';
import { describeFacets, describeNeeds, performancePhrase } from '../src/pipeline/describe.js';
import { PerfumeBot } from '../src/pipeline/orchestrator.js';
import { rank } from '../src/pipeline/rank.js';
import { bullets, headline, renderCompare, renderExplain, renderRecommendations } from '../src/pipeline/render.js';
import { noteMatches, scoreFragrance } from '../src/pipeline/retrieve.js';
import type { Facets, Fragrance, Reason, Recommendation } from '../src/types.js';
import { EMPTY_FACETS } from '../src/types.js';
import { fixtureCatalog, makeFragrance, scriptedJev, type Script } from './helpers.js';

const catalog = fixtureCatalog();
const facets = (p: Partial<Facets> = {}): Facets => ({ ...structuredClone(EMPTY_FACETS), ...p });
const A = (pairs: Array<[string, number]>) => pairs.map(([name, strength]) => ({ name, strength }));
const stats = (n: number) => ({ fragrances: n, brands: n, dropped: 0, unresolvedNotes: 0, unresolvedAccords: 0 });
const cardText = (rec: Recommendation, f: Facets, measured = false) => [headline(rec, f), ...bullets(rec, f, 6, { measured })].join(' | ');

/** Runs the real rank stage (reasons included) for one record. */
async function recommend(fr: Fragrance, f: Facets, script: Script = {}): Promise<Recommendation> {
  const cand = scoreFragrance(fr, f, [], false)!;
  const { recommendations } = await rank({
    message: 'test', facets: f, candidates: [cand], decider: scriptedJev(script), catalogLookup: (p) => catalog.get(p), take: 1,
  });
  return recommendations[0]!;
}

const rec = (fr: Fragrance, reasons: Reason[]): Recommendation => ({
  fragrance: fr, final: 0.8, retrieval: 0.8, judgement: { fit: 3, confidence: 0.9, facets: {} }, reasons,
});
const composition = (lead: Composition['lead']): Composition => ({ lead, tone: 'crisp', clarify: null, tip: false, followUps: [] });

/** A csv/api-style record: notes but no accords and no votes of any kind. */
const unvoted = (pid: string, name: string) => ({
  ...makeFragrance({
    pid, name, brand: 'Tiny House', notes: { top: ['Bergamot'], middle: ['Rose'], base: ['Musk'] }, rating: undefined,
  }),
  timeOfDay: { day: 0, night: 0 },
});

// ---------------------------------------------------------------------------
// Findings 17 / 27 - note matching is whole-word
// ---------------------------------------------------------------------------

describe('liked and avoided notes match whole words only', () => {
  it('noteMatches: no substring matches, plurals and qualified names are fine', () => {
    for (const note of ['Rosemary', 'Rosewood', 'Tuberose']) assert.equal(noteMatches(note, 'Rose'), false, note);
    assert.equal(noteMatches('Pineapple', 'Apple'), false);
    assert.equal(noteMatches('Honeysuckle', 'Honey'), false);
    assert.equal(noteMatches('Pittosporum', 'Rum'), false);
    assert.equal(noteMatches('Turkish Rose', 'Rose'), true);
    assert.equal(noteMatches('Roses', 'rose'), true);
    assert.equal(noteMatches('Red Berries', 'berry'), true);
    assert.equal(noteMatches('Tonka Bean', 'Tonka'), true);
    // A different part of the plant, or a longer name than the note, is not the note.
    assert.equal(noteMatches('Orange Blossom', 'Orange'), false);
    assert.equal(noteMatches('Pepper', 'Pink Pepper'), false);
  });

  it('a Rosemary-only perfume is not said to feature the rose the user asked for', async () => {
    const r = await recommend(catalog.get('B')!, facets({ likedNotes: ['Rose'] })); // Citrus Riviera: Rosemary, no rose
    assert.doesNotMatch(cardText(r, facets({ likedNotes: ['Rose'] })), /as you asked/);
    const e = await recommend(catalog.get('E')!, facets({ likedNotes: ['Rose'] }));
    assert.match(cardText(e, facets({ likedNotes: ['Rose'] })), /Features Rose, as you asked/);
  });

  it('quotes the record\'s own note name ("Turkish Rose" for a wanted rose)', async () => {
    const fr = makeFragrance({ pid: 'T', name: 'Turkish Delight', brand: 'X', notes: { top: [], middle: ['Turkish Rose'], base: ['Musk'] } });
    const r = await recommend(fr, facets({ likedNotes: ['Rose'] }));
    assert.match(cardText(r, facets({ likedNotes: ['Rose'] })), /Features Turkish Rose, as you asked/);
  });

  it('retrieval: an avoided rose does not penalise Rosemary; a liked rose does not score it as a hit', () => {
    const b = catalog.get('B')!;
    assert.equal(scoreFragrance(b, facets({ avoidedNotes: ['Rose'] }), [])!.signals.penalty, 1);
    assert.equal(scoreFragrance(b, facets({ likedNotes: ['Rose'] }), [])!.signals.notes, 0);
    assert.ok(scoreFragrance(catalog.get('E')!, facets({ avoidedNotes: ['Rose'] }), [])!.signals.penalty! < 0.5);
  });
});

// ---------------------------------------------------------------------------
// Findings 23 / 33 - records without votes or accords
// ---------------------------------------------------------------------------

describe('records with no votes or accords (csv/api data)', () => {
  const bare = unvoted('Z', 'Obscura');

  it('get no season claim: zero votes rank every season "first"', async () => {
    const r = await recommend(bare, facets({ season: 'winter' }), { climate_fit: 0.9 });
    assert.equal(r.reasons.find((x) => x.kind === 'season'), undefined);
    assert.doesNotMatch(cardText(r, facets({ season: 'winter' }), true), /winter|season votes/);
  });

  it('compare prints only the parts that exist', () => {
    const { text } = renderCompare([catalog.get('A')!, bare], 'A', 0.9, '');
    const line = text.split('\n').find((l) => l.includes('Obscura'))!;
    assert.equal(line, '**Obscura** by Tiny House: mid-priced designer.');
    assert.doesNotMatch(text, /best in winter and spring|; ;|: ;/);
  });

  it('explain skips empty sections and says nothing about day or night without votes', () => {
    const { text } = renderExplain(bare, undefined, { measured: true });
    assert.doesNotMatch(text, /\*\*Scent:\*\* \.|When to wear|day or night|Performance/);
    assert.match(text, /\*\*Notes:\*\* top — Bergamot; heart — Rose; base — Musk\./);
  });

  it('bullets never print an empty accord list', () => {
    const liked = rec(bare, [{ kind: 'family', weight: 0.9, data: { families: ['floral_rose'], accords: [], liked: 1 } }]);
    const text = bullets(liked, facets(), 6).join(' | ');
    assert.doesNotMatch(text, /\(\)|Main accords: ?($|\|)/);
    assert.ok(bullets(rec(bare, []), facets()).every((b) => !/Main accords: ?$/.test(b)));
  });
});

// ---------------------------------------------------------------------------
// Findings 24 / 29 / 30 - mild weather is not heat, and not summer
// ---------------------------------------------------------------------------

describe('climate and season wording', () => {
  it('a mild-climate request gets no summer season reason', async () => {
    const r = await recommend(catalog.get('B')!, facets({ climate: 'mild' }), { climate_fit: 0.9 }); // a summer-first citrus
    assert.equal(r.reasons.find((x) => x.kind === 'season'), undefined);
    assert.doesNotMatch(cardText(r, facets({ climate: 'mild' })), /summer|heat/i);
  });

  it('mild gets its own wording, never "fresh in the heat"', () => {
    const r = rec(catalog.get('E')!, [{ kind: 'climate', weight: 1, data: { climate: 'mild', heavy: 0.1, fresh: 0.2 } }]);
    const h = headline(r, facets({ climate: 'mild' }));
    assert.doesNotMatch(h, /heat/);
    assert.match(h, /mild/);
  });

  it('a heavy scent is not "fresh in the heat", a light one is not "blooms in cold air"', () => {
    const heavy = rec(catalog.get('A')!, [{ kind: 'climate', weight: 1, data: { climate: 'hot_humid', heavy: 0.9, fresh: 0 } }]);
    assert.doesNotMatch(cardText(heavy, facets({ climate: 'hot_humid' })), /heat/);
    const light = rec(catalog.get('B')!, [{ kind: 'climate', weight: 1, data: { climate: 'cold', heavy: 0.05, fresh: 0.9 } }]);
    assert.doesNotMatch(cardText(light, facets({ climate: 'cold' })), /cold air/);
  });

  it('cold still implies winter and heat still implies summer', async () => {
    const cold = await recommend(catalog.get('A')!, facets({ climate: 'cold' }), { climate_fit: 0.9 });
    assert.equal(cold.reasons.find((x) => x.kind === 'season')?.data.season, 'winter');
    const hot = await recommend(catalog.get('B')!, facets({ climate: 'hot_dry' }), { climate_fit: 0.9 });
    assert.equal(hot.reasons.find((x) => x.kind === 'season')?.data.season, 'summer');
  });

  it('"a natural X scent" only for the top season', () => {
    const second = rec(catalog.get('E')!, [{ kind: 'season', weight: 1, data: { season: 'fall', share: 30, rank: 2 } }]);
    assert.doesNotMatch(headline(second, facets()), /natural/);
    const first = rec(catalog.get('E')!, [{ kind: 'season', weight: 1, data: { season: 'spring', share: 40, rank: 1 } }]);
    assert.match(headline(first, facets()), /a natural spring scent/);
  });
});

// ---------------------------------------------------------------------------
// Finding 28 - colour comes from facets.favouriteColour, not regex
// ---------------------------------------------------------------------------

describe('favourite colour', () => {
  const recs = () => [rec(catalog.get('E')!, [{ kind: 'persona', weight: 1, data: { ageStyle: 'mature_elegant', families: ['floral_rose'] } }])];
  const text = (p: Partial<Facets>) => renderRecommendations({
    message: 'x', facets: facets({ ageStyle: 'mature_elegant', likes: { floral_rose: 0.9 }, ...p }), recs: recs(),
    composition: composition('persona'), refs: [], gift: false,
  });

  it('colour words in the persona text are not a love of that colour', () => {
    for (const persona of ['my mum, she hates pink but adores roses', 'she adores orange blossom', 'enjoying her golden years', 'a navy officer']) {
      const r = text({ persona });
      const all = [r.text, ...r.recommendations.flatMap((c) => c.bullets)].join('\n');
      assert.doesNotMatch(all, /a love of|evokes/, persona);
    }
  });

  it('a favourite colour from Jev is acknowledged through the families it maps to', () => {
    const r = text({ favouriteColour: 'pink' });
    assert.match(r.text, /a love of pink, I'd look to romantic rosy-floral scents/);
    assert.match(r.recommendations[0]!.bullets.join(' '), /suits a love of pink/);
  });

  it('a colour is never tied to a family it does not map to', () => {
    const r = text({ favouriteColour: 'black', persona: 'she loves black' }); // black is dark and smoky, not rosy
    assert.doesNotMatch(r.text, /evokes/);
    assert.doesNotMatch(r.recommendations[0]!.bullets.join(' '), /love of black/);
  });

  it('end to end: "she hates pink" produces no colour claim', async () => {
    const bot = new PerfumeBot(catalog, scriptedJev({ age_style: 'mature_elegant', persona: 0.9, like_floral_rose: 0.9, persona_fit: 0.9 }));
    const r = await bot.chat(undefined, 'A perfume for my 70 year old mum, she hates pink but adores roses');
    const all = [r.reply.text, ...r.reply.recommendations.flatMap((c) => [c.headline, ...c.bullets])].join('\n');
    assert.doesNotMatch(all, /love of pink|pink evokes/);
  });
});

// ---------------------------------------------------------------------------
// Findings 31 / 32 / 34 - already fixed; pinned here
// ---------------------------------------------------------------------------

describe('headline and opening claims (31, 32, 34)', () => {
  it('persona headline follows the age style and is silent for "any"', () => {
    const p = (ageStyle: string) => headline(rec(catalog.get('F')!, [{ kind: 'persona', weight: 1, data: { ageStyle } }]), facets());
    assert.doesNotMatch(p('youthful'), /grown-up/);
    assert.match(p('youthful'), /playful/);
    assert.doesNotMatch(p('any'), /—/);
  });

  it('a luxury or niche perfume is never "at a very friendly price"', () => {
    for (const tier of ['luxury', 'niche', 'mid']) {
      const h = headline(rec(catalog.get('A')!, [{ kind: 'value', weight: 1, data: { value: 'great value', tier } }]), facets());
      assert.doesNotMatch(h, /friendly price|cheap/, tier);
    }
  });

  it('a hot-climate opener that calls the picks fresh is only used for light picks', () => {
    const open = (pids: string[]) => renderRecommendations({
      message: 'x', facets: facets({ climate: 'hot_humid' }), recs: pids.map((p) => rec(catalog.get(p)!, [])),
      composition: composition('climate'), refs: [], gift: false,
    }).text.split('\n')[0]!;
    assert.doesNotMatch(open(['A', 'L', 'H', 'D']), /humid|muggy|fresh|crisp/i);
    assert.match(open(['B', 'I', 'J']), /humid|muggy/i);
  });
});

// ---------------------------------------------------------------------------
// Finding 35 - an explicit time of day wins over the occasion
// ---------------------------------------------------------------------------

describe('time of day', () => {
  it('a daytime date gets no evening reason; an evening office request gets no daytime reason', async () => {
    const date = facets({ occasion: 'date_night', timeOfDay: 'day' });
    const d = await recommend(catalog.get('D')!, date); // Sugar Velvet: 82% night
    assert.equal(d.reasons.find((x) => x.kind === 'time_of_day'), undefined);
    assert.doesNotMatch(cardText(d, date), /evening|date night/i);
    const office = facets({ occasion: 'office', timeOfDay: 'night' });
    const c = await recommend(catalog.get('C')!, office); // Quiet Musk: 20% night
    assert.equal(c.reasons.find((x) => x.kind === 'time_of_day'), undefined);
  });

  it('the occasion still implies the time when none was given', async () => {
    const d = await recommend(catalog.get('D')!, facets({ occasion: 'date_night' }));
    assert.equal(d.reasons.find((x) => x.kind === 'time_of_day')?.data.when, 'night');
  });
});

// ---------------------------------------------------------------------------
// Finding 36 - family phrases never name a material the perfume lacks
// ---------------------------------------------------------------------------

describe('family phrases', () => {
  const animalic = makeFragrance({
    pid: 'G1', name: 'Gold Test', brand: 'X', accords: A([['aldehydic', 100], ['animalic', 80], ['powdery', 70]]),
    notes: { top: ['Aldehydes'], middle: ['Jasmine'], base: ['Civet', 'Castoreum'] },
  });
  const breezy = makeFragrance({
    pid: 'C1', name: 'Clean One', brand: 'X', accords: A([['fresh', 100], ['citrus', 80], ['green', 50]]),
    notes: { top: ['Bergamot'], middle: ['Violet'], base: ['Amber'] },
  });

  it('the material phrase needs the material; otherwise the neutral phrase', () => {
    assert.equal(familyPhrase(animalic, 'leather'), 'bold, animalic');
    assert.equal(familyPhrase(catalog.get('H')!, 'leather'), FAMILY_DEFS.leather.phrase); // has leather
    assert.equal(familyPhrase(breezy, 'fresh_aquatic'), 'fresh and airy');
    assert.equal(familyPhrase(catalog.get('I')!, 'fresh_aquatic'), FAMILY_DEFS.fresh_aquatic.phrase); // aquatic accord
    for (const def of Object.values(FAMILY_DEFS)) {
      if (def.material) assert.doesNotMatch(def.material.fallback, /leather|aquatic|musk|ros[ey]|amber|smok|aldehyd|wood|green|citrus/, def.label);
    }
  });

  it('cards for a leather-family perfume without leather never say leather', () => {
    const r = rec(animalic, [{ kind: 'family', weight: 1, data: { families: ['leather'], accords: ['aldehydic', 'animalic'], liked: 1 } }]);
    assert.doesNotMatch(cardText(r, facets()), /leather/i);
  });

  it('a liked family only leads when the perfume is built on it', async () => {
    // Live: an aquatic-aromatic with a trace of incense was sold as "Dark, smoky ... the dark, smoky style you're after".
    const fr = makeFragrance({
      pid: 'Q', name: 'Aqua Trace', brand: 'X', accords: A([['citrus', 100], ['aquatic', 90], ['aromatic', 90], ['green', 90], ['smoky', 50]]),
      notes: { top: ['Bergamot'], middle: ['Sea Notes', 'Rosemary'], base: ['Incense'] },
    });
    assert.ok(!dominantFamilies(fr, 3).includes('oud_smoky'));
    const r = await recommend(fr, facets({ likes: { oud_smoky: 0.9 } }));
    assert.equal(r.reasons.find((x) => x.kind === 'family')!.data.liked, 0);
    assert.doesNotMatch(cardText(r, facets({ likes: { oud_smoky: 0.9 } })), /smoky|dramatic|you're after/i);
  });
});

// ---------------------------------------------------------------------------
// Finding 37 - the compare opener
// ---------------------------------------------------------------------------

describe('compare opener', () => {
  it('no constraints: a plain verdict, not "(no specific constraints yet)"', () => {
    const { text } = renderCompare([catalog.get('A')!, catalog.get('C')!], 'A', 0.9, describeFacets(facets(), 'user'));
    assert.match(text, /^Overall, I'd lean towards \*\*Ember Nocturne\*\*\./);
  });

  it('a short natural summary of at most two needs, never the internal facet dump', () => {
    const f = facets({
      occasion: 'evening_party', climate: 'cold', season: 'fall', budget: 'budget', gender: 'feminine',
      persona: 'compare #1 and #2 for my mum', likes: { amber_oriental: 0.9 },
    });
    assert.equal(describeNeeds(f), 'an evening party in cold weather');
    assert.equal(describeNeeds(facets({ season: 'fall', likes: { amber_oriental: 0.9 } })), 'autumn and a love of warm amber scents');
    assert.equal(describeNeeds(facets()), '');
    const { text } = renderCompare([catalog.get('A')!, catalog.get('C')!], 'A', 0.9, describeFacets(f, 'user'));
    assert.match(text, /^For an evening party in cold weather, I'd lean towards \*\*Ember Nocturne\*\*\./);
    assert.doesNotMatch(text, /budget:|about the wearer|compare #1|season: fall|\(/);
  });

  it('end to end: a first-message compare', async () => {
    const script: Script = (k, _s, q) => (k === 'intent' ? 'compare' : k === 'winner' ? Object.keys((q as { criteria: object }).criteria)[0] : k.startsWith('ref_') ? 'asking' : undefined);
    const r = await new PerfumeBot(catalog, scriptedJev(script)).chat(undefined, 'Compare Ember Nocturne and Quiet Musk');
    assert.match(r.reply.text, /^Overall, I'd lean towards \*\*/);
  });
});

// ---------------------------------------------------------------------------
// Finding 38 - grammar
// ---------------------------------------------------------------------------

describe('grammar', () => {
  it('no "a autumn" in the measured season bullet', () => {
    const r = rec(catalog.get('A')!, [{ kind: 'season', weight: 1, data: { season: 'fall', share: 44, rank: 1 } }]);
    const b = bullets(r, facets(), 3, { measured: true })[0]!;
    assert.doesNotMatch(b, /\ba autumn/);
    assert.match(b, /autumn/);
  });

  it('longevity is never a bare "moderate"', () => {
    const fr = makeFragrance({ pid: 'M', name: 'Mid', brand: 'X', sillageV: { moderate: 10 }, longevityV: { weak: 10, moderate: 10 } });
    assert.equal(performancePhrase(fr), 'moderate projection, moderate longevity');
    const r = rec(fr, [{ kind: 'longevity', weight: 1, data: { longevity: 'moderate' } }]);
    assert.ok(bullets(r, facets()).includes('Performance: moderate projection, moderate longevity'));
    assert.match(renderExplain(fr, undefined).text, /\*\*Performance:\*\* moderate projection, moderate longevity\./);
  });

  it('tier and value: no double parentheses', () => {
    const fr = makeFragrance({ pid: 'N', name: 'Niche', brand: 'X', priceTier: 'niche', valueV: { ok: 10, good_value: 3, overpriced: 3 } });
    const style = renderExplain(fr, undefined).text.split('\n').find((l) => l.startsWith('**Style:**'))!;
    assert.doesNotMatch(style, /\) \(/);
    assert.match(style, /niche \(premium-priced\) — fair value\.$/);
  });

  it('notes and pros keep their proper nouns', () => {
    const fr = makeFragrance({
      pid: 'P', name: 'Colonia Test', brand: 'X', pros: ['Refined Italian cologne elegance'], cons: ['Short on Virginia Cedar'],
      notes: { top: ['Bergamot'], middle: ['Turkish Rose', 'Jasmine'], base: ['Virginia Cedar', 'Musk'] },
    });
    const r = rec(fr, [{ kind: 'note', weight: 1, data: { notes: ['Turkish Rose', 'Jasmine', 'Virginia Cedar'], wanted: 0 } }]);
    assert.match(bullets(r, facets()).join(' '), /Key notes: Turkish Rose, Jasmine and Virginia Cedar/);
    const text = renderExplain(fr, undefined).text;
    assert.match(text, /Refined Italian cologne elegance/);
    assert.match(text, /Short on Virginia Cedar/);
  });

  it('no "Officially unisex, with a unisex character"', () => {
    const fr = makeFragrance({ pid: 'U', name: 'Uni', brand: 'X', gender: 'unisex', genderV: { unisex: 10 } });
    const r = rec(fr, [{ kind: 'gender', weight: 1, data: { gender: 'feminine' } }]);
    for (const measured of [false, true]) {
      const b = bullets(r, facets(), 3, { measured }).find((x) => x.startsWith('Officially'))!;
      assert.doesNotMatch(b, /unisex.*unisex/);
    }
  });
});

// ---------------------------------------------------------------------------
// Fuzz: the shipped seed catalog and a csv catalog with unvoted records
// ---------------------------------------------------------------------------

describe('fuzz over scripted requests', () => {
  let seed: Catalog;
  let csv: Catalog;
  before(async () => {
    seed = await loadCatalog({ source: 'seed', seedDir: 'data/catalog', log: () => {} });
    const bare = [...seed.fragrances].slice(0, 30).map((f, i) => ({
      ...unvoted(`z${i}`, `Unvoted ${i}`), notes: f.notes, accords: i % 2 ? [] : f.accords, gender: f.gender,
    }));
    csv = new Catalog([...seed.fragrances, ...bare], 'csv', stats(seed.size + bare.length));
  });

  const OCC = ['evening_party', 'formal_event', 'office', 'date_night', 'wedding', 'casual_daily', 'outdoor_active', 'travel', 'any'];
  const CLI = ['cold', 'mild', 'hot_dry', 'hot_humid', 'any'];
  const SEA = ['winter', 'spring', 'summer', 'fall', 'any'];
  const LEADS = ['occasion', 'climate', 'persona', 'taste', 'value', 'general'];
  const MSGS: Array<[string, string]> = [
    ['I love rose', 'wants'], ['I want something with apple', 'wants'], ['I love honey', 'wants'], ['no rose please', 'avoids'],
    ['something with rum', 'wants'], ['I like tea', 'wants'], ['I love orange', 'wants'], ['a perfume please', 'not_a_note'],
  ];
  const STATS = /\d+% of|Rated \d|by [\d,]+ people|[Cc]ommunity|People love/;
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

  it('never prints broken, invented or contradictory text', async () => {
    let r = 42;
    const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const problems: string[] = [];
    for (let i = 0; i < 120; i++) {
      const cat = i % 2 ? csv : seed;
      const measured = cat.source !== 'seed';
      const [msg, polarity] = pick(MSGS);
      const script: Record<string, string | number> = {
        occasion: pick(OCC), climate: pick(CLI), season: pick(SEA), time_of_day: pick(['day', 'night', 'any']),
        age_style: pick(['youthful', 'contemporary', 'mature_elegant', 'any']), budget: pick(['budget', 'mid', 'luxury', 'any']),
        lead: pick(LEADS), climate_fit: 0.5 + rnd() * 0.5, persona_fit: 0.9, note_0: polarity,
        [`like_${pick(Object.keys(FAMILY_DEFS))}`]: 0.6 + rnd() * 0.4,
      };
      let cur: Script = script;
      const bot = new PerfumeBot(cat, scriptedJev((k, s, q) => (typeof cur === 'function' ? cur(k, s, q) : cur[k])));
      const res = await bot.chat(undefined, msg);
      const f = (res.reply.debug as { understanding: { facets: Facets } }).understanding.facets;
      const cards = res.reply.recommendations.map((c) => [c.headline, ...c.bullets].join(' | '));
      const texts = [res.reply.text, ...cards];
      const shown = res.reply.recommendations;
      if (shown.length >= 2) {
        cur = { ...script, intent: 'explain' };
        texts.push((await bot.chat(res.sessionId, 'tell me more about the second one')).reply.text);
        cur = (k) => (k === 'intent' ? 'compare' : k === 'winner' ? `p_${shown[0]!.pid}` : script[k]);
        texts.push((await bot.chat(res.sessionId, 'compare #1 and #2')).reply.text);
      }
      const all = texts.join('\n');
      const where = `${cat.source} ${JSON.stringify(script)} "${msg}"`;
      const bad = (what: string, re: RegExp, text = all) => { const m = re.exec(text); if (m) problems.push(`${what}: "${text.slice(Math.max(0, m.index - 50), m.index + 40)}" (${where})`); };
      bad('undefined/NaN', /undefined|NaN|\[object/);
      bad('a/an', /\ba a\b|\ba [aeio]\w/i);
      bad('empty part', /; ;|: ;|\(\)|: \.|, ;|\) \(/);
      bad('facet dump', /no specific constraints|budget: budget|about the wearer/);
      if (!measured) bad('statistic in seed mode', STATS);
      if (f.climate === 'mild' && f.season === 'any') bad('heat on a mild request', /heat|summer/i, cards.join('\n'));
      if (f.timeOfDay === 'day') bad('evening on a daytime request', /evening|date night/i, cards.join('\n'));
      if (f.timeOfDay === 'night') bad('daytime on an evening request', /daytime/i, cards.join('\n'));
      res.reply.recommendations.forEach((c, j) => {
        const fr = cat.get(c.pid)!;
        const notes = [...fr.notes.top, ...fr.notes.middle, ...fr.notes.base].map(norm);
        const m = /Features (.+?), as you asked/.exec(cards[j]!);
        for (const said of m ? m[1]!.split(/, | and /) : []) {
          if (!notes.includes(norm(said))) problems.push(`"${said}" is not a note of ${fr.name}`);
          if (!f.likedNotes.some((w) => norm(said).includes(norm(w)))) problems.push(`"${said}" was not asked for (${f.likedNotes})`);
        }
        for (const fam of dominantFamilies(fr, 3)) {
          const def = FAMILY_DEFS[fam];
          if (def.material && cards[j]!.toLowerCase().includes(def.phrase) && familyPhrase(fr, fam) !== def.phrase) {
            problems.push(`${fr.name} is called "${def.phrase}"`);
          }
        }
      });
    }
    assert.deepEqual(problems.slice(0, 10), []);
  });

  it('material phrases on the seed catalog are backed by the record', () => {
    const EVIDENCE: Array<[string, RegExp]> = [
      ['leather', /\b(leather|suede)\b/], ['aquatic', /\b(aquatic|marine|ozonic|salty|sea|calone|salt)\b/], ['musky', /\b(musk|musky|ambrette)\b/],
      ['rosy', /\broses?\b/], ['smoky', /\b(oud|smoky|smoke|tobacco|agarwood|birch tar|incense|cade|guaiac|frankincense|olibanum)\b/],
      ['aldehydic', /\baldehyd/], ['warm amber', /\b(amber|balsamic|benzoin|labdanum|myrrh|opoponax|olibanum|frankincense|incense|balsam|styrax|cistus)\b/],
    ];
    for (const fr of seed.fragrances) {
      const own = [...fr.notes.top, ...fr.notes.middle, ...fr.notes.base, ...fr.accords.map((a) => a.name)].join(' ').toLowerCase();
      for (const fam of dominantFamilies(fr, 3)) {
        const phrase = familyPhrase(fr, fam);
        for (const [word, ev] of EVIDENCE) if (phrase.includes(word)) assert.match(own, ev, `${fr.name} called "${phrase}"`);
      }
    }
  });

  it('keeps the material phrase where it is true', () => {
    const withLeather = [...seed.fragrances].filter((fr) => dominantFamilies(fr, 3).includes('leather') && fr.accords.some((a) => a.name === 'leather'));
    assert.ok(withLeather.length > 0);
    for (const fr of withLeather) assert.equal(familyPhrase(fr, 'leather'), 'refined leather', fr.name);
  });
});

describe('review follow-ups (integration)', () => {
  it('rock rose and lily of the valley are different plants', () => {
    assert.equal(noteMatches('Rock Rose', 'rose'), false);
    assert.equal(noteMatches('Lily of the Valley', 'lily'), false);
    assert.equal(noteMatches('Water Lily', 'lily'), false);
    assert.equal(noteMatches('Turkish Rose', 'rose'), true);
    assert.equal(noteMatches('Lily', 'lily'), true);
    assert.equal(noteMatches('Lily of the Valley', 'lily of the valley'), true);
    assert.equal(noteMatches('Rock Rose', 'rock rose'), true);
  });
});
