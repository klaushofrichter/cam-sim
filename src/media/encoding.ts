// How a live stream is encoded from the prepared media: as prepared (a stream
// copy) while the stream's Enc is the model's factory one, else re-encoded
// at the running Enc's size, frame rate, codec, bit rate, GOP and profile
// (after a SetEnc). The prepared main is 1280x720 whatever GetEnc says
// (src/media/fixtures.ts); a changed main is encoded at its real size, which
// takes a real camera's worth of CPU at 4K.
import type { Engine } from '../engine/engine';
import type { EncStream } from '../profile/enc';

export type Stream = 'sub' | 'main';

const VIDEO_KEYS = ['size', 'frameRate', 'vType', 'bitRate', 'gop', 'profile'] as const;
const H264_PROFILE: Record<string, string> = { Base: 'baseline', Main: 'main', High: 'high' };

export const encStream = (e: Engine, stream: Stream): EncStream => e.settings.running.Enc[stream === 'main' ? 'mainStream' : 'subStream'];

// The SAR filter: the E1's sub stream has no aspect_ratio_info in its VUI
// (measured); setsar=0 makes x264 leave it out.
export const sarFilter = (e: Engine, stream: Stream): string[] => (stream === 'sub' && e.profile.media.noSar ? ['setsar=0'] : []);

export function encodingOf(e: Engine, stream: Stream): { key: string; args: string[] } {
  const s = encStream(e, stream);
  const factory = e.profile.enc[stream === 'main' ? 'mainStream' : 'subStream'];
  const key = JSON.stringify(VIDEO_KEYS.map((k) => s[k]));
  if (VIDEO_KEYS.every((k) => s[k] === factory[k])) return { key, args: ['-c', 'copy'] };
  const h265 = s.vType === 'h265';
  const vf = [`scale=${s.width}:${s.height}`, ...sarFilter(e, stream), `fps=${s.frameRate}`].join(',');
  return {
    key,
    args: [
      '-map', '0:v', '-map', '0:a?', '-vf', vf,
      ...(h265
        ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:repeat-headers=1:bframes=0']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-bf', '0', ...(H264_PROFILE[s.profile] ? ['-profile:v', H264_PROFILE[s.profile]] : [])]),
      '-pix_fmt', 'yuv420p', '-g', String(Math.max(1, s.gop * s.frameRate)), '-b:v', `${s.bitRate}k`, '-c:a', 'copy',
    ],
  };
}
