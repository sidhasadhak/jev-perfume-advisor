/**
 * JevClient against an injected fetch - no network. Retries use `retry-after: 0`
 * so the backoff paths run instantly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_USD_PER_M_INPUT, JevBudgetError, JevClient, JevError, MAX_RETRY_AFTER_MS, Semaphore, TELEMETRY_KEEP, Telemetry,
  parseRetryAfter, validateQuestions,
} from '../src/jev/client.js';
import type { QuestionSet } from '../src/jev/types.js';
import { choice, noul, score } from '../src/jev/types.js';

interface Call {
  url: string;
  init: RequestInit;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function toResponse(r: Reply): Response {
  const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
  return new Response(text, { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } });
}

/** Fake fetch that replays `replies` in order (the last one repeats) and records every call. */
function fakeFetch(replies: Reply[], delayMs = 0) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return toResponse(replies[Math.min(calls.length - 1, replies.length - 1)] as Reply);
  }) as typeof fetch;
  return { impl, calls };
}

/**
 * Fake fetch whose requests stay in flight until the test answers them (or their
 * signal aborts, like real fetch), so tests can hold concurrency slots on purpose.
 */
function gatedFetch() {
  const sent: Array<{ state: unknown; answer: () => void }> = [];
  const impl = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal as AbortSignal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    sent.push({ state: JSON.parse(init?.body as string).state, answer: () => resolve(toResponse(ok())) });
  })) as typeof fetch;
  return { impl, sent };
}

/** Lets every pending microtask and I/O callback run. */
const tick = () => new Promise<void>((r) => setImmediate(r));

const QS = {
  occasion: choice('What occasion is the perfume for?', { office: 'Work or business', evening_party: null }),
  fit: score('How well does it suit the request?', ['poor', 'ok', 'great']),
  gift: noul('Is the perfume a gift?'),
};

const OK_ANSWERS = {
  occasion: { type: 'choice', choice: 'evening_party', confidence: 0.91, probabilities: { office: 0.09, evening_party: 0.91 } },
  fit: { type: 'score', score: 1.8, confidence: 0.7, legend: { '0': 'poor', '1': 'ok', '2': 'great' }, probabilities: { '0': 0.05, '1': 0.1, '2': 0.85 } },
  gift: { type: 'noul', noul: 0.12 },
};

const ok = (answers: unknown = OK_ANSWERS, input_tokens = 120): Reply => ({
  status: 200,
  body: { model: 'jev-2026-08', answers, usage: { input_tokens, output_tokens: 0 } },
});
const fail = (status: number, body = 'nope'): Reply => ({ status, body, headers: { 'retry-after': '0' } });

function client(replies: Reply[], extra: Partial<ConstructorParameters<typeof JevClient>[0]> = {}) {
  const f = fakeFetch(replies);
  return { c: new JevClient({ apiKey: 'test-key', fetchImpl: f.impl, maxRetries: 2, ...extra }), calls: f.calls };
}

describe('JevClient', () => {
  it('sends a typed request and returns typed answers', async () => {
    const { c, calls } = client([ok()]);
    const state = { message: 'something for an evening party' };
    const d = await c.decide(state, QS, { label: 'understand' });

    // Compile-time: the choice is narrowed to the offered keys.
    const picked: 'office' | 'evening_party' = d.answers.occasion.choice;
    assert.equal(picked, 'evening_party');
    assert.equal(d.answers.occasion.confidence, 0.91);
    assert.deepEqual(d.answers.occasion.probabilities, { office: 0.09, evening_party: 0.91 });
    assert.equal(d.answers.fit.score, 1.8);
    assert.equal(d.answers.fit.legend['2'], 'great');
    assert.equal(d.answers.gift.noul, 0.12);
    assert.equal(d.model, 'jev-2026-08');
    assert.deepEqual(d.usage, { input_tokens: 120, output_tokens: 0 });
    assert.ok(d.latencyMs >= 0);

    assert.equal(calls.length, 1);
    const { url, init } = calls[0] as Call;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.method, 'POST');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-key');
    assert.equal(headers['Content-Type'], 'application/json');
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, 'jev-latest');
    assert.deepEqual(body.state, state);
    assert.deepEqual(body.questions, JSON.parse(JSON.stringify(QS)));
  });

  it('uses a custom model name', async () => {
    const { c, calls } = client([ok()], { model: 'jev-beta' });
    await c.decide('x', QS);
    assert.equal(JSON.parse((calls[0] as Call).init.body as string).model, 'jev-beta');
  });

  it('builds the endpoint whether or not the base already ends in /v1', async () => {
    const withV1 = client([ok()], { baseUrl: 'https://proxy.example.com/v1/' });
    assert.equal(withV1.c.endpoint, 'https://proxy.example.com/v1/systemone');
    await withV1.c.decide('x', QS);
    assert.equal((withV1.calls[0] as Call).url, 'https://proxy.example.com/v1/systemone');

    const bare = client([ok()], { baseUrl: 'https://proxy.example.com//' });
    assert.equal(bare.c.endpoint, 'https://proxy.example.com/v1/systemone');
  });

  it('retries a 429 and then succeeds', async () => {
    const { c, calls } = client([fail(429), ok()]);
    const d = await c.decide('x', QS);
    assert.equal(d.answers.occasion.choice, 'evening_party');
    assert.equal(calls.length, 2);
    assert.equal(c.telemetry.calls[0]?.attempts, 2);
    assert.equal(c.telemetry.calls[0]?.ok, true);
  });

  it('retries a 529 (overloaded)', async () => {
    const { c, calls } = client([fail(529), fail(529), ok()]);
    await c.decide('x', QS);
    assert.equal(calls.length, 3);
  });

  it('gives up after maxRetries on a persistent retryable error', async () => {
    const { c, calls } = client([fail(503)], { maxRetries: 2 });
    await assert.rejects(c.decide('x', QS), (e: unknown) => e instanceof JevError && e.status === 503 && e.retryable);
    assert.equal(calls.length, 3);
    assert.equal(c.telemetry.calls[0]?.ok, false);
  });

  it('does not retry a 401 and points at TYPESAFE_API_KEY', async () => {
    const { c, calls } = client([fail(401, 'bad key'), ok()]);
    await assert.rejects(c.decide('x', QS), (e: unknown) => {
      assert.ok(e instanceof JevError);
      assert.equal(e.status, 401);
      assert.equal(e.retryable, false);
      assert.match(e.message, /TYPESAFE_API_KEY/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it('does not retry a 422', async () => {
    const { c, calls } = client([fail(422, '{"error":"bad schema"}'), ok()]);
    await assert.rejects(c.decide('x', QS), (e: unknown) => e instanceof JevError && e.status === 422 && !e.retryable);
    assert.equal(calls.length, 1);
  });

  it('rejects an answer that picks an option that was not offered', async () => {
    const answers = { ...OK_ANSWERS, occasion: { type: 'choice', choice: 'beach', confidence: 1, probabilities: { beach: 1 } } };
    const { c, calls } = client([ok(answers)]);
    await assert.rejects(c.decide('x', QS), (e: unknown) => e instanceof JevError && /unknown option "beach"/.test(e.message));
    assert.equal(calls.length, 1);
  });

  it('rejects a response with a missing answer', async () => {
    const { gift: _omit, ...answers } = OK_ANSWERS;
    const { c } = client([ok(answers)]);
    await assert.rejects(c.decide('x', QS), (e: unknown) => e instanceof JevError && /missing answer for "gift"/.test(e.message));
  });

  it('rejects an answer of the wrong type', async () => {
    const answers = { ...OK_ANSWERS, gift: { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: {} } };
    const { c } = client([ok(answers)]);
    await assert.rejects(c.decide('x', QS), (e: unknown) => e instanceof JevError && /expected noul/.test(e.message));
  });

  it('records telemetry and cost', async () => {
    const { c } = client([ok(OK_ANSWERS, 1_000), ok(OK_ANSWERS, 499_000), fail(401)]);
    await c.decide('a', QS, { label: 'understand' });
    await c.decide('b', QS, { label: 'rank:1' });
    await assert.rejects(c.decide('c', QS, { label: 'rank:2' }), JevError);

    assert.deepEqual(c.telemetry.calls.map((r) => [r.label, r.questions, r.inputTokens, r.ok]), [
      ['understand', 3, 1_000, true],
      ['rank:1', 3, 499_000, true],
      ['rank:2', 3, 0, false],
    ]);
    const s = c.telemetry.summary();
    assert.equal(s.calls, 3);
    assert.equal(s.questions, 9);
    assert.equal(s.inputTokens, 500_000);
    assert.equal(s.failures, 1);
    assert.ok(Math.abs(s.usd - 0.5 * JEV_USD_PER_M_INPUT) < 1e-12);
  });

  it('limits in-flight requests to the concurrency option', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const inner = fakeFetch([ok()], 15);
    const impl = (async (...args: Parameters<typeof fetch>) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        return await inner.impl(...args);
      } finally {
        inFlight--;
      }
    }) as typeof fetch;
    const c = new JevClient({ apiKey: 'k', fetchImpl: impl, concurrency: 2 });

    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => c.decide(`s${i}`, QS)));
    assert.equal(results.length, 7);
    assert.equal(inner.calls.length, 7);
    assert.equal(maxInFlight, 2);
  });

  it('refuses to construct without an API key', () => {
    assert.throws(() => new JevClient({ apiKey: '' }), (e: unknown) => e instanceof JevError && /TYPESAFE_API_KEY/.test(e.message));
  });
});

describe('validateQuestions', () => {
  const options = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]));
  const levels = (n: number) => Array.from({ length: n }, (_, i) => `level ${i}`);
  // Raw objects on purpose: the choice()/score() builders would throw before we got here.
  const bad: Record<string, QuestionSet> = {
    '1-option choice': { q: { type: 'choice', instructions: 'Pick', criteria: options(1) } },
    '256-option choice': { q: { type: 'choice', instructions: 'Pick', criteria: options(256) } },
    '1-level score': { q: { type: 'score', instructions: 'Rate', criteria: levels(1) } },
    '11-level score': { q: { type: 'score', instructions: 'Rate', criteria: levels(11) } },
    'empty set': {},
    'invalid key': { 'has space': { type: 'noul', instructions: 'Yes?' } },
    'blank instructions': { q: { type: 'noul', instructions: '  ' } },
  };

  for (const [name, qs] of Object.entries(bad)) {
    it(`rejects ${name}`, () => {
      assert.throws(() => validateQuestions(qs), JevError);
    });
  }

  it('accepts the limits themselves (2 and 255 options, 2 and 10 levels)', () => {
    validateQuestions({
      a: { type: 'choice', instructions: 'Pick', criteria: options(2) },
      b: { type: 'choice', instructions: 'Pick', criteria: options(255) },
      c: { type: 'score', instructions: 'Rate', criteria: levels(2) },
      d: { type: 'score', instructions: 'Rate', criteria: levels(10) },
    });
  });

  it('is enforced by decide() before any request is sent', async () => {
    const { c, calls } = client([ok()]);
    await assert.rejects(async () => c.decide('x', bad['256-option choice'] as QuestionSet), JevError);
    assert.equal(calls.length, 0);
    assert.equal(c.telemetry.calls.length, 0);
  });
});

describe('JevClient cancellation', () => {
  it('never sends a call whose signal has already aborted', async () => {
    const { c, calls } = client([ok()]);
    const ctl = new AbortController();
    ctl.abort(new Error('turn over'));
    await assert.rejects(c.decide('x', QS, { signal: ctl.signal }), /turn over/);
    assert.equal(calls.length, 0);
    assert.equal(c.telemetry.calls.length, 0);
  });

  it('drops calls still queued for a slot when the turn aborts, instead of sending them later', { timeout: 5_000 }, async () => {
    const f = gatedFetch();
    const c = new JevClient({ apiKey: 'k', fetchImpl: f.impl, concurrency: 2 });
    const turn = new AbortController();
    const settled = Array.from({ length: 5 }, (_, i) => c.decide(`s${i}`, QS, { signal: turn.signal }).catch((e: unknown) => e));
    await tick();
    assert.equal(f.sent.length, 2, 'two in flight, three queued');

    turn.abort(new Error('user left'));
    for (const e of await Promise.all(settled)) assert.equal((e as Error).message, 'user left');
    assert.equal(f.sent.length, 2, 'the queued calls were never sent');
    assert.equal(c.telemetry.calls.length, 0, 'an abort is not a failure');

    // Both slots came back: a later call goes straight out.
    const next = c.decide('next', QS);
    await tick();
    assert.equal(f.sent.length, 3);
    f.sent[2]?.answer();
    await next;
  });

  it('lets an aborted waiter leave the queue without taking a slot', { timeout: 5_000 }, async () => {
    const f = gatedFetch();
    const c = new JevClient({ apiKey: 'k', fetchImpl: f.impl, concurrency: 1 });
    const first = c.decide('first', QS);
    const ctl = new AbortController();
    const cancelled = c.decide('cancelled', QS, { signal: ctl.signal });
    const last = c.decide('last', QS);
    await tick();

    ctl.abort(new Error('cancelled'));
    await assert.rejects(cancelled, /cancelled/);
    f.sent[0]?.answer();
    await first;
    await tick();
    assert.deepEqual(f.sent.map((s) => s.state), ['first', 'last']);
    f.sent[1]?.answer();
    await last;
  });
});

describe('JevClient time budget', () => {
  const budgetError = (ms: number, extra?: RegExp) => (e: unknown) =>
    e instanceof JevError && !e.retryable && e instanceof JevBudgetError && new RegExp(`within its ${ms}ms budget`).test(e.message) && (!extra || extra.test(e.message));

  it('rejects without sending when the budget cannot fit an attempt', async () => {
    const { c, calls } = client([ok()]);
    await assert.rejects(c.decide('x', QS, { budgetMs: 500 }), budgetError(500));
    assert.equal(calls.length, 0);
  });

  it('counts queueing time, leaving the queue once no attempt could fit', { timeout: 5_000 }, async () => {
    const f = gatedFetch();
    const c = new JevClient({ apiKey: 'k', fetchImpl: f.impl, concurrency: 1 });
    const holder = c.decide('holder', QS); // keeps the only slot until answered
    const t0 = performance.now();
    await assert.rejects(c.decide('late', QS, { budgetMs: 1_200, label: 'judge:late' }), budgetError(1_200));
    const waited = performance.now() - t0;
    // 1200ms budget minus the ~1000ms an attempt needs: it should give up after ~200ms, not wait for the slot.
    assert.ok(waited >= 150 && waited < 1_000, `left the queue after ${Math.round(waited)}ms`);

    f.sent[0]?.answer();
    await holder;
    assert.deepEqual(f.sent.map((s) => s.state), ['holder']);
    assert.deepEqual(c.telemetry.calls.map((r) => [r.label, r.ok, r.attempts]), [['judge:late', false, 0], ['decide', true, 1]]);
  });

  it('cuts the attempt timeout to the budget and does not retry past it', { timeout: 5_000 }, async () => {
    const f = gatedFetch(); // never answered: every attempt runs into its timeout
    const c = new JevClient({ apiKey: 'k', fetchImpl: f.impl, timeoutMs: 10_000, maxRetries: 4 });
    const t0 = performance.now();
    await assert.rejects(c.decide('x', QS, { budgetMs: 1_300 }), budgetError(1_300, /timed out/));
    const took = performance.now() - t0;
    assert.ok(took >= 1_200 && took < 2_000, `took ${Math.round(took)}ms`);
    assert.equal(f.sent.length, 1);
  });

  it('fails fast when Retry-After asks for longer than the budget has left', { timeout: 5_000 }, async () => {
    const { c, calls } = client([{ status: 429, body: 'slow down', headers: { 'retry-after': '5' } }, ok()]);
    const t0 = performance.now();
    await assert.rejects(c.decide('x', QS, { budgetMs: 3_000 }), (e: unknown) => {
      assert.ok(budgetError(3_000, /HTTP 429/)(e));
      assert.equal((e as JevError).status, 429, 'keeps the status, so the server can still say "Jev is busy"');
      return true;
    });
    assert.ok(performance.now() - t0 < 500);
    assert.equal(calls.length, 1);
  });

  it('retries as usual when the budget has room', async () => {
    const { c, calls } = client([fail(529), ok()]);
    const d = await c.decide('x', QS, { budgetMs: 10_000 });
    assert.equal(d.answers.gift.noul, 0.12);
    assert.equal(calls.length, 2);
  });
});

describe('Retry-After', () => {
  const at = (headers: Record<string, string>) => parseRetryAfter(new Headers(headers), Date.parse('Sun, 06 Nov 1994 08:49:37 GMT'));

  it('reads delta-seconds, every HTTP-date form and retry-after-ms', () => {
    assert.equal(at({ 'retry-after': '3' }), 3_000);
    assert.equal(at({ 'retry-after': '0' }), 0);
    assert.equal(at({ 'retry-after': 'Sun, 06 Nov 1994 08:49:47 GMT' }), 10_000);
    assert.equal(at({ 'retry-after': 'Sunday, 06-Nov-94 08:49:47 GMT' }), 10_000);
    assert.equal(at({ 'retry-after': 'Sun Nov  6 08:49:47 1994' }), 10_000, 'asctime has no zone but is GMT');
    assert.equal(at({ 'retry-after': 'Sun, 06 Nov 1994 08:49:30 GMT' }), 0, 'a past date means now');
    assert.equal(at({ 'retry-after-ms': '750', 'retry-after': '3' }), 750);
    assert.equal(at({ 'retry-after-ms': 'soon', 'retry-after': '3' }), 3_000);
    assert.equal(at({}), undefined);
    for (const junk of ['soon', '-1', '1e3', ' ']) assert.equal(at({ 'retry-after': junk }), undefined, junk);
  });

  it('waits for a Retry-After HTTP-date before retrying', { timeout: 5_000 }, async () => {
    const until = Math.ceil((Date.now() + 1_200) / 1_000) * 1_000; // a whole second, so the header is exact
    const sentAt: number[] = [];
    const f = fakeFetch([{ status: 429, body: 'busy', headers: { 'retry-after': new Date(until).toUTCString() } }, ok()]);
    const impl = ((...args: Parameters<typeof fetch>) => (sentAt.push(Date.now()), f.impl(...args))) as typeof fetch;
    await new JevClient({ apiKey: 'k', fetchImpl: impl }).decide('x', QS);
    assert.equal(sentAt.length, 2);
    assert.ok((sentAt[1] as number) >= until - 50, `retried ${until - (sentAt[1] as number)}ms early`);
  });

  it('honours retry-after-ms', { timeout: 5_000 }, async () => {
    const sentAt: number[] = [];
    const f = fakeFetch([{ status: 529, body: 'overloaded', headers: { 'retry-after-ms': '600' } }, ok()]);
    const impl = ((...args: Parameters<typeof fetch>) => (sentAt.push(performance.now()), f.impl(...args))) as typeof fetch;
    await new JevClient({ apiKey: 'k', fetchImpl: impl }).decide('x', QS);
    const gap = (sentAt[1] as number) - (sentAt[0] as number);
    assert.ok(gap >= 580, `retried after ${Math.round(gap)}ms`);
  });

  it('gives up instead of retrying early when Retry-After is beyond the maximum', { timeout: 5_000 }, async () => {
    const seconds = MAX_RETRY_AFTER_MS / 1_000 + 90;
    const { c, calls } = client([{ status: 429, body: 'come back later', headers: { 'retry-after': String(seconds) } }, ok()]);
    await assert.rejects(c.decide('x', QS), (e: unknown) => e instanceof JevError && e.status === 429);
    assert.equal(calls.length, 1);
  });
});

describe('Telemetry', () => {
  it('keeps only the most recent calls but still counts every one', () => {
    const t = new Telemetry();
    const n = TELEMETRY_KEEP + 100;
    for (let i = 0; i < n; i++) {
      t.record({ label: `c${i}`, questions: 2, inputTokens: 10, latencyMs: 3, ok: i % 10 !== 0, attempts: 1 });
    }
    assert.equal(t.calls.length, TELEMETRY_KEEP);
    assert.equal(t.calls[0]?.label, 'c100');
    assert.equal(t.calls.at(-1)?.label, `c${n - 1}`);
    const s = t.summary();
    assert.deepEqual([s.calls, s.questions, s.inputTokens, s.totalLatencyMs, s.failures], [n, 2 * n, 10 * n, 3 * n, n / 10]);
  });
});

describe('Semaphore', () => {
  /** Hold a slot while `fn` runs. */
  const withSlot = async (sem: Semaphore, fn: () => Promise<unknown>, signal?: AbortSignal) => {
    await sem.acquire(signal);
    try {
      await fn();
    } finally {
      sem.release();
    }
  };
  /** Settles `n` microtask hops after `p` does. */
  const hops = (n: number, p: Promise<unknown> = Promise.resolve()) => {
    for (let i = 0; i < n; i++) p = p.then(() => undefined);
    return p;
  };

  it('never lets a newcomer slip in between a release and the waiter it wakes', async () => {
    // The newcomer's own await chain settles `depth` hops after the holder lets go - as another
    // chat turn's chain can, since every session shares the client's semaphore.
    for (let depth = 0; depth < 8; depth++) {
      const sem = new Semaphore(1);
      let active = 0;
      let max = 0;
      const busy = (until: () => Promise<unknown>) => async () => {
        max = Math.max(max, ++active);
        await until();
        active--;
      };
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      const holder = withSlot(sem, busy(() => gate));
      const waiter = withSlot(sem, busy(tick));
      const newcomer = hops(depth, gate).then(() => withSlot(sem, busy(tick)));
      open();
      await Promise.all([holder, waiter, newcomer]);
      assert.equal(max, 1, `limit exceeded when the newcomer arrived ${depth} hops after the release`);
    }
  });

  it('holds the limit under churn, with aborts, and hands every slot back', async () => {
    const LIMIT = 3;
    const sem = new Semaphore(LIMIT);
    let seed = 7;
    const rand = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647; // seeded, so every run churns alike
    let active = 0;
    let max = 0;
    let ran = 0;
    let aborted = 0;
    const tasks: Array<Promise<void>> = [];
    const spawn = (): void => {
      const ctl = new AbortController();
      if (rand() < 0.25) void hops(Math.floor(rand() * 6)).then(() => ctl.abort());
      tasks.push(withSlot(sem, async () => {
        max = Math.max(max, ++active);
        await hops(Math.floor(rand() * 4));
        active--;
        ran++;
        // Finished work starts new work a few hops later, so arrivals land on every tick.
        if (tasks.length < 400) for (let i = 0; i < 2; i++) void hops(Math.floor(rand() * 6)).then(spawn);
      }, ctl.signal).catch(() => { aborted++; }));
    };
    for (let i = 0; i < 12; i++) spawn();
    for (let seen = -1; seen !== tasks.length;) {
      seen = tasks.length;
      await Promise.all(tasks);
      await tick();
    }

    assert.equal(max, LIMIT, `${max} in flight at once, limit ${LIMIT}`);
    assert.ok(tasks.length >= 400 && aborted > 0, `churn too small: ${tasks.length} tasks, ${aborted} aborted`);
    assert.equal(ran + aborted, tasks.length);
    // Nothing leaked: all LIMIT slots are free again, and one more has to wait.
    for (let i = 0; i < LIMIT; i++) await sem.acquire();
    let extra = false;
    void sem.acquire().then(() => { extra = true; });
    await tick();
    assert.equal(extra, false);
  });
});

describe('review follow-ups (integration)', () => {
  it('backoff sleeps do not leave abort listeners on the caller\'s signal', async () => {
    const ctl = new AbortController();
    let added = 0;
    let removed = 0;
    const add = ctl.signal.addEventListener.bind(ctl.signal);
    const remove = ctl.signal.removeEventListener.bind(ctl.signal);
    ctl.signal.addEventListener = ((...a: Parameters<typeof add>) => { added++; return add(...a); }) as typeof add;
    ctl.signal.removeEventListener = ((...a: Parameters<typeof remove>) => { removed++; return remove(...a); }) as typeof remove;
    let n = 0;
    const fetchImpl = (async () => (++n < 3
      ? new Response('busy', { status: 529, headers: { 'retry-after': '0' } })
      : Response.json({ model: 'm', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 0 } }))) as typeof fetch;
    const c = new JevClient({ apiKey: 'k', fetchImpl, maxRetries: 4 });
    await c.decide('s', { q: { type: 'noul', instructions: 'q?' } }, { signal: ctl.signal });
    assert.equal(added, removed, `listeners added ${added}, removed ${removed}`);
  });

  it('running out of budget is a JevBudgetError (busy), not a generic failure', async () => {
    const fetchImpl = (async () => new Response('busy', { status: 529, headers: { 'retry-after': '5' } })) as typeof fetch;
    const c = new JevClient({ apiKey: 'k', fetchImpl });
    await assert.rejects(c.decide('s', { q: { type: 'noul', instructions: 'q?' } }, { budgetMs: 1500 }), JevBudgetError);
  });
});
