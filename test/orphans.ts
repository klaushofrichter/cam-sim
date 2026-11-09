// Media child processes left behind by an aborted test run (cam-sim#70): a
// killed vitest worker or a Ctrl-C ends the simulator without its cleanup, and
// its MediaMTX (config in $TMPDIR/camsim-rtsp-*) and ffmpeg publishers (to
// rtsp://camsim-publisher:…) keep running. They are orphans once their parent
// is gone (reparented to pid 1 or a subreaper, which isn't node). A running
// simulator's children have a node parent and are left alone.
import { execFileSync } from 'child_process';

export interface Proc {
  pid: number;
  ppid: number;
  command: string;
}

const OURS = [/(^|\/)mediamtx\s.*camsim-rtsp-/, /ffmpeg\s.*rtsp:\/\/camsim-publisher:/];

export function parsePs(out: string): Proc[] {
  return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

export function findOrphans(procs: Proc[]): Proc[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return procs.filter((p) => {
    if (!OURS.some((re) => re.test(p.command))) return false;
    const parent = byPid.get(p.ppid);
    return !parent || !/(^|\/)node[\d.]*$/.test(parent.command.split(' ')[0]);
  });
}

// Kills the orphans; returns their pids. No-op where `ps` isn't there.
export function sweepOrphans(): number[] {
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return [];
  }
  const killed: number[] = [];
  for (const p of findOrphans(parsePs(out))) {
    try {
      process.kill(p.pid, 'SIGKILL');
      killed.push(p.pid);
    } catch {
      // gone already, or not ours to kill
    }
  }
  return killed;
}
