// The Reolink E1 Outdoor Pro, a pan/tilt/zoom camera, on firmware
// v3.1.0.5714_2511271366, from the captures of 2026-10-30 in
// reference/E1-Outdoor-Pro/ (README there): a read-only probe plus a PTZ
// measurement.
//
// Taken from the captures: DevInfo (exactType WIFI_SOLO_IPC, wifi 1, itemNo
// E560), Enc, Ability, the IrLights and WhiteLed extras, the factory Isp,
// WhiteLed, IrLights and Osd, the MdAlarm grid (60 x 33), and the PTZ answers
// (e1-ptz.json).
//
// The CX820's (not measured on the E1): the AiAlarm values (grid 60 x 33,
// like MdAlarm), GetUser without CurUser, the FTP masks, the WhiteLed modes,
// Rec overwrite 1, the record file flags, and the Baichuan auth types, login
// reply and pushes. The PTZ movement model below is the simulator's own where
// the camera was not measured (README, "Not measured").
import ability from './e1-ability.json';
import ptzAnswers from './e1-ptz.json';
import { CX820 } from './cx820';
import { IR_LIGHTS_EXTRA, devInfoFor, resetDefaultsFor, type Settings } from './rlc1224a';
import type { CameraProfile } from './profile';
import type { PtzSpec } from '../engine/ptz';

export const E1_FIRMWARE = {
  model: 'E1 Outdoor Pro',
  firmVer: 'v3.1.0.5714_2511271366',
  hardVer: 'IPC_560SD88MPW',
  buildDay: 'build 2511271366',
  cfgVer: 'v3.1.0.0',
  detail: 'IPC_560SD88MPWS38A9T460E1W13110',
} as const;

// GetDevInfo: the RLC-1224A's keys; a Wi-Fi camera.
const devInfo = devInfoFor(E1_FIRMWARE, 'E560', { exactType: 'WIFI_SOLO_IPC', wifi: 1 });

// GetEnc: 4K H.265 main at 20 fps, 640x360 H.264 sub, audio on.
const ENC = {
  audio: 1,
  channel: 0,
  mainStream: { bitRate: 4096, frameRate: 20, gop: 2, height: 2160, profile: 'High', size: '3840*2160', vType: 'h265', width: 3840 },
  subStream: { bitRate: 256, frameRate: 10, gop: 4, height: 360, profile: 'High', size: '640*360', vType: 'h264', width: 640 },
};

// GetWhiteLed answers with these next to `value`, even for action 0 (like the
// CX820; the initial detection types are all on here).
const WHITE_LED_EXTRA = {
  initial: { WhiteLed: { wlAiDetectType: { dog_cat: 1, people: 1, vehicle: 1 } } },
  range: {
    AiDetectType: { dog_cat: 'boolean', people: 'boolean', vehicle: 'boolean' },
    WhiteLed: { bright: { max: 100, min: 0 } },
  },
};

// Motion and AI areas: a 60 x 33 grid (measured for MdAlarm).
const COLS = 60;
const ROWS = 33;
const AREA = '1'.repeat(COLS * ROWS);

// The camera's values on 2026-10-30 as the factory state, over the CX820's
// for what was not captured.
function factorySettings(name: string): Settings {
  const s = CX820.factorySettings(name);
  s.MdAlarm.scope = { cols: COLS, rows: ROWS, table: AREA };
  for (const t of ['people', 'vehicle', 'dog_cat'] as const) s.AiAlarm[t].scope = { area: AREA, cols: COLS, rows: ROWS }; // (not measured)
  // With bd_night, CBR, day/night Auto; no binningMode or corridorMode.
  s.Isp = {
    antiFlicker: '60HZ', backLight: 'Off',
    bd_day: { bright: 128, dark: 128, mode: 'Auto' },
    bd_led_color: { bright: 128, dark: 128, mode: 'Auto' },
    bd_night: { bright: 128, dark: 128, mode: 'Auto' },
    blc: 128, blueGain: 128, channel: 0, constantFrameRate: 0,
    dayNight: 'Auto', dayNightThreshold: 50, drc: 128, encType: 'CBR', exposure: 'Auto',
    gain: { max: 62, min: 1 }, hdr: 0, mirroring: 0, nr3d: 1, redGain: 128, rotation: 0,
    shutter: { max: 125, min: 0 }, whiteBalance: 'Auto',
  };
  // No LightAlarm or NewLightAlarm; mode 1, bright 85.
  s.WhiteLed = {
    LightingSchedule: { EndHour: 6, EndMin: 0, StartHour: 18, StartMin: 0 },
    bright: 85, channel: 0, mode: 1, state: 0,
    wlAiDetectType: { dog_cat: 1, people: 1, vehicle: 1 },
  };
  return s;
}

// Pan/tilt/zoom. Measured: zoom 0-27 and focus 0-97 starting at 7 and 49,
// speed 1-64, 64 preset slots (ids 0-63), names up to 31 characters, speed 32
// ZoomInc for 1.5 s takes zoom 7 -> 26. The simulator's own (not measured):
// pan 0-355 and tilt 0-50 degrees starting at 180/25, the rates, and the
// default speed 32. Autofocus: focus follows zoom on focusTrack, through the
// measured points zoom 7 -> 49, 20 -> ~77 (after ToPos) and 26 -> 81 (after
// ZoomInc); the ends (zoom 0 -> 34, 27 -> 82) are extrapolated (not measured
// exactly).
const PTZ: PtzSpec = {
  pan: [0, 355], tilt: [0, 50], zoom: [0, 27], focus: [0, 97],
  start: { pan: 180, tilt: 25, zoom: 7, focus: 49 },
  slots: 64, nameMax: 31, speed: [1, 64], defaultSpeed: 32,
  rate: { panTilt: 1.5, zoom: 0.4, focus: 0.4 },
  focusTrack: [[0, 34], [7, 49], [20, 77], [26, 81], [27, 82]],
  answers: ptzAnswers.answers,
  zoomFocusRange: ptzAnswers.zoomFocusRange,
  presetRange: ptzAnswers.presetRange,
  refusals: ptzAnswers.refusals,
};

export const E1_OUTDOOR_PRO: CameraProfile = {
  ...CX820,
  model: 'E1-Outdoor-Pro',
  firmware: E1_FIRMWARE,
  devInfo,
  enc: ENC,
  ability,
  extras: { IrLights: IR_LIGHTS_EXTRA, WhiteLed: WHITE_LED_EXTRA },
  factorySettings,
  resetDefaults: () => resetDefaultsFor(factorySettings('')),
  media: { sub: '640x360', subFps: 10, mainFps: 20, mainSize: '3840x2160' },
  ptz: PTZ,
};
