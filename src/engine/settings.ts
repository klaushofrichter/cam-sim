import type pino from 'pino';
import { factorySettings, resetDefaults, nameRspCode, AI_TYPES, OSD_POSITIONS, type Settings, type AiType } from '../profile/rlc1224a';
import { clone, deepMerge, isObject, readJson, writeJsonAtomic } from '../util/json-file';

// Settings keys added after files were first written (2026-10-05: Ntp).
const ADDED_LATER: Array<keyof Settings> = ['Ntp'];

// Factory settings with every well-formed object of `loaded` laid over them.
// Returns whether anything was missing or malformed.
function overFactory(name: string, loaded: unknown): { settings: Settings; complete: boolean } {
  const settings = factorySettings(name);
  if (!isObject(loaded)) return { settings, complete: false };
  let complete = true;
  for (const key of Object.keys(settings) as Array<keyof Settings>) {
    const v = loaded[key];
    // Keys newer than the file: the factory value, and the file is fine.
    if (v === undefined && ADDED_LATER.includes(key)) continue;
    if (key === 'AiAlarm') {
      for (const t of AI_TYPES) {
        if (isObject(v) && isObject(v[t])) deepMerge(settings.AiAlarm[t], v[t]);
        else complete = false;
      }
    } else if (isObject(v)) deepMerge(settings[key] as Record<string, any>, v);
    else complete = false;
  }
  return { settings, complete };
}

type Key = keyof Settings;

const SET_COMMANDS: Record<string, Key> = {
  SetRecV20: 'Rec',
  SetMdAlarm: 'MdAlarm',
  SetAiAlarm: 'AiAlarm',
  SetIsp: 'Isp',
  SetIrLights: 'IrLights',
  SetWhiteLed: 'WhiteLed',
  SetOsd: 'Osd',
  SetFtpV20: 'Ftp',
  SetNetPort: 'NetPort',
  SetNtp: 'Ntp',
};

export const isSetCommand = (cmd: string): boolean => Object.hasOwn(SET_COMMANDS, cmd);

const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

// Firmware range checks for the keys that were sent: -56 for a bad number,
// -67 for a bad enum value, -4 for FTP's empty server (all measured).
function validate(cmd: string, p: any): number | null {
  if (cmd === 'SetMdAlarm') {
    const s = p?.MdAlarm?.newSens?.sensDef;
    if (s !== undefined && !int(s, 1, 50)) return -56;
  }
  if (cmd === 'SetAiAlarm') {
    const a = p?.AiAlarm ?? {};
    if (!(AI_TYPES as readonly string[]).includes(a.ai_type)) return -67;
    if (a.sensitivity !== undefined && !int(a.sensitivity, 0, 100)) return -56;
  }
  if (cmd === 'SetIsp' && p?.Isp?.dayNight !== undefined && !['Auto', 'Color', 'Black&White'].includes(p.Isp.dayNight)) return -67;
  if (cmd === 'SetIrLights' && !['Auto', 'Off'].includes(p?.IrLights?.state)) return -67;
  if (cmd === 'SetWhiteLed') {
    const w = p?.WhiteLed ?? {};
    if (w.mode !== undefined && ![0, 1, 2, 3].includes(w.mode)) return -67;
    if (w.bright !== undefined && !int(w.bright, 0, 100)) return -56;
    // The manual light: only the numbers 0 and 1 (measured 2026-09-29).
    if (w.state !== undefined && w.state !== 0 && w.state !== 1) return -56;
  }
  if (cmd === 'SetOsd') {
    const o = p?.Osd ?? {};
    for (const part of [o.osdChannel, o.osdTime]) if (part?.pos !== undefined && !OSD_POSITIONS.includes(part.pos)) return -67;
    // The OSD name is the camera's name, with the same rules as SetDevName.
    if (o.osdChannel?.name !== undefined) {
      const r = nameRspCode(o.osdChannel.name);
      if (r !== null) return r;
    }
  }
  if (cmd === 'SetFtpV20' && p?.Ftp?.server === '') return -4;
  return null;
}

// Camera settings with the firmware's write semantics: a Set with a partial
// object answers success and reads back fine (running), but the keys it left
// out are reset in the saved configuration, which the camera loads on its
// next restart (measured 2026-09-26).
export class SettingsStore {
  running: Settings;
  saved: Settings;
  readonly factoryName: string;
  private readonly file?: string;
  private lightTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: { name: string; file?: string; log: pino.Logger }) {
    this.factoryName = opts.name;
    this.file = opts.file;
    let saved = factorySettings(opts.name);
    if (opts.file) {
      try {
        const loaded = readJson(opts.file);
        if (loaded !== undefined) {
          const r = overFactory(opts.name, loaded);
          saved = r.settings;
          if (!r.complete) opts.log.warn({ file: opts.file }, 'settings_file_invalid');
        }
      } catch {
        opts.log.warn({ file: opts.file }, 'settings_file_invalid');
      }
    }
    this.saved = saved;
    this.running = clone(this.saved);
  }

  get(key: Key, sub?: AiType): Record<string, any> {
    const v = key === 'AiAlarm' ? this.running.AiAlarm[sub ?? 'people'] : this.running[key];
    return clone(v);
  }

  set(cmd: string, param: any, opts: { strictPartial: boolean }): { rspCode: number } | null {
    if (!isSetCommand(cmd)) throw new Error(`not a settings command: ${cmd}`);
    const key = SET_COMMANDS[cmd];
    const rsp = validate(cmd, param);
    if (rsp !== null) return { rspCode: rsp };
    const sent = (param?.[key] ?? {}) as Record<string, any>;
    const defaults = resetDefaults();
    const lightWas = this.running.WhiteLed.state;
    if (key === 'AiAlarm') {
      const t = sent.ai_type as AiType;
      this.saved.AiAlarm[t] = deepMerge(defaults.AiAlarm[t], sent);
      this.running.AiAlarm[t] = opts.strictPartial ? clone(this.saved.AiAlarm[t]) : deepMerge(this.running.AiAlarm[t], sent);
    } else {
      const name = this.name;
      this.saved[key] = deepMerge(defaults[key] as Record<string, any>, sent) as any;
      this.running[key] = (opts.strictPartial ? clone(this.saved[key]) : deepMerge(this.running[key] as Record<string, any>, sent)) as any;
      // The OSD name is the camera's name (one value with GetDevName and
      // GetDevInfo.name): a SetOsd without one leaves it as it is. Not
      // measured, but the camera refuses an empty name, so the partial-Set
      // reset can't empty it.
      if (key === 'Osd' && sent.osdChannel?.name === undefined) this.storeName(name);
    }
    if (key === 'WhiteLed') this.lightLate(lightWas);
    this.persist();
    return null;
  }

  // The manual light (WhiteLed.state) switches at once, but GetWhiteLed
  // reports the new state only about 1 s later when it goes on and 3 s when
  // it goes off (measured on cam1 2026-09-30). A newer write replaces a
  // switch still pending.
  private lightLate(was: unknown): void {
    this.cancelLight();
    const want = this.running.WhiteLed.state;
    if (want === was) return;
    this.running.WhiteLed.state = was;
    this.lightTimer = setTimeout(() => {
      this.lightTimer = undefined;
      this.running.WhiteLed.state = want;
    }, want === 1 ? 1000 : 3000);
    this.lightTimer.unref?.();
  }

  private cancelLight(): void {
    clearTimeout(this.lightTimer);
    this.lightTimer = undefined;
  }

  // The camera's name: GetDevName, GetDevInfo.name and the OSD text are one
  // value (measured on cam1 2026-10-03), kept in Osd.osdChannel.name.
  get name(): string {
    return this.running.Osd.osdChannel.name;
  }

  // SetDevName: the camera's rules; a refused name keeps the old one.
  setName(name: unknown): { rspCode: number } | null {
    const rsp = nameRspCode(name);
    if (rsp !== null) return { rspCode: rsp };
    this.storeName(name as string);
    this.persist();
    return null;
  }

  private storeName(name: string): void {
    this.running.Osd.osdChannel.name = name;
    this.saved.Osd.osdChannel.name = name;
  }

  applySavedOnReboot(): void {
    this.cancelLight();
    this.running = clone(this.saved);
  }

  resetFactory(): void {
    this.saved = factorySettings(this.factoryName);
    this.applySavedOnReboot();
    this.persist();
  }

  private persist(): void {
    if (this.file) writeJsonAtomic(this.file, this.saved);
  }
}
