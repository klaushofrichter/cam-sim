// cam-sim#70: media children of an aborted run are found and killed; a running
// simulator's children (node parent) and unrelated processes are left alone.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findOrphans, parsePs, sweepOrphans } from './orphans';

const PS = `
    1     0 /sbin/launchd
  500     1 /opt/homebrew/bin/node --require x vitest/dist/workers/forks.js
  501   500 /repo/tools/mediamtx /tmp/T/camsim-rtsp-aaa/mediamtx.yml
  502   500 ffmpeg -hide_banner -re -i /tmp/f/clip-sub.mp4 -c copy -f rtsp -rtsp_transport tcp rtsp://camsim-publisher:pw@127.0.0.1:5000/h264Preview_01_sub
  601     1 /repo/tools/mediamtx /tmp/T/camsim-rtsp-bbb/mediamtx.yml
  602     1 ffmpeg -hide_banner -re -i x.mp4 -f rtsp rtsp://camsim-publisher:pw@127.0.0.1:5001/h264Preview_01_main
  603   999 ffmpeg -hide_banner -re -i x.mp4 -f rtsp rtsp://camsim-publisher:pw@127.0.0.1:5002/h264Preview_01_sub
  700   650 /lib/systemd/systemd --user
  701   700 mediamtx /tmp/camsim-rtsp-ccc/mediamtx.yml
  800     1 /usr/local/bin/mediamtx /etc/mediamtx.yml
  801     1 ffmpeg -i in.mp4 out.mp4
  802     1 /tmp/camproxy-go2rtc-x/go2rtc -config /tmp/camproxy-go2rtc-x/go2rtc.yaml
`;

describe('orphaned media processes (#70)', () => {
  it('finds cam-sim MediaMTX and publishers whose parent is gone or not node', () => {
    expect(findOrphans(parsePs(PS)).map((p) => p.pid)).toEqual([601, 602, 603, 701]);
  });

  it.skipIf(process.platform === 'win32')('kills a real orphan', async () => {
    // A stand-in "mediamtx": tail following a mediamtx.yml in a camsim-rtsp-
    // folder (a symlink; macOS kills a copied system binary), started in the
    // background by a shell that exits at once: an orphan.
    const dir = mkdtempSync(join(tmpdir(), 'camsim-rtsp-orphan-test-'));
    const bin = join(dir, 'mediamtx');
    symlinkSync(spawnSync('sh', ['-c', 'command -v tail']).stdout.toString().trim(), bin);
    writeFileSync(join(dir, 'mediamtx.yml'), '');
    const pid = Number(spawnSync('sh', ['-c', `"${bin}" -f "${join(dir, 'mediamtx.yml')}" >/dev/null 2>&1 & echo $!`]).stdout.toString().trim());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(alive()).toBe(true);
      expect(sweepOrphans()).toContain(pid);
      await expect.poll(alive).toBe(false);
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
