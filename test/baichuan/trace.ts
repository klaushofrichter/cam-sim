import { readFileSync } from 'fs';
import { join } from 'path';

// Reads reference/rlc-1224a/baichuan/*.txt: one message per line
// ("-> cmd 8 (download) hdr[24]=[f0 de …]"), then its decrypted XML indented
// by four spaces. Lines in parentheses are placeholders and are skipped.
export const TRACE_DIR = join(__dirname, '..', '..', 'reference', 'rlc-1224a', 'baichuan');

export interface TraceMessage {
  dir: 'in' | 'out'; // in: sent by the client (->); out: sent by the camera (<-)
  cmd: number;
  label: string;
  header: Buffer;
  xml: string; // the lines as the camera sent them, each ending in "\n"; '' when none
}

const LINE = /^\s+[\d.]+\s+(->|<-) cmd (\d+)(?: \(([^)]*)\))? hdr\[(\d+)\]=\[([0-9a-f ]+)\]/;

export function readTrace(file: string): TraceMessage[] {
  const out: TraceMessage[] = [];
  let cur: TraceMessage | undefined;
  let xml: string[] = [];
  const flush = () => {
    if (cur) out.push({ ...cur, xml: xml.map((l) => `${l}\n`).join('') });
    cur = undefined;
    xml = [];
  };
  for (const raw of readFileSync(join(TRACE_DIR, file), 'utf8').split('\n')) {
    const m = LINE.exec(raw);
    if (m) {
      flush();
      cur = { dir: m[1] === '<-' ? 'out' : 'in', cmd: Number(m[2]), label: m[3] ?? '', header: Buffer.from(m[5].replace(/ /g, ''), 'hex'), xml: '' };
    } else if (raw.startsWith('    (')) {
      continue;
    } else if (cur && raw.startsWith('    ')) {
      xml.push(raw.slice(4));
    } else {
      flush();
    }
  }
  flush();
  return out;
}
