import { existsSync } from 'node:fs';
import type { CatalogSource } from './catalog/catalog.js';

export const TYPESAFE_BASE = 'https://api.typesafe.ai';
/** OpenRouter serves TypeSafe's System One API at <base>/v1/systemone with identical request/response bodies. */
export const OPENROUTER_BASE = 'https://openrouter.ai/api';
export const DEFAULT_RATE_LIMIT_PER_MIN = 30;

export interface Config {
  jevMode: 'live' | 'mock';
  /** Who serves Jev, for logs and /api/health. */
  jevProvider: 'typesafe' | 'openrouter' | 'custom';
  /** Configuration problems that were corrected automatically - log them at startup. */
  warnings: string[];
  /** Why mock mode was chosen, if it was. Surfaced in logs and /api/health. */
  jevModeReason?: string;
  typesafeApiKey: string;
  typesafeApiBase: string;
  typesafeModel: string;
  jevConcurrency: number;
  /** Jev screens every perfume when the catalog is at most this size. */
  jevScreenLimit: number;
  catalogSource: CatalogSource;
  seedDir: string;
  fragdbCsvDir: string;
  fragdbApiKey: string;
  fragdbApiBase: string;
  port: number;
  host: string;
  /** Chat messages per minute per client IP; always a whole number of at least 1. */
  rateLimitPerMin: number;
}

/** Load .env (if present) with Node's built-in loader, then read config from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');

  // Either key works. An explicit TypeSafe key wins; an OpenRouter key alone points the client at OpenRouter.
  const typesafeKey = (env.TYPESAFE_API_KEY ?? '').trim();
  const openrouterKey = (env.OPENROUTER_API_KEY ?? '').trim();
  const key = typesafeKey || openrouterKey;
  const explicitBase = env.TYPESAFE_API_BASE?.trim();
  let apiBase = explicitBase || (typesafeKey || !openrouterKey ? TYPESAFE_BASE : OPENROUTER_BASE);
  const warnings: string[] = [];
  // An OpenRouter key ("sk-or-...") can only ever authenticate at OpenRouter. Pairing it with
  // TypeSafe's own endpoint (e.g. a stale TYPESAFE_API_BASE line) is a guaranteed 401, so fix the route.
  if (key.startsWith('sk-or-') && apiBase.replace(/\/+$/, '') === TYPESAFE_BASE) {
    warnings.push(`An OpenRouter key was configured with TYPESAFE_API_BASE=${TYPESAFE_BASE}; using ${OPENROUTER_BASE} instead. Remove that line from .env to silence this.`);
    apiBase = OPENROUTER_BASE;
  }
  const jevProvider: Config['jevProvider'] = apiBase.replace(/\/+$/, '') === OPENROUTER_BASE ? 'openrouter'
    : apiBase.replace(/\/+$/, '') === TYPESAFE_BASE ? 'typesafe' : 'custom';
  // Blank counts as unset (a bare `JEV_MODE=` line in .env). Anything else unrecognised must fail:
  // falling through to auto would quietly run live, and bill, whenever a key is present.
  const requested = (env.JEV_MODE ?? '').trim().toLowerCase() || 'auto';
  if (requested !== 'auto' && requested !== 'live' && requested !== 'mock') {
    throw new Error(`JEV_MODE must be auto, live or mock (got "${env.JEV_MODE}")`);
  }
  let jevMode: Config['jevMode'];
  let jevModeReason: string | undefined;
  if (requested === 'mock') {
    jevMode = 'mock';
    jevModeReason = 'JEV_MODE=mock';
  } else if (requested === 'live') {
    if (!key) throw new Error('JEV_MODE=live but no key is set. Add OPENROUTER_API_KEY or TYPESAFE_API_KEY to .env (see .env.example).');
    jevMode = 'live';
  } else if (key) {
    jevMode = 'live';
  } else {
    jevMode = 'mock';
    jevModeReason = 'neither OPENROUTER_API_KEY nor TYPESAFE_API_KEY is set';
  }

  // A blank line in .env ("CATALOG_SOURCE=") means the default, as for every other setting.
  const source = (env.CATALOG_SOURCE?.trim() || 'seed').toLowerCase();
  if (source !== 'seed' && source !== 'csv' && source !== 'api') {
    throw new Error(`CATALOG_SOURCE must be seed, csv or api (got "${source}")`);
  }

  return {
    jevMode,
    jevModeReason,
    jevProvider,
    warnings,
    typesafeApiKey: key,
    typesafeApiBase: apiBase,
    typesafeModel: env.TYPESAFE_MODEL?.trim() || 'jev-latest',
    jevConcurrency: intOr(env, 'JEV_CONCURRENCY', 8, warnings),
    jevScreenLimit: intOr(env, 'JEV_SCREEN_LIMIT', 400, warnings),
    catalogSource: source,
    seedDir: env.SEED_DIR?.trim() || './data/catalog',
    fragdbCsvDir: env.FRAGDB_CSV_DIR?.trim() || './data/fragdb',
    fragdbApiKey: env.FRAGDB_API_KEY?.trim() ?? '',
    fragdbApiBase: env.FRAGDB_API_BASE?.trim() || 'https://fragdb.net/api',
    port: intOr(env, 'PORT', 8787, warnings),
    // "localhost" binds IPv4 and IPv6 loopback both, so http://localhost always reaches this app
    // (on macOS, localhost resolves to ::1 first and could otherwise reach a different program).
    host: env.HOST?.trim() || 'localhost',
    rateLimitPerMin: intOr(env, 'RATE_LIMIT_PER_MIN', DEFAULT_RATE_LIMIT_PER_MIN, warnings),
  };
}

/**
 * A whole number of at least 1, else the default. A value that is set but invalid (0.5, -1, "ten")
 * also records a warning, so the operator learns their setting was ignored rather than guessing.
 */
function intOr(env: NodeJS.ProcessEnv, name: string, d: number, warnings: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return d;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  warnings.push(`${name} must be a whole number of at least 1 (got "${env[name]}"); using ${d}.`);
  return d;
}
