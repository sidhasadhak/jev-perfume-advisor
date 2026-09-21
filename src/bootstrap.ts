import { loadCatalog } from './catalog/loader.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { JevClient } from './jev/client.js';
import { MockJev } from './jev/mock.js';
import type { Decider } from './jev/types.js';
import { PerfumeBot } from './pipeline/orchestrator.js';
import { nodeTooOld, nodeVersionMessage } from './runtime.js';

export interface Runtime {
  config: Config;
  bot: PerfumeBot;
  decider: Decider;
}

/** Shared wiring for the HTTP server and the CLI. */
export async function bootstrap(log: (msg: string) => void = console.error): Promise<Runtime> {
  if (nodeTooOld()) throw new Error(nodeVersionMessage());
  const config = loadConfig();
  for (const w of config.warnings) log(`config warning: ${w}`);
  const catalog = await loadCatalog({
    source: config.catalogSource,
    seedDir: config.seedDir,
    csvDir: config.fragdbCsvDir,
    apiKey: config.fragdbApiKey,
    apiBase: config.fragdbApiBase,
    log,
  });
  log(`catalog: ${catalog.size} fragrances from "${catalog.source}" (${catalog.stats.brands} brands, ${catalog.stats.dropped} dropped)`);

  const decider: Decider = config.jevMode === 'live'
    ? new JevClient({
        apiKey: config.typesafeApiKey,
        baseUrl: config.typesafeApiBase,
        model: config.typesafeModel,
        concurrency: config.jevConcurrency,
      })
    : new MockJev();

  if (config.jevMode === 'live') {
    log(`jev: live - ${config.typesafeModel} via ${config.jevProvider} (${config.typesafeApiBase})`);
  } else {
    log(`jev: MOCK MODE (${config.jevModeReason}). Answers come from a keyword heuristic, NOT from Jev.`);
    log('     Set OPENROUTER_API_KEY or TYPESAFE_API_KEY in .env to use the real model.');
  }

  if (catalog.size > config.jevScreenLimit) {
    log(`jev: catalog (${catalog.size}) exceeds JEV_SCREEN_LIMIT=${config.jevScreenLimit}; Jev screens the top ${config.jevScreenLimit} by community-vote score each turn`);
  } else {
    log(`jev: screens all ${catalog.size} perfumes on every request`);
  }
  return { config, bot: new PerfumeBot(catalog, decider, { screenLimit: config.jevScreenLimit }), decider };
}
