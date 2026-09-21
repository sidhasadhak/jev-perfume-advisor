/**
 * The TODO.md backlog from the live red-team run: questions the app used to answer
 * with four perfumes (safety, knowledge, requirements it cannot check, brands and
 * flankers it does not carry, attribute comparisons) and the conversation slips.
 * Jev is scripted; the catalog is the test fixtures plus a few real-shaped records.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Catalog } from '../src/catalog/catalog.js';
import { parseRemindsOf } from '../src/catalog/fragdb.js';
import { loadCatalog } from '../src/catalog/loader.js';
import { JevError } from '../src/jev/client.js';
import { MockJev } from '../src/jev/mock.js';
import { compose, followUpPool } from '../src/pipeline/compose.js';
import { FOLLOW_UPS } from '../src/pipeline/followups.js';
import { NOTE_GLOSSARY, renderKnowledge, renderSafety, requirementLine } from '../src/pipeline/knowledge.js';
import { NoteLexicon, candidateSpans, concentrationTerms, mayExpressDislike } from '../src/pipeline/lexicon.js';
import { PerfumeBot } from '../src/pipeline/orchestrator.js';
import { knownAlternative, renderCompare, renderRecommendations } from '../src/pipeline/render.js';
import { SessionStore } from '../src/pipeline/session.js';
import type { Trace } from '../src/pipeline/trace.js';
import { TOPIC, understand, wearerPhrases } from '../src/pipeline/understand.js';
import type { Facets, Fragrance } from '../src/types.js';
import { EMPTY_FACETS } from '../src/types.js';
import { FIXTURES, makeFragrance, scriptedJev, type Script } from './helpers.js';

const A = (pairs: Array<[string, number]>) => pairs.map(([name, strength]) => ({ name, strength }));

/** Real-shaped records: a clone and its original, a house with one perfume, a budget scent. */
const EXTRA: Fragrance[] = [
  makeFragrance({
    pid: 'ORIG', name: 'Grand Cru', brand: 'Maison Rare', gender: 'unisex', priceTier: 'niche', perfumers: ['Anne Nez'], year: 2015,
    accords: A([['amber', 100], ['woody', 80], ['warm spicy', 60]]),
    notes: { top: ['Saffron', 'Jasmine'], middle: ['Amberwood'], base: ['Fir Resin', 'Cedar'] },
    seasonV: { winter: 8000, fall: 7000, spring: 3000, summer: 1500 }, nightShare: 0.7,
    sillageV: { strong: 5000, enormous: 3000 }, longevityV: { long_lasting: 5000, eternal: 3000 },
  }),
  makeFragrance({
    pid: 'CLONE', name: 'Red Echo', brand: 'High Street', gender: 'unisex', priceTier: 'budget',
    accords: A([['amber', 100], ['woody', 75], ['warm spicy', 55]]),
    notes: { top: ['Saffron'], middle: ['Jasmine'], base: ['Amberwood', 'Cedar'] },
    seasonV: { winter: 7000, fall: 6000, spring: 2500, summer: 1200 }, nightShare: 0.65,
    sillageV: { moderate: 5000, strong: 3000 }, longevityV: { moderate: 5000, long_lasting: 3000 },
    remindsOf: [{ pid: 'ORIG', yes: 1000, no: 100 }],
  }),
];
const catalog = new Catalog([...FIXTURES, ...EXTRA], 'seed', { fragrances: FIXTURES.length + EXTRA.length, brands: 13, dropped: 0, unresolvedNotes: 0, unresolvedAccords: 0 });
const lexicon = new NoteLexicon(catalog);
const facets = (p: Partial<Facets>): Facets => ({ ...structuredClone(EMPTY_FACETS), ...p });

type Debug = { understanding: { intent: string; route: string; facets: Facets }; trace: Trace };
const debugOf = (r: { reply: { debug?: unknown } }) => r.reply.debug as Debug;

function scriptedBot() {
  let script: Script = {};
  const bot = new PerfumeBot(catalog, scriptedJev((k, s, q) => (typeof script === 'function' ? script(k, s, q) : script[k])));
  return { bot, set: (s: Script) => { script = s; } };
}

/** Runs one turn of `bot` with `script`, optionally continuing `sid`. */
async function turn(b: ReturnType<typeof scriptedBot>, message: string, script: Script, sid?: string) {
  b.set(script);
  return b.bot.chat(sid, message);
}

const shipped = await loadCatalog({ source: 'seed', seedDir: fileURLToPath(new URL('../data/catalog/', import.meta.url)), log: () => {} });
const names = (xs: Array<{ fragrance: Fragrance }>) => xs.map((m) => m.fragrance.name);

// ---------------------------------------------------------------------------
// P0: wrong perfume swapped in
// ---------------------------------------------------------------------------

describe('name matching never swaps in another perfume', () => {
  it('"Sauvage" is not "Eau Sauvage", in either direction', () => {
    assert.deepEqual(names(shipped.mentionedIn('Which lasts longer, Sauvage or Bleu de Chanel?')).sort(), ['Bleu de Chanel Eau de Parfum', 'Sauvage']);
    assert.deepEqual(names(shipped.mentionedIn('Tell me about Eau Sauvage')), ['Eau Sauvage']);
    assert.deepEqual(names(shipped.mentionedIn('Is Dior Sauvage worth it?')), ['Sauvage']);
  });

  it('flags a name the text carries on past ("Coco Noir", "Angel Nova") as a possible other perfume', () => {
    const coco = shipped.mentionedIn('Tell me about Chanel Coco Noir');
    assert.deepEqual(names(coco), ['Coco']);
    assert.equal(coco[0]!.continuation?.display, 'Coco Noir');
    assert.equal(shipped.mentionedIn('I love Mugler Angel Nova')[0]!.continuation?.display, 'Angel Nova');
    assert.equal(shipped.mentionedIn('Is Dior Sauvage EDP worth it?')[0]!.continuation?.display, 'Sauvage EDP');
  });

  it('does not flag a name that is simply written out in full, or a longer catalog name', () => {
    // Our record IS the EDP: naming its concentration is the same perfume.
    const bleu = shipped.mentionedIn('Bleu de Chanel EDP or Aventus?');
    assert.equal(bleu.find((m) => m.fragrance.name.startsWith('Bleu'))!.continuation, undefined);
    assert.deepEqual(names(shipped.mentionedIn('Tell me about Coco Mademoiselle')), ['Coco Mademoiselle']);
    // "Sauvage" inside "Sauvage Elixir" belongs to it; the separate "Sauvage" is plain Sauvage.
    const both = shipped.mentionedIn('Sauvage Elixir vs Sauvage');
    assert.deepEqual(names(both).sort(), ['Sauvage', 'Sauvage Elixir']);
    assert.ok(both.every((m) => !m.continuation));
    assert.equal(shipped.mentionedIn('Is Aventus or Layton better?')[0]!.continuation, undefined);
  });

  it('a variant Jev confirms is never described as the catalog perfume', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'Tell me about Ember Nocturne Noir', { intent: 'explain', ref_0: 'asking', variant_0: 0.9 });
    assert.match(r.reply.text, /I don't have Ember Nocturne Noir in my catalog - only Ember Nocturne by Maison Test/);
    assert.doesNotMatch(r.reply.text, /Notes:/);
    assert.deepEqual(r.reply.followUps, ['Tell me more about Ember Nocturne by Maison Test', 'More like Ember Nocturne by Maison Test']);
    assert.equal(debugOf(r).understanding.route, 'unresolved:variant');
  });

  it('a variant used as a reference is set aside, and the reply says so', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'I love Ember Nocturne Noir - what else would I like?', { intent: 'more_like', ref_0: 'similar', variant_0: 0.9 });
    assert.deepEqual(debugOf(r).understanding.facets.referencePids, []);
    assert.match(r.reply.text, /^I don't have Ember Nocturne Noir - only Ember Nocturne by Maison Test, which is a different scent/);
    assert.doesNotMatch(r.reply.text, /If you love Ember Nocturne/);
    // Having said the original is a different scent, it is not offered as a pick either.
    assert.ok(!r.reply.recommendations.some((c) => c.pid === 'A'));
  });

  it('when Jev says the extra words are part of the same perfume, it is used as normal', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'Tell me about Ember Nocturne Noir', { intent: 'explain', ref_0: 'asking', variant_0: 0.1 });
    assert.match(r.reply.text, /^\*\*Ember Nocturne\*\* by Maison Test/);
  });

  it('"Sauvage EDT vs EDP" is a concentration question about the one version we carry', async () => {
    const cat = new Catalog([...FIXTURES, makeFragrance({ pid: 'SV', name: 'Sauvage', brand: 'Dior', gender: 'men', priceTier: 'luxury' }),
      makeFragrance({ pid: 'ES', name: 'Eau Sauvage', brand: 'Dior', gender: 'men', priceTier: 'luxury' })], 'seed',
    { fragrances: 14, brands: 12, dropped: 0, unresolvedNotes: 0, unresolvedAccords: 0 });
    const bot = new PerfumeBot(cat, scriptedJev({ intent: 'compare', ref_0: 'asking' }));
    const r = await bot.chat(undefined, 'Dior Sauvage EDT vs EDP - which one is better?');
    assert.match(r.reply.text, /I only carry one version of \*\*Sauvage\*\* by Dior, so I can't compare its EDT and EDP side by side/);
    assert.doesNotMatch(r.reply.text, /Eau Sauvage/);
    assert.equal((r.reply.debug as Debug).understanding.route, 'knowledge:concentration');
  });

  it('short names in a list are all compared once Jev says a name was left out ("... and Eros")', async () => {
    const u = await understand({
      message: 'Rank these for summer: Sauvage, Aventus, Acqua di Gio and Eros', session: new SessionStore().getOrCreate(), catalog: shipped,
      lexicon: new NoteLexicon(shipped), decider: scriptedJev((k) => (k === 'intent' ? 'compare' : /^ref_/.test(k) ? 'asking' : k === 'unknown_perfume' ? 0.9 : k === 'compare_on' ? 'season' : k === 'season' ? 'summer' : undefined)),
    });
    assert.equal(u.intent, 'compare');
    const got = u.focusPids.map((p) => shipped.get(p)!.name).sort();
    assert.deepEqual(got, ['Acqua di Giò', 'Aventus', 'Eros', 'Sauvage']);
  });
});

// ---------------------------------------------------------------------------
// P0: health and safety
// ---------------------------------------------------------------------------

describe('health and safety questions get no products and no reassurance', () => {
  for (const [kind, message] of [
    ['pregnancy', 'Which perfumes are safe to wear while pregnant?'],
    ['child', 'A gentle perfume for my 6 month old baby'],
    ['pet', 'A perfume I can spray on my dog'],
    ['medical', 'Is Ember Nocturne safe for my asthma?'],
  ] as const) {
    it(`${kind}: ${message}`, async () => {
      const b = scriptedBot();
      const r = await turn(b, message, { intent: 'recommend', safety: kind, tone: 'reassuring' });
      assert.deepEqual(r.reply.recommendations, []);
      assert.doesNotMatch(r.reply.text, /good hands|No problem at all|Happy to help you narrow/);
      assert.match(r.reply.text, kind === 'pet' ? /vet/ : /doctor|paediatrician|pharmacist/);
      assert.equal(debugOf(r).understanding.route, `safety:${kind}`);
    });
  }

  it('a baby read as the wearer\'s age is a safety question too', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'perfume for my 8 year old daughter', { intent: 'recommend', age_style: 'child', gender: 'feminine' });
    assert.equal(debugOf(r).understanding.route, 'safety:child');
    assert.deepEqual(r.reply.recommendations, []);
  });

  it('a safety question about a named perfume is still a safety answer, not its card', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'Is Ember Nocturne safe to wear while breastfeeding?', { intent: 'explain', ref_0: 'asking', safety: 'pregnancy' });
    assert.doesNotMatch(r.reply.text, /Notes:|Strengths:/);
    assert.match(r.reply.text, /including Ember Nocturne/);
  });

  it('safety turns do not change what we know about the user, and offer light scents only as a choice', async () => {
    const b = scriptedBot();
    const first = await turn(b, 'office perfume', { intent: 'recommend', occasion: 'office' });
    const r = await turn(b, 'is it safe while pregnant?', { intent: 'recommend', safety: 'pregnancy', occasion: 'any', same_wearer: 0.9 }, first.sessionId);
    assert.deepEqual(r.reply.followUps, [FOLLOW_UPS.lighter_scents.text]);
    assert.equal(b.bot.sessions.getOrCreate(first.sessionId).facets.occasion, 'office');
  });

  it('"migraines - is there anything I can wear?" gets light picks with a caveat, not a refusal', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'Perfume gives me migraines. Is there anything I can wear?', { intent: 'recommend', safety: 'sensitive', tone: 'reassuring' });
    assert.equal(debugOf(r).understanding.route, 'recommend');
    assert.ok(r.reply.recommendations.length > 0);
    assert.match(r.reply.text, /^I can't give medical advice, and I don't have allergen or ingredient data for any perfume/);
    assert.match(r.reply.text, /lighter, softer options - not a guarantee/);
    assert.doesNotMatch(r.reply.text, /good hands|No problem at all/);
    const safety = debugOf(r).trace.levers.flatMap((g) => g.items).find((i) => i.key === 'safety')!;
    assert.equal(safety.status, 'used');
  });

  it('an "alcohol-free" Jev infers from a sensitivity never blocks every spray; the user\'s own words do', async () => {
    const b = scriptedBot();
    const inferred = await turn(b, 'Perfume gives me migraines. Is there anything I can wear?', { intent: 'recommend', safety: 'sensitive', requirement: 'alcohol_free' });
    assert.ok(inferred.reply.recommendations.length > 0);
    assert.match(inferred.reply.text, /^I can't give medical advice/);
    const said = await turn(b, 'I need an alcohol-free perfume', { intent: 'recommend', requirement: 'alcohol_free' });
    assert.deepEqual(said.reply.recommendations, []);
  });

  it('every safety reply declines to judge and points to a professional', () => {
    for (const k of ['pregnancy', 'child', 'pet', 'medical'] as const) {
      const t = renderSafety(k).text;
      assert.match(t, /can't|don't/, k);
      assert.doesNotMatch(t, /good hands|No problem|perfectly safe|is safe to wear|are safe to wear/i, k);
    }
  });
});

// ---------------------------------------------------------------------------
// P0: requirements the catalog cannot check
// ---------------------------------------------------------------------------

describe('requirements the catalog cannot check are admitted, never implied as met', () => {
  it('alcohol-free / halal: no sprays presented as the answer, and an offer instead', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'An alcohol-free perfume for Friday prayers, something woody', { intent: 'recommend', requirement: 'alcohol_free', like_woody: 0.9 });
    assert.deepEqual(r.reply.recommendations, []);
    assert.match(r.reply.text, /I don't have data on alcohol content/);
    assert.deepEqual(r.reply.followUps, [FOLLOW_UPS.sprays_anyway.text]);
    // The request itself is kept, so the offer can be taken up.
    const next = await turn(b, FOLLOW_UPS.sprays_anyway.text, {}, r.sessionId);
    assert.ok(next.reply.recommendations.length > 0);
    assert.ok('woody' in debugOf(next).understanding.facets.likes);
  });

  it('"Are any of these alcohol-free?" after a list is answered, not met with a new list', async () => {
    const b = scriptedBot();
    const first = await turn(b, 'something woody', { intent: 'recommend', like_woody: 0.9 });
    const r = await turn(b, 'Are any of these alcohol-free?', { intent: 'refine', requirement: 'alcohol_free' }, first.sessionId);
    assert.deepEqual(r.reply.recommendations, []);
    assert.deepEqual(b.bot.sessions.getOrCreate(first.sessionId).lastShown, first.reply.recommendations.map((c) => c.pid));
  });

  it('vegan / natural / hypoallergenic: the caveat leads, picks follow, and no cheerful opener', async () => {
    for (const kind of ['vegan_cruelty_free', 'natural', 'hypoallergenic', 'format'] as const) {
      const b = scriptedBot();
      const r = await turn(b, 'a perfume for my girlfriend', { intent: 'recommend', requirement: kind, tone: 'reassuring', gender: 'feminine' });
      assert.ok(r.reply.recommendations.length > 0, kind);
      assert.match(r.reply.text, /^I (don't|only carry)/, kind);
      assert.doesNotMatch(r.reply.text, /No problem at all|good hands/, kind);
    }
  });

  it('a requirement asked about one perfume is answered about that perfume', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'Is Ember Nocturne vegan?', { intent: 'explain', ref_0: 'asking', requirement: 'vegan_cruelty_free' });
    assert.match(r.reply.text, /I don't have vegan or cruelty-free certification data for \*\*Ember Nocturne\*\*/);
    assert.deepEqual(r.reply.recommendations, []);
  });
});

// ---------------------------------------------------------------------------
// P1: general perfume questions
// ---------------------------------------------------------------------------

describe('general perfume questions get an answer, not four perfumes', () => {
  const vetted: Array<[string, string, RegExp]> = [
    ['How can I make my perfume last longer?', 'longevity_tips', /moisturised skin/],
    ['What is the difference between EDP and EDT?', 'concentration', /Eau de parfum \(EDP\)\*\*: roughly 15-20%/],
    ['How should I store my perfume, and does it expire?', 'storage_expiry', /cool, dark and dry/],
    ["Why can't I smell my own perfume after a few minutes?", 'nose_fatigue', /nose fatigue/],
    ['What are top, middle and base notes?', 'notes_pyramid', /Top notes/],
    ['What perfume does Taylor Swift wear?', 'celebrity', /don't have reliable information on what particular people wear/],
    ['What are the newest perfume releases of 2025?', 'new_releases', /isn't a live feed/],
    ['I have oily skin - which perfume suits my skin type?', 'skin_type', /oilier skin usually holds it longer/],
    ['What is a sillage monster anyway?', 'other_question', /not able to answer that one reliably/],
  ];
  for (const [message, topic, expect] of vetted) {
    it(`${topic}: ${message}`, async () => {
      const b = scriptedBot();
      const r = await turn(b, message, { intent: 'knowledge', topic });
      assert.deepEqual(r.reply.recommendations, []);
      assert.match(r.reply.text, expect);
      assert.equal(debugOf(r).understanding.route, `knowledge:${topic}`);
    });
  }

  it('a knowledge topic Jev is sure of wins over a "recommend" intent', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'What does oud actually smell like?', { intent: 'recommend', topic: 'note_description', like_oud_smoky: 0.9 });
    assert.equal(r.reply.text, NOTE_GLOSSARY.oud);
    assert.deepEqual(r.reply.followUps, ['Show me perfumes with oud']);
  });

  it('a question about a perfume we have, with no general topic, shows its card ("how many hours does it last?")', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'How many hours does Grand Cru last on skin?', { intent: 'knowledge', ref_0: 'asking' });
    assert.equal(debugOf(r).understanding.route, 'explain');
    assert.match(r.reply.text, /\*\*Performance:\*\* enormous projection, very long-lasting\./);
  });

  it('"Do you have <a perfume we lack>?" says we don\'t have it, in the user\'s words', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'Do you have Kayali Vanilla 28?', (k, _s, q) => {
      if (k === 'perfume_name' && q.type === 'choice') return Object.entries(q.criteria).find(([, v]) => v === 'Kayali Vanilla 28')![0];
      return k === 'intent' ? 'knowledge' : k === 'topic' ? 'other_question' : k === 'unknown_perfume' ? 0.9 : undefined;
    });
    assert.match(r.reply.text, /^I don't have Kayali Vanilla 28 in my catalog/);
    assert.equal(debugOf(r).understanding.route, 'unresolved:perfume');
  });

  it('the catch-all topic does not swallow a question about a perfume we have', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'How many hours does Grand Cru last on skin?', { intent: 'knowledge', topic: 'other_question', ref_0: 'asking' });
    assert.equal(debugOf(r).understanding.route, 'explain');
  });

  it('a topic Jev is unsure of does not hijack a real request', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'a long-lasting perfume for the office', { intent: 'recommend', topic: 'longevity_tips', occasion: 'office' }, undefined);
    // toAnswer puts 0.9 on the scripted option; at 0.5 confidence a topic is not sure enough.
    const low = new PerfumeBot(catalog, scriptedJev({ intent: 'recommend', topic: 'longevity_tips', occasion: 'office' }, 0.5));
    const r2 = await low.chat(undefined, 'a long-lasting perfume for the office');
    assert.equal(debugOf(r).understanding.route, 'knowledge:longevity_tips');
    assert.ok(r2.reply.recommendations.length > 0);
  });

  it('questions about a named perfume use its record: who made it, fakes, price, reformulation, dupes', async () => {
    const b = scriptedBot();
    const who = await turn(b, 'Who made Grand Cru and when?', { intent: 'explain', ref_0: 'asking', topic: 'creator_year' });
    assert.equal(who.reply.text, '**Grand Cru** by Maison Rare was created by Anne Nez and launched in 2015.');
    const fake = await turn(b, 'How can I tell if my Grand Cru is fake?', { intent: 'explain', ref_0: 'asking', topic: 'authenticity' });
    assert.match(fake.reply.text, /batch code/);
    assert.match(fake.reply.text, /genuine \*\*Grand Cru\*\* by Maison Rare should smell amber, woody and warm spicy/);
    const price = await turn(b, 'Where can I buy Grand Cru cheapest?', { intent: 'explain', ref_0: 'asking', topic: 'price_where' });
    assert.match(price.reply.text, /I don't have store prices/);
    assert.doesNotMatch(price.reply.text, /[$€£]\s?\d/);
    const dupe = await turn(b, 'What is Red Echo a clone of?', { intent: 'explain', ref_0: 'asking', topic: 'dupe' });
    assert.match(dupe.reply.text, /\*\*Red Echo\*\* by High Street is widely seen as an alternative to \*\*Grand Cru\*\* by Maison Rare/);
    const noDupe = await turn(b, 'What is Quiet Musk a clone of?', { intent: 'explain', ref_0: 'asking', topic: 'dupe' });
    assert.match(noDupe.reply.text, /I don't have \*\*Quiet Musk\*\* by Studio Clean listed as a known dupe/);
  });

  it('layering two perfumes we have says what they share and which goes first; no new picks', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'Can I layer Grand Cru with Red Echo?', { intent: 'knowledge', topic: 'layering', ref_0: 'asking', ref_1: 'asking' });
    assert.match(r.reply.text, /share amber, woody and warm spicy accords/);
    assert.match(r.reply.text, /Spray the heavier one/);
    assert.deepEqual(r.reply.recommendations, []);
  });

  it('a perfume\'s name is not a note request ("layer with Tobacco Vanille" does not ask for tobacco)', () => {
    const masked = shipped.maskNames('What can I layer with Tobacco Vanille?', shipped.mentionedIn('What can I layer with Tobacco Vanille?').map((m) => m.fragrance.pid));
    assert.deepEqual(new NoteLexicon(shipped).find(masked), []);
  });

  it('every topic has a vetted answer, and none recommends', () => {
    for (const topic of Object.keys(TOPIC).filter((t) => t !== 'none')) {
      const out = renderKnowledge({ topic: topic as never, frs: [], notes: [], message: 'x', catalog });
      assert.ok(out.text.length > 30, topic);
      assert.deepEqual(out.recommendations, [], topic);
    }
  });
});

// ---------------------------------------------------------------------------
// P1: explain fallback, repeated cards
// ---------------------------------------------------------------------------

describe('explain never guesses #1 or repeats a card', () => {
  it('a question about "it" with no perfume Jev can point at asks which one', async () => {
    const b = scriptedBot();
    const first = await turn(b, 'party perfume', { intent: 'recommend', occasion: 'evening_party' });
    const r = await turn(b, 'Is it any good?', { intent: 'explain', focus: 'none' }, first.sessionId);
    assert.match(r.reply.text, /^Which one do you mean\?/);
    assert.equal(r.reply.followUps.length, first.reply.recommendations.length);
    assert.ok(r.reply.followUps.every((c) => c.startsWith('Tell me more about ')));
  });

  it('asking about the same perfume twice in a row does not print the same card again', async () => {
    const b = scriptedBot();
    const first = await turn(b, 'party perfume', { intent: 'recommend', occasion: 'evening_party' });
    const why = await turn(b, FOLLOW_UPS.why_top.text, {}, first.sessionId);
    const again = await turn(b, 'tell me more about the first one', { intent: 'explain' }, first.sessionId);
    assert.notEqual(again.reply.text, why.reply.text);
    assert.match(again.reply.text, /which I described just above/);
  });
});

// ---------------------------------------------------------------------------
// P1: compare on the attribute asked about
// ---------------------------------------------------------------------------

describe('compare answers the attribute that was asked about', () => {
  it('"Which of these lasts the longest?" ranks all four from the vote data, and changes no facet', async () => {
    const b = scriptedBot();
    const first = await turn(b, 'office perfume for my husband', { intent: 'recommend', occasion: 'office', gender: 'masculine' });
    const before = structuredClone(b.bot.sessions.getOrCreate(first.sessionId).facets);
    const r = await turn(b, 'Which of these lasts the longest?', { intent: 'compare', compare_on: 'longevity', longevity: 'very_long', projection: 'strong' }, first.sessionId);
    const shown = first.reply.recommendations.map((c) => c.name);
    assert.match(r.reply.text, /^Going by my catalog's performance data, /);
    for (const n of shown) assert.ok(r.reply.text.includes(n), `${n} is compared`);
    assert.doesNotMatch(r.reply.text, /comes down to taste/);
    assert.deepEqual(b.bot.sessions.getOrCreate(first.sessionId).facets, before, 'a compare writes nothing into the brief');
  });

  it('longevity follows the vote data even when every perfume gets the same word, and calls near-equal ones level', () => {
    const lv = (pid: string, long: number) => makeFragrance({ pid, name: `Scent ${pid}`, brand: 'House', longevityV: { moderate: 10_000 - long, long_lasting: long } });
    const [p, q, r] = [lv('P', 2000), lv('Q', 5000), lv('R', 7500)]; // all "long-lasting", in rising order
    const t = renderCompare([p, q, r], null, 0, '', { axis: 'longevity' }).text;
    assert.match(t, /\*\*Scent R\*\* lasts longest - though all of them are long-lasting\./);
    assert.match(t, /From longest- to shortest-lasting: Scent R, Scent Q, Scent P\./);
    const level = renderCompare([lv('S', 6000), lv('T', 6100)], null, 0, '', { axis: 'longevity' }).text;
    assert.match(level, /are about level on longevity/);
  });

  it('price compares by tier and says there are no store prices', () => {
    const [orig, clone] = [catalog.get('ORIG')!, catalog.get('CLONE')!];
    const t = renderCompare([orig, clone], null, 0, '', { axis: 'price' }).text;
    assert.match(t, /^\*\*Red Echo\*\* is the cheaper one \u2014 it's budget-friendly, while Grand Cru is a niche, premium-priced scent\./);
    assert.match(t, /price tier, not store prices/);
    const same = renderCompare([catalog.get('A')!, catalog.get('E')!], null, 0, '', { axis: 'price' }).text;
    assert.match(same, /^Both are luxury \/ prestige scents, and I don't have store prices/);
  });

  it('a dupe question uses the known link, not a taste verdict', () => {
    const t = renderCompare([catalog.get('CLONE')!, catalog.get('ORIG')!], null, 0, '', { axis: 'similarity' }).text;
    assert.match(t, /^Yes — \*\*Red Echo\*\* is widely seen as an alternative to \*\*Grand Cru\*\*: both are amber, woody and warm spicy\./);
    assert.doesNotMatch(t, /lean towards/);
    const unlinked = renderCompare([catalog.get('A')!, catalog.get('B')!], null, 0, '', { axis: 'similarity' }).text;
    assert.match(unlinked, /aren't a known dupe pair/);
  });

  it('season ranks every perfume for the season asked', () => {
    const frs = ['B', 'A', 'J', 'H'].map((p) => catalog.get(p)!);
    const t = renderCompare(frs, null, 0, '', { axis: 'season', season: 'summer' }).text;
    assert.match(t, /^For summer, \*\*(Citrus Riviera|Neroli Azzurro)\*\* is the best fit/);
    assert.match(t, /My order for summer: /);
    assert.match(t, /is really more of a winter scent/);
  });

  it('the best of poor fits for a season is not called "the best fit"', () => {
    const t = renderCompare(['B', 'J'].map((p) => catalog.get(p)!), null, 0, '', { axis: 'season', season: 'winter' }).text;
    assert.match(t, /^Neither is really a winter scent; \*\*(Citrus Riviera|Neroli Azzurro)\*\* comes closest/);
  });

  it('an overall compare of three or more ranks them by Jev\'s probabilities', () => {
    const frs = ['A', 'B', 'C'].map((p) => catalog.get(p)!);
    const t = renderCompare(frs, 'B', 0.7, 'the office', { ranking: { A: 0.1, B: 0.7, C: 0.2 } }).text;
    assert.match(t, /^For the office, I'd lean towards \*\*Citrus Riviera\*\*\.\nAfter it: Quiet Musk and Ember Nocturne, in that order\./);
  });

  it('a named perfume we do not carry is left out and said so', () => {
    const t = renderCompare(['A', 'B'].map((p) => catalog.get(p)!), 'A', 0.8, '', { missing: 'Kayali Vanilla 28' }).text;
    assert.match(t, /I don't have Kayali Vanilla 28 in my catalog, so I've left it out\./);
  });
});

// ---------------------------------------------------------------------------
// P1: brands and perfumes we do not carry
// ---------------------------------------------------------------------------

describe('brands and perfumes we do not carry are named, not ignored', () => {
  it('"the best Kayali perfume": says Kayali is not carried, in the user\'s own words', async () => {
    const b = scriptedBot();
    const r = await turn(b, "What's the best Kayali perfume?", (k, _s, q) => {
      if (k === 'other_brand') return 0.9;
      if (k === 'brand_name' && q.type === 'choice') return Object.entries(q.criteria).find(([, v]) => v === 'Kayali')![0];
      return k === 'intent' ? 'recommend' : undefined;
    });
    assert.match(r.reply.text, /^I don't carry Kayali yet, so I can't rank its perfumes\./);
    assert.doesNotMatch(r.reply.text, /No problem at all|good hands/);
  });

  it('never claims not to carry a brand whose name we might have ("Maison" alone, "Test")', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'something by Test please', { intent: 'recommend', other_brand: 0.9 });
    assert.doesNotMatch(r.reply.text, /I don't carry/);
  });

  it('"the best <house> perfume" for a house we carry shows only that house', async () => {
    const b = scriptedBot();
    const r = await turn(b, "What's the best Maison Test perfume?", { intent: 'recommend', wants_brand: 0.9 });
    assert.ok(r.reply.recommendations.length > 0);
    assert.ok(r.reply.recommendations.every((c) => c.brand === 'Maison Test'));
    assert.match(r.reply.text, /I only carry 2 perfumes from Maison Test\./);
  });

  it('an unknown perfume in a request is admitted before the picks', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'Do you have Kayali Vanilla 28?', (k, _s, q) => {
      if (k === 'unknown_perfume') return 0.9;
      if (k === 'perfume_name' && q.type === 'choice') return Object.entries(q.criteria).find(([, v]) => v === 'Kayali Vanilla 28')![0];
      return k === 'intent' ? 'recommend' : k === 'like_gourmand_sweet' ? 0.9 : undefined;
    });
    assert.match(r.reply.text, /^I don't have Kayali Vanilla 28 in my catalog, so I can't match it exactly\./);
  });

  it('a route that names nothing never makes the naming call (so it cannot fail unawaited)', async () => {
    const inner = scriptedJev({ intent: 'recommend', safety: 'pregnancy', other_brand: 0.9 });
    const labels: string[] = [];
    const decider = {
      mode: inner.mode,
      decide: ((state, qs, opts) => {
        labels.push(opts?.label ?? '');
        if (opts?.label === 'name') return Promise.reject(new JevError('Jev HTTP 401', 401));
        return inner.decide(state, qs, opts);
      }) as typeof inner.decide,
    };
    const r = await new PerfumeBot(catalog, decider).chat(undefined, 'Is Kayali safe while pregnant?');
    assert.equal((r.reply.debug as Debug).understanding.route, 'safety:pregnancy');
    assert.ok(!labels.includes('name'));
  });

  it('offers the user\'s own words to Jev as the deck of possible names', () => {
    assert.deepEqual(candidateSpans("What's the best Kayali perfume?"), ['Kayali']);
    assert.ok(candidateSpans('Do you have Kayali Vanilla 28?').includes('Kayali Vanilla 28'));
    assert.ok(candidateSpans('Which Bath & Body Works body mist is best?').includes('Bath & Body Works'));
    // A list is never offered as one name.
    assert.ok(!candidateSpans('Rank Sauvage, Aventus and Kayali Vanilla 28').some((x) => x.includes(',') || / and /.test(x)));
  });
});

// ---------------------------------------------------------------------------
// Budget as a limit; weak matches hedged
// ---------------------------------------------------------------------------

describe('a stated budget is a limit', () => {
  it('"under $60" never returns luxury or niche picks, and says when it ran short', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'something fresh under $60', { intent: 'recommend', budget: 'budget', like_citrus: 0.9 });
    const tiers = r.reply.recommendations.map((c) => catalog.get(c.pid)!.priceTier);
    assert.ok(tiers.every((t) => t === 'budget' || t === 'mid'), tiers.join());
    assert.match(r.reply.text, /Only 2 of these are within that budget; the rest are a step up in price\./);
  });

  it('"can you make it stronger?" keeps the budget limit', async () => {
    const b = scriptedBot();
    const first = await turn(b, 'something fresh under $60', { intent: 'recommend', budget: 'budget', like_citrus: 0.9 });
    const r = await turn(b, 'Can you make it stronger?', { intent: 'refine', refine: 'stronger' }, first.sessionId);
    assert.ok(r.reply.recommendations.every((c) => ['budget', 'mid'].includes(catalog.get(c.pid)!.priceTier)));
  });
});

// ---------------------------------------------------------------------------
// P2: conversation
// ---------------------------------------------------------------------------

describe('conversation slips', () => {
  it('two wearers in one message: asks who to start with, using their own words', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'I need two perfumes: a floral one for me and something woody for my husband.', { intent: 'recommend', two_wearers: 0.9 });
    assert.deepEqual(r.reply.recommendations, []);
    assert.deepEqual(r.reply.followUps, ['Start with a floral one for me', 'Start with something woody for my husband']);
    assert.deepEqual(wearerPhrases('One for my wife, one for my son'), ['one for my wife', 'one for my son']);
  });

  it('"actually, one I can wear all year round" clears the season', async () => {
    const b = scriptedBot();
    const first = await turn(b, 'A summer perfume for me', { intent: 'recommend', season: 'summer' });
    const r = await turn(b, "Actually I'd rather have one I can wear all year round", { intent: 'refine', drop_season: 0.9 }, first.sessionId);
    assert.equal(debugOf(r).understanding.facets.season, 'any');
  });

  it('a refinement\'s families are not presented as the user\'s taste', async () => {
    const b = scriptedBot();
    const first = await turn(b, 'a perfume for me', { intent: 'recommend' });
    const r = await turn(b, 'something warmer', { intent: 'refine', refine: 'warmer', lead: 'taste' }, first.sessionId);
    assert.deepEqual(debugOf(r).understanding.facets.refinedLikes.sort(), ['amber_oriental', 'spicy']);
    assert.doesNotMatch(r.reply.text, /Since you're drawn to/);
  });

  it('a self-contradicting brief is flagged, with lighter/stronger as the first chips', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'fresh and light for the gym but a beast-mode sweet gourmand', {
      intent: 'recommend', conflicting: 0.9, like_citrus: 0.9, like_gourmand_sweet: 0.9, occasion: 'outdoor_active',
    });
    assert.match(r.reply.text, /^Heads-up: some of what you asked for pulls in opposite directions - .+ versus .+, so I've aimed for a balance\./);
    assert.deepEqual(r.reply.followUps.slice(0, 2), [FOLLOW_UPS.lighter.text, FOLLOW_UPS.stronger.text]);
  });

  it('a French message: dislikes are asked about, notes are understood, and the reply says it is in English - once', async () => {
    assert.ok(mayExpressDislike('Il déteste la vanille et tout ce qui est sucré'));
    assert.deepEqual(new NoteLexicon(shipped).find('il déteste la vanille').map((n) => n.note), ['Vanilla']);
    const b = scriptedBot();
    const r1 = await turn(b, 'Un parfum pour mon mari', { intent: 'recommend', non_english: 0.9 });
    assert.match(r1.reply.text, /^I can only reply in English for now/);
    const r2 = await turn(b, 'Quelque chose de moins cher ?', { intent: 'refine', refine: 'cheaper', non_english: 0.9 }, r1.sessionId);
    assert.doesNotMatch(r2.reply.text, /only reply in English/);
  });

  it('the sarcastic "everyone wears these" gets an owning-the-miss opener, not "No problem at all"', async () => {
    const b = scriptedBot();
    const first = await turn(b, 'going out', { intent: 'recommend' });
    const r = await turn(b, 'Wow thanks, so I will smell like every other guy', { intent: 'refine', refine: 'more_unique', tone: 'apologetic' }, first.sessionId);
    assert.match(r.reply.text, /^(Fair point|Understood)/);
  });

  it('occasion openers only describe picks that fit them', () => {
    const rec = (pid: string) => ({ fragrance: catalog.get(pid)!, final: 0.8, retrieval: 0.8, judgement: { fit: 3, confidence: 0.8, facets: {} }, reasons: [] });
    const f = facets({ occasion: 'outdoor_active' });
    const composition = { lead: 'occasion' as const, tone: 'crisp' as const, clarify: null, tip: false, followUps: [] };
    // Heavy picks (oud-leather, gourmand, tuberose): the "fresh and light" opener would describe them wrongly.
    const heavy = renderRecommendations({ message: 'gym', facets: f, recs: ['H', 'D', 'K'].map(rec), composition, refs: [], gift: false });
    assert.doesNotMatch(heavy.text, /fresh and light is the way/);
    // Light picks: it fits, and is used.
    const light = renderRecommendations({ message: 'gym', facets: f, recs: ['B', 'I', 'J'].map(rec), composition, refs: [], gift: false });
    assert.match(light.text, /fresh and light is the way/);
  });
});

// ---------------------------------------------------------------------------
// Smaller open items
// ---------------------------------------------------------------------------

describe('open items from the code review', () => {
  it('distinctive two-word names rank as names even without the brand', () => {
    const cat = new Catalog([makeFragrance({ pid: 'BO', name: 'Black Orchid', brand: 'Tom Ford' }), makeFragrance({ pid: 'OW', name: 'Oud Wood', brand: 'Tom Ford', notes: { top: ['Oud'], middle: [], base: [] } })],
      'seed', { fragrances: 2, brands: 1, dropped: 0, unresolvedNotes: 0, unresolvedAccords: 0 });
    assert.equal(cat.mentionedIn('something like Black Orchid')[0]?.score, 0.8);
    assert.equal(cat.mentionedIn('I love Oud Wood')[0]?.score, 0.8);
  });

  it('/api/search finds N°19 by its number', () => {
    assert.equal(shipped.search('19')[0]?.fragrance.name, 'N°19');
  });

  it('follow-up chips that tie keep the pool\'s order, whatever order Jev lists its keys in', async () => {
    const f = facets({});
    const pool = followUpPool(f, []);
    const tie = new MockJev({
      resolver: (_s, key, q) => {
        if (key !== 'next' || q.type !== 'choice') return undefined;
        const keys = Object.keys(q.criteria).reverse(); // shuffled key order, equal probabilities
        return { type: 'choice', choice: keys[0]!, confidence: 0.1, probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])) };
      },
    });
    const c = await compose({ message: 'x', facets: f, recs: [], uncertain: [], gift: false, decider: tie });
    assert.deepEqual(c.followUps, pool.slice(0, 3));
  });

  it('a duplicated browser tab can fork its session: same history, separate from then on', () => {
    const store = new SessionStore();
    const s = store.getOrCreate();
    s.lastShown = ['A', 'B'];
    const copy = store.fork(s.id)!;
    assert.notEqual(copy.id, s.id);
    assert.deepEqual(copy.lastShown, ['A', 'B']);
    copy.lastShown.push('C');
    assert.deepEqual(s.lastShown, ['A', 'B']);
    assert.equal(store.fork('no-such-session-id'), undefined);
  });

  it('reads FragDB reminds_of links, strongest agreement first', () => {
    assert.deepEqual(parseRemindsOf('728:460:100;44034:1100:111;bad;9::'), [{ pid: '44034', yes: 1100, no: 111 }, { pid: '728', yes: 460, no: 100 }]);
    const cdnim = shipped.fragrances.find((f) => f.name === 'Club de Nuit Intense Man')!;
    assert.equal(shipped.get(cdnim.remindsOf![0]!.pid)!.name, 'Aventus');
  });

  it('knows the concentration words people use', () => {
    assert.deepEqual(concentrationTerms('Sauvage EDT vs EDP').sort(), ['edp', 'edt']);
    assert.deepEqual(concentrationTerms('Bleu de Chanel Eau de Parfum'), ['edp']);
  });

  it('the trace names the route and labels the new checks', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'Is it safe to wear perfume while pregnant?', { intent: 'knowledge', safety: 'pregnancy', topic: 'other_question' });
    const d = debugOf(r);
    assert.equal(d.understanding.route, 'safety:pregnancy');
    const group = d.trace.levers.find((g) => g.lever === 'Safety & requirements')!;
    const safety = group.items.find((i) => i.key === 'safety')!;
    assert.deepEqual([safety.label, safety.answer, safety.status], ['Health & safety', 'pregnancy', 'used']);
    const topic = d.trace.levers.flatMap((g) => g.items).find((i) => i.key === 'topic')!;
    assert.equal(topic.label, 'General question about');
  });
});

// ---------------------------------------------------------------------------
// Findings from the pre-merge review of this change (each reproduced, then fixed)
// ---------------------------------------------------------------------------

describe('review findings', () => {
  const shippedLexicon = new NoteLexicon(shipped);
  /** understand() on the real catalog, with Jev answering `ref_i` "asking" only for the perfumes the user named. */
  const understandShipped = (message: string, script: Record<string, string | number>, named: string[] = []) => {
    const refNames = shipped.mentionedIn(message, 5).map((m) => m.fragrance.name);
    return understand({
      message, session: new SessionStore().getOrCreate(), catalog: shipped, lexicon: shippedLexicon,
      decider: scriptedJev((k) => {
        if (/^ref_\d+$/.test(k)) return named.includes(refNames[Number(k.slice(4))]!) ? 'asking' : 'incidental';
        return script[k];
      }),
    });
  };
  const shippedBot = (script: Script) => new PerfumeBot(shipped, scriptedJev(typeof script === 'function' ? script : (k) => script[k]));

  it('a name inside a longer named one is never compared, and the missing perfume is still reported', async () => {
    const u = await understandShipped('Rank Sauvage Elixir, Coco Mademoiselle and Kayali Vanilla 28 for winter',
      { intent: 'compare', unknown_perfume: 0.9 }, ['Sauvage Elixir', 'Coco Mademoiselle']);
    assert.deepEqual(u.focusPids.map((p) => shipped.get(p)!.name).sort(), ['Coco Mademoiselle', 'Sauvage Elixir']);
    assert.equal(u.compareMissing, true);
  });

  it('a brandless flanker ("Coco Noir") is never described as the original', async () => {
    const r = await shippedBot({ intent: 'explain', unknown_perfume: 0.9 }).chat(undefined, 'Tell me about Coco Noir');
    assert.match(r.reply.text, /^I don't have Coco Noir in my catalog - only Coco by Chanel/);
  });

  it('"for her birthday" is not the perfume For Her', async () => {
    const u = await understandShipped('Do you have Kayali Vanilla 28? It is for her birthday', { intent: 'explain', unknown_perfume: 0.9 });
    assert.deepEqual(u.focusPids, []);
    assert.equal(u.unresolved?.kind, 'perfume');
  });

  it('a concentration after a name is the same line, not a flanker: "Le Male EDT vs Le Male Le Parfum" compares the two', async () => {
    const u = await understandShipped('Le Male EDT vs Le Male Le Parfum - which is better?', { intent: 'compare', unknown_perfume: 0.9 }, ['Le Male Le Parfum']);
    assert.equal(u.intent, 'compare');
    assert.deepEqual(u.focusPids.map((p) => shipped.get(p)!.name).sort(), ['Le Male', 'Le Male Le Parfum']);
  });

  it('a child outranks a sensitivity: "my 6-year-old has eczema" gets the child answer, never picks', async () => {
    // Jev's safety choice says "sensitive", but the age question says a child.
    const r = await turn(scriptedBot(), 'My 6-year-old daughter has eczema - which perfume can she wear?', { intent: 'recommend', safety: 'sensitive', age_style: 'child' });
    assert.equal(debugOf(r).understanding.route, 'safety:child');
    assert.deepEqual(r.reply.recommendations, []);
    // A safety choice leaning "sensitive" but giving "child" real weight picks the more serious one.
    const both = new PerfumeBot(catalog, new MockJev({
      resolver: (_s, key, q) => {
        if (key !== 'safety' || q.type !== 'choice') return undefined;
        const keys = Object.keys(q.criteria);
        const p = (o: string) => (o === 'sensitive' ? 0.5 : o === 'child' ? 0.35 : 0.15 / (keys.length - 2));
        return { type: 'choice', choice: 'sensitive', confidence: 0.5, probabilities: Object.fromEntries(keys.map((o) => [o, p(o)])) };
      },
    }));
    const r2 = await both.chat(undefined, 'My 6-year-old daughter has eczema - which perfume can she wear?');
    assert.equal(debugOf(r2).understanding.route, 'safety:child');
  });

  it('a possessive or split brand name is never reported as not carried ("Chanel\'s", "Mont Blanc", "Penhaligon")', async () => {
    // Found as the house, so Jev is only asked about OTHER brands...
    assert.deepEqual(shipped.brandsIn("What's Chanel's best perfume?"), ['Chanel']);
    assert.deepEqual(shipped.brandsIn("What's the best Mont Blanc perfume?"), ['Montblanc']);
    assert.deepEqual(shipped.brandsIn('Anything from Penhaligon?'), ["Penhaligon's"]);
    // ...and even if Jev said "a brand we lack", a name that may be ours keeps the reply from denying it.
    for (const msg of ["What's Chanel's best perfume?", "What's the best Mont Blanc perfume?", 'Anything from Penhaligon?', 'Something from Kurkdjian']) {
      assert.equal(shipped.mayNameOtherBrand(msg), true, msg);
    }
    assert.equal(shipped.mayNameOtherBrand("What's the best Kayali perfume?"), false);
    assert.deepEqual(names(shipped.mentionedIn("something like Byredo Rose of No Man's Land")), ["Rose of No Man's Land"]);
  });

  it('punctuation ends a perfume name, and its own house after it is not a flanker', () => {
    for (const t of ['I like Sauvage, Kayali Vanilla 28 and Delina', 'I love Aventus. Summer is coming, what should I get?', 'Layton PDM or Aventus?', 'I wear Tobacco Vanille Tom Ford']) {
      assert.ok(shipped.mentionedIn(t).every((m) => !m.continuation), t);
    }
  });

  it('note words in a perfume name are not masked away: "I love oud wood" still asks about oud', async () => {
    const u = await understandShipped('I love the smell of oud wood, what do you recommend?', { intent: 'recommend' });
    assert.ok(u.proposed.notes.includes('Oud'));
  });

  it('a halal / alcohol-free request in any language keeps its requirement', async () => {
    for (const msg of ['Alkolsüz, helal bir parfüm önerir misin?', 'أريد عطر حلال بدون كحول', 'I need an ethanol-free perfume, something woody']) {
      const r = await turn(scriptedBot(), msg, { intent: 'recommend', requirement: 'alcohol_free', like_woody: 0.9 });
      assert.deepEqual(r.reply.recommendations, [], msg);
      assert.equal(debugOf(r).understanding.route, 'requirement:alcohol_free', msg);
    }
  });

  it('two different perfumes with concentration words are compared, not called "one version"', async () => {
    for (const [msg, named] of [
      ['Sauvage EDT vs Sauvage Elixir - which lasts longer?', ['Sauvage', 'Sauvage Elixir']],
      ['Acqua di Gio EDT vs Acqua di Gioia EDP, which lasts longer?', ['Acqua di Giò', 'Acqua di Gioia']],
    ] as const) {
      const u = await understandShipped(msg, { intent: 'compare', compare_on: 'longevity' }, [...named]);
      assert.equal(u.intent, 'compare', msg);
      assert.equal(u.knowledge, undefined, msg);
    }
  });

  it('the concentration answer names the other versions it does carry', () => {
    const lmp = shipped.fragrances.find((f) => f.name === 'Le Male Le Parfum')!;
    const t = renderKnowledge({ topic: 'concentration', frs: [lmp], notes: [], message: 'Le Male Le Parfum EDT vs EDP', catalog: shipped, concentrations: ['edt', 'edp'] }).text;
    assert.match(t, /^I carry \*\*Le Male Le Parfum\*\* and \*\*Le Male\*\* by Jean Paul Gaultier, but I can't match them to the EDT and EDP you asked about/);
  });

  it('a comparison of two named perfumes stays a comparison when Jev also sees "another question"', async () => {
    const r = await turn(scriptedBot(), 'Which is better for a wedding, Grand Cru or Red Echo?', { intent: 'compare', topic: 'other_question', ref_0: 'asking', ref_1: 'asking' });
    assert.equal(debugOf(r).understanding.route, 'compare');
    assert.match(r.reply.text, /Grand Cru/);
    assert.match(r.reply.text, /Red Echo/);
  });

  it('compare_on is asked on a first turn, so short names found later still get an attribute answer', async () => {
    const r = await shippedBot((k) => ({ intent: 'compare', unknown_perfume: 0.9, compare_on: 'longevity' } as Record<string, string | number>)[k])
      .chat(undefined, 'Eros or Coco - which one lasts longer?');
    assert.match(r.reply.text, /^Going by my catalog's performance data/);
  });

  it('a brand with nothing in the stated budget says so about the brand, not the whole catalog', async () => {
    const r = await turn(scriptedBot(), "What's the best Maison Test perfume under $60?", { intent: 'recommend', wants_brand: 0.9, budget: 'budget' });
    assert.match(r.reply.text, /None of the Maison Test perfumes I carry fit that budget/);
    assert.doesNotMatch(r.reply.text, /Nothing I know fits/);
    assert.doesNotMatch(r.reply.text, /good value for money/);
  });

  it('the budget shortfall line counts the picks actually shown', async () => {
    const r = await turn(scriptedBot(), 'something fresh under $60', { intent: 'recommend', budget: 'budget', like_citrus: 0.9 });
    const within = r.reply.recommendations.filter((c) => catalog.get(c.pid)!.priceTier === 'budget').length;
    if (within > 0 && within < r.reply.recommendations.length) {
      assert.match(r.reply.text, new RegExp(`Only ${within} of these (is|are) within that budget`));
    }
  });

  it('a vegan/hypoallergenic question with no perfume named is answered with caveated picks, not a spray offer', async () => {
    const b = scriptedBot();
    const r = await turn(b, 'Are there any vegan woody perfumes?', { intent: 'knowledge', requirement: 'vegan_cruelty_free', like_woody: 0.9 });
    assert.ok(r.reply.recommendations.length > 0);
    assert.doesNotMatch(r.reply.text, /If a spray is fine/);
    assert.ok('woody' in b.bot.sessions.getOrCreate(r.sessionId).facets.likes, 'the brief is kept');
  });

  it('day or night: never "the best fit" for a perfume worn at the other time', () => {
    const t = renderCompare(['B', 'I'].map((p) => catalog.get(p)!), null, 0, '', { axis: 'evening' }).text;
    assert.match(t, /^Neither is really an evening scent; \*\*(Citrus Riviera|Ocean Voyage)\*\* comes closest/);
  });

  it('"better for this time of year?" with no known season asks Jev, rather than a verdict made of nothing', async () => {
    const labels: string[] = [];
    const inner = scriptedJev({ intent: 'compare', compare_on: 'season', ref_0: 'asking', ref_1: 'asking' });
    const bot = new PerfumeBot(catalog, { mode: inner.mode, decide: ((st, qs, o) => { labels.push(o?.label ?? ''); return inner.decide(st, qs, o); }) as typeof inner.decide });
    await bot.chat(undefined, 'Which is better for this time of year, Grand Cru or Red Echo?');
    assert.ok(labels.includes('compare'));
  });

  it('sensitivity picks are called "lighter, softer" only when they are', async () => {
    const r = await turn(scriptedBot(), 'Perfume gives me migraines but I want something loud', {
      intent: 'recommend', safety: 'sensitive', projection: 'beast', like_oud_smoky: 0.9, like_amber_oriental: 0.9,
    });
    const loud = r.reply.recommendations.some((c) => /strong|enormous/.test(c.bullets.join(' ')));
    if (loud) assert.doesNotMatch(r.reply.text, /lighter, softer options/);
  });

  it('luxury and niche are one high-end band: no "X is the cheaper one" between them', () => {
    const t = renderCompare([catalog.get('A')!, catalog.get('H')!], null, 0, '', { axis: 'price' }).text;
    assert.match(t, /^Both are high-end - one luxury, one niche - and I don't have store prices/);
  });

  it('a dislike in an accented Latin-script language not on the word list is still asked about', () => {
    assert.ok(mayExpressDislike('Nie lubię wanilii, coś na zimę'));
    assert.ok(mayExpressDislike('Jag gillar inte vanilj'));
  });

  it('near-tied performance that straddles a word gives each word, never "both" one of them', () => {
    // Means 0.495 ("moderate") and 0.5025 ("long-lasting"): a tie that straddles the word boundary.
    const a = makeFragrance({ pid: 'U', name: 'Scent U', brand: 'House', longevityV: { weak: 200, moderate: 9800 } });
    const b = makeFragrance({ pid: 'V', name: 'Scent V', brand: 'House', longevityV: { moderate: 9900, long_lasting: 100 } });
    const t = renderCompare([a, b], null, 0, '', { axis: 'longevity' }).text;
    assert.match(t, /about level on longevity \((moderate and long-lasting|long-lasting and moderate)\)/);
  });

  it('the language notice does not turn matching picks into "the closest matches"', async () => {
    const r = await turn(scriptedBot(), 'Un parfum pour mon mari', { intent: 'recommend', non_english: 0.9, gender: 'masculine' });
    assert.match(r.reply.text, /^I can only reply in English for now\.\n/);
    assert.doesNotMatch(r.reply.text, /closest matches/);
  });

  it('a similarity check without accord data says so', () => {
    const bare = makeFragrance({ pid: 'Z', name: 'Bare', brand: 'None', accords: [] });
    assert.match(renderCompare([bare, catalog.get('A')!], null, 0, '', { axis: 'similarity' }).text, /^I don't have enough accord data/);
  });

  it('a few "reminds me of" votes are not a known alternative', () => {
    const weak = makeFragrance({ pid: 'W', name: 'Weak', brand: 'X', remindsOf: [{ pid: 'ORIG', yes: 3, no: 0 }] });
    assert.equal(knownAlternative(weak, catalog.get('ORIG')!), undefined);
    assert.ok(knownAlternative(catalog.get('CLONE')!, catalog.get('ORIG')!));
  });

  it('the panel labels a dropped constraint "used" only when it was cleared', async () => {
    const b = scriptedBot();
    const first = await turn(b, 'A summer perfume for me', { intent: 'recommend', season: 'summer' });
    const r = await turn(b, 'maybe other seasons too', { intent: 'refine', drop_season: 0.55 }, first.sessionId);
    const item = debugOf(r).trace.levers.flatMap((g) => g.items).find((i) => i.key === 'drop_season')!;
    assert.equal(debugOf(r).understanding.facets.season, 'summer');
    assert.equal(item.status, 'not used');
  });

  it('performance and safety sentences read as English', () => {
    const t = renderKnowledge({ topic: 'application', frs: [catalog.get('B')!], notes: [], message: 'x', catalog }).text;
    assert.match(t, /\*\*Citrus Riviera\*\* by Atelier Sud has (intimate|moderate) projection and (lasts a moderate time|is long-lasting|fades quickly)/);
    assert.match(renderSafety('pregnancy').text, /for any perfume, so I can't say/);
  });

  it('an empty pool still settles the naming call: a rejected key surfaces as an error, never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const inner = scriptedJev({ intent: 'recommend', other_brand: 0.9, wants_brand: 0.9, budget: 'budget' });
      const bot = new PerfumeBot(catalog, {
        mode: inner.mode,
        decide: ((st, qs, o) => (o?.label === 'name' ? Promise.reject(new JevError('Jev HTTP 401', 401)) : inner.decide(st, qs, o))) as typeof inner.decide,
      });
      // "Maison Test" is luxury-only, so under a budget nothing fits and the pool is empty.
      await bot.chat(undefined, 'the best Maison Test perfume under $60, not Kayali').catch(() => undefined);
      await new Promise((res) => setTimeout(res, 50));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('"What does Oud Wood smell like?" describes the perfume, not raw oud', async () => {
    const cat = new Catalog([...FIXTURES, makeFragrance({ pid: 'OW', name: 'Oud Wood', brand: 'Tom Ford', accords: A([['oud', 100], ['woody', 80]]) })], 'seed',
      { fragrances: 13, brands: 12, dropped: 0, unresolvedNotes: 0, unresolvedAccords: 0 });
    const r = await new PerfumeBot(cat, scriptedJev({ intent: 'knowledge', topic: 'note_description', ref_0: 'asking' })).chat(undefined, 'What does Tom Ford Oud Wood smell like?');
    assert.equal(debugOf(r).understanding.route, 'explain');
    assert.match(r.reply.text, /^\*\*Oud Wood\*\* by Tom Ford/);
  });

  it('only the seed catalog is described as holding sprays only', () => {
    assert.match(requirementLine('alcohol_free', undefined, true), /everything in my catalog is an alcohol-based spray/);
    assert.doesNotMatch(requirementLine('alcohol_free', undefined, false), /everything in my catalog/);
    assert.match(requirementLine('format', undefined, false), /don't have product-format data/);
  });
});

describe('review findings: second pass', () => {
  const shippedLexicon = new NoteLexicon(shipped);
  const understandShipped = (message: string, script: Record<string, string | number>) => understand({
    message, session: new SessionStore().getOrCreate(), catalog: shipped, lexicon: shippedLexicon,
    decider: scriptedJev((k) => (/^ref_\d+$/.test(k) ? 'asking' : script[k])),
  });
  const namesOf = (pids: string[]) => pids.map((p) => shipped.get(p)!.name).sort();

  it('one version named, the other asked version carried: compare the two records', async () => {
    const lm = await understandShipped('Le Male EDT vs Le Male Le Parfum - which lasts longer?', { intent: 'compare', compare_on: 'longevity' });
    assert.equal(lm.intent, 'compare');
    assert.deepEqual(namesOf(lm.focusPids), ['Le Male', 'Le Male Le Parfum']);
    const sv = await understandShipped('Is Sauvage Elixir stronger than the EDT?', { intent: 'compare', compare_on: 'projection' });
    assert.equal(sv.intent, 'compare');
    assert.deepEqual(namesOf(sv.focusPids), ['Sauvage', 'Sauvage Elixir']);
  });

  it('a version the user did not ask about is never swapped in: "Sauvage EDT vs EDP" is not Sauvage vs Elixir', async () => {
    const u = await understandShipped('Dior Sauvage EDT vs EDP - which one is better?', { intent: 'compare' });
    assert.equal(u.knowledge?.topic, 'concentration');
  });

  it('two named records stay a comparison even when Jev also tags a concentration topic', async () => {
    const u = await understandShipped('Which lasts longer, Sauvage EDT or Sauvage Elixir?', { intent: 'compare', topic: 'concentration', compare_on: 'longevity' });
    assert.equal(u.intent, 'compare');
    assert.equal(u.compareOn, 'longevity');
    assert.deepEqual(namesOf(u.focusPids), ['Sauvage', 'Sauvage Elixir']);
  });

  it('a compare with one perfume we lack says so, not "I can\'t answer that"', async () => {
    const r = await turn(scriptedBot(), 'Which is better, Grand Cru or Kayali Vanilla 28?', { intent: 'compare', topic: 'other_question', ref_0: 'asking', unknown_perfume: 0.9 });
    assert.equal(debugOf(r).understanding.route, 'unresolved:perfume');
  });

  it('an adult with migraines still gets picks when Jev also gives "medical" some weight', async () => {
    const bot = new PerfumeBot(catalog, new MockJev({
      resolver: (_s, key, q) => {
        if (key !== 'safety' || q.type !== 'choice') return undefined;
        const p: Record<string, number> = { sensitive: 0.6, medical: 0.3, none: 0.1 };
        return { type: 'choice', choice: 'sensitive', confidence: 0.6, probabilities: Object.fromEntries(Object.keys(q.criteria).map((o) => [o, p[o] ?? 0])) };
      },
    }));
    const r = await bot.chat(undefined, 'Perfume gives me migraines - is there anything I can wear?');
    assert.equal(debugOf(r).understanding.route, 'recommend');
    assert.ok(r.reply.recommendations.length > 0);
  });

  it('a requirement on a general question keeps its caveat', async () => {
    const r = await turn(scriptedBot(), 'Which hypoallergenic perfume suits my skin type?', { intent: 'knowledge', topic: 'skin_type', requirement: 'hypoallergenic' });
    assert.equal(debugOf(r).understanding.route, 'knowledge:skin_type');
    assert.match(r.reply.text, /^I don't have allergen data for any perfume/);
  });

  it('a house with nothing in budget offers other houses, not "more affordable" again', async () => {
    const r = await turn(scriptedBot(), "What's the best Maison Test perfume under $60?", { intent: 'recommend', wants_brand: 0.9, budget: 'budget' });
    assert.ok(r.reply.followUps.includes(FOLLOW_UPS.other_brands.text));
    assert.ok(!r.reply.followUps.includes(FOLLOW_UPS.cheaper.text));
    const next = await turn(scriptedBot(), FOLLOW_UPS.other_brands.text, {}, r.sessionId);
    assert.ok(next.reply.recommendations.length > 0);
  });

  it('the other-brands chip drops the brand and keeps the budget', async () => {
    const b = scriptedBot();
    const first = await turn(b, "What's the best Maison Test perfume under $60?", { intent: 'recommend', wants_brand: 0.9, budget: 'budget' });
    const r = await turn(b, FOLLOW_UPS.other_brands.text, {}, first.sessionId);
    const f = debugOf(r).understanding.facets;
    assert.deepEqual([f.brands, f.budget], [[], 'budget']);
    assert.ok(r.reply.recommendations.every((c) => ['budget', 'mid'].includes(catalog.get(c.pid)!.priceTier)));
  });

  it('a day-or-night tie describes each perfume by its own lean', () => {
    const mk = (pid: string, night: number) => makeFragrance({ pid, name: `Scent ${pid}`, brand: 'House', nightShare: night });
    const t = renderCompare([mk('P', 0.385), mk('Q', 0.37)], null, 0, '', { axis: 'daytime' }).text;
    assert.match(t, /about level \(Scent P works day or night, Scent Q is mostly worn in the day\)|about level \(Scent Q is mostly worn in the day, Scent P works day or night\)/);
  });
});
