/**
 * Multi-turn conversation behaviour: who the wearer is, what a follow-up points
 * at, what our own chips mean, and how a turn degrades when Jev is slow or fails.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Catalog } from '../src/catalog/catalog.js';
import { JevError } from '../src/jev/client.js';
import type { ChoiceQuestion, DecideOptions, Decider, NoulQuestion, Question } from '../src/jev/types.js';
import { FOLLOW_UPS, compareFollowUps, explainFollowUps, matchFollowUp, moreLike } from '../src/pipeline/followups.js';
import { NoteLexicon, ordinalRefs } from '../src/pipeline/lexicon.js';
import { PerfumeBot } from '../src/pipeline/orchestrator.js';
import { SessionStore } from '../src/pipeline/session.js';
import type { Trace } from '../src/pipeline/trace.js';
import { mergeFacets, understand } from '../src/pipeline/understand.js';
import type { Facets, Fragrance, Session } from '../src/types.js';
import { EMPTY_FACETS } from '../src/types.js';
import { FIXTURES, fixtureCatalog, makeFragrance, scriptedJev, type Script } from './helpers.js';

const catalog = fixtureCatalog();
const lexicon = new NoteLexicon(catalog);
const facets = (p: Partial<Facets>): Facets => ({ ...structuredClone(EMPTY_FACETS), ...p });

/** Real seed-catalog shapes that caused trouble: names that are ordinary words, and a name two houses share. */
const EXTRA: Fragrance[] = [
  makeFragrance({ pid: 'V1', name: 'First', brand: 'Van Cleef & Arpels', gender: 'women', priceTier: 'luxury' }),
  makeFragrance({ pid: 'Y1', name: 'Paris', brand: 'Yves Saint Laurent', gender: 'women', priceTier: 'mid' }),
  makeFragrance({ pid: 'P1', name: "L'Homme", brand: 'Prada', gender: 'men', priceTier: 'mid' }),
  makeFragrance({ pid: 'Y2', name: "L'Homme", brand: 'Yves Saint Laurent', gender: 'men', priceTier: 'mid' }),
  makeFragrance({ pid: 'N1', name: 'Ani', brand: 'Nishane', gender: 'unisex', priceTier: 'niche' }),
];
const wide = new Catalog([...FIXTURES, ...EXTRA], 'seed', { fragrances: FIXTURES.length + EXTRA.length, brands: 15, dropped: 0, unresolvedNotes: 0, unresolvedAccords: 0 });
const wideLexicon = new NoteLexicon(wide);

type Debug = { understanding: { intent: string; refine: string; facets: Facets }; trace: Trace; telemetry: { failures: number } };
const debugOf = (r: { reply: { debug?: unknown } }) => r.reply.debug as Debug;

/** Makes `s` look as if it has just shown `shown`, as after a recommendation turn. */
function showing(s: Session, shown: string[]): Session {
  s.lastShown = shown;
  s.turns.push({ role: 'user', text: 'a perfume please' }, { role: 'assistant', text: 'Here are some ideas', shown });
  return s;
}
const sessionShowing = (shown: string[]) => showing(new SessionStore().getOrCreate(), shown);

/** A bot whose script can be swapped between turns. */
function scriptedBot(cat: Catalog = catalog) {
  let script: Script = {};
  const bot = new PerfumeBot(cat, scriptedJev((k, s, q) => (typeof script === 'function' ? script(k, s, q) : script[k])));
  return { bot, set: (s: Script) => { script = s; } };
}

// ---------------------------------------------------------------------------
// Finding 11: every stage has its own per-call budget inside the turn
// ---------------------------------------------------------------------------

describe('stage budgets', () => {
  it('passes a per-call budget to every Jev call, by stage', async () => {
    const budgets = new Map<string, Set<number | undefined>>();
    const inner = scriptedJev({ intent: 'compare' });
    const spy: Decider = {
      mode: 'mock',
      decide: (s, q, o) => {
        const stage = (o?.label ?? '').replace(/^judge:.*/, 'judge').replace(/^screen .*/, 'screen');
        budgets.set(stage, (budgets.get(stage) ?? new Set()).add(o?.budgetMs));
        return inner.decide(s, q, o);
      },
    };
    const bot = new PerfumeBot(catalog, spy);
    const r1 = await bot.chat(undefined, 'party');
    await bot.chat(r1.sessionId, 'compare #1 and #2');
    assert.deepEqual(Object.fromEntries([...budgets].map(([k, v]) => [k, [...v]])), {
      // understand has no fallback, so it gets room for a retry beyond one full 10 s attempt.
      understand: [22_000], screen: [12_000], judge: [10_000], compose: [10_000], compare: [10_000],
    });
  });

  it('judge calls that never answer fall back to vote data instead of timing the whole turn out', async () => {
    const inner = scriptedJev({ occasion: 'office' });
    const hanging: Decider = {
      mode: 'mock',
      decide: (s, q, o?: DecideOptions) => {
        if (!o?.label?.startsWith('judge:')) return inner.decide(s, q, o);
        // Never answers. Stands in for the client: its budget, scaled 1000x down, is the only thing
        // that can end the call before the turn's own timeout does.
        return new Promise((_resolve, reject) => {
          o.signal?.addEventListener('abort', () => reject(o.signal!.reason), { once: true });
          if (o.budgetMs !== undefined) setTimeout(() => reject(new JevError('budget spent', undefined, true)), o.budgetMs / 1000);
        });
      },
    };
    const r = await new PerfumeBot(catalog, hanging, { turnTimeoutMs: 1500 }).chat(undefined, 'office perfume');
    assert.ok(r.reply.recommendations.length > 0, 'the turn still recommends');
    assert.ok(debugOf(r).telemetry.failures > 0, 'the judge calls did fail');
  });
});

// ---------------------------------------------------------------------------
// Finding 13: a failed compare call still renders the comparison
// ---------------------------------------------------------------------------

describe('compare when Jev fails', () => {
  const failingCompare = (err: Error): Decider => {
    const inner = scriptedJev({ intent: 'compare' });
    return { mode: 'mock', decide: (s, q, o) => (o?.label === 'compare' ? Promise.reject(err) : inner.decide(s, q, o)) };
  };

  it('an overloaded Jev renders the side-by-side with no winner', async () => {
    const bot = new PerfumeBot(catalog, failingCompare(new JevError('Jev HTTP 529: overloaded', 529, true)));
    const r = await bot.chat(showing(bot.sessions.getOrCreate(), ['C', 'G', 'E']).id, 'compare #1 and #2');
    assert.match(r.reply.text, /they're close/);
    assert.match(r.reply.text, /\*\*Quiet Musk\*\*/);
    assert.match(r.reply.text, /\*\*Blue Current\*\*/);
  });

  it('a rejected API key still surfaces', async () => {
    const bot = new PerfumeBot(catalog, failingCompare(new JevError('Jev HTTP 401', 401)));
    await assert.rejects(bot.chat(showing(bot.sessions.getOrCreate(), ['C', 'G', 'E']).id, 'compare #1 and #2'), /401/);
  });
});

// ---------------------------------------------------------------------------
// Finding 16 (+28): refining to a different wearer
// ---------------------------------------------------------------------------

describe('a different wearer', () => {
  const mum = facets({
    occasion: 'evening_party', region: 'mediterranean', climate: 'hot_dry', season: 'summer', timeOfDay: 'night', budget: 'luxury',
    gender: 'feminine', ageStyle: 'mature_elegant', persona: 'a 65 year-old lady who loves the colour pink', favouriteColour: 'pink',
    likes: { floral_rose: 0.9, floral_soft_powdery: 0.75 }, avoids: { oud_smoky: 0.8 }, likedNotes: ['Rose'], avoidedNotes: ['Oud'],
  });

  it('refine to someone else resets the wearer and keeps the situation', () => {
    const m = mergeFacets(mum, facets({ gender: 'masculine', ageStyle: 'contemporary' }), 'refine', false, 'none', []);
    assert.deepEqual(
      [m.gender, m.ageStyle, m.persona, m.favouriteColour, m.likes, m.avoids, m.likedNotes, m.avoidedNotes],
      ['masculine', 'contemporary', '', 'none', {}, {}, [], []],
    );
    assert.deepEqual(
      [m.occasion, m.region, m.climate, m.season, m.timeOfDay, m.budget],
      ['evening_party', 'mediterranean', 'hot_dry', 'summer', 'night', 'luxury'],
    );
  });

  async function afterTheLady(message: string, script: Script) {
    const { bot, set } = scriptedBot();
    set({ occasion: 'evening_party', budget: 'luxury', gender: 'feminine', age_style: 'mature_elegant', persona: 0.95, favourite_colour: 'pink', like_floral_rose: 0.9, like_floral_soft_powdery: 0.75 });
    const r1 = await bot.chat(undefined, 'A suitable perfume for a 65 year-old lady who loves the colour pink, for an evening party');
    set(script);
    return bot.chat(r1.sessionId, message);
  }
  const forTheSon = (sameWearer: number) => afterTheLady('Now something for my 30 year old son', {
    intent: 'refine', same_wearer: sameWearer, gender: 'masculine', age_style: 'contemporary', persona: 0.9,
  });

  it('end to end: Jev sure it is someone else -> nothing of the lady carries over', async () => {
    const r = await forTheSon(0.02);
    const f = debugOf(r).understanding.facets;
    assert.equal(f.gender, 'masculine');
    assert.deepEqual(f.likes, {});
    assert.equal(f.favouriteColour, 'none');
    assert.doesNotMatch(f.persona, /lady|pink/);
    assert.equal(f.occasion, 'evening_party', 'the situation carries over');
    assert.equal(f.budget, 'luxury', 'the situation carries over');
    const all = [r.reply.text, ...r.reply.recommendations.flatMap((c) => c.bullets)].join('\n');
    assert.doesNotMatch(all, /pink/i);
  });

  it('Jev leaning towards a different wearer (same_wearer 0.4) -> the old wearer does not carry over', async () => {
    // Review follow-up: at 0.35 the son's reply still said "love of pink" with a 0.3 threshold.
    const f = debugOf(await forTheSon(0.4)).understanding.facets;
    assert.equal(f.favouriteColour, 'none');
    assert.equal(f.likes.floral_rose, undefined);
  });

  it('Jev leaning towards the same wearer (same_wearer 0.6) -> a refine keeps the wearer', async () => {
    const f = debugOf(await forTheSon(0.6)).understanding.facets;
    assert.equal(f.favouriteColour, 'pink');
    assert.ok(f.likes.floral_rose);
  });

  it('our own chips never change the wearer, whatever same_wearer says', async () => {
    const f = debugOf(await afterTheLady(FOLLOW_UPS.cheaper.text, { same_wearer: 0.02, persona: 0.9 })).understanding.facets;
    assert.match(f.persona, /lady/);
    assert.equal(f.favouriteColour, 'pink');
    assert.equal(f.ageStyle, 'mature_elegant');
  });
});

// ---------------------------------------------------------------------------
// Finding 18 (+42): what "the first two" and named perfumes point at
// ---------------------------------------------------------------------------

describe('references in follow-ups', () => {
  it('"the first two" / "top two" are positions #1 and #2', () => {
    assert.deepEqual(ordinalRefs('compare the first two'), [0, 1]);
    assert.deepEqual(ordinalRefs('Which of the first two is better for me?'), [0, 1]);
    assert.deepEqual(ordinalRefs('compare your top two picks'), [0, 1]);
    assert.deepEqual(ordinalRefs('the top 3'), [0, 1, 2]);
    assert.deepEqual(ordinalRefs('compare the first and the third'), [0, 2], 'unchanged');
  });

  it('positions past the list count only when they refer to the list', () => {
    assert.deepEqual(ordinalRefs('tell me about the sixth one'), [5]);
    assert.deepEqual(ordinalRefs('what about #7?'), [6]);
    assert.deepEqual(ordinalRefs('which is better for my 10th anniversary?'), []);
  });

  const ask = (message: string, script: Script, shown = ['C', 'G', 'E']) =>
    understand({ message, session: sessionShowing(shown), catalog: wide, lexicon: wideLexicon, decider: scriptedJev(script) });

  it('"compare the first two" compares #1 and #2, not a perfume called "First"', async () => {
    const u = await ask('compare the first two', { intent: 'compare', ref_0: 'incidental' });
    assert.equal(u.intent, 'compare');
    assert.deepEqual(u.focusPids, ['C', 'G']);
  });

  it('a name Jev calls incidental never fills a compare, explain or more-like', async () => {
    // "these" is every perfume shown, never Paris.
    const cmp = await ask('Which of these is better for a trip to Paris?', { intent: 'compare', ref_0: 'incidental' });
    assert.deepEqual(cmp.focusPids, ['C', 'G', 'E']);
    // "it", with Jev pointing at none of the three: ask which one, never Paris and never a guess at #1.
    const exp = await ask('Would it work for a trip to Paris?', { intent: 'explain', ref_0: 'incidental' });
    assert.deepEqual(exp.focusPids, []);
    assert.deepEqual(exp.unresolved, { kind: 'position', position: 0, shown: 3 });
    const more = await ask('something like that for a trip to Paris', { intent: 'more_like', ref_0: 'incidental' });
    assert.deepEqual(more.facets.referencePids, []);
  });

  it('a name Jev says the user is asking about or likes does fill them', async () => {
    const cmp = await ask('is Paris better than the second one?', { intent: 'compare', ref_0: 'asking' });
    assert.deepEqual(cmp.focusPids, ['G', 'Y1']);
    const exp = await ask('I adore Paris, what is it like?', { intent: 'explain', ref_0: 'similar' });
    assert.deepEqual(exp.focusPids, ['Y1']);
  });
});

// ---------------------------------------------------------------------------
// Finding 19: references we cannot resolve are said plainly
// ---------------------------------------------------------------------------

describe('unresolvable references', () => {
  async function afterFour(script: Script, message: string) {
    const { bot, set } = scriptedBot();
    set({ occasion: 'evening_party' });
    const r1 = await bot.chat(undefined, 'party perfume');
    assert.equal(r1.reply.recommendations.length, 4);
    set(script);
    return { r1, r: await bot.chat(r1.sessionId, message) };
  }

  it('"the sixth one" after four picks says so instead of describing #1', async () => {
    const { r1, r } = await afterFour({ intent: 'explain' }, 'tell me about the sixth one');
    assert.match(r.reply.text, /I only showed 4 options, so there's no #6/);
    assert.doesNotMatch(r.reply.text, new RegExp(`\\*\\*${r1.reply.recommendations[0]!.name}\\*\\*`));
  });

  it('a perfume that is not in the catalog is named as such', async () => {
    const { r1, r } = await afterFour({ intent: 'explain', unknown_perfume: 0.9 }, 'Tell me about Creed Silver Mountain Wolf 2025');
    assert.match(r.reply.text, /I don't have that perfume in my catalog/);
    assert.doesNotMatch(r.reply.text, new RegExp(`\\*\\*${r1.reply.recommendations[0]!.name}\\*\\*`));
  });

  it('comparing with an unknown perfume or position does not compare two other perfumes', async () => {
    const unknown = await afterFour({ intent: 'compare', unknown_perfume: 0.9 }, 'compare the first one with Kayali Vanilla 28');
    assert.match(unknown.r.reply.text, /couldn't find one of those perfumes/);
    const position = await afterFour({ intent: 'compare' }, 'compare the first one with the sixth one');
    assert.match(position.r.reply.text, /no #6/);
  });

  it('a perfume name that looks like a position is reported as a perfume', async () => {
    const { r } = await afterFour({ intent: 'explain', unknown_perfume: 0.9 }, 'Tell me about Chanel No 5');
    assert.match(r.reply.text, /I don't have that perfume in my catalog/);
  });

  it('a reference that does resolve is answered as before', async () => {
    const { r1, r } = await afterFour({ intent: 'explain', unknown_perfume: 0.05 }, 'tell me more about the second one');
    assert.match(r.reply.text, new RegExp(`^\\*\\*${r1.reply.recommendations[1]!.name}\\*\\*`));
  });

  it('Jev is asked about perfumes other than the ones on the table', async () => {
    let q: NoulQuestion | undefined;
    await understand({
      message: 'tell me about Quiet Musk', session: sessionShowing(['C', 'G']), catalog, lexicon,
      decider: scriptedJev((k, _s, question) => { if (k === 'unknown_perfume') q = question as NoulQuestion; return undefined; }),
    });
    assert.match(q!.instructions, /LATEST message name a specific perfume other than these: Quiet Musk by Studio Clean; Blue Current by Homme Moderne\?$/);
  });
});

// ---------------------------------------------------------------------------
// Findings 20, 21, 40: our chips are recognised exactly, and only exactly
// ---------------------------------------------------------------------------

describe('chip recognition', () => {
  it('free text that merely starts like a chip is left to Jev', () => {
    assert.equal(matchFollowUp('Tell me more about Quiet Musk and how it compares to Blue Current', catalog), undefined);
    assert.equal(matchFollowUp('More like the first one', wide), undefined);
    assert.equal(matchFollowUp('More like Ember Nocturne but cheaper', catalog), undefined);
  });

  it('the exact chip text is recognised, case- and punctuation-insensitive', () => {
    assert.deepEqual(matchFollowUp('more like ember nocturne by maison test!', catalog), { text: 'more like ember nocturne by maison test!', intent: 'more_like', pid: 'A' });
    // Our chips always carry the brand; a bare name is left to Jev ("tell me more about her" is not Burberry Her).
    assert.equal(matchFollowUp('More like Ember Nocturne', catalog), undefined);
  });

  it('"More like X but cheaper", typed by the user, keeps Jev\'s refine', async () => {
    const { bot, set } = scriptedBot();
    set({ occasion: 'office' });
    const r1 = await bot.chat(undefined, 'office');
    set({ intent: 'more_like', refine: 'cheaper', ref_0: 'similar' });
    const u = debugOf(await bot.chat(r1.sessionId, 'More like Ember Nocturne but cheaper')).understanding;
    assert.equal(u.intent, 'more_like');
    assert.equal(u.refine, 'cheaper');
  });

  it('chips carry the brand, so a name two houses share resolves to the right one', () => {
    const [prada, ysl] = [wide.get('P1')!, wide.get('Y2')!];
    assert.equal(matchFollowUp(explainFollowUps(prada)[0]!, wide)?.pid, 'P1');
    assert.equal(matchFollowUp(explainFollowUps(ysl)[0]!, wide)?.pid, 'Y2');
    assert.equal(matchFollowUp(moreLike("L'Homme"), wide), undefined, 'a bare shared name is ambiguous');
  });

  it('every perfume chip resolves to its own perfume, short names included', () => {
    for (const fr of wide.fragrances) {
      for (const chip of [...explainFollowUps(fr), ...compareFollowUps(fr)]) {
        if (Object.values(FOLLOW_UPS).some((d) => d.text === chip)) continue;
        assert.equal(matchFollowUp(chip, wide)?.pid, fr.pid, chip);
      }
    }
  });

  it('"Tell me more about First by Van Cleef & Arpels" explains First, not #1', async () => {
    const bot = new PerfumeBot(wide, scriptedJev({ intent: 'recommend' }));
    const r = await bot.chat(showing(bot.sessions.getOrCreate(), ['C', 'G', 'E']).id, compareFollowUps(wide.get('V1')!)[0]!);
    assert.match(r.reply.text, /^\*\*First\*\* by Van Cleef & Arpels/);
  });
});

// ---------------------------------------------------------------------------
// Finding 22: the persona is the wearer's description, not a log of messages
// ---------------------------------------------------------------------------

describe('persona', () => {
  it('Jev is asked about the LATEST message only', async () => {
    let q: NoulQuestion | undefined;
    await understand({
      message: 'x', session: new SessionStore().getOrCreate(), catalog, lexicon,
      decider: scriptedJev((k, _s, question) => { if (k === 'persona') q = question as NoulQuestion; return undefined; }),
    });
    assert.match(q!.instructions, /LATEST message/);
  });

  it('follow-ups do not accumulate into the persona', async () => {
    const first = 'my 65 year old mum who loves pink';
    const bot = new PerfumeBot(catalog, scriptedJev((k, s) => (k === 'persona' ? (s.latest_message === first ? 0.95 : 0.05) : undefined)));
    let r = await bot.chat(undefined, first);
    for (const m of ['Something more affordable', 'Only unisex options', 'Something lighter and more subtle', 'Compare #1 and #2']) {
      r = await bot.chat(r.sessionId, m);
    }
    assert.equal(bot.sessions.getOrCreate(r.sessionId).facets.persona, first);
  });

  it('our chips never add to the persona, even if Jev reads a wearer into them', async () => {
    const bot = new PerfumeBot(catalog, scriptedJev({ persona: 0.95 }));
    const r1 = await bot.chat(undefined, 'my 65 year old mum who loves pink');
    const r2 = await bot.chat(r1.sessionId, FOLLOW_UPS.cheaper.text);
    assert.equal(debugOf(r2).understanding.facets.persona, 'my 65 year old mum who loves pink');
  });

  it('a long persona keeps its beginning', () => {
    const original = `my mum, 65, ${'loves gardening and '.repeat(19)}pink`;
    const m = mergeFacets(facets({ persona: original }), facets({ persona: 'she is also a retired teacher' }), 'refine', true, 'none', []);
    assert.ok(m.persona.startsWith('my mum, 65'), m.persona.slice(0, 40));
    assert.ok(m.persona.length <= 400);
  });
});

// ---------------------------------------------------------------------------
// Finding 25: a refine steps once
// ---------------------------------------------------------------------------

describe('relative refinements step one level', () => {
  it('"stronger" steps projection and longevity once, even when Jev also reads them as strong', () => {
    const m = mergeFacets(facets({}), facets({ projection: 3, longevity: 3 }), 'refine', true, 'stronger', []);
    assert.deepEqual([m.projection, m.longevity], [3, 3]);
    const from2 = mergeFacets(facets({ projection: 2, longevity: 2 }), facets({ projection: 4, longevity: 4 }), 'refine', true, 'stronger', []);
    assert.deepEqual([from2.projection, from2.longevity], [3, 3]);
  });

  it('"lighter" and "cheaper" step once from the previous value', () => {
    assert.equal(mergeFacets(facets({ projection: 3 }), facets({ projection: 1 }), 'refine', true, 'lighter', []).projection, 2);
    assert.equal(mergeFacets(facets({ budget: 'luxury' }), facets({ budget: 'budget' }), 'refine', true, 'cheaper', []).budget, 'mid');
    assert.equal(mergeFacets(facets({ budget: 'budget' }), facets({ budget: 'luxury' }), 'refine', true, 'pricier', []).budget, 'mid');
  });

  it('end to end: the "stronger" chip after an office list', async () => {
    const { bot, set } = scriptedBot();
    set({ occasion: 'office' });
    const r1 = await bot.chat(undefined, 'office perfume');
    set({ projection: 'strong', longevity: 'long' });
    const f = debugOf(await bot.chat(r1.sessionId, FOLLOW_UPS.stronger.text)).understanding.facets;
    assert.deepEqual([f.projection, f.longevity], [3, 3]);
  });
});

// ---------------------------------------------------------------------------
// Finding 26: "cheaper" under an explanation means cheaper than THAT perfume
// ---------------------------------------------------------------------------

describe('cheaper alternatives to an explained perfume', () => {
  it('the explanation offers a chip anchored to the perfume, and none for a budget one', () => {
    assert.ok(explainFollowUps(catalog.get('E')!).includes('Cheaper alternatives to Rose Imperiale by Grande Parfumerie'));
    assert.ok(!explainFollowUps(catalog.get('E')!).includes(FOLLOW_UPS.cheaper.text));
    assert.ok(!explainFollowUps(catalog.get('I')!).some((c) => /cheaper/i.test(c)), 'Ocean Voyage is already budget');
  });

  it('clicking it looks for perfumes like that one, one price level down', async () => {
    const { bot, set } = scriptedBot();
    set({ intent: 'explain', ref_0: 'asking' });
    const r1 = await bot.chat(undefined, 'tell me about Rose Imperiale');
    const chip = r1.reply.followUps.find((c) => c.startsWith('Cheaper alternatives to'))!;
    set({ intent: 'recommend', refine: 'none' });
    const r2 = await bot.chat(r1.sessionId, chip);
    const u = debugOf(r2).understanding;
    assert.deepEqual([u.intent, u.refine, u.facets.referencePids, u.facets.budget], ['more_like', 'cheaper', ['E'], 'mid']);
    assert.ok(!r2.reply.recommendations.some((c) => c.pid === 'E'));
  });

  it('steps down from the perfume\'s price, not from an earlier budget', async () => {
    const { bot, set } = scriptedBot();
    set({ budget: 'luxury' });
    const r1 = await bot.chat(undefined, 'something luxurious');
    set({ intent: 'recommend' });
    const r2 = await bot.chat(r1.sessionId, explainFollowUps(catalog.get('C')!).find((c) => c.startsWith('Cheaper'))!);
    assert.equal(debugOf(r2).understanding.facets.budget, 'budget', 'Quiet Musk is mid-priced');
  });
});

// ---------------------------------------------------------------------------
// Finding 28: the favourite colour is a Jev decision, not a regex
// ---------------------------------------------------------------------------

describe('favourite colour', () => {
  const seen = (message: string, script: Script = {}, session = new SessionStore().getOrCreate()) => {
    const qs: Record<string, Question> = {};
    const decider = scriptedJev((k, s, q) => {
      qs[k] = q;
      return typeof script === 'function' ? script(k, s, q) : script[k];
    });
    return understand({ message, session, catalog, lexicon, decider }).then((u) => ({ u, qs }));
  };

  it('is asked only when the message has a colour word, and lists the traps as "none"', async () => {
    assert.equal((await seen('a warm cosy scent')).qs.favourite_colour, undefined);
    const { qs } = await seen('she hates pink but adores roses');
    const none = (qs.favourite_colour as ChoiceQuestion).criteria.none!;
    for (const trap of ['hates pink', 'orange blossom', 'golden years', 'navy officer']) assert.match(none, new RegExp(trap));
  });

  it('lands in facets.favouriteColour, and "none" stays none', async () => {
    assert.equal((await seen('a perfume for my mum who loves pink', { favourite_colour: 'pink' })).u.facets.favouriteColour, 'pink');
    assert.equal((await seen('my grandmother adores orange blossom', { favourite_colour: 'none' })).u.facets.favouriteColour, 'none');
  });

  it('follows the same wearer and resets with a new one', () => {
    const prev = facets({ favouriteColour: 'pink', gender: 'feminine' });
    assert.equal(mergeFacets(prev, facets({}), 'refine', true, 'none', []).favouriteColour, 'pink');
    assert.equal(mergeFacets(prev, facets({ occasion: 'office' }), 'recommend', true, 'none', []).favouriteColour, 'pink');
    assert.equal(mergeFacets(prev, facets({}), 'recommend', false, 'none', []).favouriteColour, 'none');
    assert.equal(mergeFacets(prev, facets({}), 'refine', false, 'none', []).favouriteColour, 'none');
  });

  it('shows under the Wearer lever in the trace', async () => {
    const r = await new PerfumeBot(catalog, scriptedJev({ favourite_colour: 'pink' })).chat(undefined, 'for my mum who loves pink');
    const wearer = debugOf(r).trace.levers.find((g) => g.lever === 'Wearer')!;
    const item = wearer.items.find((i) => i.key === 'favourite_colour')!;
    assert.deepEqual([item.label, item.answer, item.status], ['Favourite colour', 'pink', 'used']);
  });
});

describe('explicit levels in a refine (review follow-up to finding 25)', () => {
  const f = (p: Partial<Facets>): Facets => ({ ...structuredClone(EMPTY_FACETS), ...p });
  it('an absolute level Jev confirms overrides the one-step change when it goes further', () => {
    assert.equal(mergeFacets(f({ budget: 'luxury' }), f({ budget: 'budget' }), 'refine', true, 'cheaper', [], true).budget, 'budget');
    assert.deepEqual(
      (({ projection, longevity }) => [projection, longevity])(mergeFacets(f({ projection: 1, longevity: 1 }), f({ projection: 4, longevity: 4 }), 'refine', true, 'stronger', [], true)),
      [4, 4]);
    assert.equal(mergeFacets(f({ projection: 3 }), f({ projection: 1 }), 'refine', true, 'lighter', [], true).projection, 1);
  });
  it('an absolute level that is NOT further keeps the one-step change', () => {
    assert.equal(mergeFacets(f({ budget: 'luxury' }), f({ budget: 'luxury' }), 'refine', true, 'cheaper', [], true).budget, 'mid');
    assert.equal(mergeFacets(f({ projection: 2 }), f({ projection: 2 }), 'refine', true, 'stronger', [], true).projection, 3);
  });
  it('end to end: "under $40" after a luxury list goes to budget only when Jev says the level is explicit', async () => {
    let script: Record<string, string | number> = { budget: 'luxury' };
    const bot = new PerfumeBot(catalog, scriptedJev((k) => script[k]));
    const r1 = await bot.chat(undefined, 'something luxurious');
    script = { intent: 'refine', refine: 'cheaper', budget: 'budget', explicit_level: 0.9 };
    const explicit = debugOf(await bot.chat(r1.sessionId, 'too expensive - under $40 please')).understanding.facets;
    assert.equal(explicit.budget, 'budget');
    const bot2 = new PerfumeBot(catalog, scriptedJev((k) => script[k]));
    script = { budget: 'luxury' };
    const r2 = await bot2.chat(undefined, 'something luxurious');
    script = { intent: 'refine', refine: 'cheaper', budget: 'budget', explicit_level: 0.1 };
    const relative = debugOf(await bot2.chat(r2.sessionId, 'something a bit cheaper')).understanding.facets;
    assert.equal(relative.budget, 'mid');
  });
});

describe('integration follow-ups to the review', () => {
  it('"tell me about <short catalog name>" is explained, not answered with "not in my catalog"', async () => {
    // "Eros"/"Coco" are too common-word-like for the pre-pass without their brand; once Jev says a
    // perfume is named, an exact catalog name in the message is used.
    const short = makeFragrance({ pid: 'S', name: 'Eros', brand: 'Versace', accords: [{ name: 'fresh', strength: 100 }], seasonV: { summer: 10 } });
    const cat = new Catalog([...FIXTURES, short], 'seed', { fragrances: 13, brands: 12, dropped: 0, unresolvedNotes: 0, unresolvedAccords: 0 });
    const bot = new PerfumeBot(cat, scriptedJev({ intent: 'explain', unknown_perfume: 0.95 }));
    const r = await bot.chat(undefined, 'tell me about Eros');
    assert.match(r.reply.text, /^\*\*Eros\*\* by Versace/);
    // ...while a name we genuinely do not carry still gets the honest answer.
    const r2 = await bot.chat(undefined, 'tell me about Silver Mountain Wolf');
    assert.doesNotMatch(r2.reply.text, /^\*\*/);
  });

  it('a programming error in compare surfaces instead of rendering "too close to call"', async () => {
    let n = 0;
    const inner = scriptedJev({ intent: 'compare' });
    const broken: Decider = {
      mode: 'mock',
      decide: (st, q, o) => (o?.label === 'compare' && ++n ? Promise.reject(new TypeError('boom')) : inner.decide(st, q, o)),
    };
    const bot = new PerfumeBot(catalog, broken);
    const r1 = await bot.chat(undefined, 'party');
    await assert.rejects(bot.chat(r1.sessionId, 'compare #1 and #2'), TypeError);
  });

  it('ordinals: counted nouns are not positions; "the sixth" at the end of a phrase is', () => {
    assert.deepEqual(ordinalRefs('What are the top 3 notes in the second one?'), [1]);
    assert.deepEqual(ordinalRefs('Which of the first two is better for me?'), [0, 1]);
    assert.deepEqual(ordinalRefs('tell me about the sixth'), [5]);
    assert.deepEqual(ordinalRefs('and the 6th?'), [5]);
    assert.deepEqual(ordinalRefs('a gift for my 10th anniversary'), []);
  });
});

describe('taste questions read only the latest message (live regression)', () => {
  it('like_/avoid_ questions ask about the LATEST message, so an earlier wearer\'s tastes are not re-asserted', async () => {
    // Live: after the pink lady, "Now something for my 30 year old son" got like_floral_rose 0.56 because
    // Jev re-read the earlier turns. Carrying tastes is mergeFacets' job, not the classifier's.
    const asked: Record<string, string> = {};
    const spy = scriptedJev((k, _s, q) => { asked[k] = q.instructions; return undefined; });
    const session = new SessionStore().getOrCreate();
    await understand({ message: 'nothing too sweet, I love roses', session, catalog, lexicon: new NoteLexicon(catalog), decider: spy });
    assert.match(asked.like_floral_rose!, /LATEST message/);
    assert.match(asked.avoid_gourmand_sweet!, /LATEST message/);
  });
});
