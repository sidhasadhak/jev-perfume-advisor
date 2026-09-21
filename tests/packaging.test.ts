/** Guards for the things that make a fresh clone install and run. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MIN_NODE, nodeTooOld } from '../src/runtime.js';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  engines: { node: string }; scripts: Record<string, string>; dependencies: Record<string, string>;
};

describe('packaging', () => {
  it('the app\'s minimum Node matches package.json "engines"', () => {
    assert.equal(pkg.engines.node, `>=${MIN_NODE.join('.')}`);
    assert.equal(nodeTooOld('20.11.1'), true);
    assert.equal(nodeTooOld('20.12.0'), false);
    assert.equal(nodeTooOld('18.19.0'), true);
    assert.equal(nodeTooOld('22.1.0'), false);
  });

  it('npm test does not rely on the shell expanding a glob (Windows cmd.exe does not)', () => {
    assert.doesNotMatch(pkg.scripts.test!, /\*/);
  });

  it('npm start runs from source, so a fresh clone needs no build step', () => {
    assert.match(pkg.scripts.start!, /^tsx /);
    assert.ok(pkg.dependencies.tsx, 'tsx must be a runtime dependency (npm install --omit=dev, Docker)');
  });

  it('.env and local tooling are git-ignored; .env.example is not', () => {
    const ignore = readFileSync('.gitignore', 'utf8').split('\n').map((l) => l.trim());
    for (const p of ['.env', 'node_modules/', 'dist/']) assert.ok(ignore.includes(p), `${p} missing from .gitignore`);
    assert.ok(!ignore.includes('.env.example'));
  });

  it('.env.example sets no key and pins no base URL', () => {
    const ex = readFileSync('.env.example', 'utf8');
    assert.match(ex, /^OPENROUTER_API_KEY=$/m);
    assert.match(ex, /^TYPESAFE_API_KEY=$/m);
    assert.doesNotMatch(ex, /^TYPESAFE_API_BASE=/m);
  });

  it('setup creates .env from the example without a terminal, and never overwrites an existing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      copyFileSync('scripts/setup.mjs', join(dir, 'scripts', 'setup.mjs'));
      copyFileSync('package.json', join(dir, 'package.json'));
      copyFileSync('.env.example', join(dir, '.env.example'));
      const run = () => execFileSync(process.execPath, ['scripts/setup.mjs'], { cwd: dir, input: '', encoding: 'utf8' });
      const out = run();
      assert.ok(existsSync(join(dir, '.env')));
      assert.match(out, /mock mode/);
      writeFileSync(join(dir, '.env'), 'OPENROUTER_API_KEY=sk-or-keep-me\n');
      assert.match(run(), /already exists/);
      assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'OPENROUTER_API_KEY=sk-or-keep-me\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
