import type { Request, Response } from 'express';
import type { Engine } from '../engine/engine';
import type { SessionInfo } from '../engine/sessions';
import { isSetCommand } from '../engine/settings';
import { timeValue } from '../engine/clock';
import { validPair } from '../tls/certs';
import { testFtp } from '../ftp/uploader';
import { NAME_MAX, AI_TYPES } from '../profile/rlc1224a';
import { sleep } from '../util/sleep';
import { isOneOf } from '../util/one-of';
import { ptzHandler } from './ptz-commands';

// Error details as the firmware words them (measured where noted).
const DETAIL: Record<number, string> = {
  [-1]: 'not exist', // measured (GetPtzCurPos on the E1)
  [-4]: 'param error', // measured (CheckDownload)
  [-6]: 'please login first', // measured
  [-7]: 'login failed',
  [-9]: 'not support', // measured
  [-12]: 'get config failed', // measured (GetPtzTattern on the E1)
  [-13]: 'set config failed', // measured (PtzCtrl zoom while zooming on the E1)
  [-54]: 'the respode of msg is err', // measured
  [-56]: 'err get data from json', // measured (GetPushV20)
  [-64]: 'err received data from json', // measured (Search, onlyStatus with reversed months)
  [-67]: 'param error',
  [-454]: 'ftp connect failed',
};

export type Entry = Record<string, unknown>;
export const ok = (cmd: string, value: unknown, extra: Entry = {}): Entry => ({ cmd, code: 0, ...extra, value });
export const fail = (cmd: string, rspCode: number): Entry => ({ cmd, code: 1, error: { detail: DETAIL[rspCode] ?? 'param error', rspCode } });
const UNKNOWN: Entry = { cmd: 'Unknown', code: 1, error: { detail: 'not support', rspCode: -9 } };

export interface Ctx {
  engine: Engine;
  cmd: string;
  action?: number;
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
export type Handler = (c: Ctx) => Entry | 'destroyed' | Promise<Entry | 'destroyed'>;

const getter = (key: string, pick: (e: Engine, p: any) => unknown): Handler => (c) => ok(c.cmd, { [key]: pick(c.engine, c.param) });

const HANDLERS: Record<string, Handler> = {
  Logout: (c) => {
    c.engine.sessions.logout(c.token);
    return ok(c.cmd, { rspCode: 200 });
  },
  GetOnline: (c) => ok(c.cmd, { User: c.engine.sessions.online() }),
  // The CX820 answers without CurUser (measured 2026-10-20).
  GetUser: (c) => ok(c.cmd, c.engine.profile.getUserCurUser
    ? { CurUser: { User: c.session.user.name }, User: c.engine.sessions.users() }
    : { User: c.engine.sessions.users() }),
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
    return ok(c.cmd, { DevInfo: c.engine.profile.devInfo(c.engine.settings.name, c.engine.serial, c.engine.config.firmVer) });
  },
  // The camera's name, one value with GetDevInfo.name and the OSD text
  // (measured 2026-10-03). action 1 adds the initial value and the range the
  // camera reports (minLen 0, though it refuses an empty name). The initial
  // value is the simulator's factory name (CAMSIM_NAME; cam1's not measured).
  GetDevName: (c) => {
    const value = { DevName: { name: c.engine.settings.name } };
    if (c.action !== 1) return ok(c.cmd, value);
    return ok(c.cmd, value, {
      initial: { DevName: { name: c.engine.settings.factoryName } },
      range: { DevName: { name: { maxLen: NAME_MAX, minLen: 0 } } },
    });
  },
  GetTime: (c) => ok(c.cmd, timeValue(c.engine.clock, c.engine.config.tz)),
  GetHddInfo: getter('HddInfo', (e) => e.sd.hddInfo()),
  GetEnc: getter('Enc', (e) => e.profile.enc),
  GetNetPort: getter('NetPort', (e) => e.settings.get('NetPort')),
  GetNtp: getter('Ntp', (e) => e.settings.get('Ntp')),
  GetAbility: (c) => ok(c.cmd, c.engine.profile.ability),
  GetRecV20: getter('Rec', (e) => e.settings.get('Rec')),
  GetMdAlarm: getter('MdAlarm', (e) => e.settings.get('MdAlarm')),
  GetAiAlarm: getter('AiAlarm', (e, p) => e.settings.get('AiAlarm', isOneOf(AI_TYPES, p?.ai_type) ? p.ai_type : 'people')),
  GetIsp: getter('Isp', (e) => e.settings.get('Isp')),
  GetIrLights: (c) => ok(c.cmd, { IrLights: c.engine.settings.get('IrLights') }, c.engine.profile.extras.IrLights),
  // The CX820 adds initial and range (measured); the RLC-1224A does not.
  GetWhiteLed: (c) => ok(c.cmd, { WhiteLed: c.engine.settings.get('WhiteLed') }, c.engine.profile.extras.WhiteLed),
  GetOsd: getter('Osd', (e) => e.settings.get('Osd')),
  // The real camera masks the FTP user in its answer (the model's mask:
  // `camera` -> `ca**ra`, on the CX820 `cam4` -> `c**4`), and the CX820 the
  // password too. Set and TestFtp keep the full values.
  GetFtpV20: getter('Ftp', (e) => {
    const ftp = e.settings.get('Ftp');
    const mask = e.profile.ftpPasswordMask;
    return {
      ...ftp,
      ...(mask !== undefined && ftp.password ? { password: mask } : {}),
      userName: e.profile.maskFtpUser(String(ftp.userName ?? '')),
    };
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
    return c.engine.sd.knows(name) ? ok(c.cmd, { downloadTask: c.engine.activeDownloads.size }) : fail(c.cmd, -4);
  },
  TestFtp: async (c) => {
    const r = await testFtp(c.engine, c.param?.Ftp);
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
    // Over an installed certificate the firmware answers 200 and changes
    // nothing (measured); the fault does the same on any certificate.
    if (c.engine.faults.consume('cert.ignoreImport')) return ok(c.cmd, { rspCode: 200 });
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
  const r = c.cmd === 'SetDevName'
    ? e.settings.setName(c.param?.DevName?.name)
    : e.settings.set(c.cmd, c.param, { strictPartial: !!e.faults.active('settings.strictPartial') });
  if (!r) e.bus.emit('settings', { cmd: c.cmd });
  return r ? fail(c.cmd, r.rspCode) : ok(c.cmd, { rspCode: 200 });
}

export function runCommand(c: Ctx): Entry | 'destroyed' | Promise<Entry | 'destroyed'> {
  // PTZ models only: the fixed models answer these as unknown, as before.
  const ptz = c.engine.ptz ? ptzHandler(c) : undefined;
  if (ptz) return ptz(c);
  if (Object.hasOwn(HANDLERS, c.cmd)) return HANDLERS[c.cmd](c);
  if (isSetCommand(c.cmd) || c.cmd === 'SetDevName') return setCommand(c);
  return UNKNOWN;
}
