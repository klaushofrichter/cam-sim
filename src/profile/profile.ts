// A camera model: everything the simulator reports as the model's own, as
// measured on a real camera (reference/<model>/). CAMSIM_MODEL picks one;
// RLC-1224A is the default and answers exactly as before profiles existed.
import type { PushMessage } from '../baichuan/xml';
import type { Settings } from './rlc1224a';
import { RLC1224A } from './rlc1224a';
import { CX820 } from './cx820';
import { E1_OUTDOOR_PRO } from './E1-Outdoor-Pro';
import type { PtzSpec } from '../engine/ptz';
import type { NameFormat } from '../engine/sdcard';
import type { Enc } from './enc';

export const MODELS = ['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'] as const;
export type Model = (typeof MODELS)[number];

type Obj = Record<string, any>;
type Stream = 'sub' | 'main';

export type { EncStream } from './enc';

export interface CameraProfile {
  model: Model;
  // GetDevInfo's fixed fields; firmVer is the default for CAMSIM_FIRMWARE.
  firmware: { model: string; firmVer: string; hardVer: string; buildDay: string; cfgVer: string; detail: string };
  devInfo(name: string, serial: string, firmVer: string): Obj;
  // GetEnc's factory value (the settings' Enc starts as this; SetEnc changes
  // the running one) and its range for action 1 (src/profile/enc.ts).
  enc: Enc;
  encRange: Obj[];
  ability: unknown;
  // Extra keys next to `value` that a Get answers with even for action 0.
  extras: { IrLights?: Obj; WhiteLed?: Obj };
  // GetUser: whether the reply has CurUser.
  getUserCurUser: boolean;
  // GetFtpV20's masks. maskFtpPassword undefined: the password as stored.
  maskFtpUser(user: string): string;
  ftpPasswordMask?: string;
  // SetWhiteLed's accepted modes.
  whiteLedModes: readonly number[];
  factorySettings(name: string): Settings;
  resetDefaults(): Settings;
  // Record file names: the flags field without trigger bits.
  fileFlags: Record<Stream, bigint>;
  // Record file names' format (absent: name version 0A, as the RLC-1224A's).
  nameFormat?: NameFormat;
  // refusesDownload: cmd 8 answers 400 (no body, no chunks) even for a file
  // Search lists, as the E1 Outdoor Pro does (measured 2026-11-02); HTTP
  // Download still serves it.
  baichuan: { authTypes: readonly string[]; loginReplyLines: readonly string[]; pushes: readonly PushMessage[]; refusesDownload?: boolean };
  // Generated and converted media: sub size and frame rate, main frame rate,
  // the default CAMSIM_MAIN_SIZE (WxH).
  // noSar: the sub stream's H.264 VUI has no aspect_ratio_info, as the E1
  // Outdoor Pro's (measured); x264 writes a 1:1 SAR unless told otherwise.
  // ext: the third live stream ("ext", the Reolink app's Balanced) for a
  // model whose GetAbility live ver is 1 (main + ext + sub): its size and
  // frame rate (WxH). GetEnc doesn't list it on the CX820, so it can't be
  // read or changed there; a model without it refuses the ext stream.
  media: { sub: string; subFps: number; mainFps: number; mainSize: string; noSar?: boolean; ext?: { size: string; fps: number } };
  // The RTSP DESCRIBE's SDP (src/rtsp/sdp.ts). sprop false: the video tracks
  // have no fmtp line, so no sprop-parameter-sets (the parameter sets come
  // in band only), as the E1 Outdoor Pro's and the RLC-1224A's (measured
  // 2026-11-02); the CX820 sends them. tool: the session's a=tool line.
  rtsp: { sprop: boolean; tool?: string };
  // flvWithoutRtmp: HTTP(S) FLV works with NetPort.rtmpEnable 0 (the CX820,
  // measured 2026-11-03: RTMP off, port 1935 refused, /flv answering; the E1
  // assumed so). Absent: /flv needs RTMP on, as on the RLC-1224A (measured).
  flvWithoutRtmp?: boolean;
  // Pan/tilt/zoom: set exactly when the ability grants ptzCtrl (ptzEnabled).
  ptz?: PtzSpec;
}

const PROFILES: Record<Model, CameraProfile> = { 'RLC-1224A': RLC1224A, CX820, 'E1-Outdoor-Pro': E1_OUTDOOR_PRO };

export const DEFAULT_MODEL: Model = 'RLC-1224A';

export function profileFor(model: Model | undefined): CameraProfile {
  return PROFILES[model ?? DEFAULT_MODEL];
}
