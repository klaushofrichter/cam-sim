// A small library folder for the e2e simulator: one generated video (no
// captured content), made once.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = process.env.CAMSIM_LIBRARY_DIR || join(tmpdir(), 'cam-sim-e2e-library');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'Yard.mp4');
if (!existsSync(file)) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-t', '4',
    '-vf', 'hue=h=120', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', `${file}.tmp.mp4`]);
  execFileSync('mv', [`${file}.tmp.mp4`, file]);
}
