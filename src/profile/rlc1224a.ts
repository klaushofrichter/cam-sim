// The Reolink RLC-1224A on firmware v3.2.0.6011_2607012059, as measured on
// the real camera on 2026-09-26 (reference/rlc-1224a/*.json). Values the
// simulator reports as-is live here; other models are their own profile files
// (cx820.ts), selected in profile.ts. The default model.
import ability from './ability.json';
import { FIRMWARE_VERSION } from './version';
import { LOGIN_REPLY_LINES } from '../baichuan/device-info';
import { PUSHES, RLC_AUTH_TYPES } from '../baichuan/xml';
import type { CameraProfile } from './profile';
import { deepMerge } from '../util/json-file';

export const FIRMWARE = {
  model: 'RLC-1224A',
  firmVer: FIRMWARE_VERSION,
  hardVer: 'IPC_NT18NA612MP',
  buildDay: 'build 2607012059',
  cfgVer: 'v3.2.0.0',
  detail: 'IPC_NT18NA612MPS18T2C0E1W011000',
} as const;

export function devInfo(name: string, serial: string, firmVer: string) {
  return {
    B485: 0, IOInputNum: 0, IOOutputNum: 0, audioNum: 1,
    buildDay: FIRMWARE.buildDay, cfgVer: FIRMWARE.cfgVer, channelNum: 1, detail: FIRMWARE.detail,
    diskNum: 1, exactType: 'IPC', firmVer, frameworkVer: 1, hardVer: FIRMWARE.hardVer, itemNo: '',
    model: FIRMWARE.model, name, pakSuffix: 'pak,paks', serial, type: 'IPC', wifi: 0,
    // The one field a real camera never sends: clients such as cams label the
    // camera as simulated (Klaus, 2026-09-28). Everything else stays identical.
    // With the build's version (the container's APP_VERSION), so cams can
    // show which cam-sim it is (cams issue #69).
    simulator: `cam-sim ${process.env.APP_VERSION || 'dev'}`,
  };
}

export const ENC = {
  audio: 1,
  channel: 0,
  mainStream: { bitRate: 8192, frameRate: 20, gop: 2, height: 2512, profile: 'High', size: '4512*2512', vType: 'h265', width: 4512 },
  subStream: { bitRate: 1024, frameRate: 10, gop: 4, height: 512, profile: 'High', size: '896*512', vType: 'h264', width: 896 },
};

export const DEFAULT_NET_PORT = {
  httpEnable: 1, httpPort: 80, httpsEnable: 1, httpsPort: 443, mediaPort: 9000,
  onvifEnable: 1, onvifPort: 8000, rtmpEnable: 1, rtmpPort: 1935, rtspEnable: 1, rtspPort: 554,
};

// GetNtp: not measured on the RLC-1224A yet (cam-proxy P4 measures it on the
// multi-camera host); the Reolink API document's object until then.
export const DEFAULT_NTP = { enable: 1, interval: 1440, port: 123, server: 'pool.ntp.org' };

export const ABILITY = ability;

// GetIrLights answers with these next to `value`, even for action 0.
export const IR_LIGHTS_EXTRA = {
  initial: { IrLights: { state: 'Auto' } },
  range: { IrLights: { state: ['Auto', 'Off'] } },
};

export const OSD_POSITIONS = ['Upper Left', 'Top Center', 'Upper Right', 'Lower Left', 'Bottom Center', 'Lower Right'];

// The camera's name (GetDevName, GetDevInfo.name and the OSD text are one
// value), measured on cam1 2026-10-03: 1–31 characters of ASCII letters,
// digits, space and - ( ) + = [ ] { }, no leading or trailing space. Longer
// than 31 answers -56, anything else (a refused character, a non-ASCII letter,
// the empty name, an outer space) -54. Not measured: a value that isn't a
// string (-56 here, the firmware's "err get data from json"), and which code
// wins when a name is both too long and has a refused character (-56 here).
export const NAME_MAX = 31;
export const NAME_RE = /^[A-Za-z0-9()+=\[\]{}-](?:[A-Za-z0-9 ()+=\[\]{}-]{0,29}[A-Za-z0-9()+=\[\]{}-])?$/;
export function nameRspCode(name: unknown): number | null {
  if (typeof name !== 'string' || Buffer.byteLength(name, 'utf8') > NAME_MAX) return -56;
  return NAME_RE.test(name) ? null : -54;
}
export const AI_TYPES = ['people', 'vehicle', 'dog_cat'] as const;
export type AiType = (typeof AI_TYPES)[number];

type Obj = Record<string, any>;
export interface Settings {
  Rec: Obj;
  MdAlarm: Obj;
  AiAlarm: Record<AiType, Obj>;
  Isp: Obj;
  IrLights: Obj;
  WhiteLed: Obj;
  Osd: Obj;
  Ftp: Obj;
  NetPort: Obj;
  Ntp: Obj;
}

export const ALL = '1'.repeat(168);
const NONE = '0'.repeat(168);
const AREA = '1'.repeat(70 * 39);

// Every schedule table key the firmware returns, in its order.
export function scheduleTable(on: string[]): Record<string, string> {
  const keys = [
    'AI_CROSSLINE_0', 'AI_CROSSLINE_1', 'AI_CROSSLINE_2', 'AI_DOG_CAT',
    'AI_INTRUSION_0', 'AI_INTRUSION_1', 'AI_INTRUSION_2',
    'AI_LEGACY_0', 'AI_LEGACY_1', 'AI_LEGACY_2',
    'AI_LOITERING_0', 'AI_LOITERING_1', 'AI_LOITERING_2',
    'AI_LOSS_0', 'AI_LOSS_1', 'AI_LOSS_2',
    'AI_PEOPLE', 'AI_VEHICLE', 'MD', 'TIMING',
  ];
  return Object.fromEntries(keys.map((k) => [k, on.includes(k) ? ALL : NONE]));
}

export const SENS_SLOTS = [
  [0, 0, 6, 0], [6, 0, 12, 0], [12, 0, 18, 0], [18, 0, 23, 59],
].map(([beginHour, beginMin, endHour, endMin], id) => ({ beginHour, beginMin, endHour, endMin, id }));

function aiAlarm(ai_type: AiType) {
  return {
    ai_type, channel: 0,
    max_target_height: 0, max_target_width: 0, min_target_height: 0, min_target_width: 0,
    scope: { area: AREA, cols: 70, rows: 39 },
    sensitivity: 60, stay_time: 3,
  };
}

// The camera's current values on 2026-09-26, used as the simulator's
// factory state (so a fresh simulator looks like the real Den camera).
export function factorySettings(name: string): Settings {
  const recOn = ['AI_DOG_CAT', 'AI_PEOPLE', 'AI_VEHICLE', 'MD'];
  return {
    Rec: {
      bSmartRec: 0, enable: 1, overwrite: 0, packTime: '', postRec: '15 Seconds', preRec: 1, saveDay: 7,
      schedule: { channel: 0, table: scheduleTable(recOn) },
    },
    MdAlarm: {
      channel: 0,
      newSens: { sens: SENS_SLOTS.map((s) => ({ ...s, enable: 0, priority: 0, sensitivity: 10 })), sensDef: 10 },
      scope: { cols: 70, rows: 39, table: AREA },
      sens: SENS_SLOTS.map((s) => ({ ...s, sensitivity: 10 })),
      useNewSens: 1,
    },
    AiAlarm: { people: aiAlarm('people'), vehicle: aiAlarm('vehicle'), dog_cat: aiAlarm('dog_cat') },
    Isp: {
      antiFlicker: '60HZ', backLight: 'Off',
      bd_day: { bright: 128, dark: 128, mode: 'Auto' },
      bd_led_color: { bright: 128, dark: 128, mode: 'Auto' },
      bd_night: { bright: 128, dark: 128, mode: 'Auto' },
      binningMode: 1, blc: 128, blueGain: 128, channel: 0, constantFrameRate: 0, corridorMode: 0,
      dayNight: 'Auto', dayNightThreshold: 50, drc: 128, encType: 'VBR', exposure: 'Auto',
      gain: { max: 62, min: 1 }, hdr: 0, mirroring: 0, nr3d: 1, redGain: 128, rotation: 0,
      shutter: { max: 125, min: 0 }, whiteBalance: 'Auto',
    },
    IrLights: { state: 'Auto' },
    WhiteLed: {
      LightingSchedule: { EndHour: 6, EndMin: 0, StartHour: 18, StartMin: 0 },
      NewLightAlarm: { enable: 0, lightAlarmBright: 100, lightMode: 1 },
      bright: 100, channel: 0, mode: 1, state: 0,
      wlAiDetectType: { dog_cat: 1, people: 1, vehicle: 1 },
    },
    Osd: {
      bgcolor: 0, channel: 0,
      osdChannel: { enable: 1, name, pos: 'Lower Right' },
      osdTime: { enable: 1, pos: 'Top Center' },
      watermark: 1,
    },
    Ftp: {
      anonymous: 0, autoDir: 1, bpicSingle: 0, bvideoSingle: 0, enable: 0, interval: 15, maxSize: 100,
      mode: 0, onlyFtps: 1, password: '', picCaptureMode: 0, picHeight: 2512, picInterval: 60, picName: '',
      picWidth: 4512, port: 21, remoteDir: '',
      schedule: { channel: 0, table: scheduleTable(recOn) },
      server: '', streamType: 0, userName: '', videoName: '',
    },
    NetPort: { ...DEFAULT_NET_PORT },
    Ntp: { ...DEFAULT_NTP },
  };
}

// Zero values of the same shape: numbers 0, strings '', 0/1 bitmaps all '0'.
function zeroed(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(zeroed);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, zeroed(v)]));
  if (typeof o === 'number') return 0;
  if (typeof o === 'string') return /^[01]{24,}$/.test(o) ? '0'.repeat(o.length) : '';
  return o;
}

// What a partial Set leaves in the keys it omits. Measured 2026-09-26 (a
// partial SetIsp turned rotation 0 -> 1, a partial SetOsd watermark 1 -> 0,
// a partial SetAiAlarm stay_time 3 -> 0), plus the values cams' mock camera
// used for the other keys it modelled. Everything else: the zero value.
export function resetDefaults(): Settings {
  return resetDefaultsFor(factorySettings(''));
}

// The same rules over another model's factory settings (its key sets).
export function resetDefaultsFor(factory: Settings): Settings {
  const z = zeroed(factory) as Settings;
  deepMerge(z.Rec, { postRec: '1 Minute', saveDay: 30 });
  deepMerge(z.MdAlarm, { newSens: { sensDef: 25 } });
  for (const t of AI_TYPES) deepMerge(z.AiAlarm[t], { ai_type: t, sensitivity: 50, stay_time: 0 });
  deepMerge(z.Isp, { dayNight: 'Auto', antiFlicker: 'Off', rotation: 1, mirroring: 1 });
  deepMerge(z.IrLights, { state: 'Auto' });
  deepMerge(z.Osd, { osdChannel: { pos: 'Upper Left' }, osdTime: { pos: 'Upper Left' } });
  // Not measured, and zero values would switch every port off after a
  // reboot, leaving no way back in: keep the factory ports.
  z.NetPort = { ...DEFAULT_NET_PORT };
  return z;
}

// GetFtpV20's user: first two characters, `**`, last two (measured on the Pi,
// 2026-10-02: `camera` -> `ca**ra`). Names under 5 characters are left as
// they are (the RLC-1224A's mask for them is not measured).
export const maskFtpUser = (u: string): string => (u.length >= 5 ? `${u.slice(0, 2)}**${u.slice(-2)}` : u);

// Flags of a real clip without trigger bits.
export const FILE_FLAGS = { sub: 0x55148000000000n, main: 0x7b288200000000n };

export const RLC1224A: CameraProfile = {
  model: 'RLC-1224A',
  firmware: FIRMWARE,
  devInfo,
  enc: ENC,
  ability: ABILITY,
  extras: { IrLights: IR_LIGHTS_EXTRA },
  getUserCurUser: true,
  maskFtpUser,
  whiteLedModes: [0, 1, 2, 3],
  factorySettings,
  resetDefaults,
  fileFlags: FILE_FLAGS,
  baichuan: { authTypes: RLC_AUTH_TYPES, loginReplyLines: LOGIN_REPLY_LINES, pushes: PUSHES },
  media: { sub: '896x512', subFps: 10, mainFps: 20, mainSize: '4512x2512' },
};
