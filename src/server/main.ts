import { lookup } from 'node:dns/promises';
import { bootstrap } from '../bootstrap.js';
import { buildApp } from './app.js';

const { config, bot } = await bootstrap();
const app = await buildApp(bot, config);

function portInUse(): never {
  // The raw EADDRINUSE stack trace does not tell a newcomer what to do; this does.
  console.error(`\n  Port ${config.port} is already in use - maybe Scent Sommelier is already running in another window?\n`
    + `  To use another port, change the line PORT=${config.port} in .env to e.g. PORT=${config.port + 1},\n`
    + `  or run: PORT=${config.port + 1} npm start\n`);
  process.exit(1);
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') portInUse();
  throw e;
}

// "localhost" means IPv4 and IPv6 loopback. If another program holds one of them, the server still starts
// on the other - and then http://localhost reaches whichever the client tries first. Treat that as in use.
if (config.host === 'localhost') {
  const wanted = new Set((await lookup('localhost', { all: true })).map((a) => a.family));
  // Node reports family as 'IPv4'/'IPv6' (older versions: 4/6).
  const got = new Set<number>(app.addresses().map((a) => (String(a.family) === 'IPv6' || String(a.family) === '6' ? 6 : 4)));
  if ([...wanted].some((f) => !got.has(f))) {
    await app.close();
    portInUse();
  }
}

const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
console.error(`\n  Scent Sommelier is running at http://${shown}:${config.port}\n`);
