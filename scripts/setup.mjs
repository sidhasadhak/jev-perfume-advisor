#!/usr/bin/env node
/**
 * One-time setup: checks Node, creates .env from .env.example, and (in a terminal)
 * asks for a Jev API key. Uses only Node built-ins, so it works before and after
 * `npm install`, and on macOS, Linux and Windows alike.
 *
 *   npm run setup
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Minimum Node from package.json "engines" (">=20.12"): one source of truth, readable before `npm install`. */
function minNode() {
  const range = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines?.node ?? '';
  const [, major = '0', minor = '0'] = /(\d+)(?:\.(\d+))?/.exec(range) ?? [];
  return [Number(major), Number(minor)];
}
const [MIN_MAJOR, MIN_MINOR] = minNode();
const [major, minor] = process.versions.node.split('.').map(Number);
const nodeTooOld = () => major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR);
const nodeVersionMessage = () => `This app needs Node.js ${MIN_MAJOR}.${MIN_MINOR} or newer, but you are running ${process.versions.node}.\n`
  + 'Install the current LTS from https://nodejs.org (or run "nvm install" in this folder), then try again.';

const ENV = '.env';
const EXAMPLE = '.env.example';

if (nodeTooOld()) {
  console.error(`\n  ${nodeVersionMessage().replace(/\n/g, '\n  ')}\n`);
  process.exit(1);
}

if (!existsSync(EXAMPLE)) {
  console.error('\n  Run this from the project folder (the one containing .env.example).\n');
  process.exit(1);
}

let env;
if (existsSync(ENV)) {
  env = readFileSync(ENV, 'utf8');
  console.log(`\n  ${ENV} already exists - keeping it.`);
} else {
  copyFileSync(EXAMPLE, ENV);
  env = readFileSync(ENV, 'utf8');
  console.log(`\n  Created ${ENV} from ${EXAMPLE}.`);
}

const hasKey = (name) => new RegExp(`^${name}=\\S+`, 'm').test(env);
if (hasKey('OPENROUTER_API_KEY') || hasKey('TYPESAFE_API_KEY')) {
  console.log('  A Jev API key is already set.');
  done(true);
} else if (!process.stdin.isTTY) {
  console.log('  No terminal to ask for a key in: the app will run in mock mode until you add one to .env.');
  done(false);
} else {
  const key = (await askHidden(
    '\n  Paste your OpenRouter API key to use the real Jev model\n'
    + '  (get one at https://openrouter.ai/keys), or press Enter to try mock mode: ',
  )).trim();
  if (!key) {
    console.log('  No key given - the app will run in mock mode (clearly labelled) until you add one to .env.');
    done(false);
  } else {
    // An OpenRouter key goes in OPENROUTER_API_KEY; anything else is taken as a TypeSafe key.
    const name = key.startsWith('sk-or-') ? 'OPENROUTER_API_KEY' : 'TYPESAFE_API_KEY';
    env = new RegExp(`^${name}=.*$`, 'm').test(env)
      ? env.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${key}`)
      : `${env.trimEnd()}\n${name}=${key}\n`;
    writeFileSync(ENV, env);
    console.log(`  Saved to ${ENV} as ${name}. This file is git-ignored, so the key is never committed.`);
    done(true);
  }
}

function done(live) {
  // The last PORT line wins, as when the app reads .env.
  const port = [...env.matchAll(/^PORT=(\d+)\s*$/gm)].pop()?.[1] ?? '8787';
  console.log(`
  Next:
    npm start            then open http://localhost:${port}
    npm run chat         chat in the terminal instead
${live ? '    npm run smoke        run the five example questions against live Jev (about $0.01)\n' : ''}`);
}

/**
 * Read a line without echoing it, so a key is not left on screen or in scrollback.
 * Reads raw keystrokes itself: readline's own redraw on Backspace wipes the prompt.
 */
function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
    };
    const onData = (chunk) => {
      // Arrow keys and other escape sequences carry no key text.
      for (const ch of chunk.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '')) {
        if (ch === '\r' || ch === '\n' || ch === '\x04') { finish(); resolve(value); return; }
        if (ch === '\x03') {
          finish();
          console.log('  Setup cancelled - run "npm run setup" again any time.');
          process.exit(130);
        }
        if (ch === '\x7f' || ch === '\b') { value = value.slice(0, -1); continue; }
        if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}
