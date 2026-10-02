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
  // Control port TLS: auto = only with CAMSIM_TLS_CERT_FILE; on = always,
  // with the camera's current certificate (following ImportCertificate).
  controlTls: 'auto' | 'on' | 'off';
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
  // baichuan null: no Baichuan listener (the CLI without CAMSIM_BAICHUAN_PORT).
  ports: { https: number; http: number; control: number; rtsp: number; onvif: number; baichuan: number | null };
  // Baichuan idle timeouts (ms); tests shorten them.
  baichuan: { idleMs: number; firstMessageMs: number };
  logLevel: string;
  // Main-stream size of converted library videos (the camera's 4512x2512).
  mainSize: string;
  // Library sources are cut to this many seconds (a loop, not a movie).
  maxVideoS: number;
  // The video library's source folder, and the video selected at start.
  libraryDir?: string;
  video?: string;
  pipelineMaxMin: number; // CAMSIM_PIPELINE_MAX_MIN: the longest SD pipeline switch-on (minutes)
  fontDir?: string; // CAMSIM_FONT_DIR: a folder with DejaVuSans.ttf and DejaVuSans-Bold.ttf
  // CAMSIM_FTP_*: FTP upload configured and enabled at start.
  ftp?: { server: string; port: number; userName: string; password: string; remoteDir: string; onlyFtps: 0 | 1; streamType: 0 | 1 };
}

// Messages name the variable, never its value (values may be secrets).
export class ConfigError extends Error {}

// Baichuan (TCP 9000), measured on the RLC-1224A (reference/rlc-1224a/baichuan/):
// a logged-in connection closes about 32 s after the client's last message, one
// that never sends after 12.5 s; 12 connections at once, bare ones included.
export const BAICHUAN_IDLE_MS = 32_000;
export const BAICHUAN_FIRST_MESSAGE_MS = 12_500;
export const BAICHUAN_SESSION_LIMIT = 12;
// cam-sim's own cap (not measured): connections over the limit are held until
// their first message or the first-message timeout, so a client opening
// thousands could use up the simulator's file descriptors. Past this many held,
// a new connection is reset at once.
export const BAICHUAN_OVER_LIMIT_HELD_MAX = 20;

function maxVideoS(v: string | undefined): number {
  if (!v) return 60;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 600) throw new ConfigError('CAMSIM_MAX_VIDEO_S must be a whole number of seconds from 1 to 600');
  return n;
}

function mainSize(v: string | undefined): string {
  if (!v) return '4512x2512';
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(v);
  if (!m || Number(m[1]) % 2 || Number(m[2]) % 2) throw new ConfigError('CAMSIM_MAIN_SIZE must look like 4512x2512 (even numbers)');
  return v;
}

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
    if (a < 1 || b < 0 || (level !== 'admin' && level !== 'guest') || b === entry.length - 1) {
      throw new ConfigError(`CAMSIM_USERS entry ${i + 1} must be name:admin|guest:password (password not empty)`);
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

  // Plan 1 is headless and fixture-only; fail loudly rather than ignore.
  if (env.CAMSIM_MEDIA === 'video') throw new ConfigError('CAMSIM_MEDIA=video is not used: put videos in CAMSIM_LIBRARY_DIR and select one with CAMSIM_VIDEO');

  let ftp: CamSimConfig['ftp'];
  if (env.CAMSIM_FTP_SERVER) {
    ftp = {
      server: env.CAMSIM_FTP_SERVER,
      port: int('CAMSIM_FTP_PORT', 21, 1, 65535),
      userName: env.CAMSIM_FTP_USER || '',
      password: secret('CAMSIM_FTP_PASSWORD') ?? '',
      remoteDir: env.CAMSIM_FTP_DIR || '',
      onlyFtps: oneOf('CAMSIM_FTP_TLS', ['true', 'false'] as const, 'true') === 'true' ? 1 : 0,
      streamType: oneOf('CAMSIM_FTP_STREAM', ['main', 'sub'] as const, 'main') === 'sub' ? 1 : 0,
    };
  }

  // The name becomes part of uploaded file names (<Name>_00_…): no path
  // separators, dot segments or control characters.
  const name = env.CAMSIM_NAME || 'Cam';
  if (/[\/\\]|^\.\.?$|\p{C}/u.test(name) || name.length > 31) {
    throw new ConfigError('CAMSIM_NAME must be at most 31 characters, without / \\ or control characters');
  }

  return {
    name,
    ftp,
    users,
    controlToken: secret('CAMSIM_CONTROL_TOKEN'),
    webUi: env.CAMSIM_WEB_UI === 'true',
    controlTls: oneOf('CAMSIM_CONTROL_TLS', ['auto', 'on', 'off'] as const, 'auto'),
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
      rtsp: port('CAMSIM_RTSP_PORT', 8554),
      onvif: port('CAMSIM_ONVIF_PORT', 8000),
      // Only when set: several CLI simulators on one host (cams' e2e) must not
      // all bind 9000. The image sets 9000.
      baichuan: env.CAMSIM_BAICHUAN_PORT === undefined ? null : port('CAMSIM_BAICHUAN_PORT', 9000),
    },
    baichuan: { idleMs: BAICHUAN_IDLE_MS, firstMessageMs: BAICHUAN_FIRST_MESSAGE_MS },
    logLevel: env.CAMSIM_LOG_LEVEL || 'info',
    mainSize: mainSize(env.CAMSIM_MAIN_SIZE),
    maxVideoS: maxVideoS(env.CAMSIM_MAX_VIDEO_S),
    libraryDir: env.CAMSIM_LIBRARY_DIR || undefined,
    video: env.CAMSIM_VIDEO || undefined,
    pipelineMaxMin: int('CAMSIM_PIPELINE_MAX_MIN', 1440, 1, 1440),
    fontDir: env.CAMSIM_FONT_DIR || undefined,
  };
}
