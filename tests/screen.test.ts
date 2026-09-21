import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JevError } from '../src/jev/client.js';
import type { Decider, NoulQuestion } from '../src/jev/types.js';
import { PerfumeBot } from '../src/pipeline/orchestrator.js';
import { retrieve } from '../src/pipeline/retrieve.js';
import { compactProfile, screen } from '../src/pipeline/screen.js';
import type { Facets } from '../src/types.js';
import { EMPTY_FACETS } from '../src/types.js';
import { FIXTURES, fixtureCatalog, scriptedJev } from './helpers.js';

const catalog = fixtureCatalog();
const facets = (p: Partial<Facets> = {}): Facets => ({ ...structuredClone(EMPTY_FACETS), ...p });

/** Records every question set it is asked, and answers every screening noul with `p(profile)`. */
function spyDecider(p: (instructions: string) => number = () => 0.5) {
  const seen: Array<{ label?: string; keys: string[]; instructions: string[] }> = [];
  const inner = scriptedJev((key, _s, q) => (q.type === 'noul' && /^p\d+_/.test(key) ? p((q as NoulQuestion).instructions) : undefined));
  const d: Decider = {
    mode: 'mock',
    decide: (state, qs, opts) => {
      seen.push({ label: opts?.label, keys: Object.keys(qs), instructions: Object.values(qs).map((q) => q.instructions) });
      return inner.decide(state, qs, opts);
    },
  };
  return { d, seen };
}

describe('screen', () => {
  it('asks exactly one question per perfume, in batches, with valid keys', async () => {
    const { d, seen } = spyDecider();
    const r = await screen({ message: 'x', facets: facets(), fragrances: FIXTURES, refs: [], decider: d, batchSize: 5 });
    assert.equal(r.screened, FIXTURES.length);
    assert.equal(r.batches, Math.ceil(FIXTURES.length / 5));
    assert.ok(seen.every((c) => c.keys.length <= 5));
    const keys = seen.flatMap((c) => c.keys);
    assert.equal(new Set(keys).size, FIXTURES.length);
    for (const k of keys) assert.match(k, /^[A-Za-z0-9_:-]{1,64}$/);
    assert.equal(r.scores.size, FIXTURES.length);
  });

  it('profiles are built only from catalog data', () => {
    const p = compactProfile(catalog.get('A')!);
    assert.match(p, /Ember Nocturne by Maison Test \(2012\)/);
    assert.match(p, /amber/);
    assert.match(p, /winter/);
  });

  it('a failed batch leaves the others scored; a rejected key on every batch surfaces', async () => {
    let n = 0;
    const flaky: Decider = { mode: 'mock', decide: (s, q, o) => (++n === 1 ? Promise.reject(new JevError('busy', 529, true)) : scriptedJev().decide(s, q, o)) };
    const r = await screen({ message: 'x', facets: facets(), fragrances: FIXTURES, refs: [], decider: flaky, batchSize: 4 });
    assert.equal(r.failedBatches, 1);
    assert.equal(r.scores.size, FIXTURES.length - 4);

    const denied: Decider = { mode: 'live', decide: () => Promise.reject(new JevError('Jev HTTP 401', 401)) };
    await assert.rejects(screen({ message: 'x', facets: facets(), fragrances: FIXTURES, refs: [], decider: denied }), /401/);
  });
});

describe('Jev considers every perfume', () => {
  it('every perfume in the catalog is screened, and the debug trace says so', async () => {
    const { d, seen } = spyDecider();
    const r = await new PerfumeBot(catalog, d).chat(undefined, 'a perfume for an evening party');
    const dbg = r.reply.debug as { screening: { screened: number; of: number } };
    assert.deepEqual({ screened: dbg.screening.screened, of: dbg.screening.of }, { screened: FIXTURES.length, of: FIXTURES.length });
    const screened = seen.filter((c) => c.label?.startsWith('screen')).flatMap((c) => c.instructions);
    for (const f of FIXTURES) assert.ok(screened.some((i) => i.includes(`${f.name} by ${f.brand}`)), `${f.name} was not screened`);
  });

  it('a perfume the vote data ranks LAST reaches the top when Jev rates it best', async () => {
    const f = facets({ occasion: 'evening_party', timeOfDay: 'night' });
    const byVotes = retrieve(catalog, f, { limit: Infinity, maxPerBrand: Infinity, hardGate: false });
    const last = byVotes[byVotes.length - 1]!.fragrance;
    const script = (key: string, state: any, q: any) => {
      if (key === 'occasion') return 'evening_party';
      if (key === 'time_of_day') return 'night';
      if (/^p\d+_/.test(key)) return q.instructions.includes(`${last.name} by`) ? 0.99 : 0.2;
      if (key === 'fit') return String(state.candidate_perfume?.name).startsWith(last.name) ? 4 : 2;
      return undefined;
    };
    const r = await new PerfumeBot(catalog, scriptedJev(script)).chat(undefined, 'party');
    assert.equal(r.reply.recommendations[0]!.name, last.name, `expected Jev's pick ${last.name} first`);
  });

  it('wrong-gender perfumes are no longer dropped before Jev sees them', async () => {
    const { d, seen } = spyDecider();
    await new PerfumeBot(catalog, scriptedJev({ gender: 'feminine' })).chat(undefined, 'for my wife');
    const r2 = await new PerfumeBot(catalog, {
      mode: 'mock',
      decide: (s, q, o) => (o?.label?.startsWith('screen') ? d.decide(s, q, o) : scriptedJev({ gender: 'feminine' }).decide(s, q, o)),
    }).chat(undefined, 'for my wife');
    const screened = seen.flatMap((c) => c.instructions).join('\n');
    assert.match(screened, /Black Oud Leather/, 'masculine scents are screened too');
    for (const rec of r2.reply.recommendations) assert.ok(!['G', 'H', 'I'].includes(rec.pid), `${rec.name} is masculine`);
  });

  it('above the screen limit, the vote data picks which perfumes Jev screens - and the trace shows the cap', async () => {
    const { d } = spyDecider();
    const r = await new PerfumeBot(catalog, d, { screenLimit: 5 }).chat(undefined, 'something');
    const dbg = r.reply.debug as { screening: { screened: number; of: number } };
    assert.deepEqual({ screened: dbg.screening.screened, of: dbg.screening.of }, { screened: 5, of: FIXTURES.length });
  });

  it('explicit exclusions still apply before screening', async () => {
    const { d, seen } = spyDecider();
    const bot = new PerfumeBot(catalog, {
      mode: 'mock',
      decide: (s, q, o) => (o?.label?.startsWith('screen') ? d.decide(s, q, o) : scriptedJev({ intent: 'recommend', ref_0: 'different' }).decide(s, q, o)),
    });
    await bot.chat(undefined, 'anything but Quiet Musk');
    const screened = seen.flatMap((c) => c.instructions).join('\n');
    assert.doesNotMatch(screened, /Quiet Musk by/);
  });
});
