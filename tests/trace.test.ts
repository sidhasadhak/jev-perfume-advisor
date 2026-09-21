import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PerfumeBot } from '../src/pipeline/orchestrator.js';
import { retrieve } from '../src/pipeline/retrieve.js';
import type { Trace, TraceItem } from '../src/pipeline/trace.js';
import { EMPTY_FACETS, type Facets } from '../src/types.js';
import { fixtureCatalog, scriptedJev, type Script } from './helpers.js';

const catalog = fixtureCatalog();
const facets = (p: Partial<Facets>): Facets => ({ ...structuredClone(EMPTY_FACETS), ...p });

async function traceOf(message: string, script: Script, confidence = 0.9, sessionId?: string, bot?: PerfumeBot) {
  const b = bot ?? new PerfumeBot(catalog, scriptedJev(script, confidence));
  const r = await b.chat(sessionId, message);
  const d = r.reply.debug as { trace: Trace; understanding: { facets: Facets } };
  const find = (key: string): TraceItem | undefined => d.trace.levers.flatMap((g) => g.items).find((i) => i.key === key);
  const leverOf = (key: string) => d.trace.levers.find((g) => g.items.some((i) => i.key === key))?.lever;
  return { r, trace: d.trace, facets: d.understanding.facets, find, leverOf, bot: b };
}

describe('location classifiers', () => {
  it('Jev is asked for region and setting, and they land in the facets', async () => {
    const t = await traceOf('A summer holiday in Turkey, mostly at the beach', { region: 'mediterranean', setting: 'outdoor', season: 'summer' });
    assert.equal(t.facets.region, 'mediterranean');
    assert.equal(t.facets.setting, 'outdoor');
    assert.equal(t.leverOf('region'), 'Location & climate');
    assert.equal(t.find('region')!.answer, 'the Mediterranean');
  });

  it('indoor favours discreet projection; outdoor tolerates more', () => {
    const quiet = catalog.get('C')!; // intimate/moderate sillage
    const loud = catalog.get('K')!; // enormous sillage
    const pos = (f: Facets, pid: string) => retrieve(catalog, f, { limit: Infinity, maxPerBrand: Infinity }).findIndex((c) => c.fragrance.pid === pid);
    assert.ok(pos(facets({ setting: 'indoor' }), quiet.pid) < pos(facets({ setting: 'indoor' }), loud.pid));
    const s = (setting: Facets['setting'], pid: string) =>
      retrieve(catalog, facets({ setting }), { limit: Infinity, maxPerBrand: Infinity }).find((c) => c.fragrance.pid === pid)!.signals.setting!;
    assert.ok(s('outdoor', loud.pid) > s('indoor', loud.pid));
  });

  it('region is passed to Jev\'s judgement as context', async () => {
    let seen = '';
    const bot = new PerfumeBot(catalog, scriptedJev((k, state) => {
      if (k === 'region') return 'middle_east';
      if (k === 'fit' && !seen) seen = String(state.what_we_know);
      return undefined;
    }));
    await bot.chat(undefined, 'something for Dubai');
    assert.match(seen, /location: the Middle East/);
  });
});

describe('How Jev decided: the trace', () => {
  it('groups every classifier under its lever, with answer, confidence and status', async () => {
    const t = await traceOf('Evening party in Turkey, budget-friendly', {
      occasion: 'evening_party', region: 'mediterranean', budget: 'budget', time_of_day: 'night', tone: 'enthusiastic', lead: 'occasion',
    });
    const levers = t.trace.levers.map((g) => g.lever);
    for (const l of ['Conversation', 'Occasion', 'Location & climate', 'Season & time', 'Wearer', 'Preferences', 'Budget', 'Reply shape']) {
      assert.ok(levers.includes(l), `missing lever ${l}`);
    }
    const occ = t.find('occasion')!;
    assert.deepEqual([occ.answer, occ.status, occ.probability, occ.certainty], ['evening party', 'used', 0.9, 0.9]);
    assert.ok(occ.alternatives!.length > 0);
    assert.equal(t.find('budget')!.status, 'used');
    assert.equal(t.find('tone')!.answer, 'enthusiastic');
    assert.equal(t.find('season')!.status, 'not mentioned');
  });

  it('reports low-confidence answers as ignored', async () => {
    const t = await traceOf('hmm', { occasion: 'office' }, 0.3);
    assert.equal(t.find('occasion')!.status, 'low confidence');
    assert.equal(t.facets.occasion, 'any');
  });

  it('reports facets carried over from an earlier turn', async () => {
    let script: Record<string, string | number> = { occasion: 'evening_party', gender: 'feminine' };
    const bot = new PerfumeBot(catalog, scriptedJev((k) => script[k]));
    const t1 = await traceOf('party for my wife', {}, 0.9, undefined, bot);
    script = { intent: 'refine', refine: 'cheaper' };
    const t2 = await traceOf('cheaper please', {}, 0.9, t1.r.sessionId, bot);
    assert.equal(t2.find('occasion')!.status, 'from earlier');
    assert.equal(t2.facets.occasion, 'evening_party');
  });

  it('shows family likes Jev gave weight to, and whether they were used', async () => {
    const t = await traceOf('she loves pink', { like_floral_rose: 0.92, like_floral_soft_powdery: 0.7, like_fruity: 0.3 });
    const likes = t.trace.levers.find((g) => g.lever === 'Preferences')!.items.filter((i) => i.key.startsWith('like_'));
    assert.deepEqual(likes.map((i) => [i.key, i.status]), [
      ['like_floral_rose', 'used'], ['like_floral_soft_powdery', 'used'], ['like_fruity', 'not used'],
    ]);
  });

  it('names the perfumes and notes Jev was asked about', async () => {
    const t = await traceOf('I love Ember Nocturne and vanilla', { ref_0: 'similar', note_0: 'wants' });
    const items = t.trace.levers.flatMap((g) => g.items);
    assert.ok(items.some((i) => /Ember Nocturne/.test(i.label) && i.answer === 'similar'));
    assert.ok(items.some((i) => /vanilla/i.test(i.label)));
  });

  it('includes the screening (all perfumes) and the detailed judging', async () => {
    const t = await traceOf('party', { occasion: 'evening_party' });
    assert.equal(t.trace.screening!.screened, 12);
    assert.ok(t.trace.screening!.top.length <= 10);
    assert.ok(t.trace.judging!.length > 0);
    assert.ok(Number.isFinite(t.trace.judging![0]!.fit));
    assert.ok('conflict' in t.trace.judging![0]!.checks);
  });

  it('small talk still produces a trace of the one understand call', async () => {
    const t = await traceOf('hello', { intent: 'greeting' });
    assert.equal(t.find('intent')!.answer, 'greeting');
    assert.equal(t.trace.screening, undefined);
  });
});

describe('trace probabilities', () => {
  it('shows the chosen option\'s probability on the same scale as its runner-ups, and certainty separately', async () => {
    // Live Jev returns certainty BELOW the winning probability, e.g. choice=taste p=0.38 certainty=0.27, runner-up 0.30.
    const bot = new PerfumeBot(catalog, scriptedJev((key, _s, q) => undefined));
    const inner = bot as unknown as { decider: { decide: Function } };
    const real = inner.decider.decide.bind(inner.decider);
    inner.decider.decide = async (state: unknown, qs: Record<string, any>, opts: unknown) => {
      const d = await real(state, qs, opts);
      if (qs.lead) (d.answers as any).lead = { type: 'choice', choice: 'taste', confidence: 0.27, probabilities: { taste: 0.38, occasion: 0.3, value: 0.2, climate: 0.1, general: 0.02, persona: 0, reference: 0 } };
      return d;
    };
    const r = await bot.chat(undefined, 'citrus please');
    const lead = (r.reply.debug as { trace: Trace }).trace.levers.flatMap((g) => g.items).find((i) => i.key === 'lead')!;
    assert.equal(lead.probability, 0.38);
    assert.equal(lead.certainty, 0.27);
    assert.ok(lead.alternatives!.every((a) => a.p <= lead.probability), 'no runner-up may look larger than the chosen answer');
  });
});
