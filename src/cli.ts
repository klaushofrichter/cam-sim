#!/usr/bin/env node
import { loadConfig, ConfigError } from './config';
import { createLogger } from './log';
import { createCamSim } from './index';
import { ensureFixtures, defaultFixtureDir } from './media/fixtures';

// Container / npx entry point: configuration from CAMSIM_* variables.
async function main(): Promise<number | undefined> {
  if (process.argv.includes('--make-fixtures')) {
    const log = createLogger(process.env.CAMSIM_LOG_LEVEL || 'info');
    const paths = await ensureFixtures(process.env.CAMSIM_FIXTURE_DIR || defaultFixtureDir(), log);
    log.info({ dir: paths.dir }, 'fixtures_ready');
    return 0;
  }
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`cam-sim: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const log = createLogger(config.logLevel);
  const sim = await createCamSim({ users: config.users, log }, config);
  const ports = await sim.listen();
  log.info({ name: config.name, ports, controlApi: !!config.controlToken, media: config.media, speed: config.speed }, 'cam_sim_listening');
  const stop = async (signal: string) => {
    log.info({ signal }, 'cam_sim_stopping');
    await sim.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
  return undefined;
}

main().then(
  (code) => {
    if (code !== undefined) process.exit(code);
  },
  (e) => {
    process.stderr.write(`cam-sim: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
