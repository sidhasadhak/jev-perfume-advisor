import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JevError } from '../src/jev/client.js';
import { MockJev } from '../src/jev/mock.js';
import type { Decider } from '../src/jev/types.js';
import { FOLLOW_UPS, moreLike, tellMeMore } from '../src/pipeline/followups.js';
import { NoteLexicon, hasNegationCue, ordinalRefs } from '../src/pipeline/lexicon.js';
import { PerfumeBot } from '../src/pipeline/orchestrator.js';
import { blend, rank } from '../src/pipeline/rank.js';
import { bullets, headline, seedFrom, toCards } from '../src/pipeline/render.js';
import { features, retrieve } from '../src/pipeline/retrieve.js';
import { SessionStore } from '../src/pipeline/session.js';
import { mergeFacets, understand } from '../src/pipeline/understand.js';
import type { Facets } from '../src/types.js';
import { EMPTY_FACETS } from '../src/types.js';
import { Catalog } from '../src/catalog/catalog.js';
import { FIXTURES, fixtureCatalog, scriptedJev, type Script } from './helpers.js';

const catalog = fixtureCatalog();
const lexicon = new NoteLexicon(catalog);
const facets = (p: Partial<Facets>): Facets => ({ ...structuredClone(EMPTY_FACETS), ...p });
const names = (pids: string[]) => pids.map((p) => catalog.get(p)!.name);

async function turn(message: string, script: Script, sessionId?: string, bot?: PerfumeBot) {
  const b = bot ?? new PerfumeBot(catalog, scriptedJev(script));
  return { bot: b, res: await b.chat(sessionId, message) };
}

// ---------------------------------------------------------------------------
// The five example requests from the brief, end to end (Jev answers scripted).
// ---------------------------------------------------------------------------

describe('example requests', () => {
  it('evening party -> night-leaning scents with presence', async () => {
    const { res } = await turn('Suggest me a perfume for an evening party', { occasion: 'evening_party', time_of_day: 'night' });
    const picks = res.reply.recommendations;
    assert.ok(picks.length >= 3);
    for (const p of picks.slice(0, 3)) {
      const f = features(catalog.get(p.pid)!);
      assert.ok(f.night > 0.6, `${p.name} should be an evening scent (night=${f.night})`);
    }
    assert.match(res.reply.text, /party|night|evening/i);
  });

  it('Nordic winters -> warm, dense winter scents; no summer freshies', async () => {
    const { res } = await turn('Something for Nordic winters', { climate: 'cold', season: 'winter' });
    const top = res.reply.recommendations.map((r) => r.pid);
    assert.ok(['A', 'L', 'H', 'D'].includes(top[0]!), `top pick ${top[0]} should be a winter warmer`);
    for (const pid of top.slice(0, 3)) assert.ok(!['B', 'I', 'J'].includes(pid), `${pid} is a summer scent`);
    assert.match(res.reply.text, /cold|winter|freezing/i);
  });

  it('summer in Turkey -> fresh, humid-safe scents; nothing heavy', async () => {
    const { res } = await turn('What should I wear for a summer in Turkey?', { climate: 'hot_humid', season: 'summer', occasion: 'travel' });
    const top = res.reply.recommendations.map((r) => r.pid).slice(0, 3);
    for (const pid of top) assert.ok(!['A', 'L', 'H', 'D', 'K'].includes(pid), `${pid} is too heavy for humid heat`);
    assert.ok(top.includes('J') || top.includes('B'), 'expected a Mediterranean citrus in the top 3');
  });

  it('working professional -> office-safe, never the beast-mode oud or tuberose', async () => {
    const { res } = await turn('Best perfume for a working professional', { occasion: 'office', age_style: 'contemporary' });
    const top = res.reply.recommendations.map((r) => r.pid).slice(0, 3);
    assert.ok(top.includes('C') || top.includes('G'), `expected Quiet Musk or Blue Current, got ${names(top)}`);
    for (const pid of top) assert.ok(!['H', 'K'].includes(pid), `${pid} is too loud for the office`);
  });

  it('65-year-old lady who loves pink -> classic feminine rose, not youthful or masculine', async () => {
    const { res } = await turn('A suitable perfume for a 65 year-old lady who loves the colour pink', {
      gender: 'feminine', age_style: 'mature_elegant', persona: 0.95, favourite_colour: 'pink',
      like_floral_rose: 0.9, like_floral_soft_powdery: 0.75,
    });
    const recs = res.reply.recommendations;
    assert.equal(recs[0]!.pid, 'E', `expected Rose Imperiale first, got ${recs[0]!.name}`);
    for (const r of recs) assert.ok(!['G', 'H', 'I'].includes(r.pid), `${r.name} is masculine`);
    const peony = recs.findIndex((r) => r.pid === 'F');
    assert.ok(peony === -1 || peony > 0, 'the youthful peony should not beat the classic rose');
    assert.match(res.reply.text, /pink/i, 'the reply should acknowledge the love of pink');
  });
});

// ---------------------------------------------------------------------------
// Understand
// ---------------------------------------------------------------------------

describe('understand', () => {
  const session = () => new SessionStore().getOrCreate();

  it('drops low-confidence facet choices and reports them as uncertain', async () => {
    const decider = scriptedJev({ occasion: 'office', gender: 'feminine' }, 0.3);
    const u = await understand({ message: 'hmm something nice', session: session(), catalog, lexicon, decider });
    assert.equal(u.facets.occasion, 'any');
    assert.equal(u.facets.gender, 'any');
    assert.ok(u.uncertain.includes('occasion') && u.uncertain.includes('gender'));
  });

  it('a decider that "likes" every family cannot flatten the taste signal', async () => {
    const likesAll = scriptedJev((k) => (k.startsWith('like_') ? (k === 'like_floral_rose' ? 0.95 : 0.6) : undefined));
    const u = await understand({ message: 'something nice', session: session(), catalog, lexicon, decider: likesAll });
    const liked = Object.keys(u.facets.likes);
    assert.ok(liked.length <= 5, `kept ${liked.length} likes`);
    assert.ok(liked.includes('floral_rose'), 'the strongest like survives');
  });

  it('an unsure "out of scope" that still carries perfume facets is treated as a request (live Jev regression)', async () => {
    // Live Jev read "What should I wear for a summer in Turkey?" as clothing: out_of_scope at 73%.
    const u = await understand({
      message: 'What should I wear for a summer in Turkey?', session: session(), catalog, lexicon,
      decider: scriptedJev({ intent: 'out_of_scope', occasion: 'travel', climate: 'hot_dry', season: 'summer' }, 0.73),
    });
    assert.equal(u.intent, 'recommend');
  });

  it('a confident "out of scope" is respected', async () => {
    const u = await understand({
      message: 'What is the capital of Turkey?', session: session(), catalog, lexicon,
      decider: scriptedJev({ intent: 'out_of_scope', climate: 'hot_dry', season: 'summer' }, 0.95),
    });
    assert.equal(u.intent, 'out_of_scope');
  });

  it('tells Jev it is talking to a perfume assistant', async () => {
    let state: any;
    await understand({ message: 'x', session: session(), catalog, lexicon, decider: scriptedJev((_k, s) => { state = s; return undefined; }) });
    assert.match(state.context, /perfume/);
  });

  it('infers season from climate', async () => {
    const u = await understand({ message: 'for Dubai', session: session(), catalog, lexicon, decider: scriptedJev({ climate: 'hot_dry' }) });
    assert.equal(u.facets.season, 'summer');
  });

  it('only asks avoid_* questions when the message could express aversion', async () => {
    const seen: string[] = [];
    const spy = scriptedJev((k) => { seen.push(k); return undefined; });
    await understand({ message: 'a warm cosy scent', session: session(), catalog, lexicon, decider: spy });
    assert.ok(!seen.some((k) => k.startsWith('avoid_')));
    seen.length = 0;
    await understand({ message: 'nothing too sweet please', session: session(), catalog, lexicon, decider: spy });
    assert.ok(seen.some((k) => k.startsWith('avoid_')));
  });

  it('a named perfume the user likes turns the request into more_like', async () => {
    const u = await understand({
      message: 'I love Ember Nocturne, find me something similar', session: session(), catalog, lexicon,
      decider: scriptedJev({ intent: 'recommend', ref_0: 'similar' }),
    });
    assert.equal(u.intent, 'more_like');
    assert.ok(u.facets.referencePids.includes('A') || u.facets.referencePids.includes('L'));
  });

  it('note polarity: wanted and avoided notes', async () => {
    const u = await understand({
      message: 'I love vanilla but hate tuberose', session: session(), catalog, lexicon,
      decider: scriptedJev({ note_0: 'wants', note_1: 'avoids' }),
    });
    // Lexicon order is longest-first, so resolve by name rather than index.
    const all = [...u.facets.likedNotes, ...u.facets.avoidedNotes].map((n) => n.toLowerCase());
    assert.ok(all.includes('vanilla') && all.includes('tuberose'));
  });

  it('refine without anything shown yet is treated as a fresh recommendation', async () => {
    const u = await understand({ message: 'cheaper', session: session(), catalog, lexicon, decider: scriptedJev({ intent: 'refine' }) });
    assert.equal(u.intent, 'recommend');
  });

  it('explain resolves "the second one" deterministically', async () => {
    const s = session();
    s.lastShown = ['A', 'B', 'C'];
    s.turns.push({ role: 'assistant', text: 'x' });
    const u = await understand({ message: 'tell me more about the second one', session: s, catalog, lexicon, decider: scriptedJev({ intent: 'explain' }) });
    assert.equal(u.intent, 'explain');
    assert.deepEqual(u.focusPids, ['B']);
  });

  it('compare falls back to the first two shown', async () => {
    const s = session();
    s.lastShown = ['C', 'G', 'E'];
    s.turns.push({ role: 'assistant', text: 'x' });
    const u = await understand({ message: 'which is better?', session: s, catalog, lexicon, decider: scriptedJev({ intent: 'compare' }) });
    assert.equal(u.intent, 'compare');
    assert.deepEqual(u.focusPids, ['C', 'G']);
  });
});

describe('mergeFacets', () => {
  const prev = facets({ occasion: 'evening_party', gender: 'feminine', persona: 'my mum, 65', budget: 'luxury', likes: { floral_rose: 0.9 } });

  it('refine keeps context and steps the budget down', () => {
    const m = mergeFacets(prev, facets({}), 'refine', true, 'cheaper', ['luxury']);
    assert.equal(m.occasion, 'evening_party');
    assert.equal(m.budget, 'mid');
    assert.equal(m.gender, 'feminine');
  });

  it('cheaper with no budget yet steps relative to what was shown', () => {
    const m = mergeFacets(facets({}), facets({}), 'refine', true, 'cheaper', ['niche', 'luxury', 'luxury', 'mid']);
    assert.equal(m.budget, 'mid');
  });

  it('a new request for the same wearer keeps who they are but resets the situation', () => {
    const m = mergeFacets(prev, facets({ occasion: 'office' }), 'recommend', true, 'none', []);
    assert.equal(m.occasion, 'office');
    assert.equal(m.gender, 'feminine');
    assert.equal(m.persona, 'my mum, 65');
    assert.equal(m.likes.floral_rose, 0.9);
  });

  it('a new request for someone else starts clean', () => {
    const m = mergeFacets(prev, facets({ gender: 'masculine' }), 'recommend', false, 'none', []);
    assert.equal(m.gender, 'masculine');
    assert.equal(m.persona, '');
    assert.deepEqual(m.likes, {});
  });

  it('fresh avoids cancel previous likes', () => {
    const m = mergeFacets(prev, facets({ avoids: { floral_rose: 0.8 } }), 'refine', true, 'none', []);
    assert.equal(m.likes.floral_rose, undefined);
    assert.equal(m.avoids.floral_rose, 0.8);
  });

  it('less_sweet adds an avoid and removes the like', () => {
    const m = mergeFacets(facets({ likes: { gourmand_sweet: 0.9 } }), facets({}), 'refine', true, 'less_sweet', []);
    assert.equal(m.likes.gourmand_sweet, undefined);
    assert.ok((m.avoids.gourmand_sweet ?? 0) > 0);
  });
});

// ---------------------------------------------------------------------------
// Retrieve
// ---------------------------------------------------------------------------

describe('retrieve', () => {
  it('excludes clearly wrong-gender scents when a gender is requested', () => {
    const pids = retrieve(catalog, facets({ gender: 'feminine' })).map((c) => c.fragrance.pid);
    for (const m of ['G', 'H', 'I']) assert.ok(!pids.includes(m), `${m} is masculine`);
  });

  it('avoided families are pushed down', () => {
    const base = retrieve(catalog, facets({ occasion: 'evening_party' }));
    const avoid = retrieve(catalog, facets({ occasion: 'evening_party', avoids: { gourmand_sweet: 0.9 } }));
    const pos = (cs: typeof base) => cs.findIndex((c) => c.fragrance.pid === 'D');
    assert.ok(pos(avoid) > pos(base));
  });

  it('avoided notes are penalised hard', () => {
    const cs = retrieve(catalog, facets({ occasion: 'evening_party', avoidedNotes: ['Tuberose'] }));
    const k = cs.find((c) => c.fragrance.pid === 'K')!;
    assert.ok(k.signals.penalty! < 0.5);
  });

  it('reference search excludes the reference and prefers its closest relatives', () => {
    const cs = retrieve(catalog, facets({ referencePids: ['A'] }));
    assert.ok(!cs.some((c) => c.fragrance.pid === 'A'));
    assert.equal(cs[0]!.fragrance.pid, 'L');
  });

  it('caps results per brand', () => {
    const cs = retrieve(catalog, facets({}), { maxPerBrand: 1 });
    const brands = cs.map((c) => c.fragrance.brand);
    assert.equal(new Set(brands).size, brands.length);
  });

  it('budget prefers the budget tier', () => {
    const cs = retrieve(catalog, facets({ budget: 'budget', season: 'summer' }));
    assert.equal(cs[0]!.fragrance.pid, 'I');
  });

  it('scores are within [0,1] and signals only include expressed facets', () => {
    for (const c of retrieve(catalog, facets({ occasion: 'office' }))) {
      assert.ok(c.retrieval >= 0 && c.retrieval <= 1);
      assert.ok(!('season' in c.signals));
      assert.ok('occasion' in c.signals && 'popularity' in c.signals);
    }
  });
});

// ---------------------------------------------------------------------------
// Rank
// ---------------------------------------------------------------------------

describe('rank', () => {
  it('blend rises with Jev fit and falls with conflict', () => {
    const j = (fit: number, conflict = 0.05) => ({ fit, confidence: 0.8, facets: { conflict } });
    assert.ok(blend(0.5, j(4)) > blend(0.5, j(2)));
    assert.ok(blend(0.5, j(2)) > blend(0.5, j(0)));
    assert.ok(blend(0.5, j(3, 0.95)) < blend(0.5, j(3, 0.05)));
    assert.ok(blend(0.6, null) < 0.6);
  });

  it('Jev can overturn the retrieval order', async () => {
    const cands = retrieve(catalog, facets({ occasion: 'evening_party' }));
    const last = cands[cands.length - 1]!.fragrance.name;
    const decider = scriptedJev((k, state) => (k === 'fit' ? (String(state.candidate_perfume.name).startsWith(last) ? 4 : 1) : undefined));
    const r = await rank({ message: 'party', facets: facets({ occasion: 'evening_party' }), candidates: cands, decider, catalogLookup: (p) => catalog.get(p), judge: cands.length });
    assert.equal(r.recommendations[0]!.fragrance.name, last);
  });

  it('diversity keeps two flankers of the same line apart', async () => {
    const cands = retrieve(catalog, facets({ climate: 'cold', season: 'winter' }));
    const r = await rank({ message: 'winter', facets: facets({ climate: 'cold' }), candidates: cands, decider: scriptedJev(), catalogLookup: (p) => catalog.get(p), take: 3 });
    const pids = r.recommendations.map((x) => x.fragrance.pid);
    assert.ok(!(pids.includes('A') && pids.includes('L')), `both flankers shown: ${pids}`);
  });

  it('degrades to retrieval scores when some Jev calls fail', async () => {
    let n = 0;
    const flaky: Decider = {
      mode: 'mock',
      decide: (s, q, o) => (++n % 2 ? Promise.reject(new JevError('boom', 503, true)) : scriptedJev().decide(s, q, o)),
    };
    const cands = retrieve(catalog, facets({ occasion: 'office' }));
    const r = await rank({ message: 'office', facets: facets({ occasion: 'office' }), candidates: cands, decider: flaky, catalogLookup: (p) => catalog.get(p) });
    assert.ok(r.failedJudgements > 0);
    assert.ok(r.recommendations.length > 0);
  });

  it('a rejected API key surfaces instead of silently degrading', async () => {
    const denied: Decider = { mode: 'live', decide: () => Promise.reject(new JevError('Jev HTTP 401', 401)) };
    const cands = retrieve(catalog, facets({}));
    await assert.rejects(rank({ message: 'x', facets: facets({}), candidates: cands, decider: denied, catalogLookup: (p) => catalog.get(p) }), /401/);
  });
});

// ---------------------------------------------------------------------------
// Render - grounding
// ---------------------------------------------------------------------------

describe('render', () => {
  it('never mentions a note or accord that is not in the record', async () => {
    const scripts: Script[] = [
      { occasion: 'evening_party', time_of_day: 'night' },
      { climate: 'cold', season: 'winter', like_amber_oriental: 0.9 },
      { occasion: 'office', gender: 'feminine' },
      { gender: 'feminine', age_style: 'mature_elegant', persona: 0.9, like_floral_rose: 0.9 },
    ];
    // Police specific MATERIALS (notes, material-like accords). Generic style words such as
    // "floral" or "fresh" are legitimate descriptions of any record in that family.
    const GENERIC = new Set(['floral', 'white floral', 'fresh', 'sweet', 'woody', 'fruity', 'green', 'powdery', 'warm spicy',
      'fresh spicy', 'soft spicy', 'aromatic', 'citrus', 'aquatic', 'musky', 'amber', 'smoky', 'earthy', 'soapy', 'aldehydic']);
    const vocab = new Set<string>();
    for (const f of FIXTURES) {
      for (const n of [...f.notes.top, ...f.notes.middle, ...f.notes.base]) vocab.add(n.toLowerCase());
      for (const a of f.accords) if (!GENERIC.has(a.name)) vocab.add(a.name.toLowerCase());
    }
    for (const script of scripts) {
      const { res } = await turn('test', script);
      for (const card of res.reply.recommendations) {
        const fr = catalog.get(card.pid)!;
        const own = new Set([...fr.notes.top, ...fr.notes.middle, ...fr.notes.base, ...fr.accords.map((a) => a.name)].map((x) => x.toLowerCase()));
        const text = [card.headline, ...card.bullets].join(' ').toLowerCase();
        for (const term of vocab) {
          // "floral" is fine for a record with "white floral": skip terms contained in its own terms.
          if (own.has(term) || term.length < 4 || [...own].some((o) => o.includes(term))) continue;
          assert.ok(!new RegExp(`\\b${term}\\b`).test(text), `${card.name} mentions "${term}", which it does not contain: ${text}`);
        }
      }
    }
  });

  it('produces clean text: no undefined/NaN, balanced bold markers', async () => {
    for (const script of [{ occasion: 'wedding' }, { climate: 'hot_dry' }, {}, { budget: 'budget' }] as Script[]) {
      const { res } = await turn('hello there, a perfume please', script);
      const all = [res.reply.text, ...res.reply.recommendations.flatMap((r) => [r.headline, ...r.bullets])].join('\n');
      assert.ok(!/undefined|NaN|\[object/.test(all), all);
      assert.equal((res.reply.text.match(/\*\*/g) ?? []).length % 2, 0);
    }
  });

  it('asks the clarifying question Jev chose', async () => {
    const { res } = await turn('a perfume', { ask: 0.9, clarify_topic: 'budget' });
    assert.match(res.reply.text, /budget/i);
  });

  it('bullets and headlines are non-empty for every fixture', () => {
    for (const fr of FIXTURES) {
      const rec = { fragrance: fr, final: 0.7, retrieval: 0.7, judgement: { fit: 3, confidence: 0.8, facets: {} }, reasons: [] };
      assert.ok(headline(rec, facets({})).length > 3);
      assert.ok(bullets(rec, facets({})).length >= 1);
    }
  });

  it('variation is deterministic per message', () => {
    assert.equal(seedFrom('abc'), seedFrom('abc'));
    assert.notEqual(seedFrom('abc'), seedFrom('abd'));
  });
});

// ---------------------------------------------------------------------------
// Orchestrator - multi-turn conversation
// ---------------------------------------------------------------------------

describe('conversation', () => {
  it('recommend -> cheaper -> explain #2 -> compare -> thanks', async () => {
    let script: Script = { occasion: 'evening_party', gender: 'feminine' };
    const bot = new PerfumeBot(catalog, scriptedJev((k, s, q) => (typeof script === 'function' ? script(k, s, q) : script[k])));

    const r1 = await bot.chat(undefined, 'perfume for a party, for my wife');
    const sid = r1.sessionId;
    const first = r1.reply.recommendations.map((r) => r.pid);
    assert.ok(first.length >= 2);
    const d1 = r1.reply.debug as { telemetry: { calls: number }; jevCalls: Array<{ label: string }> };
    assert.equal(d1.jevCalls[0]!.label, 'understand');
    assert.ok(d1.jevCalls.some((c) => c.label === 'compose'));
    assert.ok(d1.jevCalls.some((c) => c.label.startsWith('judge:')));

    script = { intent: 'refine', refine: 'cheaper' };
    const r2 = await bot.chat(sid, 'something cheaper');
    const u2 = (r2.reply.debug as { understanding: { facets: Facets } }).understanding.facets;
    assert.equal(u2.occasion, 'evening_party', 'refine keeps the occasion');
    assert.equal(u2.gender, 'feminine', 'refine keeps the wearer');
    assert.notEqual(u2.budget, 'any');

    script = { intent: 'explain' };
    const shown = r2.reply.recommendations;
    const r3 = await bot.chat(sid, 'why the second one?');
    assert.match(r3.reply.text, new RegExp(shown[1]!.name));
    assert.match(r3.reply.text, /Why I suggested it/);

    script = (k) => (k === 'intent' ? 'compare' : k === 'winner' ? `p_${shown[0]!.pid}` : undefined);
    const r4 = await bot.chat(sid, 'compare #1 and #2');
    assert.match(r4.reply.text, new RegExp(`lean towards \\*\\*${shown[0]!.name}`));

    script = { intent: 'thanks' };
    const r5 = await bot.chat(sid, 'thanks!');
    assert.equal(r5.reply.recommendations.length, 0);
    assert.match(r5.reply.text, /pleasure/i);
  });

  it('"different options" never repeats what was shown', async () => {
    let script: Record<string, string> = { occasion: 'casual_daily' };
    const bot = new PerfumeBot(catalog, scriptedJev((k) => script[k]));
    const r1 = await bot.chat(undefined, 'an everyday scent');
    script = { intent: 'refine', refine: 'different_options' };
    const r2 = await bot.chat(r1.sessionId, 'show me different ones');
    const again = r2.reply.recommendations.filter((r) => r1.reply.recommendations.some((x) => x.pid === r.pid));
    assert.equal(again.length, 0);
  });

  it('small talk takes the short path with a single Jev call', async () => {
    const { res } = await turn('hi!', { intent: 'greeting' });
    const d = res.reply.debug as { telemetry: { calls: number } };
    assert.equal(d.telemetry.calls, 1);
    assert.equal(res.reply.recommendations.length, 0);
  });

  it('works with the unscripted lexical MockJev too', async () => {
    const bot = new PerfumeBot(catalog, new MockJev());
    const r = await bot.chat(undefined, 'a warm perfume for cold winter nights');
    assert.ok(r.reply.text.length > 20);
    assert.equal(r.mode, 'mock');
  });
});

describe('lexicon', () => {
  it('ordinals', () => {
    assert.deepEqual(ordinalRefs('compare the first and the third'), [0, 2]);
    assert.deepEqual(ordinalRefs('what about #2?'), [1]);
    assert.deepEqual(ordinalRefs('the last one'), [-1]);
  });
  it('negation cue', () => {
    assert.ok(hasNegationCue("I don't like oud"));
    assert.ok(hasNegationCue('nothing too sweet'));
    assert.ok(!hasNegationCue('a warm cosy scent'));
  });
  it('notes: longest match first, no overlaps', () => {
    const found = lexicon.find('I love pink pepper and vanilla').map((n) => n.note.toLowerCase());
    assert.ok(found.includes('pink pepper') && found.includes('vanilla'));
  });
});

// ---------------------------------------------------------------------------
// Follow-up chips we generate must mean exactly what they say.
// ---------------------------------------------------------------------------

describe('follow-up chips', () => {
  /** A decider that always thinks the user wants a fresh recommendation. */
  const stubborn = () => scriptedJev({ intent: 'recommend', refine: 'none' });

  async function afterFirstTurn() {
    const bot = new PerfumeBot(catalog, stubborn());
    const r1 = await bot.chat(undefined, 'party perfume');
    return { bot, sid: r1.sessionId, shown: r1.reply.recommendations };
  }

  it('every chip in the table resolves to its intended intent, whatever the decider says', async () => {
    for (const def of Object.values(FOLLOW_UPS)) {
      const { bot, sid } = await afterFirstTurn();
      const r = await bot.chat(sid, def.text);
      const u = (r.reply.debug as { understanding: { intent: string; refine: string } }).understanding;
      assert.equal(u.intent, def.intent, `"${def.text}" -> ${u.intent}`);
      if ('refine' in def) assert.equal(u.refine, def.refine, `"${def.text}" refine`);
    }
  });

  it('"Why is #1 the top pick?" explains the first pick', async () => {
    const { bot, sid, shown } = await afterFirstTurn();
    const r = await bot.chat(sid, FOLLOW_UPS.why_top.text);
    assert.equal(r.reply.recommendations.length, 0);
    assert.match(r.reply.text, new RegExp(`^\\*\\*${shown[0]!.name}\\*\\*`));
  });

  it('"What about for daytime?" flips the time and drops a night-only occasion', async () => {
    const bot = new PerfumeBot(catalog, scriptedJev((k) => (k === 'occasion' ? 'evening_party' : k === 'intent' ? 'recommend' : undefined)));
    const r1 = await bot.chat(undefined, 'party');
    const r2 = await bot.chat(r1.sessionId, FOLLOW_UPS.daytime.text);
    const f = (r2.reply.debug as { understanding: { facets: Facets } }).understanding.facets;
    assert.equal(f.timeOfDay, 'day');
    assert.notEqual(f.occasion, 'evening_party');
  });

  it('a bare name is not a chip: "tell me more about her" is left to Jev', async () => {
    const { bot, sid } = await afterFirstTurn();
    const r = await bot.chat(sid, 'Tell me more about Quiet Musk');
    // The stubborn decider says "recommend"; without the brand this is not our chip, so Jev's answer stands.
    assert.equal((r.reply.debug as { understanding: { intent: string } }).understanding.intent, 'recommend');
  });

  it('name-bearing chips resolve the perfume deterministically', async () => {
    const { bot, sid } = await afterFirstTurn();
    const more = await bot.chat(sid, moreLike('Ember Nocturne', 'Maison Test'));
    const u = (more.reply.debug as { understanding: { intent: string; facets: Facets } }).understanding;
    assert.equal(u.intent, 'more_like');
    assert.deepEqual(u.facets.referencePids, ['A']);
    const tell = await bot.chat(sid, tellMeMore('Quiet Musk', 'Studio Clean'));
    assert.match(tell.reply.text, /^\*\*Quiet Musk\*\*/);
  });

  it('matching is case- and punctuation-insensitive', async () => {
    const { bot, sid } = await afterFirstTurn();
    const r = await bot.chat(sid, 'something MORE affordable!!');
    assert.equal((r.reply.debug as { understanding: { refine: string } }).understanding.refine, 'cheaper');
  });
});

describe('headline variety', () => {
  it('does not repeat the same use-case across the cards of one reply', async () => {
    const { res } = await turn('party', { occasion: 'evening_party', time_of_day: 'night' });
    const uses = res.reply.recommendations.map((r) => r.headline.split(' \u2014 ')[1]).filter(Boolean);
    assert.equal(new Set(uses).size, uses.length, `repeated: ${uses.join(' | ')}`);
  });
});

describe('data provenance in the wording', () => {
  const STATS = /\d+% of|Rated \d|by [\d,]+ people|[Cc]ommunity|People love/;
  const scripts: Script[] = [
    { occasion: 'evening_party', time_of_day: 'night', vibe: 'crowd_pleaser' },
    { climate: 'cold', season: 'winter' },
    { budget: 'budget', season: 'summer' },
    { gender: 'feminine', occasion: 'office' },
  ];
  const texts = async (cat: Catalog) => {
    const out: string[] = [];
    for (const script of scripts) {
      const bot = new PerfumeBot(cat, scriptedJev(script));
      const r1 = await bot.chat(undefined, 'something');
      out.push(r1.reply.text, ...r1.reply.recommendations.flatMap((r) => r.bullets));
      const r2 = await new PerfumeBot(cat, scriptedJev({ ...script as object, intent: 'explain' })).chat(undefined, 'tell me about Ember Nocturne');
      out.push(r2.reply.text);
    }
    return out.join('\n');
  };

  it('seed catalog (estimated votes): no exact statistics or community claims', async () => {
    const all = await texts(fixtureCatalog()); // fixtureCatalog() is source 'seed'
    const m = STATS.exec(all);
    assert.equal(m, null, `found "${m?.[0]}" in: ${all.slice(Math.max(0, (m?.index ?? 0) - 80), (m?.index ?? 0) + 80)}`);
  });

  it('real FragDB data (csv/api): quotes the measured figures', async () => {
    const real = new Catalog(FIXTURES, 'csv', { fragrances: FIXTURES.length, brands: 11, dropped: 0, unresolvedNotes: 0, unresolvedAccords: 0 });
    assert.match(await texts(real), STATS);
  });
});

describe('headline claims match the facts behind them', () => {
  const rec = (pid: string, kind: 'value' | 'persona', data: Record<string, string | number>) => ({
    fragrance: catalog.get(pid)!, final: 0.8, retrieval: 0.8, judgement: { fit: 3, confidence: 0.9, facets: {} },
    reasons: [{ kind, weight: 1, data }],
  });
  it('only budget-tier perfumes are called cheap', () => {
    assert.match(headline(rec('I', 'value', { value: 'great value', tier: 'budget' }), facets({})), /friendly price/);
    const mid = headline(rec('C', 'value', { value: 'great value', tier: 'mid' }), facets({}));
    assert.doesNotMatch(mid, /friendly price|cheap/);
    assert.match(mid, /value for money/);
  });
  it('persona phrasing follows the wearer\'s age/style', () => {
    assert.match(headline(rec('E', 'persona', { ageStyle: 'mature_elegant' }), facets({})), /grown-up/);
    assert.doesNotMatch(headline(rec('G', 'persona', { ageStyle: 'contemporary' }), facets({})), /grown-up/);
  });
});

describe('reply prose', () => {
  it('does not mention launch years (recommendations and explanations)', async () => {
    const bot = new PerfumeBot(catalog, scriptedJev({ occasion: 'evening_party', time_of_day: 'night' }));
    const r1 = await bot.chat(undefined, 'party');
    const r2 = await new PerfumeBot(catalog, scriptedJev({ intent: 'explain' })).chat(undefined, 'tell me about Rose Imperiale');
    for (const text of [r1.reply.text, r2.reply.text]) assert.doesNotMatch(text, /\b(18|19|20)\d\d\b/, text);
  });
});

describe('opening and filler (live regressions)', () => {
  it('a taste-led opening is not followed by a sentence repeating the same families', async () => {
    // Live: "Since you're drawn to bright citrus scents... For the person you described, I'd lean towards bright citrus scents."
    const { res } = await turn('budget citrus for an outdoor wedding in Greece', {
      occasion: 'wedding', climate: 'hot_dry', season: 'summer', like_citrus: 0.98, persona: 0.58, lead: 'taste',
    });
    const opening = res.reply.text.split('\n')[0]!;
    assert.equal((opening.match(/bright citrus/g) ?? []).length, 1, opening);
    assert.doesNotMatch(opening, /person you described/);
  });

  it('never says "the wearer you described" without saying anything about the wearer', async () => {
    const { res } = await turn('I love citrus', { persona: 0.9, like_citrus: 0.9, persona_fit: 0.9 });
    const all = [res.reply.text, ...res.reply.recommendations.flatMap((r) => [r.headline, ...r.bullets])].join('\n');
    assert.doesNotMatch(all, /wearer you described/);
  });

  it('a hot-climate opener that calls the picks fresh is not used when the picks are heavy', async () => {
    // Force heavy picks in humid heat: user loves gourmand.
    const { res } = await turn('sweet vanilla for Bangkok', {
      climate: 'hot_humid', like_gourmand_sweet: 0.95, lead: 'climate',
      fit: 2,
    });
    const recs = res.reply.recommendations.map((r) => catalog.get(r.pid)!);
    const heavy = recs.reduce((s, f) => s + features(f).heaviness, 0) / recs.length;
    if (heavy >= 0.45) assert.doesNotMatch(res.reply.text.split('\n')[0]!, /lean fresh|crisp and breathable/);
  });
});
