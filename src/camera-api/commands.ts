import type { Request, Response } from 'express';
import type { Engine } from '../engine/engine';
import type { SessionInfo } from '../engine/sessions';
import { isSetCommand } from '../engine/settings';
import { timeValue } from '../engine/clock';
import { validPair } from '../tls/certs';
import { testFtp } from '../ftp/uploader';
import { devInfo, ENC, ABILITY, IR_LIGHTS_EXTRA, AI_TYPES, type AiType } from '../profile/rlc1224a';
import { sleep } from '../util/sleep';

// Error details as the firmware words them (measured where noted).
const DETAIL: Record<number, string> = {
  [-4]: 'param error', // measured (CheckDownload)
  [-6]: 'please login first', // measured
  [-7]: 'login failed',
  [-9]: 'not support', // measured
  [-54]: 'the respode of msg is err', // measured
  [-56]: 'err get data from json', // measured (GetPushV20)
  [-64]: 'err received data from json', // measured (Search, onlyStatus with reversed months)
  [-67]: 'param error',
};

export type Entry = Record<string, unknown>;
export const ok = (cmd: string, value: unknown, extra: Entry = {}): Entry => ({ cmd, code: 0, ...extra, value });
export const fail = (cmd: string, rspCode: number): Entry => ({ cmd, code: 1, error: { detail: DETAIL[rspCode] ?? 'param error', rspCode } });
export const UNKNOWN: Entry = { cmd: 'Unknown', code: 1, error: { detail: 'not support', rspCode: -9 } };

export interface Ctx {
  engine: Engine;
  cmd: string;
  param: any;
  session: SessionInfo;
  token: string;
  req: Request;
  res: Response;
  // Runs right before the reply is sent, once the whole request has been
  // handled. Not 'finish': that event can come after the client has the reply,
  // so a client reading the state straight away would race it.
  beforeReply: (fn: () => void) => void;
}

// A handler returns the reply entry, or 'destroyed' when it dropped the
// connection itself (like the firmware sometimes does).
type Handler = (c: Ctx) => Entry | 'destroyed' | Promise<Entry | 'destroyed'>;

// First two characters, `**`, last two. Names under 5 characters are left
// as they are (the camera's mask for them is not measured).
export const maskFtpUser = (u: string): string => (u.length >= 5 ? `${u.slice(0, 2)}**${u.slice(-2)}` : u);

const getter = (key: string, pick: (e: Engine, p: any) => unknown): Handler => (c) => ok(c.cmd, { [key]: pick(c.engine, c.param) });

const HANDLERS: Record<string, Handler> = {
  Logout: (c) => {
    c.engine.sessions.logout(c.token);
    return ok(c.cmd, { rspCode: 200 });
  },
  GetOnline: (c) => ok(c.cmd, { User: c.engine.sessions.online() }),
  GetUser: (c) => ok(c.cmd, { CurUser: { User: c.session.user.name }, User: c.engine.sessions.users() }),
  AddUser: (c) => {
    const u = c.param?.User ?? {};
    const r = c.engine.sessions.addUser({ name: u.userName, password: u.password, level: u.level });
    return r === null ? ok(c.cmd, { rspCode: 200 }) : fail(c.cmd, r);
  },
  DelUser: (c) => {
    const r = c.engine.sessions.delUser(c.param?.User?.userName);
    return r === null ? ok(c.cmd, { rspCode: 200 }) : fail(c.cmd, r);
  },
  ModifyUser: (c) => {
    const u = c.param?.User ?? {};
    const r = c.engine.sessions.modifyUser(u.userName, { password: u.password ?? u.newPassword, level: u.level });
    return r === null ? ok(c.cmd, { rspCode: 200 }) : fail(c.cmd, r);
  },
  GetDevInfo: (c) => {
    c.engine.counters.devInfoCalls++;
    return ok(c.cmd, { DevInfo: devInfo(c.engine.config.name, c.engine.serial, c.engine.config.firmVer) });
  },
  GetTime: (c) => ok(c.cmd, timeValue(c.engine.clock, c.engine.config.tz)),
  GetHddInfo: getter('HddInfo', (e) => e.sd.hddInfo()),
  GetEnc: getter('Enc', () => ENC),
  GetNetPort: getter('NetPort', (e) => e.settings.get('NetPort')),
  GetAbility: (c) => ok(c.cmd, ABILITY),
  GetRecV20: getter('Rec', (e) => e.settings.get('Rec')),
  GetMdAlarm: getter('MdAlarm', (e) => e.settings.get('MdAlarm')),
  GetAiAlarm: getter('AiAlarm', (e, p) => e.settings.get('AiAlarm', (AI_TYPES as readonly string[]).includes(p?.ai_type) ? (p.ai_type as AiType) : 'people')),
  GetIsp: getter('Isp', (e) => e.settings.get('Isp')),
  GetIrLights: (c) => ok(c.cmd, { IrLights: c.engine.settings.get('IrLights') }, IR_LIGHTS_EXTRA),
  GetWhiteLed: getter('WhiteLed', (e) => e.settings.get('WhiteLed')),
  GetOsd: getter('Osd', (e) => e.settings.get('Osd')),
  // The real camera masks the FTP user in its answer (measured on the Pi,
  // 2026-10-02: `camera` -> `ca**ra`). Set and TestFtp keep the full name.
  GetFtpV20: getter('Ftp', (e) => {
    const ftp = e.settings.get('Ftp');
    return { ...ftp, userName: maskFtpUser(String(ftp.userName ?? '')) };
  }),
  GetMdState: (c) => ok(c.cmd, c.engine.events.mdState()),
  GetAiState: (c) => ok(c.cmd, c.engine.events.aiState()),
  Search: async (c) => {
    const e = c.engine;
    e.counters.searches++;
    // Firmware: a Search overlapping another fails with -54, and the one
    // already running may come back empty.
    if (e.search.busy) {
      e.search.spoiled = true;
      return fail(c.cmd, -54);
    }
    e.search = { busy: true, spoiled: false };
    try {
      await sleep(e.faults.active('search.delayMs')?.ms ?? e.timings.searchMs);
      if (e.search.spoiled) return ok(c.cmd, { SearchResult: { channel: 0 } });
      const s = c.param?.Search ?? {};
      const stream = s.streamType === 'main' ? 'main' : 'sub';
      if (!s.StartTime || !s.EndTime) return fail(c.cmd, -4);
      // Firmware (measured 2026-09-29): Status lists only months with
      // recordings, and empty keys are left out; months in reverse are -64.
      if (s.onlyStatus === 1) {
        const ym = (x: any) => x.year * 12 + x.mon;
        if (ym(s.EndTime) < ym(s.StartTime)) return fail(c.cmd, -64);
        const Status = e.sd.statuses(stream, s.StartTime, s.EndTime);
        return ok(c.cmd, { SearchResult: { channel: 0, ...(Status.length ? { Status } : {}) } });
      }
      const File = e.sd.search(stream, s.StartTime, s.EndTime);
      const Status = e.sd.statuses(stream, s.StartTime, s.StartTime);
      return ok(c.cmd, { SearchResult: { channel: 0, ...(File.length ? { File } : {}), ...(Status.length ? { Status } : {}) } });
    } finally {
      e.search = { busy: false, spoiled: false };
    }
  },
  CheckDownload: (c) => {
    const name = String(c.param?.filename ?? '');
    const known = c.engine.sd.all().some((r) => [r.files.sub.name, r.files.main.name].some((n) => n === name || n.endsWith(`/${name}`)));
    return known ? ok(c.cmd, { downloadTask: c.engine.activeDownloads.size }) : fail(c.cmd, -4);
  },
  TestFtp: async (c) => {
    const r = await testFtp(c.engine, c.param?.Ftp);
    if (r === -454) return { cmd: c.cmd, code: 1, error: { detail: 'ftp connect failed', rspCode: -454 } };
    return r === null ? ok(c.cmd, { rspCode: 200 }) : fail(c.cmd, r);
  },
  GetCertificateInfo: (c) => ok(c.cmd, { CertificateInfo: { crtName: 'server.crt', enable: c.engine.certs.state.enable, keyName: 'server.key' } }),
  CertificateClear: (c) => {
    c.beforeReply(() => c.engine.clearCertificate());
    return ok(c.cmd, { rspCode: 200 });
  },
  ImportCertificate: (c) => {
    const ic = c.param?.importCertificate ?? {};
    const pem = (x: any) => (typeof x?.content === 'string' ? Buffer.from(x.content, 'base64').toString('utf8') : '');
    const cert = pem(ic.crt), key = pem(ic.key);
    // Validate now, apply when the reply goes out (the web server restarts).
    if (c.engine.certs.state.enable === 1) return ok(c.cmd, { rspCode: 200 });
    if (!validPair(cert, key)) return fail(c.cmd, -4);
    c.beforeReply(() => c.engine.importCertificate(cert, key));
    return ok(c.cmd, { rspCode: 200 });
  },
  Reboot: (c) => {
    const e = c.engine;
    const ms = e.rebootDefaults.ms;
    const drops = e.rebootDefaults.dropsConnection ?? e.rng.next() < 0.5;
    // The firmware may go down before answering.
    if (drops) {
      void e.reboot({ ms, dropsConnection: true });
      c.req.socket.destroy();
      return 'destroyed';
    }
    c.res.on('finish', () => void e.reboot({ ms, dropsConnection: false }));
    return ok(c.cmd, { rspCode: 200 });
  },
};

function setCommand(c: Ctx): Entry {
  const e = c.engine;
  e.counters.noteSet(c.cmd);
  const failing = e.faults.consume('settings.fail', c.cmd);
  if (failing) return fail(c.cmd, failing.rspCode ?? -67);
  if (e.faults.consume('settings.ignore', c.cmd)) return ok(c.cmd, { rspCode: 200 });
  const r = e.settings.set(c.cmd, c.param, { strictPartial: !!e.faults.active('settings.strictPartial') });
  if (!r) e.bus.emit('settings', { cmd: c.cmd });
  return r ? fail(c.cmd, r.rspCode) : ok(c.cmd, { rspCode: 200 });
}

export async function runCommand(c: Ctx): Promise<Entry | 'destroyed'> {
  if (Object.hasOwn(HANDLERS, c.cmd)) return HANDLERS[c.cmd](c);
  if (isSetCommand(c.cmd)) return setCommand(c);
  return UNKNOWN;
}
