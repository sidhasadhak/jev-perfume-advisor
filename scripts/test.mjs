#!/usr/bin/env node
/**
 * Runs every tests/*.test.ts. A plain "tsx --test tests/*.test.ts" relies on the shell expanding the
 * glob, which Windows cmd.exe does not do (and Node 20's test runner cannot either).
 *   npm test                       all suites
 *   npm test -- tests/seed.test.ts one file
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const args = process.argv.slice(2);
const files = args.length ? args : readdirSync('tests').filter((f) => f.endsWith('.test.ts')).sort().map((f) => join('tests', f));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const { status } = spawnSync(process.execPath, [tsx, '--test', ...files], { stdio: 'inherit' });
process.exit(status ?? 1);
