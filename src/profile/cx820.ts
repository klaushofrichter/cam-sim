// The Reolink CX820 (cam4, "Backyard middle") on firmware
// v3.2.0.5316_2509028854, measured on the real camera on 2026-10-20 with the
// read-only captures in reference/cx820/ (README there). Where the CX820 was
// not measured (anything that needs a Set), it behaves like the RLC-1224A;
// reference/cx820/README.md lists those points.
import ability from './cx820-ability.json';
import {
  AI_TYPES, DEFAULT_NET_PORT, DEFAULT_NTP, IR_LIGHTS_EXTRA, factorySettings as rlcFactory, maskFtpUser as rlcMaskFtpUser,
  resetDefaultsFor, type AiType, type Settings,
} from './rlc1224a';
import { CX820_LOGIN_REPLY_LINES } from '../baichuan/device-info-cx820';
import { RLC_AUTH_TYPES, afterLogin } from '../baichuan/xml';
import type { CameraProfile } from './profile';

export const CX820_FIRMWARE = {
  model: 'CX820',
  firmVer: 'v3.2.0.5316_2509028854',
  hardVer: 'IPC_NT18NA68MP',
  buildDay: 'build 2509028854',
  cfgVer: 'v3.2.0.0',
  detail: 'IPC_NT18NA68MPS40T2C0E1W0110000',
} as const;

// GetDevInfo: the RLC-1224A's keys, with an itemNo.
function devInfo(name: string, serial: string, firmVer: string) {
  const f = CX820_FIRMWARE;
  return {
    B485: 0, IOInputNum: 0, IOOutputNum: 0, audioNum: 1,
    buildDay: f.buildDay, cfgVer: f.cfgVer, channelNum: 1, detail: f.detail,
    diskNum: 1, exactType: 'IPC', firmVer, frameworkVer: 1, hardVer: f.hardVer, itemNo: 'P335X',
    model: f.model, name, pakSuffix: 'pak,paks', serial, type: 'IPC', wifi: 0,
    // As in rlc1224a.ts: the one field a real camera never sends.
    simulator: `cam-sim ${process.env.APP_VERSION || 'dev'}`,
  };
}

// GetEnc: 4K H.265 main at 25 fps, 640x360 H.264 sub, audio off.
const ENC = {
  audio: 0,
  channel: 0,
  mainStream: { bitRate: 6144, frameRate: 25, gop: 2, height: 2160, profile: 'High', size: '3840*2160', vType: 'h265', width: 3840 },
  subStream: { bitRate: 256, frameRate: 10, gop: 4, height: 360, profile: 'High', size: '640*360', vType: 'h264', width: 640 },
};

// GetWhiteLed answers with these next to `value`, even for action 0.
const WHITE_LED_EXTRA = {
  initial: { WhiteLed: { wlAiDetectType: { dog_cat: 0, people: 0, vehicle: 0 } } },
  range: {
    AiDetectType: { dog_cat: 'boolean', people: 'boolean', vehicle: 'boolean' },
    WhiteLed: { bright: { max: 100, min: 0 } },
  },
};

// Motion and AI areas: a 120 x 67 grid (the RLC-1224A's is 70 x 39).
const COLS = 120;
const ROWS = 67;
const AREA = '1'.repeat(COLS * ROWS);

// The camera's values on 2026-10-20 as the factory state, like the
// RLC-1224A profile. Not taken over: the FTP upload (cam-proxy's; off and
// empty here) and NetPort's httpEnable 0 and rtmpEnable 0 (switched off on
// this camera; the simulator's factory ports stay on so clients can use HTTP
// and FLV). The key sets are the measured ones.
function factorySettings(name: string): Settings {
  const s = rlcFactory(name);
  s.Rec.overwrite = 1;
  s.MdAlarm.scope = { cols: COLS, rows: ROWS, table: AREA };
  for (const t of AI_TYPES as readonly AiType[]) {
    s.AiAlarm[t] = { ...s.AiAlarm[t], scope: { area: AREA, cols: COLS, rows: ROWS }, sensitivity: 60, stay_time: 0 };
  }
  // No bd_night, binningMode or corridorMode; day/night "Color".
  s.Isp = {
    antiFlicker: '60HZ', backLight: 'Off',
    bd_day: { bright: 128, dark: 128, mode: 'Auto' },
    bd_led_color: { bright: 128, dark: 128, mode: 'Auto' },
    blc: 128, blueGain: 128, channel: 0, constantFrameRate: 0,
    dayNight: 'Color', dayNightThreshold: 50, drc: 128, encType: 'VBR', exposure: 'Auto',
    gain: { max: 62, min: 1 }, hdr: 0, mirroring: 0, nr3d: 1, redGain: 128, rotation: 0,
    shutter: { max: 125, min: 0 }, whiteBalance: 'Auto',
  };
  // The spotlight: LightAlarm instead of NewLightAlarm, mode 5.
  s.WhiteLed = {
    LightAlarm: { EndHour: 7, EndMin: 0, StartHour: 18, StartMin: 0 },
    LightingSchedule: { EndHour: 6, EndMin: 0, StartHour: 18, StartMin: 0 },
    bright: 100, channel: 0, mode: 5, state: 0,
    wlAiDetectType: { dog_cat: 1, people: 1, vehicle: 1 },
  };
  s.Ftp.picWidth = 3840;
  s.Ftp.picHeight = 2160;
  s.NetPort = { ...DEFAULT_NET_PORT };
  s.Ntp = { ...DEFAULT_NTP };
  return s;
}

// GetFtpV20's user: one character each side for a 4-character name
// (measured: `cam4` -> `c**4`). Longer names as on the RLC-1224A (`ca**ra`),
// shorter ones as they are: not measured on the CX820.
const maskFtpUser = (u: string): string => (u.length === 4 ? `${u[0]}**${u[3]}` : rlcMaskFtpUser(u));

// The unsolicited pushes after a login (login-proxy.txt): the same eight
// cmds as the RLC-1224A, all soon after the login reply, with no wait for a
// client message or the idle close (78/79 about 0.34 s, the rest about 0.70 s
// after it, earlier when the client sends something). FloodlightStatus has
// no brightness.
const PUSHES = [
  afterLogin(78, 340, ['<VideoInput version="1.1">', '<channelId>0</channelId>', '<bright>128</bright>', '<contrast>128</contrast>', '<saturation>128</saturation>', '<hue>128</hue>', '</VideoInput>']),
  afterLogin(79, 340, ['<Serial version="1.1">', '<channelId>0</channelId>', '<baudRate>9600</baudRate>', '<dataBit>CS8</dataBit>', '<stopBit>1</stopBit>', '<parity>none</parity>', '<flowControl>none</flowControl>', '<controlProtocol>PELCO_D</controlProtocol>', '<controlAddress>1</controlAddress>', '</Serial>']),
  afterLogin(464, 700, ['<NetInfo version="1.1">', '<net_type>wire</net_type>', '<signal>100</signal>', '</NetInfo>']),
  afterLogin(547, 700, ['<SirenStatusList version="1.1" />']),
  afterLogin(291, 700, ['<FloodlightStatusList version="1.1">', '<FloodlightStatus>', '<channel>0</channel>', '<status>0</status>', '</FloodlightStatus>', '</FloodlightStatusList>']),
  afterLogin(677, 700, ['<ioStatus version="1.1">', '<statusList>', '<channel>0</channel>', '</statusList>', '</ioStatus>']),
  afterLogin(600, 700, ['<yoloWorldEventList version="1.1" />']),
  afterLogin(669, 700, ['<AiModelList version="1.1">', '<AiModelItem>', '<name>clip</name>', '<version>1</version>', '</AiModelItem>', '</AiModelList>']),
];

export const CX820: CameraProfile = {
  model: 'CX820',
  firmware: CX820_FIRMWARE,
  devInfo,
  enc: ENC,
  ability,
  extras: { IrLights: IR_LIGHTS_EXTRA, WhiteLed: WHITE_LED_EXTRA },
  // GetUser: only the User list.
  getUserCurUser: false,
  maskFtpUser,
  // GetFtpV20 shows a set password as 11 stars (measured with one password;
  // whether the length is fixed is not). A Set that sends the mask back keeps
  // the stored password (not measured: no Set on the real camera).
  ftpPasswordMask: '*'.repeat(11),
  // Mode 5 is the camera's measured value; which other modes it takes is not
  // measured (the RLC-1224A's 0-3 are kept).
  whiteLedModes: [0, 1, 2, 3, 5],
  factorySettings,
  // The partial-Set resets are not measured on the CX820: the RLC-1224A's
  // rules over the CX820's key sets.
  resetDefaults: () => resetDefaultsFor(factorySettings('')),
  // Measured on one motion clip (Search-*.json); the trigger bits are assumed
  // at the RLC-1224A's positions (the motion bit matches).
  fileFlags: { sub: 0x2b148000000000n, main: 0x67328200000000n },
  baichuan: {
    authTypes: ['password', 'sigV1', 'sigV3', ...RLC_AUTH_TYPES.slice(2)],
    loginReplyLines: CX820_LOGIN_REPLY_LINES,
    pushes: PUSHES,
  },
  media: { sub: '640x360', subFps: 10, mainFps: 25, mainSize: '3840x2160' },
};
