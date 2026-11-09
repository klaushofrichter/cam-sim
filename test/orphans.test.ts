// cam-sim#70: media children of an aborted run are found and killed; a running
// simulator's children (node parent) and unrelated processes are left alone.
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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
    // A stand-in "mediamtx": a shell script of that name in a camsim-rtsp-
    // folder, given a mediamtx.yml there. (Not a symlink to a system tool:
    // multi-call coreutils, as on newer Ubuntu, refuse to run as "mediamtx".)
    // Its parent is a shell that waits for it, not node: what a killed run
    // leaves behind. (A truly orphaned child is reparented to whatever reaper
    // the platform has, which on a CI runner can be a node process.)
    const dir = mkdtempSync(join(tmpdir(), 'camsim-rtsp-orphan-test-'));
    const bin = join(dir, 'mediamtx');
    writeFileSync(bin, '#!/bin/sh\nwhile :; do sleep 1; done\n', { mode: 0o755 });
    writeFileSync(join(dir, 'mediamtx.yml'), '');
    const shell = spawn('sh', ['-c', `"${bin}" -f "${join(dir, 'mediamtx.yml')}" >/dev/null 2>&1 & echo $!; wait`], { stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = await new Promise<number>((resolve) => shell.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
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
      // The background child may still be the forked shell for a moment
      // before it execs the stand-in: retry until the sweep sees it.
      await expect.poll(() => sweepOrphans(), { timeout: 5000 }).toContain(pid);
      await expect.poll(alive).toBe(false);
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
      shell.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
