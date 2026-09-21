/**
 * Wire types for TypeSafe's System One API (model: Jev).
 *
 *   POST {base}/v1/systemone
 *   { model, state, questions: { <key>: { type, instructions, criteria } } }
 *   -> { model, answers: { <key>: <typed answer> }, usage }
 *
 * Jev never generates text. Every answer is one of three typed shapes, and the
 * question builders below carry the option keys through to the answer type, so
 * `answers.occasion.choice` is typed as the exact union of keys you offered.
 */

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion<K extends string = string> {
  type: 'choice';
  instructions: string;
  /** Option key -> description. `null` means "the key is self-explanatory". */
  criteria: Record<K, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** Ordered levels, lowest first. 2..10 entries. */
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion<string> | ScoreQuestion;
export type QuestionSet = Record<string, Question>;

export interface NoulAnswer {
  type: 'noul';
  /** Probability the proposition is true, 0..1. */
  noul: number;
}

export interface ChoiceAnswer<K extends string = string> {
  type: 'choice';
  choice: K;
  confidence: number;
  probabilities: Record<K, number>;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted level index; may fall between levels. */
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export type Answer = NoulAnswer | ChoiceAnswer<string> | ScoreAnswer;

export type AnswerFor<Q> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer K>
    ? ChoiceAnswer<K>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

export type Answers<QS extends QuestionSet> = { [P in keyof QS]: AnswerFor<QS[P]> };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface Decision<QS extends QuestionSet> {
  model: string;
  answers: Answers<QS>;
  usage: Usage;
  latencyMs: number;
}

export interface DecideOptions {
  signal?: AbortSignal;
  /** Label shown in telemetry, e.g. "understand" or "rank:485". */
  label?: string;
  /**
   * Total time this call may take, INCLUDING queueing for a concurrency slot,
   * every retry and backoff. When it runs out the call rejects, so callers with
   * a fallback (rank, compose, screen) can degrade instead of the whole turn
   * timing out. Undefined = the client's own limits only.
   */
  budgetMs?: number;
}

/** Anything that can answer a question set - the live API or a mock. */
export interface Decider {
  readonly mode: 'live' | 'mock';
  decide<QS extends QuestionSet>(state: unknown, questions: QS, opts?: DecideOptions): Promise<Decision<QS>>;
}

// ---------------------------------------------------------------------------
// Builders - mirror the official SDK's noul()/choice()/score() helpers.
// ---------------------------------------------------------------------------

export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

export function noul(instructions: string, criteria?: { true: string; false: string }): NoulQuestion {
  return criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };
}

export function choice<K extends string>(instructions: string, criteria: Record<K, string | null>): ChoiceQuestion<K> {
  const n = Object.keys(criteria).length;
  if (n < 2) throw new RangeError(`choice needs at least 2 options, got ${n}: ${instructions}`);
  if (n > MAX_CHOICE_OPTIONS) throw new RangeError(`choice allows at most ${MAX_CHOICE_OPTIONS} options, got ${n}`);
  return { type: 'choice', instructions, criteria };
}

export function score(instructions: string, levels: string[]): ScoreQuestion {
  if (levels.length < MIN_SCORE_LEVELS || levels.length > MAX_SCORE_LEVELS) {
    throw new RangeError(`score needs ${MIN_SCORE_LEVELS}-${MAX_SCORE_LEVELS} levels, got ${levels.length}`);
  }
  return { type: 'score', instructions, criteria: levels };
}

/** Normalize a score answer to 0..1 across its level range. */
export function score01(a: ScoreAnswer, levels: number): number {
  return levels > 1 ? Math.min(1, Math.max(0, a.score / (levels - 1))) : 0;
}
