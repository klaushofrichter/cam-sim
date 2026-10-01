import { localParts } from '../engine/clock';

// What the SD pipeline draws, from the running Osd and Isp settings.
export interface OverlaySettings {
  rotation: number;
  mirroring: number;
  watermark: number;
  name: { enable: number; pos: string };
  time: { enable: number; pos: string };
}

export function overlayOf(s: { Osd: any; Isp: any }): OverlaySettings {
  return {
    rotation: Number(s.Isp?.rotation) === 1 ? 1 : 0,
    mirroring: Number(s.Isp?.mirroring) === 1 ? 1 : 0,
    watermark: Number(s.Osd?.watermark) === 1 ? 1 : 0,
    name: { enable: Number(s.Osd?.osdChannel?.enable) === 1 ? 1 : 0, pos: String(s.Osd?.osdChannel?.pos ?? 'Lower Right') },
    time: { enable: Number(s.Osd?.osdTime?.enable) === 1 ? 1 : 0, pos: String(s.Osd?.osdTime?.pos ?? 'Top Center') },
  };
}

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const p2 = (n: number) => String(n).padStart(2, '0');

// The camera's OSD clock (GetTime timeFmt MM/DD/YYYY, hourFmt 1 = 12 h):
// "09/29/2026 11:51:48 am TUE", in the camera's zone.
export function clockText(at: Date, tz: string, fmt: { timeFmt: string; hourFmt: number }): string {
  const p = localParts({ now: () => at }, tz);
  const date = `${p2(p.mon)}/${p2(p.day)}/${p.year}`;
  const time = fmt.hourFmt === 1
    ? `${p2(p.hour % 12 || 12)}:${p2(p.min)}:${p2(p.sec)} ${p.hour < 12 ? 'am' : 'pm'}`
    : `${p2(p.hour)}:${p2(p.min)}:${p2(p.sec)}`;
  return `${date} ${time} ${DAYS[p.weekday]}`;
}

const MARGIN = 10;
const LINE = 28; // 20 px text plus spacing
const WATERMARK_H = 44; // below the 34 px watermark
// A file path as a filter option value. ffmpeg unescapes it twice: once
// as an option value (\ ' :), then, before that, as part of the filter
// graph (\ ' [ ] , ;). Escaped for the option first, then for the graph.
const q = (s: string) => s.replace(/[\\':]/g, '\\$&').replace(/[\\'[\],;]/g, '\\$&');

function place(pos: string, slot: number, belowWatermark: boolean): string {
  const x = /Left/.test(pos) ? `${MARGIN}` : /Right/.test(pos) ? `w-text_w-${MARGIN}` : '(w-text_w)/2';
  const top = /^(Upper|Top)/.test(pos);
  const y = top ? `${MARGIN + (belowWatermark ? WATERMARK_H : 0) + slot * LINE}` : `h-th-${MARGIN + slot * LINE}`;
  return `x=${x}:y=${y}`;
}

export function filterChain(s: OverlaySettings, files: { clock: string; name: string }, fonts: { regular: string; bold: string }): string {
  const out: string[] = [];
  if (s.rotation) out.push('vflip');
  if (s.mirroring) out.push('hflip');
  if (s.watermark) {
    out.push(`drawtext=fontfile=${q(fonts.bold)}:text='Reolink':fontsize=34:fontcolor=white@0.8:borderw=1:bordercolor=black@0.4:x=${MARGIN}:y=${MARGIN}`);
  }
  const shared = s.name.enable && s.time.enable && s.name.pos === s.time.pos;
  const text = (file: string, pos: string, slot: number) => {
    const under = !!s.watermark && pos === 'Upper Left';
    return `drawtext=fontfile=${q(fonts.regular)}:textfile=${q(file)}:reload=1:expansion=none:fontsize=20:fontcolor=white:borderw=2:bordercolor=black@0.6:${place(pos, slot, under)}`;
  };
  // Shared position: the time above the name (top: time first; bottom: name at the edge).
  const top = /^(Upper|Top)/.test(s.name.pos);
  if (s.time.enable) out.push(text(files.clock, s.time.pos, shared ? (top ? 0 : 1) : 0));
  if (s.name.enable) out.push(text(files.name, s.name.pos, shared ? (top ? 1 : 0) : 0));
  return out.length ? out.join(',') : 'null';
}
