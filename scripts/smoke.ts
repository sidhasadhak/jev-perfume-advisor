/**
 * End-to-end smoke test: runs the five example requests (plus a follow-up)
 * through the real pipeline and prints what Jev decided.
 *
 *   npm run smoke            uses TYPESAFE_API_KEY from .env (live Jev)
 *   JEV_MODE=mock npm run smoke
 *
 * Exits non-zero if any turn fails or returns no recommendations.
 */
import { bootstrap } from '../src/bootstrap.js';

const QUERIES = [
  'Suggest me a perfume for an evening party',
  'Something for Nordic winters',
  'What should I wear for a summer in Turkey?',
  'Best perfume for a working professional',
  'A suitable perfume for a 65 year-old lady who loves the colour pink',
];

const { bot } = await bootstrap((m) => console.error(`  ${m}`));
let failures = 0;
let usd = 0;

for (const q of QUERIES) {
  const started = performance.now();
  try {
    const first = await bot.chat(undefined, q);
    const d = first.reply.debug as {
      understanding: { intent: string; intentConfidence: number; summary: string };
      telemetry: { calls: number; questions: number; inputTokens: number; usd: number; failures: number };
    };
    usd += d.telemetry.usd;
    console.log(`\n━━ ${q}`);
    console.log(`   intent: ${d.understanding.intent} (${Math.round(d.understanding.intentConfidence * 100)}%)  ·  understood: ${d.understanding.summary}`);
    for (const r of first.reply.recommendations) console.log(`   ${String(r.match).padStart(3)}%  ${r.name} — ${r.brand}   · ${r.headline}`);
    console.log(`   jev: ${d.telemetry.calls} calls, ${d.telemetry.questions} questions, ${d.telemetry.inputTokens} tokens, `
      + `$${d.telemetry.usd.toFixed(6)}, ${d.telemetry.failures} failed · ${Math.round(performance.now() - started)} ms`);
    if (first.reply.recommendations.length === 0) { failures++; console.log('   ✗ no recommendations'); }

    // One follow-up per conversation exercises multi-turn state.
    const next = await bot.chat(first.sessionId, 'Something more affordable');
    console.log(`   ↳ "Something more affordable": ${next.reply.recommendations.map((r) => r.name).join(', ') || '(none)'}`);
  } catch (e) {
    failures++;
    console.log(`\n━━ ${q}\n   ✗ ${(e as Error).message}`);
  }
}

console.log(`\n${bot.mode === 'mock' ? '[MOCK MODE] ' : ''}${QUERIES.length - failures}/${QUERIES.length} passed · total Jev cost $${usd.toFixed(6)}`);
process.exit(failures ? 1 : 0);
