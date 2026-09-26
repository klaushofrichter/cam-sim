import { readFileSync } from 'fs';
import { FIRMWARE_VERSION } from './profile/version';
import type { FaultSpec } from './engine/faults';
import { TRIGGERS, type Trigger } from './engine/types';

export interface User {
  name: string;
  level: 'admin' | 'guest';
  password: string;
}

export interface CamSimConfig {
  name: string;
  users: User[];
  controlToken?: string;
  webUi: boolean;
  media: 'fixture' | 'video';
  dataDir?: string;
  fixtureDir?: string;
  tz: string;
  sdMb: number;
  speed: 'fast' | 'real';
  seedClips: 'none' | 'demo';
  faults: FaultSpec[];
  autoEvents: Array<{ type: Trigger; perHour: number }>;
  firmVer: string;
  seed: number;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  ports: { https: number; http: number; control: number };
  logLevel: string;
}

// Messages name the variable, never its value (values may be secrets).
export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): CamSimConfig {
  const secret = (key: string): string | undefined => {
    const file = env[`${key}_FILE`];
    if (file) {
      try {
        return readFile(file).trim();
      } catch {
        throw new ConfigError(`${key}_FILE could not be read`);
      }
    }
    return env[key] || undefined;
  };
  const oneOf = <T extends string>(key: string, allowed: readonly T[], def: T): T => {
    const v = env[key];
    if (v === undefined || v === '') return def;
    if (!(allowed as readonly string[]).includes(v)) throw new ConfigError(`${key} must be one of ${allowed.join(', ')}`);
    return v as T;
  };
  const int = (key: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    const v = env[key];
    if (v === undefined || v === '') return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${key} must be an integer from ${min} to ${max}`);
    return n;
  };
  const port = (key: string, def: number) => int(key, def, 0, 65535);

  const usersRaw = secret('CAMSIM_USERS');
  if (!usersRaw) throw new ConfigError('CAMSIM_USERS is required (name:level:password;…)');
  const users = usersRaw.split(';').filter(Boolean).map((entry, i): User => {
    const a = entry.indexOf(':');
    const b = entry.indexOf(':', a + 1);
    const name = entry.slice(0, a);
    const level = entry.slice(a + 1, b);
    if (a < 1 || b < 0 || (level !== 'admin' && level !== 'guest')) {
      throw new ConfigError(`CAMSIM_USERS entry ${i + 1} must be name:admin|guest:password`);
    }
    return { name, level, password: entry.slice(b + 1) };
  });

  let faults: FaultSpec[] = [];
  if (env.CAMSIM_FAULTS) {
    try {
      faults = JSON.parse(env.CAMSIM_FAULTS);
    } catch {
      throw new ConfigError('CAMSIM_FAULTS must be a JSON array of faults');
    }
    if (!Array.isArray(faults)) throw new ConfigError('CAMSIM_FAULTS must be a JSON array of faults');
  }

  const autoEvents: CamSimConfig['autoEvents'] = [];
  const auto = env.CAMSIM_AUTO_EVENTS;
  if (auto && auto !== 'off') {
    for (const part of auto.split(',')) {
      const m = /^\s*(\w+):(\d+(?:\.\d+)?)\/h\s*$/.exec(part);
      if (!m || !(TRIGGERS as readonly string[]).includes(m[1])) {
        throw new ConfigError('CAMSIM_AUTO_EVENTS must look like motion:6/h,person:1/h');
      }
      autoEvents.push({ type: m[1] as Trigger, perHour: Number(m[2]) });
    }
  }

  return {
    name: env.CAMSIM_NAME || 'Cam',
    users,
    controlToken: secret('CAMSIM_CONTROL_TOKEN'),
    webUi: env.CAMSIM_WEB_UI === 'true',
    media: oneOf('CAMSIM_MEDIA', ['fixture', 'video'] as const, 'fixture'),
    dataDir: env.CAMSIM_DATA_DIR || undefined,
    fixtureDir: env.CAMSIM_FIXTURE_DIR || undefined,
    tz: env.CAMSIM_TZ || 'America/Chicago',
    sdMb: int('CAMSIM_SD_MB', 4096, 1),
    speed: oneOf('CAMSIM_SPEED', ['fast', 'real'] as const, 'fast'),
    seedClips: oneOf('CAMSIM_SEED_CLIPS', ['none', 'demo'] as const, 'none'),
    faults,
    autoEvents,
    firmVer: env.CAMSIM_FIRMWARE || FIRMWARE_VERSION,
    seed: int('CAMSIM_SEED', Date.now() % 2 ** 31),
    tlsCertFile: env.CAMSIM_TLS_CERT_FILE || undefined,
    tlsKeyFile: env.CAMSIM_TLS_KEY_FILE || undefined,
    ports: {
      https: port('CAMSIM_HTTPS_PORT', 8443),
      http: port('CAMSIM_HTTP_PORT', 8080),
      control: port('CAMSIM_CONTROL_PORT', 9443),
    },
    logLevel: env.CAMSIM_LOG_LEVEL || 'info',
  };
}
