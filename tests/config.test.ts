import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPENROUTER_BASE, TYPESAFE_BASE, loadConfig } from '../src/config.js';
import { JevClient } from '../src/jev/client.js';

// A plain object (not process.env) so .env on disk is never read.
const cfg = (env: Record<string, string>) => loadConfig({ ...env } as NodeJS.ProcessEnv);

describe('Jev provider configuration', () => {
  it('an OpenRouter key alone targets OpenRouter at /api/v1/systemone', () => {
    const c = cfg({ OPENROUTER_API_KEY: 'sk-or-x' });
    assert.equal(c.jevMode, 'live');
    assert.equal(c.jevProvider, 'openrouter');
    assert.equal(c.typesafeApiBase, OPENROUTER_BASE);
    assert.equal(c.typesafeApiKey, 'sk-or-x');
    assert.equal(c.typesafeModel, 'jev-latest');
    const client = new JevClient({ apiKey: c.typesafeApiKey, baseUrl: c.typesafeApiBase });
    assert.equal(client.endpoint, 'https://openrouter.ai/api/v1/systemone');
  });

  it('a TypeSafe key targets TypeSafe, and wins when both are set', () => {
    assert.equal(cfg({ TYPESAFE_API_KEY: 'ts' }).typesafeApiBase, TYPESAFE_BASE);
    const both = cfg({ TYPESAFE_API_KEY: 'ts', OPENROUTER_API_KEY: 'or' });
    assert.equal(both.typesafeApiKey, 'ts');
    assert.equal(both.jevProvider, 'typesafe');
  });

  it('an explicit base URL always wins', () => {
    const c = cfg({ OPENROUTER_API_KEY: 'or', TYPESAFE_API_BASE: 'https://gateway.example/api' });
    assert.equal(c.typesafeApiBase, 'https://gateway.example/api');
    assert.equal(c.jevProvider, 'custom');
  });

  it('an OpenRouter key paired with the TypeSafe endpoint is rerouted to OpenRouter, with a warning', () => {
    const c = cfg({ OPENROUTER_API_KEY: 'sk-or-v1-abc', TYPESAFE_API_BASE: 'https://api.typesafe.ai' });
    assert.equal(c.typesafeApiBase, OPENROUTER_BASE);
    assert.equal(c.jevProvider, 'openrouter');
    assert.equal(c.warnings.length, 1);
    // Same if the OpenRouter key was pasted into TYPESAFE_API_KEY.
    assert.equal(cfg({ TYPESAFE_API_KEY: 'sk-or-v1-abc' }).typesafeApiBase, OPENROUTER_BASE);
    // A genuine TypeSafe key is never rerouted.
    assert.equal(cfg({ TYPESAFE_API_KEY: 'ts-abc' }).warnings.length, 0);
  });

  it('an empty TYPESAFE_API_BASE falls back to the provider default', () => {
    assert.equal(cfg({ OPENROUTER_API_KEY: 'or', TYPESAFE_API_BASE: '' }).typesafeApiBase, OPENROUTER_BASE);
  });

  it('no key -> mock mode with a reason; JEV_MODE=live without a key fails loudly', () => {
    const c = cfg({});
    assert.equal(c.jevMode, 'mock');
    assert.match(c.jevModeReason ?? '', /OPENROUTER_API_KEY/);
    assert.throws(() => cfg({ JEV_MODE: 'live' }), /OPENROUTER_API_KEY or TYPESAFE_API_KEY/);
  });

  it('the shipped .env.example does not pin a base URL that would misroute an OpenRouter key', async () => {
    const { readFileSync } = await import('node:fs');
    assert.doesNotMatch(readFileSync('.env.example', 'utf8'), /^TYPESAFE_API_BASE=/m);
  });
});

describe('JEV_MODE', () => {
  it('an unrecognised value fails and lists the valid ones (regression: it silently ran live, and billed)', () => {
    for (const mode of ['off', 'disabled', 'mocked']) {
      assert.throws(() => cfg({ JEV_MODE: mode, TYPESAFE_API_KEY: 'k' }), new RegExp(`JEV_MODE must be auto, live or mock \\(got "${mode}"\\)`));
    }
  });

  it('is trimmed and case-insensitive, and blank means auto', () => {
    assert.equal(cfg({ JEV_MODE: 'mock ', TYPESAFE_API_KEY: 'k' }).jevMode, 'mock');
    assert.equal(cfg({ JEV_MODE: ' MOCK', OPENROUTER_API_KEY: 'k' }).jevMode, 'mock');
    assert.equal(cfg({ JEV_MODE: 'Live', TYPESAFE_API_KEY: 'k' }).jevMode, 'live');
    assert.equal(cfg({ JEV_MODE: '', TYPESAFE_API_KEY: 'k' }).jevMode, 'live');
    assert.equal(cfg({ JEV_MODE: '  ' }).jevMode, 'mock');
  });
});

describe('RATE_LIMIT_PER_MIN', () => {
  it('defaults to 30 and accepts a whole number of at least 1', () => {
    assert.equal(cfg({}).rateLimitPerMin, 30);
    assert.equal(cfg({ RATE_LIMIT_PER_MIN: '12' }).rateLimitPerMin, 12);
    assert.equal(cfg({ RATE_LIMIT_PER_MIN: ' 1 ' }).rateLimitPerMin, 1);
    assert.equal(cfg({ RATE_LIMIT_PER_MIN: '12' }).warnings.length, 0);
  });

  it('a value that would block every message falls back to 30 with a warning (regression: 0.5 or -1 refused all chats)', () => {
    for (const bad of ['0.5', '-1', '0', 'ten']) {
      const c = cfg({ RATE_LIMIT_PER_MIN: bad });
      assert.equal(c.rateLimitPerMin, 30, bad);
      assert.equal(c.warnings.length, 1, bad);
      assert.match(c.warnings[0] ?? '', new RegExp(`RATE_LIMIT_PER_MIN must be a whole number of at least 1 \\(got "${bad}"\\); using 30`));
    }
  });

  it('the other numeric settings warn the same way instead of silently ignoring a bad value', () => {
    const c = cfg({ JEV_CONCURRENCY: '0', PORT: 'http' });
    assert.equal(c.jevConcurrency, 8);
    assert.equal(c.port, 8787);
    assert.equal(c.warnings.length, 2);
  });
});
