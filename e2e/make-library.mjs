// A small library folder for the e2e simulator: two generated videos (no
// captured content), made once.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = process.env.CAMSIM_LIBRARY_DIR || join(tmpdir(), 'cam-sim-e2e-library');
mkdirSync(dir, { recursive: true });
for (const [name, hue] of [['Yard.mp4', 120], ['Lane.mp4', 200]]) {
  const file = join(dir, name);
  if (existsSync(file)) continue;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-t', '4',
    '-vf', `hue=h=${hue}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', `${file}.tmp.mp4`]);
  execFileSync('mv', [`${file}.tmp.mp4`, file]);
}
