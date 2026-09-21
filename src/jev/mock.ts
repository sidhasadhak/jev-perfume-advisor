/**
 * Offline stand-in for Jev, used when no TYPESAFE_API_KEY is configured and in
 * tests. It answers every question type with a deterministic lexical heuristic:
 * option/criteria words that also appear in the state count as evidence. That is
 * enough for the app to run end to end and give plausible results; it is not an
 * imitation of Jev's judgement, and the UI labels mock mode accordingly.
 */
import type {
  Answer, ChoiceQuestion, DecideOptions, Decider, Decision, NoulQuestion, Question, QuestionSet, ScoreQuestion,
} from './types.js';
import { Telemetry, validateAnswers, validateQuestions } from './client.js';

export interface MockJevOptions {
  /** Script exact answers per question (tests, demos). Return undefined to fall back to the heuristic. */
  resolver?: (state: unknown, key: string, q: Question) => Answer | undefined;
  /** Artificial delay per call, so loading states can be exercised offline. */
  latencyMs?: number;
}

/**
 * `budgetMs` is accepted and ignored: the mock never queues or retries, so there is
 * nothing to cut short. A caller's abort is honoured, before or during `latencyMs`.
 */
export class MockJev implements Decider {
  readonly mode = 'mock' as const;
  readonly telemetry = new Telemetry();

  constructor(private readonly opts: MockJevOptions = {}) {}

  async decide<QS extends QuestionSet>(state: unknown, questions: QS, opts: DecideOptions = {}): Promise<Decision<QS>> {
    validateQuestions(questions);
    const started = performance.now();
    const label = opts.label ?? 'decide';
    const nq = Object.keys(questions).length;
    // What a live call would bill for this payload. Failures record 0, like the live client.
    const inputTokens = Math.ceil(JSON.stringify({ state, questions }).length / 4);
    const record = (ok: boolean) => {
      const latencyMs = Math.round(performance.now() - started);
      this.telemetry.record({ label, questions: nq, inputTokens: ok ? inputTokens : 0, latencyMs, ok, attempts: 1 });
      return latencyMs;
    };

    try {
      if (this.opts.latencyMs) await sleep(this.opts.latencyMs, opts.signal);
      opts.signal?.throwIfAborted();
      const stateTokens = new Set(tokenize(flatten(state)));
      const answers: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        answers[key] = this.opts.resolver?.(state, key, q) ?? heuristic(q, stateTokens);
      }
      // Catches resolver answers of the wrong type or with unknown options - same guard as the live client.
      validateAnswers(questions, answers);
      const latencyMs = record(true);
      return {
        model: 'mock-jev',
        answers: answers as Decision<QS>['answers'],
        usage: { input_tokens: inputTokens, output_tokens: 0 },
        latencyMs,
      };
    } catch (e) {
      // Like the live client: a caller's abort is not a failure worth recording.
      if (!opts.signal?.aborted) record(false);
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Lexical heuristic
// ---------------------------------------------------------------------------

/** Options that mean "no preference": they get a small prior so they win only when nothing else has evidence. */
const NEUTRAL_KEYS = new Set(['any', 'none', 'other', 'unspecified', 'neutral']);
const NEUTRAL_PRIOR = 0.5;
/** Softmax temperature: one key-word hit (weight 2) should clearly beat the neutral prior. */
const SHARPNESS = 1.5;

/**
 * Function words plus words every perfume request and question contains - they
 * would count as evidence for whichever option happens to mention them.
 */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'from', 'are', 'was', 'were', 'who', 'what',
  'which', 'when', 'where', 'how', 'why', 'any', 'not', 'but', 'you', 'your', 'has', 'have', 'had', 'can',
  'all', 'its', 'into', 'than', 'then', 'some', 'very', 'just', 'does', 'did', 'should', 'would', 'could',
  'will', 'about', 'them', 'they', 'their', 'there', 'our', 'out', 'too', 'also', 'only', 'other', 'each',
  'such', 'own', 'same', 'being', 'been', 'yes', 'etc',
  'user', 'users', 'perfume', 'perfumes', 'fragrance', 'fragrances', 'scent', 'scents', 'want', 'wants',
  'wanted', 'wearer', 'message', 'request', 'question', 'suggest', 'recommend', 'please',
]);

const SUFFIXES = ['ing', 'ies', 'ed', 'es', 's', 'y', 'e'];

/**
 * Light suffix stripper, applied until stable so plural and adjective forms meet
 * (winters/winter, snowy/snow, parties/party, roses/rose). Stems keep >= 3 chars.
 */
function stem(word: string): string {
  for (;;) {
    if (word.endsWith('ss')) return word;
    const suf = SUFFIXES.find((s) => word.endsWith(s) && word.length - s.length >= 3);
    if (!suf) return word;
    word = word.slice(0, -suf.length);
  }
}

/** Lowercase, split on non-alphanumerics, drop short/stop words, stem. */
function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t))
    .map(stem);
}

/** State as text. JSON escapes like \n would otherwise glue onto the next word. */
function flatten(state: unknown): string {
  if (typeof state === 'string') return state;
  return (JSON.stringify(state) ?? '').replace(/\\[nrt]/g, ' ');
}

/** Number of distinct words of `text` that occur in the state. */
function hits(text: string, stateTokens: Set<string>, exclude?: Set<string>): number {
  let n = 0;
  for (const t of new Set(tokenize(text))) if (!exclude?.has(t) && stateTokens.has(t)) n++;
  return n;
}

function heuristic(q: Question, stateTokens: Set<string>): Answer {
  if (q.type === 'choice') return answerChoice(q, stateTokens);
  if (q.type === 'score') return answerScore(q, stateTokens);
  return answerNoul(q, stateTokens);
}

function answerChoice(q: ChoiceQuestion, stateTokens: Set<string>): Answer {
  const keys = Object.keys(q.criteria);
  const evidence = keys.map((k) => {
    const keyTokens = new Set(tokenize(k));
    const keyHits = hits(k, stateTokens);
    const neutral = NEUTRAL_KEYS.has(k.toLowerCase());
    // A neutral option ("none", "any") is defined by what it excludes - "a disliked colour ('she hates
    // pink') does not count" - so its description words are not evidence FOR it; it only has its prior.
    const descHits = neutral ? 0 : hits(q.criteria[k] ?? '', stateTokens, keyTokens);
    return 2 * keyHits + descHits + (neutral ? NEUTRAL_PRIOR : 0);
  });
  const p = softmax(evidence.map((e) => e * SHARPNESS));
  const best = argmax(p);
  return {
    type: 'choice',
    choice: keys[best] as string,
    confidence: round4(p[best] as number),
    probabilities: Object.fromEntries(keys.map((k, i) => [k, round4(p[i] as number)])),
  };
}

const NOUL_PRIOR_OFFSET = 1.5;

function answerNoul(q: NoulQuestion, stateTokens: Set<string>): Answer {
  // Bare instructions are wordier and one-sided (no "false" side), so each hit counts half.
  const evidence = q.criteria
    ? hits(q.criteria.true, stateTokens) - hits(q.criteria.false, stateTokens)
    : 0.5 * hits(q.instructions, stateTokens);
  // Skeptical prior: most yes/no questions a pipeline asks ("does the user like X?") are false
  // for any given message, so an absence of evidence should land below 0.5, not at it.
  return { type: 'noul', noul: round4(1 / (1 + Math.exp(-(evidence - NOUL_PRIOR_OFFSET)))) };
}

function answerScore(q: ScoreQuestion, stateTokens: Set<string>): Answer {
  const p = softmax(q.criteria.map((level) => hits(level, stateTokens) * SHARPNESS));
  const score = p.reduce((s, pi, i) => s + i * pi, 0);
  return {
    type: 'score',
    score: round4(score),
    confidence: round4(Math.max(...p)),
    legend: Object.fromEntries(q.criteria.map((level, i) => [String(i), level])),
    probabilities: Object.fromEntries(p.map((pi, i) => [String(i), round4(pi)])),
  };
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function softmax(xs: number[]): number[] {
  const max = Math.max(...xs);
  const exps = xs.map((x) => Math.exp(x - max));
  const total = exps.reduce((s, x) => s + x, 0);
  return exps.map((x) => x / total);
}

/** First index of the maximum - ties go to the earlier option, which keeps results deterministic. */
function argmax(xs: number[]): number {
  let best = 0;
  xs.forEach((x, i) => { if (x > (xs[best] as number)) best = i; });
  return best;
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
