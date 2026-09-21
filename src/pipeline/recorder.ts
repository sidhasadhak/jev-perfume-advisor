import type { CallRecord } from '../jev/client.js';
import { JEV_USD_PER_M_INPUT } from '../jev/client.js';
import type { Answer, DecideOptions, Decider, Decision, QuestionSet } from '../jev/types.js';

/** One Jev call with exactly what was asked and what came back - the raw material for the trace panel. */
export interface DecisionLog {
  label: string;
  questions: QuestionSet;
  answers: Record<string, Answer> | null;
}

/**
 * Wraps a Decider for the duration of one chat turn and records every call, so
 * each reply can report exactly which Jev decisions produced it.
 */
export class TurnRecorder implements Decider {
  readonly calls: CallRecord[] = [];
  readonly log: DecisionLog[] = [];

  constructor(private readonly inner: Decider) {}

  get mode() {
    return this.inner.mode;
  }

  async decide<QS extends QuestionSet>(state: unknown, questions: QS, opts: DecideOptions = {}): Promise<Decision<QS>> {
    const label = opts.label ?? 'decide';
    const questionCount = Object.keys(questions).length;
    const started = performance.now();
    try {
      const d = await this.inner.decide(state, questions, opts);
      this.calls.push({ label, questions: questionCount, inputTokens: d.usage.input_tokens, latencyMs: d.latencyMs, ok: true, attempts: 1 });
      this.log.push({ label, questions, answers: d.answers as Record<string, Answer> });
      return d;
    } catch (e) {
      this.calls.push({ label, questions: questionCount, inputTokens: 0, latencyMs: Math.round(performance.now() - started), ok: false, attempts: 1 });
      this.log.push({ label, questions, answers: null });
      throw e;
    }
  }

  summary() {
    const inputTokens = this.calls.reduce((s, c) => s + c.inputTokens, 0);
    return {
      calls: this.calls.length,
      questions: this.calls.reduce((s, c) => s + c.questions, 0),
      inputTokens,
      usd: (inputTokens / 1_000_000) * JEV_USD_PER_M_INPUT,
      totalLatencyMs: this.calls.reduce((s, c) => s + c.latencyMs, 0),
      failures: this.calls.filter((c) => !c.ok).length,
    };
  }
}
