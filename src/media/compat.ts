import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { h265NalType, splitAnnexB } from './flv';

const run = promisify(execFile);

// The first frame as Annex B, with the parameter sets in front of it.
async function firstFrame(file: string, codec: 'hevc' | 'h264'): Promise<Buffer[]> {
  const { stdout } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-c', 'copy', '-bsf:v', `${codec}_mp4toannexb`, '-f', codec, '-'],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  return splitAnnexB(stdout);
}

// A missing parameter set fails the video's preparation: an empty stand-in
// would give every such video the same key.
const firstOfType = (nalus: Buffer[], type: (n: Buffer) => number, want: number, what: string): Buffer => {
  const n = nalus.find((x) => type(x) === want);
  if (!n) throw new Error(`no ${what} in the first frame`);
  return n;
};

async function audioFormat(file: string): Promise<string> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', file]);
  const s = JSON.parse(stdout).streams?.[0];
  return s ? `${s.codec_name}/${s.sample_rate}/${s.channels}` : 'none';
}

// Videos whose keys are equal can be played one after another in live view:
// same H.265 VPS/SPS/PPS (main), same H.264 SPS/PPS (sub), same audio format.
export async function compatKey(mainMp4: string, subMp4: string): Promise<string> {
  const [main, sub, audio] = await Promise.all([firstFrame(mainMp4, 'hevc'), firstFrame(subMp4, 'h264'), audioFormat(mainMp4)]);
  const h265 = (t: number) => firstOfType(main, h265NalType, t, `H.265 NAL type ${t} (main)`);
  const h264 = (t: number) => firstOfType(sub, (n) => n[0] & 0x1f, t, `H.264 NAL type ${t} (sub)`);
  const h = createHash('sha256');
  for (const part of [h265(32), h265(33), h265(34), h264(7), h264(8), Buffer.from(audio)]) {
    h.update(String(part.length)).update(':').update(part);
  }
  return h.digest('hex').slice(0, 16);
}
