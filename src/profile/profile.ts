// A camera model: everything the simulator reports as the model's own, as
// measured on a real camera (reference/<model>/). CAMSIM_MODEL picks one;
// RLC-1224A is the default and answers exactly as before profiles existed.
import type { PushMessage } from '../baichuan/xml';
import type { Settings } from './rlc1224a';
import { RLC1224A } from './rlc1224a';
import { CX820 } from './cx820';
import { E1_OUTDOOR_PRO } from './E1-Outdoor-Pro';
import type { PtzSpec } from '../engine/ptz';

export const MODELS = ['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'] as const;
export type Model = (typeof MODELS)[number];

type Obj = Record<string, any>;
type Stream = 'sub' | 'main';

export interface EncStream {
  bitRate: number;
  frameRate: number;
  gop: number;
  height: number;
  profile: string;
  size: string;
  vType: string;
  width: number;
}

export interface CameraProfile {
  model: Model;
  // GetDevInfo's fixed fields; firmVer is the default for CAMSIM_FIRMWARE.
  firmware: { model: string; firmVer: string; hardVer: string; buildDay: string; cfgVer: string; detail: string };
  devInfo(name: string, serial: string, firmVer: string): Obj;
  enc: { audio: number; channel: number; mainStream: EncStream; subStream: EncStream };
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
  baichuan: { authTypes: readonly string[]; loginReplyLines: readonly string[]; pushes: readonly PushMessage[] };
  // Generated and converted media: sub size and frame rate, main frame rate,
  // the default CAMSIM_MAIN_SIZE (WxH).
  media: { sub: string; subFps: number; mainFps: number; mainSize: string };
  // Pan/tilt/zoom: set exactly when the ability grants ptzCtrl (ptzEnabled).
  ptz?: PtzSpec;
}

const PROFILES: Record<Model, CameraProfile> = { 'RLC-1224A': RLC1224A, CX820, 'E1-Outdoor-Pro': E1_OUTDOOR_PRO };

export const DEFAULT_MODEL: Model = 'RLC-1224A';

export function profileFor(model: Model | undefined): CameraProfile {
  return PROFILES[model ?? DEFAULT_MODEL];
}
