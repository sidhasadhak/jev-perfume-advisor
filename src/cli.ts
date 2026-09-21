/**
 * Terminal chat.
 *   npm run chat                         interactive
 *   npm run chat -- "evening party"      one-shot (add --debug for the Jev trace)
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { bootstrap } from './bootstrap.js';
import type { ChatResult } from './pipeline/orchestrator.js';

const tty = stdout.isTTY;
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);
const accent = (s: string) => (tty ? `\x1b[35m${s}\x1b[39m` : s);

function print(res: ChatResult, debug: boolean): void {
  const { reply } = res;
  console.log(`\n${reply.text.replace(/\*\*(.+?)\*\*/g, (_m, t: string) => bold(t))}\n`);
  reply.recommendations.forEach((r, i) => {
    console.log(`  ${accent(`${i + 1}.`)} ${bold(r.name)} - ${r.brand}${r.year ? ` (${r.year})` : ''}  ${dim(`match ${r.match}%`)}`);
    console.log(`     ${dim(r.accords.join(' · '))}`);
    for (const b of r.bullets) console.log(`     - ${b}`);
  });
  if (reply.followUps.length) console.log(`\n  ${dim('Try:')} ${reply.followUps.map((f) => `"${f}"`).join('  ')}`);

  const d = reply.debug as {
    understanding: { intent: string; intentConfidence: number; summary: string };
    telemetry: { calls: number; questions: number; inputTokens: number; usd: number };
    wallMs: number;
    jevCalls: Array<{ label: string; questions: number; inputTokens: number; latencyMs: number; ok: boolean }>;
  } | undefined;
  if (d) {
    const t = d.telemetry;
    // In mock mode nothing was called or billed, so show no tokens or dollars (as the web UI does).
    console.log(dim(res.mode === 'mock'
      ? `\n  [MOCK - not Jev, no cost] ${t.calls} simulated calls, ${t.questions} typed questions - ${d.wallMs} ms`
      : `\n  Jev: ${t.calls} calls, ${t.questions} typed questions, ${t.inputTokens.toLocaleString('en-US')} tokens, `
        + `$${t.usd.toFixed(6)} - ${d.wallMs} ms`));
    if (debug) {
      console.log(dim(`  intent: ${d.understanding.intent} (${Math.round(d.understanding.intentConfidence * 100)}%)`));
      console.log(dim(`  understood: ${d.understanding.summary}`));
      for (const c of d.jevCalls) console.log(dim(`    ${c.ok ? '✓' : '✗'} ${c.label.padEnd(36)} ${String(c.questions).padStart(3)} q  ${String(c.latencyMs).padStart(5)} ms`));
    }
  }
  console.log('');
}

const args = process.argv.slice(2);
const debug = args.includes('--debug');
const oneShot = args.filter((a) => a !== '--debug').join(' ').trim();

const { bot } = await bootstrap((m) => console.error(dim(m)));
let sessionId: string | undefined;

if (oneShot) {
  print(await bot.chat(undefined, oneShot), debug);
} else {
  console.log(`\n${bold('Scent Sommelier')} ${dim('- perfume advice powered by TypeSafe Jev. Type "exit" to quit, "/new" for a fresh chat.')}\n`);
  const rl = createInterface({ input: stdin, output: stdout });
  for (;;) {
    const line = (await rl.question(accent('you › '))).trim();
    if (!line) continue;
    if (line === 'exit' || line === 'quit') break;
    if (line === '/new') { sessionId = undefined; console.log(dim('  (new conversation)\n')); continue; }
    try {
      const res = await bot.chat(sessionId, line);
      sessionId = res.sessionId;
      print(res, debug);
    } catch (e) {
      console.error(`\n  ${(e as Error).message}\n`);
    }
  }
  rl.close();
}
