// The PTZ position drawn on a snapshot: one ffmpeg run, a JPEG in on stdin,
// a JPEG out on stdout, in the live SD text's style (overlay.ts).
import { spawn } from 'child_process';
import { ptzDrawtext } from './overlay';

export function drawTextOnJpeg(jpeg: Buffer, text: string, font: string, ffmpeg = 'ffmpeg'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-vf', ptzDrawtext(font, { text }),
      '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1',
    ];
    const p = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      p.kill('SIGKILL');
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('ffmpeg timed out')), 15_000);
    timer.unref?.();
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-500)));
    p.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      const jpeg = Buffer.concat(out);
      if (code === 0 && jpeg.length > 0) {
        settled = true;
        resolve(jpeg);
      } else fail(new Error(`ffmpeg exited ${code}: ${err.trim()}`));
    });
    // A dead ffmpeg closes stdin early: its error is reported above.
    p.stdin.on('error', () => {});
    p.stdin.end(jpeg);
  });
}
