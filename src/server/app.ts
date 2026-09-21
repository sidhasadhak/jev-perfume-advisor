import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { DEFAULT_RATE_LIMIT_PER_MIN, type Config } from '../config.js';
import { JevBudgetError, JevError } from '../jev/client.js';
import type { PerfumeBot } from '../pipeline/orchestrator.js';

/** src/web, whether we run from src/ via tsx or from dist/ after a build. */
function findWebDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'src', 'web');
    if (existsSync(join(candidate, 'index.html'))) return candidate;
    dir = resolve(dir, '..');
  }
  return resolve('src/web');
}

/** What a client sees for any 5xx: the real cause may name files, modules or internals. */
const INTERNAL_ERROR = 'Something went wrong on our side.';

/** Tiny per-IP token bucket - protects the Jev key from a runaway client. */
class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly perMinute: number) {
    // Below 1 a bucket can never hold a whole token, so every message would be refused forever.
    // Refuse to start instead of serving nothing but 429s.
    if (!Number.isFinite(perMinute) || perMinute < 1) {
      throw new RangeError(`The chat rate limit must be at least 1 message per minute (got ${perMinute}).`);
    }
  }
  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: now };
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    if (this.buckets.size > 10_000) this.buckets.clear();
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

export async function buildApp(
  bot: PerfumeBot,
  config: Pick<Config, 'jevMode' | 'jevModeReason' | 'typesafeModel'> & Partial<Pick<Config, 'jevProvider' | 'rateLimitPerMin'>>,
): Promise<FastifyInstance> {
  // The limit comes from loadConfig, which validated it; never re-read the raw environment here.
  const limiter = new RateLimiter(config.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN);
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 16 * 1024 });

  // Routes answer the failures they expect. Whatever escapes them is a bug or an infrastructure
  // fault, and Fastify's default reply would echo its message (a TypeError, a file path) to the
  // client. So 5xx replies are generic and the detail goes to the log. Client errors (bad JSON,
  // body too large) keep Fastify's message, which is written for the caller.
  app.setErrorHandler<FastifyError>((err, req, reply) => {
    // Anything can be thrown - including null - so read defensively; honour .status as Fastify's default does.
    const e = (err ?? {}) as Partial<FastifyError> & { status?: number };
    const code = Number(e.statusCode ?? e.status ?? 0);
    const status = code >= 400 && code < 600 ? code : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: INTERNAL_ERROR });
    }
    req.log.info({ err }, e.message ?? 'request failed');
    return reply.code(status).send({ error: e.message || 'Request failed.' });
  });

  await app.register(fastifyStatic, { root: findWebDir(), index: ['index.html'] });

  // Docker polls this every 30 s; logging each poll would bury the real requests.
  app.get('/api/health', { logLevel: 'warn' }, async () => ({
    ok: true,
    mode: bot.mode,
    modeReason: config.jevModeReason,
    model: bot.mode === 'live' ? config.typesafeModel : 'mock-jev',
    provider: bot.mode === 'live' ? config.jevProvider : undefined,
    catalog: { source: bot.catalog.source, count: bot.catalog.size },
  }));

  app.post<{ Body: { sessionId?: unknown; message?: unknown } }>('/api/chat', async (req, reply) => {
    const { sessionId, message } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim()) return reply.code(400).send({ error: 'message is required' });
    if (message.length > 1000) return reply.code(400).send({ error: 'message is too long (max 1000 characters)' });
    if (sessionId !== undefined && typeof sessionId !== 'string') return reply.code(400).send({ error: 'sessionId must be a string' });
    if (!limiter.take(req.ip)) return reply.code(429).send({ error: 'Too many messages - please wait a moment.' });

    // Cancel Jev work if the client goes away. Listen on the RESPONSE: since Node 16 the
    // request emits 'close' as soon as its body has been read, which would abort every chat.
    const ctl = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) ctl.abort(); });
    try {
      return await bot.chat(sessionId, message, ctl.signal);
    } catch (e) {
      if (e instanceof JevError) {
        req.log.error({ status: e.status, body: e.body?.slice(0, 500) }, e.message);
        if (e.status === 401) return reply.code(502).send({ error: 'The Jev API rejected the API key. Check OPENROUTER_API_KEY / TYPESAFE_API_KEY in .env.' });
        if (e.status === 402) return reply.code(502).send({ error: 'The Jev provider reports insufficient credits on this API key.' });
        if (e.status === 429 || e.status === 529 || e instanceof JevBudgetError) {
          return reply.code(503).send({ error: 'Jev is busy right now - please try again in a moment.' });
        }
        return reply.code(502).send({ error: 'Could not reach the Jev decision model. Please try again.' });
      }
      if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') {
        return reply.code(504).send({ error: 'That took too long - please try again.' });
      }
      req.log.error(e);
      return reply.code(500).send({ error: INTERNAL_ERROR });
    }
  });

  app.post<{ Body: { sessionId?: unknown } }>('/api/reset', async (req) => {
    const id = req.body?.sessionId;
    if (typeof id === 'string') bot.sessions.reset(id);
    return { ok: true };
  });

  // A duplicated browser tab inherits its session id; it asks for its own copy, so "Why is #1
  // the top pick?" in one tab never explains the other tab's list.
  app.post<{ Body: { sessionId?: unknown } }>('/api/fork', async (req, reply) => {
    const id = req.body?.sessionId;
    if (typeof id !== 'string') return reply.code(400).send({ error: 'sessionId must be a string' });
    // Every fork creates a session, and the store evicts the oldest past its cap: without the chat
    // limit, one client could push everyone else's conversations out. A real tab forks once per load.
    if (!limiter.take(req.ip)) return reply.code(429).send({ error: 'Too many requests - please wait a moment.' });
    return { sessionId: bot.sessions.fork(id)?.id ?? null };
  });

  app.get<{ Params: { pid: string } }>('/api/fragrance/:pid', async (req, reply) => {
    const fr = bot.catalog.get(req.params.pid);
    return fr ?? reply.code(404).send({ error: 'not found' });
  });

  app.get<{ Querystring: { q?: unknown } }>('/api/search', async (req, reply) => {
    const { q = '' } = req.query;
    // A repeated parameter (?q=a&q=b) parses to an array, which the name matcher cannot handle.
    if (typeof q !== 'string') return reply.code(400).send({ error: 'q must be a single string' });
    return bot.catalog.search(q.slice(0, 100), 10).map((m) => ({ pid: m.fragrance.pid, name: m.fragrance.name, brand: m.fragrance.brand, score: m.score }));
  });

  return app;
}
