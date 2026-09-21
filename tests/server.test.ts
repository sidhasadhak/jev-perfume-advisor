/**
 * HTTP-level tests over a REAL listening socket (not fastify.inject), because
 * connection lifecycle bugs - like aborting a request when its body has been
 * read - only show up with real sockets.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { PerfumeBot } from '../src/pipeline/orchestrator.js';
import { buildApp } from '../src/server/app.js';
import { fixtureCatalog, scriptedJev } from './helpers.js';

const MOCK = { jevMode: 'mock', jevModeReason: 'test', typesafeModel: 'jev-latest' } as const;
const apps: FastifyInstance[] = [];
let base: string;

const partyBot = () => new PerfumeBot(fixtureCatalog(), scriptedJev({ occasion: 'evening_party', time_of_day: 'night' }));

/** Builds an app, listens on a free port and returns its base URL; every app is closed in after(). */
async function serve(bot: PerfumeBot, rateLimitPerMin = 1000): Promise<string> {
  const app = await buildApp(bot, { ...MOCK, rateLimitPerMin });
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

before(async () => {
  process.env.LOG_LEVEL = 'silent';
  base = await serve(partyBot());
});

after(() => Promise.all(apps.map((a) => a.close())));

const post = (path: string, body: unknown, at = base) =>
  fetch(at + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('HTTP API', () => {
  it('POST /api/chat completes over a real socket (regression: must not self-abort after reading the body)', async () => {
    const res = await post('/api/chat', { message: 'Suggest a perfume for an evening party' });
    assert.equal(res.status, 200, await res.clone().text());
    const json = await res.json() as { sessionId: string; mode: string; reply: { text: string; recommendations: unknown[] } };
    assert.ok(json.sessionId);
    assert.equal(json.mode, 'mock');
    assert.ok(json.reply.recommendations.length > 0);
  });

  it('keeps the session across turns', async () => {
    const r1 = await (await post('/api/chat', { message: 'party perfume' })).json() as { sessionId: string };
    const r2 = await (await post('/api/chat', { sessionId: r1.sessionId, message: 'another' })).json() as { sessionId: string };
    assert.equal(r2.sessionId, r1.sessionId);
  });

  it('POST /api/fork gives a duplicated tab its own copy of the conversation', async () => {
    const r1 = await (await post('/api/chat', { message: 'party perfume' })).json() as { sessionId: string };
    const fork = await (await post('/api/fork', { sessionId: r1.sessionId })).json() as { sessionId: string | null };
    assert.ok(fork.sessionId);
    assert.notEqual(fork.sessionId, r1.sessionId);
    // The copy continues the same conversation: "cheaper" refines the list both tabs saw.
    const r2 = await (await post('/api/chat', { sessionId: fork.sessionId, message: 'something cheaper' })).json() as { sessionId: string };
    assert.equal(r2.sessionId, fork.sessionId);
    assert.deepEqual(await (await post('/api/fork', { sessionId: 'unknown-session-id' })).json(), { sessionId: null });
    assert.equal((await post('/api/fork', {})).status, 400);
  });

  it('validates input', async () => {
    assert.equal((await post('/api/chat', {})).status, 400);
    assert.equal((await post('/api/chat', { message: '   ' })).status, 400);
    assert.equal((await post('/api/chat', { message: 'x'.repeat(1001) })).status, 400);
    assert.equal((await post('/api/chat', { message: 'hi', sessionId: 42 })).status, 400);
  });

  it('health, fragrance lookup, search and reset', async () => {
    const health = await (await fetch(`${base}/api/health`)).json() as { ok: boolean; mode: string; catalog: { count: number } };
    assert.equal(health.ok, true);
    assert.equal(health.catalog.count, 12);
    assert.equal((await fetch(`${base}/api/fragrance/A`)).status, 200);
    assert.equal((await fetch(`${base}/api/fragrance/nope`)).status, 404);
    const hits = await (await fetch(`${base}/api/search?q=ember`)).json() as Array<{ name: string }>;
    assert.ok(hits.some((h) => h.name === 'Ember Nocturne'));
    assert.deepEqual(await (await post('/api/reset', { sessionId: 'abcdefgh' })).json(), { ok: true });
  });

  it('search rejects a repeated q with 400 (regression: 500 that echoed "s.normalize is not a function")', async () => {
    const res = await fetch(`${base}/api/search?q=ember&q=musk`);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'q must be a single string' });
    assert.equal((await fetch(`${base}/api/search`)).status, 200, 'a missing q is still an empty search');
  });

  it('an unexpected 500 returns a generic message, never the internal one', async () => {
    const catalog = fixtureCatalog();
    catalog.get = () => { throw new Error('ENOENT: open /srv/secret/catalog.db'); };
    const at = await serve(new PerfumeBot(catalog, scriptedJev({})));
    const res = await fetch(`${at}/api/fragrance/A`);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: 'Something went wrong on our side.' });
    assert.doesNotMatch(text, /secret|ENOENT/);
  });

  it('client errors keep their 4xx status and a readable message', async () => {
    const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":' });
    assert.equal(res.status, 400);
    const json = await res.json() as { error?: unknown };
    assert.equal(typeof json.error, 'string');
  });

  it('the rate limit comes from the config passed in, not the raw environment (regression: RATE_LIMIT_PER_MIN=0.5 refused everything)', async () => {
    const saved = process.env.RATE_LIMIT_PER_MIN;
    process.env.RATE_LIMIT_PER_MIN = '0.5';
    try {
      const at = await serve(partyBot(), 2);
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await post('/api/chat', { message: 'party perfume' }, at)).status);
      assert.deepEqual(statuses, [200, 200, 429]);
    } finally {
      if (saved === undefined) delete process.env.RATE_LIMIT_PER_MIN;
      else process.env.RATE_LIMIT_PER_MIN = saved;
    }
  });

  it('refuses to build with a rate limit that could never admit a message', async () => {
    for (const bad of [0.5, 0, -1, Number.NaN]) {
      await assert.rejects(buildApp(partyBot(), { ...MOCK, rateLimitPerMin: bad }), RangeError, String(bad));
    }
  });

  it('serves the web UI', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Scent Sommelier/);
  });
});
