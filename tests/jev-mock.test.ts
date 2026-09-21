/**
 * MockJev: the offline decider. Only needs to be well-typed, deterministic and
 * plausible - these tests pin exactly that, not any particular probability.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JevError } from '../src/jev/client.js';
import { MockJev } from '../src/jev/mock.js';
import type { Answer, Question, QuestionSet } from '../src/jev/types.js';
import { choice, noul, score } from '../src/jev/types.js';

const SEASON = choice('Which season is the perfume for?', {
  summer: 'Hot, sunny days',
  winter: 'Cold, snowy months',
  any: 'No season mentioned',
});

const QS = {
  season: SEASON,
  occasion: choice('What occasion is the perfume for?', {
    evening_party: 'Night out, party, club or celebration',
    office: 'Work, office, professional or business setting',
    any: null,
  }),
  warmth: score('How warm is the setting?', ['freezing cold', 'mild weather', 'hot summer heat']),
  pink: noul('Does the user like the colour pink?', { true: 'Mentions pink or rosy colours', false: 'Prefers dark or neutral tones' }),
  gift: noul('Is the perfume a gift?'),
};

const sum = (o: Record<string, number>) => Object.values(o).reduce((s, x) => s + x, 0);

describe('MockJev', () => {
  it('is a mock decider', () => {
    assert.equal(new MockJev().mode, 'mock');
  });

  it('returns an answer of the right type for every question', async () => {
    const d = await new MockJev().decide('a cold snowy winter night out', QS);
    assert.deepEqual(Object.keys(d.answers).sort(), Object.keys(QS).sort());

    for (const key of ['season', 'occasion'] as const) {
      const a = d.answers[key];
      assert.equal(a.type, 'choice');
      assert.ok(a.choice in QS[key].criteria);
      assert.deepEqual(Object.keys(a.probabilities), Object.keys(QS[key].criteria));
      assert.equal(a.confidence, Math.max(...Object.values<number>(a.probabilities)));
    }

    const w = d.answers.warmth;
    assert.equal(w.type, 'score');
    assert.ok(w.score >= 0 && w.score <= 2);
    assert.deepEqual(w.legend, { '0': 'freezing cold', '1': 'mild weather', '2': 'hot summer heat' });
    assert.deepEqual(Object.keys(w.probabilities), ['0', '1', '2']);

    for (const key of ['pink', 'gift'] as const) {
      assert.equal(d.answers[key].type, 'noul');
      assert.ok(d.answers[key].noul >= 0 && d.answers[key].noul <= 1);
    }

    assert.equal(d.model, 'mock-jev');
    assert.equal(d.usage.output_tokens, 0);
    assert.ok(d.usage.input_tokens > 0);
  });

  it('returns probabilities that sum to ~1, rounded to 4 decimals', async () => {
    const d = await new MockJev().decide({ message: 'evening party in a hot summer' }, QS);
    for (const p of [d.answers.season.probabilities, d.answers.occasion.probabilities, d.answers.warmth.probabilities]) {
      assert.ok(Math.abs(sum(p) - 1) < 1e-3, `sum was ${sum(p)}`);
      for (const v of Object.values<number>(p)) assert.equal(v, Math.round(v * 1e4) / 1e4);
    }
  });

  it('is deterministic', async () => {
    const state = { message: 'Something pink for my grandmother', history: ['hi', 'hello'] };
    const a = await new MockJev().decide(state, QS);
    const b = await new MockJev().decide(state, QS);
    assert.deepEqual(a.answers, b.answers);
  });

  it('picks the obviously matching option', async () => {
    const m = new MockJev();
    assert.equal((await m.decide('a cold snowy winter night', { season: SEASON })).answers.season.choice, 'winter');
    assert.equal((await m.decide('a summer in Turkey', { season: SEASON })).answers.season.choice, 'summer');
    assert.equal((await m.decide('suggest me a perfume for an evening party', QS)).answers.occasion.choice, 'evening_party');
    assert.equal((await m.decide('best perfume for a working professional', QS)).answers.occasion.choice, 'office');
  });

  it('falls back to the neutral option when there is no evidence', async () => {
    const d = await new MockJev().decide('hello there', QS);
    assert.equal(d.answers.season.choice, 'any');
    assert.equal(d.answers.occasion.choice, 'any');
    // Skeptical prior: no evidence means "probably not", not a coin flip.
    assert.ok(d.answers.pink.noul < 0.5 && d.answers.pink.noul > 0);
    assert.ok(d.answers.gift.noul < 0.5 && d.answers.gift.noul > 0);
  });

  it('moves noul and score with the evidence', async () => {
    const m = new MockJev();
    const pink = await m.decide('a 65 year-old lady who loves the colour pink', QS);
    assert.ok(pink.answers.pink.noul > 0.5);
    const plain = await m.decide('a 65 year-old lady who prefers dark neutral tones', QS);
    assert.ok(plain.answers.pink.noul < 0.5);

    const hot = await m.decide('a hot summer heat wave', QS);
    const cold = await m.decide('freezing cold Nordic winters', QS);
    assert.ok(hot.answers.warmth.score > 1, `hot scored ${hot.answers.warmth.score}`);
    assert.ok(cold.answers.warmth.score < 1, `cold scored ${cold.answers.warmth.score}`);
    assert.equal(hot.answers.warmth.confidence, Math.max(...Object.values<number>(hot.answers.warmth.probabilities)));
  });

  it('lets the resolver override individual answers', async () => {
    const seen: Array<[unknown, string, Question['type']]> = [];
    const m = new MockJev({
      resolver: (state, key, q) => {
        seen.push([state, key, q.type]);
        if (key === 'season') return { type: 'choice', choice: 'summer', confidence: 1, probabilities: { summer: 1, winter: 0, any: 0 } };
        if (key === 'gift') return { type: 'noul', noul: 0.99 };
        return undefined;
      },
    });
    const d = await m.decide('a cold snowy winter night', QS);
    assert.equal(d.answers.season.choice, 'summer');
    assert.equal(d.answers.gift.noul, 0.99);
    // Unresolved keys still get heuristic answers.
    assert.equal(d.answers.occasion.type, 'choice');
    assert.equal(d.answers.warmth.type, 'score');
    assert.deepEqual(seen.map(([, k]) => k).sort(), Object.keys(QS).sort());
    assert.ok(seen.every(([s]) => s === 'a cold snowy winter night'));
  });

  it('rejects a resolver answer of the wrong type', async () => {
    const m = new MockJev({ resolver: (_s, key) => (key === 'gift' ? ({ type: 'score', score: 1 } as Answer) : undefined) });
    await assert.rejects(m.decide('x', QS), JevError);
    assert.equal(m.telemetry.calls[0]?.ok, false);
  });

  it('records a telemetry entry per call', async () => {
    const m = new MockJev();
    const state = { message: 'winter' };
    const d = await m.decide(state, QS, { label: 'understand' });
    await m.decide('summer', { season: SEASON });

    const expectedTokens = Math.ceil(JSON.stringify({ state, questions: QS }).length / 4);
    assert.equal(d.usage.input_tokens, expectedTokens);
    assert.equal(m.telemetry.calls.length, 2);
    assert.deepEqual(
      m.telemetry.calls.map((c) => [c.label, c.questions, c.ok, c.attempts]),
      [['understand', 5, true, 1], ['decide', 1, true, 1]],
    );
    assert.equal(m.telemetry.calls[0]?.inputTokens, expectedTokens);
    assert.equal(m.telemetry.summary().questions, 6);
  });

  it('propagates validateQuestions errors without recording a call', async () => {
    const m = new MockJev();
    const oneOption = { q: { type: 'choice', instructions: 'Pick', criteria: { only: null } } } as QuestionSet;
    const elevenLevels = { q: { type: 'score', instructions: 'Rate', criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) } } as QuestionSet;
    await assert.rejects(async () => m.decide('x', oneOption), JevError);
    await assert.rejects(async () => m.decide('x', elevenLevels), JevError);
    await assert.rejects(async () => m.decide('x', {}), JevError);
    assert.equal(m.telemetry.calls.length, 0);
  });

  it('simulates latency and honours abort', async () => {
    const m = new MockJev({ latencyMs: 40 });
    const d = await m.decide('x', { season: SEASON });
    assert.ok(d.latencyMs >= 30, `latency was ${d.latencyMs}`);

    const ctl = new AbortController();
    const p = m.decide('x', { season: SEASON }, { signal: ctl.signal });
    ctl.abort(new Error('user left'));
    await assert.rejects(p, /user left/);
    assert.equal(m.telemetry.calls.length, 1);
  });

  it('answers nothing for a call whose signal has already aborted', async () => {
    let asked = 0;
    const m = new MockJev({ resolver: () => { asked++; return undefined; } });
    const ctl = new AbortController();
    ctl.abort(new Error('turn over'));
    await assert.rejects(m.decide('x', QS, { signal: ctl.signal, budgetMs: 5_000 }), /turn over/);
    assert.equal(asked, 0);
    assert.equal(m.telemetry.calls.length, 0);
  });

  it('accepts a time budget without changing its answers, however small', async () => {
    const m = new MockJev({ latencyMs: 20 });
    const plain = await m.decide('a cold snowy winter night', QS);
    const budgeted = await m.decide('a cold snowy winter night', QS, { budgetMs: 1, label: 'judge:x' });
    assert.deepEqual(budgeted.answers, plain.answers);
    assert.deepEqual(m.telemetry.calls.map((c) => [c.label, c.ok]), [['decide', true], ['judge:x', true]]);
  });
});
