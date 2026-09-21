import type {
  Answer, DecideOptions, Decider, Decision, Question, QuestionSet, Usage,
} from './types.js';
import { MAX_CHOICE_OPTIONS, MAX_SCORE_LEVELS, MIN_SCORE_LEVELS } from './types.js';

/** USD per 1M input tokens (output tokens are free). https://docs.typesafe.ai */
export const JEV_USD_PER_M_INPUT = 0.042;

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'JevError';
  }
}

/** A call ran out of its time budget (queueing, attempts and backoff included) - Jev is slow or busy, not unreachable. */
export class JevBudgetError extends JevError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, false, body);
    this.name = 'JevBudgetError';
  }
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Max in-flight requests from this client. */
  concurrency?: number;
  fetchImpl?: typeof fetch;
}

/** One entry per request, kept for the debug panel and cost accounting. */
export interface CallRecord {
  label: string;
  questions: number;
  inputTokens: number;
  latencyMs: number;
  ok: boolean;
  attempts: number;
}

/** How many recent calls a Telemetry keeps. The server's decider lives as long as the process. */
export const TELEMETRY_KEEP = 500;

/**
 * Process-wide call log. It keeps only the most recent calls, because the shared
 * decider records every call of every session for the life of the server; the
 * summary counters stay cumulative. Per-reply traces use TurnRecorder instead.
 */
export class Telemetry {
  private readonly recent: CallRecord[] = [];
  private readonly totals = { calls: 0, questions: 0, inputTokens: 0, totalLatencyMs: 0, failures: 0 };

  constructor(private readonly keep = TELEMETRY_KEEP) {}

  /** The most recent calls, oldest first. */
  get calls(): readonly CallRecord[] {
    return this.recent;
  }

  record(c: CallRecord): void {
    this.recent.push(c);
    if (this.recent.length > this.keep) this.recent.shift();
    this.totals.calls++;
    this.totals.questions += c.questions;
    this.totals.inputTokens += c.inputTokens;
    this.totals.totalLatencyMs += c.latencyMs;
    if (!c.ok) this.totals.failures++;
  }

  summary() {
    const { calls, questions, inputTokens, totalLatencyMs, failures } = this.totals;
    return {
      calls,
      questions,
      inputTokens,
      usd: (inputTokens / 1_000_000) * JEV_USD_PER_M_INPUT,
      /** Wall-clock is lower than this sum because rank calls run concurrently. */
      totalLatencyMs,
      failures,
    };
  }
}

/**
 * FIFO semaphore. A released slot passes straight to the next waiter instead of
 * being freed and re-taken, so a caller arriving in between cannot barge in and
 * push the in-flight count over the limit. A waiter whose signal aborts leaves the
 * queue without ever holding a slot.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new RangeError('concurrency must be >= 1');
  }

  /** Resolves holding a slot, or rejects with the signal's reason without taking one. */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  /** Call exactly once per successful acquire(). */
  release(): void {
    const next = this.queue.shift();
    if (next) next(); // the slot changes hands; `active` stays the same
    else this.active--;
  }
}

/** No attempt starts with less than this left of a call's budget: it could not get an answer back in time. */
export const MIN_ATTEMPT_MS = 1_000;

/** The longest server-requested wait (Retry-After) worth sleeping through; beyond it the call gives up. */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * What is left of one decide() call's DecideOptions.budgetMs. The clock starts when
 * decide() is called, so time spent queueing for a slot counts against it.
 */
class Budget {
  private readonly deadline: number;

  constructor(private readonly ms: number | undefined) {
    this.deadline = ms === undefined ? Infinity : performance.now() + ms;
  }

  /** Milliseconds left; Infinity without a budget. */
  remaining(): number {
    return this.deadline - performance.now();
  }

  /** Is there still room for an attempt that could get an answer back? */
  canAttempt(): boolean {
    return this.remaining() >= MIN_ATTEMPT_MS;
  }

  /**
   * Not retryable: the caller's time is gone. It keeps the last HTTP status, so a
   * run of 429s still reads as "Jev is busy" rather than "unreachable".
   */
  exceeded(last?: JevError): JevError {
    const why = last ? ` (last error: ${last.message})` : '';
    return new JevBudgetError(`Jev call could not finish within its ${this.ms}ms budget${why}`, last?.status, last?.body);
  }

  /**
   * The caller's signal, plus an abort once too little budget is left to start an
   * attempt, so a call does not wait for a slot it could no longer use.
   */
  waitSignal(signal?: AbortSignal): { signal?: AbortSignal; dispose(): void } {
    if (this.deadline === Infinity) return { signal, dispose: () => {} };
    const ctl = new AbortController();
    // Clamped: setTimeout treats anything past 2^31-1 ms as 1 ms.
    const ms = Math.min(2 ** 31 - 1, Math.max(0, this.remaining() - MIN_ATTEMPT_MS));
    const timer = setTimeout(() => ctl.abort(this.exceeded()), ms);
    return { signal: signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal, dispose: () => clearTimeout(timer) };
  }
}

/**
 * The server's requested wait in ms: `retry-after-ms` (which the official SDK honours),
 * else `Retry-After` as delta-seconds or an HTTP-date (RFC 9110). Undefined when absent
 * or unreadable.
 */
export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms')?.trim();
  if (ms && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms);
  const ra = headers.get('retry-after')?.trim();
  if (!ra) return undefined;
  if (/^\d+(\.\d+)?$/.test(ra)) return Number(ra) * 1000;
  // Every HTTP-date form starts with a day name, which keeps Date.parse from reading "-1" as a
  // year. All are GMT, but the asctime form omits the zone and would otherwise parse as local time.
  if (!/^[A-Za-z]{3}/.test(ra)) return undefined;
  const at = Date.parse(/GMT$/.test(ra) ? ra : `${ra} GMT`);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Exponential backoff with jitter: 125-250ms, 250-500ms, 0.5-1s ... up to 8s. */
function backoff(attempt: number): number {
  const cap = Math.min(8_000, 250 * 2 ** (attempt - 1));
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason); };
    // Remove the listener when the timer wins, or every backoff leaves one on the shared turn signal.
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Client-side guard for the limits the API would otherwise reject with a 422. */
export function validateQuestions(questions: QuestionSet): void {
  const keys = Object.keys(questions);
  if (keys.length === 0) throw new JevError('question set is empty');
  for (const k of keys) {
    if (!/^[A-Za-z0-9_:-]{1,64}$/.test(k)) throw new JevError(`invalid question key "${k}"`);
    const q = questions[k] as Question;
    if (!q.instructions?.trim()) throw new JevError(`question "${k}" has no instructions`);
    if (q.type === 'choice') {
      const n = Object.keys(q.criteria).length;
      if (n < 2 || n > MAX_CHOICE_OPTIONS) throw new JevError(`choice "${k}" has ${n} options (2-${MAX_CHOICE_OPTIONS})`);
    } else if (q.type === 'score') {
      const n = q.criteria.length;
      if (n < MIN_SCORE_LEVELS || n > MAX_SCORE_LEVELS) throw new JevError(`score "${k}" has ${n} levels (2-10)`);
    }
  }
}

/**
 * The server promises typed answers, but a gateway in between might not. Check
 * that every question came back, with the right type and a sane payload.
 */
export function validateAnswers(questions: QuestionSet, answers: unknown): asserts answers is Record<string, Answer> {
  if (!answers || typeof answers !== 'object') throw new JevError('response has no answers object');
  const a = answers as Record<string, Answer | undefined>;
  for (const [k, q] of Object.entries(questions)) {
    const ans = a[k];
    if (!ans) throw new JevError(`missing answer for "${k}"`);
    if (ans.type !== q.type) throw new JevError(`answer "${k}" is ${ans.type}, expected ${q.type}`);
    if (ans.type === 'noul' && !(ans.noul >= 0 && ans.noul <= 1)) throw new JevError(`answer "${k}" noul out of range`);
    if (ans.type === 'choice') {
      if (!(ans.choice in (q as { criteria: object }).criteria)) throw new JevError(`answer "${k}" chose unknown option "${ans.choice}"`);
      ans.probabilities ??= { [ans.choice]: ans.confidence ?? 1 };
    }
    if (ans.type === 'score' && typeof ans.score !== 'number') throw new JevError(`answer "${k}" has no score`);
  }
}

type ResponseBody = { model?: string; answers: Record<string, Answer>; usage?: Usage };

/** One HTTP round trip: the validated body, or why it failed and how long the server asked us to wait. */
type Attempt = { ok: true; json: ResponseBody } | { ok: false; error: JevError; retryAfterMs?: number };

export class JevClient implements Decider {
  readonly mode = 'live' as const;
  readonly telemetry = new Telemetry();
  private readonly base: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sem: Semaphore;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: JevClientOptions) {
    if (!opts.apiKey) throw new JevError('TYPESAFE_API_KEY is not set');
    this.base = (opts.baseUrl ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
    this.model = opts.model ?? 'jev-latest';
    // Live Jev answers in well under a second; 10s per attempt leaves room for a retry inside the stage budgets.
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.sem = new Semaphore(opts.concurrency ?? 8);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Full URL. Accepts a base with or without a trailing /v1. */
  get endpoint(): string {
    return this.base.endsWith('/v1') ? `${this.base}/systemone` : `${this.base}/v1/systemone`;
  }

  decide<QS extends QuestionSet>(state: unknown, questions: QS, opts: DecideOptions = {}): Promise<Decision<QS>> {
    validateQuestions(questions);
    return this.send(state, questions, opts);
  }

  private async send<QS extends QuestionSet>(state: unknown, questions: QS, opts: DecideOptions): Promise<Decision<QS>> {
    const budget = new Budget(opts.budgetMs); // starts before queueing: waiting for a slot spends it too
    const { signal } = opts;
    const body = JSON.stringify({ model: this.model, state, questions });
    const label = opts.label ?? 'decide';
    const nq = Object.keys(questions).length;
    let started = performance.now();
    let attempt = 0;

    try {
      await this.waitForSlot(budget, signal);
      started = performance.now();
      try {
        let last: JevError | undefined;
        for (;;) {
          // This call may have queued or backed off since the caller gave up: never send for an aborted turn.
          signal?.throwIfAborted();
          if (!budget.canAttempt()) throw budget.exceeded(last);
          attempt++;
          const r = await this.attempt(body, questions, Math.min(this.timeoutMs, budget.remaining()), signal);
          if (r.ok) {
            const latencyMs = Math.round(performance.now() - started);
            const usage = r.json.usage ?? { input_tokens: 0, output_tokens: 0 };
            this.telemetry.record({ label, questions: nq, inputTokens: usage.input_tokens, latencyMs, ok: true, attempts: attempt });
            return { model: r.json.model ?? this.model, answers: r.json.answers as Decision<QS>['answers'], usage, latencyMs };
          }
          last = r.error;
          if (!r.error.retryable || attempt > this.maxRetries) throw r.error;
          await sleep(this.retryDelay(attempt, r, budget), signal);
        }
      } finally {
        this.sem.release();
      }
    } catch (e) {
      // A caller's abort is not a failure worth recording.
      if (!signal?.aborted) {
        const latencyMs = Math.round(performance.now() - started);
        this.telemetry.record({ label, questions: nq, inputTokens: 0, latencyMs, ok: false, attempts: attempt });
      }
      throw e;
    }
  }

  /** Queue for a slot, leaving the queue if the caller aborts or the budget could no longer fit an attempt. */
  private async waitForSlot(budget: Budget, signal?: AbortSignal): Promise<void> {
    const wait = budget.waitSignal(signal);
    try {
      await this.sem.acquire(wait.signal);
    } finally {
      wait.dispose();
    }
  }

  /** One request. Only the caller's abort is thrown; every other failure comes back for the retry loop to judge. */
  private async attempt(body: string, questions: QuestionSet, timeoutMs: number, signal?: AbortSignal): Promise<Attempt> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new JevError(`Jev timed out after ${Math.round(timeoutMs)}ms`, undefined, true)), timeoutMs);
    const onAbort = () => ctl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        signal: ctl.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 429 Too Many Requests / 529 Overloaded / 5xx: back off and retry.
        const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
        const hint = res.status === 401 ? ' - check OPENROUTER_API_KEY / TYPESAFE_API_KEY'
          : res.status === 402 ? ' - the account has insufficient credits'
          : res.status === 422 ? ' - the question schema was rejected'
          : '';
        const error = new JevError(`Jev HTTP ${res.status}${hint}: ${text.slice(0, 300)}`, res.status, retryable, text);
        return { ok: false, error, retryAfterMs: parseRetryAfter(res.headers) };
      }

      const json = (await res.json()) as { model?: string; answers?: unknown; usage?: Usage };
      validateAnswers(questions, json.answers);
      return { ok: true, json: json as ResponseBody };
    } catch (e) {
      if (signal?.aborted) throw e;
      return { ok: false, error: e instanceof JevError ? e : new JevError(`Jev request failed: ${(e as Error).message}`, undefined, true) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * How long to wait before the next attempt, or throw to give up. Retry-After is the
   * server's instruction, so when we cannot wait that long we fail now rather than
   * retry early; our own backoff is only a guess, so it shrinks to fit the budget.
   */
  private retryDelay(attempt: number, failure: { error: JevError; retryAfterMs?: number }, budget: Budget): number {
    const { error, retryAfterMs } = failure;
    const room = budget.remaining() - MIN_ATTEMPT_MS; // time we can sleep and still make one more attempt
    if (retryAfterMs === undefined) return Math.max(0, Math.min(backoff(attempt), room));
    if (retryAfterMs > MAX_RETRY_AFTER_MS) throw error;
    if (retryAfterMs > room) throw budget.exceeded(error);
    return retryAfterMs;
  }
}
