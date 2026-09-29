# SD Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional, time-limited pipeline that re-encodes cam-sim's live SD (sub) stream with the camera's OSD name, date and time, watermark, and flip/mirror, served on FLV `channel0_sub` and RTSP `h264Preview_01_sub`.

**Architecture:**
- One ffmpeg per camera, while the switch is on and the camera is serving. It reads the current video's `clip-sub.mp4` in real time, applies a filter chain built from the running settings, and encodes H.264.
- It tees to MediaMTX (RTSP sub, replacing the stream-copy publisher) and to stdout as FLV.
- A streaming FLV parser feeds a `LiveSubSource` that FLV clients subscribe to.
- The engine holds the switch (on, until, error) with an auto-off timer. An `SdPipeline` controller follows it and the camera's state.

**Tech Stack:** Node 26, TypeScript, Express 5, ffmpeg (`drawtext`, libx264), MediaMTX, Vitest, Svelte 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-29-sd-pipeline-design.md`

## Global Constraints

- SD only: 896×512 at 10 fps, H.264, `-g 40 -bf 0`, about 1 Mb/s, AAC audio copied. The main stream is never touched.
- Live only: FLV `channel0_sub` (camera port and `/sim/api/media/live/sub`) and RTSP `h264Preview_01_sub`. Snap, recordings, Download and FTP are unchanged.
- Effects: `Isp.rotation` → `vflip`, `Isp.mirroring` → `hflip`, applied before any text. Then `Osd.watermark`, `Osd.osdChannel` (enable, name, pos) and `Osd.osdTime` (enable, pos).
- Clock format: `timeFmt` `MM/DD/YYYY`, `hourFmt` 1 → `09/29/2026 11:51:48 am TUE` in `CAMSIM_TZ`; `hourFmt` 0 → 24 h, no am/pm.
- Switch:
  - `POST /sim/api/pipeline {"minutes": 1..CAMSIM_PIPELINE_MAX_MIN}`; the default is 60, and anything else answers 400 `{"error":"invalid"}`. It answers 200 with the pipeline state. `DELETE` answers 204.
  - It is never persisted: it is off after a restart and after `POST /sim/api/reset`.
- `CAMSIM_PIPELINE_MAX_MIN`: default 1440, range 1–1440. `CAMSIM_FONT_DIR`: optional.
- Failures: an unexpected exit restarts once after 1 s. A second failure within 60 s switches off, with `error` set to the last stderr line with paths removed.
- Off means byte-for-byte today's behaviour, and no extra ffmpeg.
- Docker: `apk add font-dejavu`.

## Review Focus

1. **A camera name with `%`, `{`, `:`, quotes, backslashes or non-ASCII** must render literally and never break the filter graph. Names go through a text file with `expansion=none`. Pinned in Task 2.
2. **A burst of settings writes** (cams saves Isp and Osd together) must cause one restart, not a storm. Restarts are debounced by 500 ms. Pinned in Task 5.
3. **Pipeline on while the camera is powered off, rebooting or offline:** the process must not run, and must resume by itself afterwards if time is left. Pinned in Task 5.
4. **An FLV client connected across off→on→off transitions:** it keeps receiving, its timestamps only rise, and it starts each live section at a keyframe. Pinned in Task 6.
5. **The clock across a DST change** (the repeated hour) must show the camera's local time. Pinned in Task 2.

---

## File structure

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | `pipelineMaxMin`, `fontDir` |
| `src/pipeline/fonts.ts` (create) | Find a regular and a bold TTF: `CAMSIM_FONT_DIR`, then Alpine, Debian/Ubuntu and macOS paths |
| `src/pipeline/overlay.ts` (create) | Pure: `clockText()` and `filterChain()` from settings |
| `src/media/flv-stream.ts` (create) | `FlvStreamParser`: incremental FLV parsing of an ffmpeg stdout |
| `src/pipeline/sd-pipeline.ts` (create) | `SdPipeline`: the ffmpeg process, clock and name files, `LiveSubSource` fan-out, restarts, failure policy, following engine state |
| `src/engine/engine.ts` (modify) | The switch: `pipeline`, `pipelineOn()`, `pipelineOff()`, `pipelineState()`, bus `pipeline`, `liveSub` |
| `src/camera-api/media-routes.ts` (modify) | `streamFlv` serves `liveSub` for sub while it's active |
| `src/rtsp/rtsp.ts` (modify) | `setSubSource('copy' \| 'pipeline')`, `publisherUrl('sub')` |
| `src/index.ts` (modify) | Create and wire `SdPipeline` in `createCamSim` |
| `src/control-api/app.ts`, `src/control-api/sse.ts` (modify) | `/pipeline` routes; the SSE topic |
| `web/src/lib/state.ts`, `web/src/pages/Simulator.svelte` (modify) | The SD pipeline card |
| `Dockerfile`, `scripts/container-smoke.sh`, `.github/workflows/pr-checks.yml` (modify) | Fonts; the smoke check; CI fonts |
| `README.md`, `openapi.yaml`, `llms.txt`, `CHANGELOG.md` (modify) | Docs |

---

### Task 1: Configuration and fonts

**Files:**
- Modify: `src/config.ts` (the `CamSimConfig` interface around lines 12–44, and the return object at lines 150–182)
- Create: `src/pipeline/fonts.ts`
- Test: `test/config.test.ts`, `test/fonts.test.ts`

**Interfaces:**
- Produces: `config.pipelineMaxMin: number`, `config.fontDir: string | undefined`.
- Produces: `findFonts(dir?: string): { regular: string; bold: string } | null`.

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts`, appended inside the existing top-level describe for `loadConfig` (use the file's existing `USERS` / base-env helper):

```ts
it('reads CAMSIM_PIPELINE_MAX_MIN (1–1440, default 1440) and CAMSIM_FONT_DIR', () => {
  const base = { CAMSIM_USERS: 'a:admin:pw' };
  expect(loadConfig(base).pipelineMaxMin).toBe(1440);
  expect(loadConfig({ ...base, CAMSIM_PIPELINE_MAX_MIN: '90' }).pipelineMaxMin).toBe(90);
  expect(() => loadConfig({ ...base, CAMSIM_PIPELINE_MAX_MIN: '0' })).toThrow(/CAMSIM_PIPELINE_MAX_MIN/);
  expect(() => loadConfig({ ...base, CAMSIM_PIPELINE_MAX_MIN: '1441' })).toThrow(/CAMSIM_PIPELINE_MAX_MIN/);
  expect(loadConfig(base).fontDir).toBeUndefined();
  expect(loadConfig({ ...base, CAMSIM_FONT_DIR: '/fonts' }).fontDir).toBe('/fonts');
});
```

`test/fonts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findFonts } from '../src/pipeline/fonts';

describe('findFonts', () => {
  it('uses CAMSIM_FONT_DIR when it has DejaVu Sans and Bold', () => {
    const d = mkdtempSync(join(tmpdir(), 'fonts-'));
    writeFileSync(join(d, 'DejaVuSans.ttf'), 'x');
    writeFileSync(join(d, 'DejaVuSans-Bold.ttf'), 'x');
    expect(findFonts(d)).toEqual({ regular: join(d, 'DejaVuSans.ttf'), bold: join(d, 'DejaVuSans-Bold.ttf') });
  });

  it('answers null for a folder without the fonts', () => {
    expect(findFonts(mkdtempSync(join(tmpdir(), 'nofonts-')))).toBeNull();
  });

  it('finds system fonts on this machine (Alpine, Debian/Ubuntu or macOS)', () => {
    const f = findFonts();
    expect(f?.regular).toMatch(/\.ttf$/);
    expect(f?.bold).toMatch(/\.ttf$/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/config.test.ts test/fonts.test.ts`
Expected: FAIL. `pipelineMaxMin` is undefined, and `../src/pipeline/fonts` cannot be resolved.

- [ ] **Step 3: Implement**

`src/config.ts`: in `CamSimConfig` add:

```ts
  pipelineMaxMin: number; // CAMSIM_PIPELINE_MAX_MIN: the longest SD pipeline switch-on (minutes)
  fontDir?: string; // CAMSIM_FONT_DIR: a folder with DejaVuSans.ttf and DejaVuSans-Bold.ttf
```

and in the returned object, after `video`:

```ts
    pipelineMaxMin: int('CAMSIM_PIPELINE_MAX_MIN', 1440, 1, 1440),
    fontDir: env.CAMSIM_FONT_DIR || undefined,
```

`src/pipeline/fonts.ts`:

```ts
import { existsSync } from 'fs';
import { join } from 'path';

// The SD pipeline's fonts: DejaVu Sans (the container's font-dejavu, or
// Debian/Ubuntu's fonts-dejavu-core), or Arial on a Mac for development.
const CANDIDATES: Array<[string, string, string]> = [
  ['/usr/share/fonts/dejavu', 'DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/truetype/dejavu', 'DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'],
  ['/System/Library/Fonts/Supplemental', 'Arial.ttf', 'Arial Bold.ttf'],
];

export function findFonts(dir?: string): { regular: string; bold: string } | null {
  const list = dir ? [[dir, 'DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'] as [string, string, string]] : CANDIDATES;
  for (const [d, r, b] of list) {
    const regular = join(d, r), bold = join(d, b);
    if (existsSync(regular) && existsSync(bold)) return { regular, bold };
  }
  return null;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/config.test.ts test/fonts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/pipeline/fonts.ts test/config.test.ts test/fonts.test.ts
git commit -m "feat(pipeline): config for the SD pipeline and font discovery"
```

---

### Task 2: Overlay model (the clock text and the filter chain)

**Files:**
- Create: `src/pipeline/overlay.ts`
- Test: `test/overlay.test.ts`

**Interfaces:**
- Consumes: `localParts(clock: Clock, tz: string)` from `src/engine/clock.ts`. It returns `{ year, mon, day, hour, min, sec, weekday }`.
- Produces:
  - `clockText(at: Date, tz: string, fmt: { timeFmt: string; hourFmt: number }): string`
  - `filterChain(s: OverlaySettings, files: { clock: string; name: string }, fonts: { regular: string; bold: string }): string`
  - `interface OverlaySettings { rotation: number; mirroring: number; watermark: number; name: { enable: number; pos: string }; time: { enable: number; pos: string } }`
  - `overlayOf(settings: { Osd: any; Isp: any }): OverlaySettings`

- [ ] **Step 1: Write the failing tests**

`test/overlay.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clockText, filterChain, overlayOf, type OverlaySettings } from '../src/pipeline/overlay';
import { findFonts } from '../src/pipeline/fonts';

const FMT = { timeFmt: 'MM/DD/YYYY', hourFmt: 1 };
const TZ = 'America/Chicago';
const off: OverlaySettings = { rotation: 0, mirroring: 0, watermark: 0, name: { enable: 0, pos: 'Lower Right' }, time: { enable: 0, pos: 'Upper Left' } };
const fonts = findFonts()!;
const files = { clock: '/tmp/x/clock.txt', name: '/tmp/x/name.txt' };

describe('clockText', () => {
  it('matches the camera: MM/DD/YYYY, 12 h with lower-case am/pm, upper-case weekday', () => {
    expect(clockText(new Date('2026-09-29T16:51:48Z'), TZ, FMT)).toBe('09/29/2026 11:51:48 am TUE');
    expect(clockText(new Date('2026-09-29T17:05:00Z'), TZ, FMT)).toBe('09/29/2026 12:05:00 pm TUE');
    expect(clockText(new Date('2026-09-29T05:00:00Z'), TZ, FMT)).toBe('09/29/2026 12:00:00 am TUE');
  });
  it('uses 24 h without am/pm for hourFmt 0', () => {
    expect(clockText(new Date('2026-09-29T21:07:09Z'), TZ, { timeFmt: 'MM/DD/YYYY', hourFmt: 0 })).toBe('09/29/2026 16:07:09 TUE');
  });
  // Review focus 5: the repeated autumn hour reads the zone's local time both times.
  it('shows local time through a DST change', () => {
    expect(clockText(new Date('2026-11-01T06:30:00Z'), TZ, FMT)).toBe('11/01/2026 01:30:00 am SUN'); // CDT
    expect(clockText(new Date('2026-11-01T07:30:00Z'), TZ, FMT)).toBe('11/01/2026 01:30:00 am SUN'); // CST
  });
});

describe('filterChain', () => {
  it('is a plain pass-through (null) with everything off', () => {
    expect(filterChain(off, files, fonts)).toBe('null');
  });
  it('flips before any text: rotation → vflip, mirroring → hflip', () => {
    expect(filterChain({ ...off, rotation: 1 }, files, fonts)).toBe('vflip');
    expect(filterChain({ ...off, mirroring: 1 }, files, fonts)).toBe('hflip');
    const both = filterChain({ ...off, rotation: 1, mirroring: 1, time: { enable: 1, pos: 'Upper Left' } }, files, fonts);
    expect(both.indexOf('vflip')).toBeLessThan(both.indexOf('drawtext'));
    expect(both.startsWith('vflip,hflip,')).toBe(true);
  });
  it('reads name and time from files with expansion off (review focus 1)', () => {
    const f = filterChain({ ...off, name: { enable: 1, pos: 'Lower Right' }, time: { enable: 1, pos: 'Top Center' } }, files, fonts);
    expect(f).toContain(`textfile='${files.name}'`);
    expect(f).toContain(`textfile='${files.clock}'`);
    expect(f.match(/reload=1/g)).toHaveLength(2);
    expect(f.match(/expansion=none/g)).toHaveLength(2);
  });
  it('places the six positions with a 10 px margin', () => {
    const at = (pos: string) => filterChain({ ...off, name: { enable: 1, pos } }, files, fonts);
    expect(at('Upper Left')).toMatch(/x=10:y=10/);
    expect(at('Top Center')).toMatch(/x=\(w-text_w\)\/2:y=10/);
    expect(at('Upper Right')).toMatch(/x=w-text_w-10:y=10/);
    expect(at('Lower Left')).toMatch(/x=10:y=h-th-10/);
    expect(at('Bottom Center')).toMatch(/x=\(w-text_w\)\/2:y=h-th-10/);
    expect(at('Lower Right')).toMatch(/x=w-text_w-10:y=h-th-10/);
  });
  it('stacks time above name at a shared position, and moves Upper Left text below the watermark', () => {
    const bottom = filterChain({ ...off, name: { enable: 1, pos: 'Lower Left' }, time: { enable: 1, pos: 'Lower Left' } }, files, fonts);
    expect(bottom).toMatch(new RegExp(`textfile='${files.name}'[^,]*y=h-th-10`));
    expect(bottom).toMatch(new RegExp(`textfile='${files.clock}'[^,]*y=h-th-38`));
    const top = filterChain({ ...off, watermark: 1, time: { enable: 1, pos: 'Upper Left' } }, files, fonts);
    expect(top).toMatch(/text='Reolink'[^,]*x=10:y=10/);
    expect(top).toMatch(new RegExp(`textfile='${files.clock}'[^,]*x=10:y=54`));
  });
  it('maps the settings objects', () => {
    expect(overlayOf({ Isp: { rotation: 1, mirroring: 0 }, Osd: { watermark: 1, osdChannel: { enable: 1, name: 'Den', pos: 'Lower Right' }, osdTime: { enable: 0, pos: 'Top Center' } } }))
      .toEqual({ rotation: 1, mirroring: 0, watermark: 1, name: { enable: 1, pos: 'Lower Right' }, time: { enable: 0, pos: 'Top Center' } });
  });
});

// Real ffmpeg on one test-pattern frame: the chain does what it says.
describe('filterChain in ffmpeg', () => {
  const W = 896, H = 512;
  const frame = (vf: string, dir: string) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=896x512:rate=10', '-frames:v', '1',
    '-vf', vf, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  it('rotation + mirroring turns the picture 180°', () => {
    const d = mkdtempSync(join(tmpdir(), 'ovl-'));
    const plain = frame('null', d);
    const turned = frame(filterChain({ ...off, rotation: 1, mirroring: 1 }, files, fonts), d);
    let same = 0;
    for (let y = 0; y < H; y += 7) for (let x = 0; x < W; x += 7) {
      const a = (y * W + x) * 3, b = ((H - 1 - y) * W + (W - 1 - x)) * 3;
      if (Math.abs(plain[a] - turned[b]) + Math.abs(plain[a + 1] - turned[b + 1]) + Math.abs(plain[a + 2] - turned[b + 2]) < 12) same++;
    }
    expect(same / (Math.ceil(W / 7) * Math.ceil(H / 7))).toBeGreaterThan(0.98);
  });
  it('draws a name literally, even with %, {, :, quotes and non-ASCII (review focus 1)', () => {
    const d = mkdtempSync(join(tmpdir(), 'ovl-'));
    const f = { clock: join(d, 'clock.txt'), name: join(d, 'name.txt') };
    writeFileSync(f.clock, '09/29/2026 11:51:48 am TUE');
    writeFileSync(f.name, `50% {off}: 'Dén' \\ "x"`);
    const plain = frame('null', d);
    const named = frame(filterChain({ ...off, name: { enable: 1, pos: 'Lower Right' } }, f, fonts), d);
    const diff = (x0: number, y0: number, x1: number, y1: number) => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 3; if (plain[i] !== named[i]) n++; }
      return n;
    };
    expect(diff(W - 300, H - 40, W - 10, H - 10)).toBeGreaterThan(200); // text drawn bottom right
    expect(diff(10, 10, 300, 40)).toBe(0); // nothing top left
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/overlay.test.ts`
Expected: FAIL. `../src/pipeline/overlay` cannot be resolved.

- [ ] **Step 3: Implement `src/pipeline/overlay.ts`**

```ts
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
// A value for a filter option, quoted; ffmpeg's quoting has no escape inside '…'.
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

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
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/overlay.test.ts`
Expected: PASS, 11 tests. If a `localParts` weekday or DST assertion fails, check `src/engine/clock.ts`: `localParts` takes a `Clock` and a zone. Fix the call, not the expected values, which match the camera.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/overlay.ts test/overlay.test.ts
git commit -m "feat(pipeline): overlay model (clock text, filter chain)"
```

---

### Task 3: Streaming FLV parser

**Files:**
- Create: `src/media/flv-stream.ts`
- Test: `test/flv-stream.test.ts`

**Interfaces:**
- Consumes: `FlvTag` from `src/media/flv.ts`.
- Produces: `class FlvStreamParser extends EventEmitter`, with:
  - `push(chunk: Buffer): void`;
  - events `'header' (header: Buffer)` and `'tag' (tag: FlvTag)`;
  - helpers `isConfigTag(t: FlvTag): boolean` and `isKeyframe(t: FlvTag): boolean`.

- [ ] **Step 1: Write the failing test**

`test/flv-stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { FlvStreamParser, isConfigTag, isKeyframe } from '../src/media/flv-stream';
import { readFlv, type FlvTag } from '../src/media/flv';
import { ensureFixtures, defaultFixtureDir } from '../src/media/fixtures';
import { createLogger } from '../src/log';

describe('FlvStreamParser', () => {
  it('yields the same header and tags as readFlv, whatever the chunking', async () => {
    const paths = await ensureFixtures(defaultFixtureDir(), createLogger('silent'));
    const buf = readFileSync(paths.subFlv);
    const want = readFlv(buf);
    for (const size of [1, 7, 11, 15, 4096, buf.length]) {
      const p = new FlvStreamParser();
      let header: Buffer | undefined;
      const tags: FlvTag[] = [];
      p.on('header', (h: Buffer) => (header = h));
      p.on('tag', (t: FlvTag) => tags.push(t));
      for (let i = 0; i < buf.length; i += size) p.push(buf.subarray(i, i + size));
      expect(header?.equals(want.header)).toBe(true);
      expect(tags.map((t) => [t.type, t.ms, t.bytes.length])).toEqual(want.tags.map((t) => [t.type, t.ms, t.bytes.length]));
    }
  });

  it('classifies config tags and keyframes', async () => {
    const paths = await ensureFixtures(defaultFixtureDir(), createLogger('silent'));
    const { tags } = readFlv(readFileSync(paths.subFlv));
    const video = tags.filter((t) => t.type === 9);
    expect(isConfigTag(video[0])).toBe(true); // AVC sequence header first
    expect(isKeyframe(video[1])).toBe(true); // then a keyframe
    expect(video.slice(1).some((t) => !isKeyframe(t))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/flv-stream.test.ts`
Expected: FAIL (module not found). If `paths.subFlv` isn't the property name, read `ensureFixtures`' return type in `src/media/fixtures.ts` (the prepared files are `sub.flv` etc.) and use its name.

- [ ] **Step 3: Implement `src/media/flv-stream.ts`**

```ts
import { EventEmitter } from 'events';
import type { FlvTag } from './flv';

// AVC/HEVC or AAC sequence header (packet type 0).
export const isConfigTag = (t: FlvTag) => (t.type === 9 || t.type === 8) && t.bytes[12] === 0;
// A video keyframe (frame type 1 in the tag body's first byte).
export const isKeyframe = (t: FlvTag) => t.type === 9 && t.bytes[11] >> 4 === 1;

// FLV from a pipe (ffmpeg -f flv pipe:1): the header once, then whole tags
// as they complete, whatever the chunk boundaries.
export class FlvStreamParser extends EventEmitter {
  private buf = Buffer.alloc(0);
  private headerDone = false;

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.headerDone) {
      if (this.buf.length < 9) return;
      const end = this.buf.readUInt32BE(5) + 4; // header, then PreviousTagSize0
      if (this.buf.length < end) return;
      this.emit('header', Buffer.from(this.buf.subarray(0, end)));
      this.buf = this.buf.subarray(end);
      this.headerDone = true;
    }
    let at = 0;
    while (at + 11 <= this.buf.length) {
      const size = this.buf.readUIntBE(at + 1, 3);
      const end = at + 11 + size + 4;
      if (end > this.buf.length) break;
      const bytes = Buffer.from(this.buf.subarray(at, end));
      const type = bytes[0] as FlvTag['type'];
      const ms = bytes.readUIntBE(4, 3) + bytes[7] * 0x1000000;
      const first = bytes[11];
      const codecId = type === 9 ? first & 0x0f : type === 8 ? first >> 4 : undefined;
      this.emit('tag', { type, ms, codecId, bytes } satisfies FlvTag);
      at = end;
    }
    this.buf = this.buf.subarray(at);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/flv-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/media/flv-stream.ts test/flv-stream.test.ts
git commit -m "feat(media): streaming FLV parser"
```

---

### Task 4: The switch in the engine (state, auto-off, reset)

**Files:**
- Modify: `src/engine/engine.ts` (fields near line 66; `reset()` at about line 231; `state()` at about line 264; `stop()`)
- Test: `test/pipeline-switch.test.ts`

**Interfaces:**
- Produces, on `Engine`:
  - `pipeline: { on: boolean; until?: number; error?: string }`
  - `pipelineOn(minutes: number): void` (validated by the caller)
  - `pipelineOff(error?: string): void`
  - `pipelineState(): { on: false; error?: string } | { on: true; until: number; running: boolean }`
  - `liveSub?: LiveSubSource`, set by `SdPipeline` in Task 5
  - bus event `'pipeline'` with `pipelineState()`
  - `state().pipeline`
- Produces the `LiveSubSource` interface (in `src/pipeline/live-sub.ts`, created here and used by Tasks 5 and 6):

```ts
import type { FlvTag } from '../media/flv';
// The pipeline's live SD stream, for FLV clients.
export interface LiveSubSource {
  active(): boolean; // a process is running and has sent its config tags
  generation(): number; // increases on every (re)start
  header(): Buffer;
  configTags(): FlvTag[]; // script, video and audio sequence headers of this generation
  subscribe(fn: (t: FlvTag, gen: number) => void): () => void;
}
```

- [ ] **Step 1: Write the failing test**

`test/pipeline-switch.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeEngine } from './helpers';

afterEach(() => vi.useRealTimers());

describe('SD pipeline switch', () => {
  it('is off at start; on sets until; the timer switches it off; each change is a bus event', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const e = await makeEngine();
    const seen: unknown[] = [];
    e.bus.on('pipeline', (s) => seen.push(s));
    expect(e.state().pipeline).toEqual({ on: false });
    e.pipelineOn(15);
    expect(e.pipelineState()).toEqual({ on: true, until: 1_000_000 + 15 * 60_000, running: false });
    e.pipelineOn(60); // on again: a new end time
    expect((e.pipelineState() as { until: number }).until).toBe(1_000_000 + 60 * 60_000);
    vi.advanceTimersByTime(60 * 60_000);
    expect(e.pipelineState()).toEqual({ on: false });
    expect(seen).toHaveLength(3);
  });

  it('keeps an error after switching off for a failure, until the next switch-on', async () => {
    const e = await makeEngine();
    e.pipelineOn(5);
    e.pipelineOff('drawtext: font not found');
    expect(e.pipelineState()).toEqual({ on: false, error: 'drawtext: font not found' });
    e.pipelineOn(5);
    expect(e.pipelineState()).not.toHaveProperty('error');
    e.pipelineOff();
  });

  it('is off after reset() and stop()', async () => {
    const e = await makeEngine();
    e.pipelineOn(5);
    e.reset();
    expect(e.pipelineState()).toEqual({ on: false });
    e.pipelineOn(5);
    e.stop();
    expect(e.pipelineState()).toEqual({ on: false });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/pipeline-switch.test.ts`
Expected: FAIL. `e.pipelineOn is not a function`.

- [ ] **Step 3: Implement**

Create `src/pipeline/live-sub.ts` with the interface above.

In `src/engine/engine.ts`, import it with `import type { LiveSubSource } from '../pipeline/live-sub';`, then add the fields after `activeDownloads`:

```ts
  // The SD pipeline switch (cam-sim spec 2026-09-29): never persisted.
  pipeline: { on: boolean; until?: number; error?: string } = { on: false };
  private pipelineTimer?: NodeJS.Timeout;
  liveSub?: LiveSubSource; // set by SdPipeline

  pipelineOn(minutes: number): void {
    clearTimeout(this.pipelineTimer);
    this.pipeline = { on: true, until: Date.now() + minutes * 60_000 };
    this.pipelineTimer = setTimeout(() => this.pipelineOff(), minutes * 60_000);
    this.pipelineTimer.unref?.();
    this.bus.emit('pipeline', this.pipelineState());
  }

  pipelineOff(error?: string): void {
    clearTimeout(this.pipelineTimer);
    this.pipelineTimer = undefined;
    this.pipeline = error ? { on: false, error } : { on: false };
    this.bus.emit('pipeline', this.pipelineState());
  }

  pipelineState(): { on: false; error?: string } | { on: true; until: number; running: boolean } {
    if (!this.pipeline.on) return this.pipeline.error ? { on: false, error: this.pipeline.error } : { on: false };
    return { on: true, until: this.pipeline.until!, running: !!this.liveSub?.active() };
  }
```

In `reset()`, before `this.bus.emit('state', { reset: true })`, add `if (this.pipeline.on || this.pipeline.error) this.pipelineOff();`. In `stop()`, add `if (this.pipeline.on) this.pipelineOff();`. In `state()`, add `pipeline: this.pipelineState(),`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/pipeline-switch.test.ts test/control-api.test.ts`
Expected: PASS. Any test that compares `state()` with a full object now needs `pipeline: { on: false }`; update those expectations in the same commit.

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts src/pipeline/live-sub.ts test/pipeline-switch.test.ts
git commit -m "feat(pipeline): switch state with auto-off in the engine"
```

---

### Task 5: SdPipeline (the ffmpeg process, files, fan-out, restarts, failures)

**Files:**
- Create: `src/pipeline/sd-pipeline.ts`
- Test: `test/sd-pipeline.test.ts`

**Interfaces:**
- Consumes:
  - `Engine` (`pipeline`, `pipelineOff`, `liveSub`, `bus` events `pipeline`, `settings`, `state`, `video` and `fault`, `offline()`, `power`, `rebooting`, `media.clipPath('sub')`, `settings.running`, `config.tz`, `clock`);
  - `overlayOf`, `filterChain`, `clockText` (Task 2);
  - `FlvStreamParser`, `isConfigTag` (Task 3);
  - `LiveSubSource` (Task 4);
  - `timeValue(clock, tz)` from `src/engine/clock.ts`, for `timeFmt`/`hourFmt`.
- Produces:
  - `class SdPipeline implements LiveSubSource`
  - `constructor(engine: Engine, opts: { fonts: { regular: string; bold: string } | null; rtspUrl?: () => string | undefined; onRunning?: (running: boolean) => void })`
  - `stop(): Promise<void>`
  - It sets `engine.liveSub = this`.

Behaviour:
- **When it runs:** the process runs exactly when `engine.pipeline.on && engine.power === 'on' && !engine.rebooting && !engine.offline()`. This is re-evaluated on bus `pipeline`, `state`, `fault` and `video`.
- **Restarts:** a bus `settings` or `video` event restarts a running process after a 500 ms debounce (review focus 2).
- **Files:** it writes `clock.txt` (via `clock.tmp` and rename) every second while running, and `name.txt` on every start.
- **Failures:** an unexpected exit restarts after 1 s. If the previous unexpected exit was less than 60 s ago, it calls `engine.pipelineOff(<last stderr line, paths replaced by '<path>'>)` instead. With no fonts, the first start calls `pipelineOff('no font for the SD pipeline (install font-dejavu or set CAMSIM_FONT_DIR)')`.
- **Running flag:** `onRunning(true)` fires once the first config tags of a generation have been seen, and `onRunning(false)` when the process ends. On each change it emits the bus `pipeline` event again (so `running` updates in the UI).

- [ ] **Step 1: Write the failing tests** (real ffmpeg, no RTSP)

`test/sd-pipeline.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeEngine } from './helpers';
import { SdPipeline } from '../src/pipeline/sd-pipeline';
import { findFonts } from '../src/pipeline/fonts';
import { isKeyframe } from '../src/media/flv-stream';
import type { FlvTag } from '../src/media/flv';

const pipes: SdPipeline[] = [];
afterEach(async () => { while (pipes.length) await pipes.pop()!.stop(); });
const until = async (f: () => boolean, ms = 15_000) => {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 50))) if (f()) return;
  throw new Error('timed out');
};

async function setup(fonts = findFonts()) {
  const e = await makeEngine();
  const p = new SdPipeline(e, { fonts });
  pipes.push(p);
  return { e, p };
}

describe('SdPipeline', () => {
  it('runs only while switched on, streams H.264 896×512 FLV with config tags, then keyframes', async () => {
    const { e, p } = await setup();
    expect(p.active()).toBe(false);
    e.pipelineOn(5);
    await until(() => p.active());
    const cfg = p.configTags();
    expect(cfg.some((t) => t.type === 9 && t.codecId === 7)).toBe(true); // AVC sequence header
    const tags: FlvTag[] = [];
    const off = p.subscribe((t) => tags.push(t));
    await until(() => tags.filter((t) => t.type === 9).length > 15);
    off();
    expect(tags.some(isKeyframe)).toBe(true);
    expect(e.pipelineState()).toMatchObject({ on: true, running: true });
    e.pipelineOff();
    await until(() => !p.active());
  }, 30_000);

  it('restarts once for a burst of settings changes (review focus 2), with a new generation', async () => {
    const { e, p } = await setup();
    e.pipelineOn(5);
    await until(() => p.active());
    const g = p.generation();
    for (let i = 0; i < 5; i++) e.bus.emit('settings', { cmd: 'SetOsd' });
    await until(() => p.generation() === g + 1 && p.active());
    await new Promise((r) => setTimeout(r, 1500));
    expect(p.generation()).toBe(g + 1);
  }, 30_000);

  it('stops while powered off and resumes on power-on with time left (review focus 3)', async () => {
    const { e, p } = await setup();
    e.pipelineOn(5);
    await until(() => p.active());
    e.powerOff();
    await until(() => !p.active());
    expect(e.pipelineState()).toMatchObject({ on: true, running: false });
    await e.powerOn(0);
    await until(() => p.active());
  }, 30_000);

  it('switches off with an error when there is no font', async () => {
    const { e } = await setup(null);
    e.pipelineOn(5);
    await until(() => !e.pipeline.on);
    expect(e.pipelineState()).toEqual({ on: false, error: expect.stringMatching(/font/) });
  });

  it('switches off with an error after a second failure within a minute', async () => {
    const { e } = await setup({ regular: '/nonexistent/a.ttf', bold: '/nonexistent/b.ttf' });
    e.settings.running.Osd.osdChannel.enable = 1; // drawtext needs the missing font
    e.pipelineOn(5);
    await until(() => !e.pipeline.on, 20_000);
    expect(e.pipeline.error).toBeTruthy();
    expect(e.pipeline.error).not.toMatch(/\/nonexistent/); // paths removed
  }, 30_000);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/sd-pipeline.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/pipeline/sd-pipeline.ts`**

```ts
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Engine } from '../engine/engine';
import { timeValue } from '../engine/clock';
import type { FlvTag } from '../media/flv';
import { FlvStreamParser, isConfigTag } from '../media/flv-stream';
import { clockText, filterChain, overlayOf } from './overlay';
import type { LiveSubSource } from './live-sub';

type Fonts = { regular: string; bold: string };

// The optional SD pipeline (spec 2026-09-29): one ffmpeg that re-encodes the
// current video's SD clip with the camera's name, time, watermark and
// flip/mirror, for FLV clients (stdout) and, when given, RTSP (tee).
export class SdPipeline implements LiveSubSource {
  private proc?: ChildProcess;
  private gen = 0;
  private hdr = Buffer.alloc(0);
  private cfg: FlvTag[] = [];
  private ready = false;
  private readonly subs = new Set<(t: FlvTag, gen: number) => void>();
  private readonly dir = mkdtempSync(join(tmpdir(), 'cam-sim-pipeline-'));
  private readonly files = { clock: join(this.dir, 'clock.txt'), name: join(this.dir, 'name.txt') };
  private clockTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private lastFailure = 0;
  private stopping = false;
  private expectedExit = false;

  private readonly onSwitch = () => this.follow();
  private readonly onChange = () => {
    if (!this.proc) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.restart(), 500);
    this.debounce.unref?.();
  };

  constructor(private readonly engine: Engine, private readonly opts: { fonts: Fonts | null; rtspUrl?: () => string | undefined; onRunning?: (running: boolean) => void }) {
    engine.liveSub = this;
    for (const t of ['pipeline', 'state', 'fault', 'video'] as const) engine.bus.on(t, this.onSwitch);
    engine.bus.on('settings', this.onChange);
    engine.bus.on('video', this.onChange);
  }

  active(): boolean { return !!this.proc && this.ready; }
  generation(): number { return this.gen; }
  header(): Buffer { return this.hdr; }
  configTags(): FlvTag[] { return this.cfg; }
  subscribe(fn: (t: FlvTag, gen: number) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private wanted(): boolean {
    const e = this.engine;
    return e.pipeline.on && e.power === 'on' && !e.rebooting && !e.offline() && !this.stopping;
  }

  private follow(): void {
    if (this.wanted() && !this.proc && !this.restartTimer) this.start();
    else if (!this.wanted() && this.proc) this.kill();
  }

  private writeClock(): void {
    const e = this.engine;
    const t = timeValue(e.clock, e.config.tz).Time;
    writeFileSync(join(this.dir, 'clock.tmp'), clockText(e.clock.now(), e.config.tz, t));
    renameSync(join(this.dir, 'clock.tmp'), this.files.clock);
  }

  private start(): void {
    const e = this.engine;
    if (!this.opts.fonts) return void e.pipelineOff('no font for the SD pipeline (install font-dejavu or set CAMSIM_FONT_DIR)');
    const running = e.settings.running as { Osd: any; Isp: any };
    writeFileSync(this.files.name, String(running.Osd?.osdChannel?.name ?? ''));
    this.writeClock();
    this.clockTimer = setInterval(() => this.writeClock(), 1000);
    this.clockTimer.unref?.();
    const vf = filterChain(overlayOf(running), this.files, this.opts.fonts);
    const rtsp = this.opts.rtspUrl?.();
    const out = rtsp
      ? ['-f', 'tee', '-map', '0:v', '-map', '0:a?', `[f=rtsp:rtsp_transport=tcp]${rtsp}|[f=flv]pipe:1`]
      : ['-map', '0:v', '-map', '0:a?', '-f', 'flv', 'pipe:1'];
    const args = ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', e.media.clipPath('sub'),
      '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-r', '10', '-g', '40', '-bf', '0', '-b:v', '1M', '-maxrate', '1M', '-bufsize', '2M', '-c:a', 'copy', ...out];
    const gen = ++this.gen;
    this.ready = false;
    this.cfg = [];
    this.expectedExit = false;
    const parser = new FlvStreamParser();
    parser.on('header', (h: Buffer) => (this.hdr = h));
    parser.on('tag', (t: FlvTag) => {
      if (t.type === 18 || isConfigTag(t)) {
        this.cfg.push(t);
        if (!this.ready && this.cfg.some((c) => c.type === 9)) {
          this.ready = true;
          this.opts.onRunning?.(true);
          e.bus.emit('pipeline', e.pipelineState());
        }
        return;
      }
      for (const fn of this.subs) fn(t, gen);
    });
    let lastErr = '';
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout!.on('data', (d: Buffer) => parser.push(d));
    p.stderr!.on('data', (d) => (lastErr = String(d).trim().split('\n').pop() ?? lastErr));
    p.on('error', (err) => (lastErr = err.message));
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = undefined;
      this.ready = false;
      clearInterval(this.clockTimer);
      this.opts.onRunning?.(false);
      e.bus.emit('pipeline', e.pipelineState());
      if (this.expectedExit || this.stopping) return void this.follow();
      const now = Date.now();
      if (now - this.lastFailure < 60_000) {
        const msg = (lastErr || 'the SD pipeline stopped').replace(/(?:[A-Za-z]:)?\/[^\s:'"]+/g, '<path>').slice(0, 200);
        return void e.pipelineOff(msg);
      }
      this.lastFailure = now;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.follow();
      }, 1000);
      this.restartTimer.unref?.();
    });
    this.proc = p;
  }

  private kill(): Promise<void> {
    const p = this.proc;
    if (!p) return Promise.resolve();
    this.expectedExit = true;
    return new Promise((r) => {
      p.once('exit', () => r());
      p.kill('SIGTERM');
      setTimeout(() => p.kill('SIGKILL'), 3000).unref();
    });
  }

  private restart(): void {
    if (!this.proc) return;
    void this.kill(); // the exit handler's follow() starts it again
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.debounce);
    clearTimeout(this.restartTimer);
    for (const t of ['pipeline', 'state', 'fault', 'video'] as const) this.engine.bus.off(t, this.onSwitch);
    this.engine.bus.off('settings', this.onChange);
    this.engine.bus.off('video', this.onChange);
    await this.kill();
    clearInterval(this.clockTimer);
    if (this.engine.liveSub === this) this.engine.liveSub = undefined;
    rmSync(this.dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/sd-pipeline.test.ts`
Expected: PASS, 5 tests.
- If the burst test sees two restarts, the debounce isn't shared. Check that `onChange` clears `this.debounce`.
- If the power test doesn't resume, `follow()` isn't reached on `state` events. Check the bus subscriptions.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/sd-pipeline.ts test/sd-pipeline.test.ts
git commit -m "feat(pipeline): SdPipeline process with fan-out, restarts and failure policy"
```

---

### Task 6: FLV clients get the live source

**Files:**
- Modify: `src/camera-api/media-routes.ts` (`streamFlv`, lines 119–188)
- Test: `test/pipeline-flv.test.ts`

**Interfaces:**
- Consumes: `engine.liveSub` (`LiveSubSource`), and `isKeyframe`/`isConfigTag` from Task 3.
- Produces: an unchanged `streamFlv(engine, res, stream, { count })` signature.

Behaviour for `stream === 'sub'`:
- Each pump checks `e.liveSub?.active()`.
- **Entering live** (it was looping):
  1. send `configTags()` except type 18, rebased to `due`;
  2. subscribe;
  3. drop tags until the first keyframe, then send each tag rebased to `base + (t.ms - firstMs)`, where `base` is `due` at the first keyframe.
- **A new generation:** the same entry sequence as entering live.
- **Leaving live** (`!active()`): unsubscribe, `src = load(e.media, false)`, `base = due`, `pass = 0`, `next = 0`, which is today's switch path.
- **Buffering:** tags received between pumps are buffered per client (an array) and written on the next pump, keeping the `flvBufferBytes` rule.
- `main` is unchanged.

- [ ] **Step 1: Write the failing test** (review focus 4)

`test/pipeline-flv.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { makeEngine, listen, login } from './helpers';
import { createCameraApp } from '../src/camera-api/app';
import { SdPipeline } from '../src/pipeline/sd-pipeline';
import { findFonts } from '../src/pipeline/fonts';
import { FlvStreamParser, isKeyframe, isConfigTag } from '../src/media/flv-stream';
import type { FlvTag } from '../src/media/flv';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FLV sub with the SD pipeline', () => {
  it('keeps one client through off → on → off: rising timestamps, each live part starting at a keyframe', async () => {
    const e = await makeEngine();
    const app = createCameraApp(e, { port: 'http' });
    const srv = await listen(app);
    const p = new SdPipeline(e, { fonts: findFonts() });
    cleanups.push(srv.close, () => p.stop());
    const t = await login(app);
    const tags: Array<{ tag: FlvTag; live: boolean }> = [];
    const parser = new FlvStreamParser();
    parser.on('tag', (tag: FlvTag) => tags.push({ tag, live: !!p.active() }));
    const req = http.get(`${srv.url}/flv?port=1935&app=bcs&stream=channel0_sub.bcs&token=${t}`, (res) => res.on('data', (d: Buffer) => parser.push(d)));
    cleanups.push(async () => void req.destroy());
    await wait(1500);
    e.pipelineOn(5);
    for (let i = 0; i < 150 && !p.active(); i++) await wait(100);
    await wait(3000);
    e.pipelineOff();
    await wait(1500);
    const media = tags.filter((x) => x.tag.type === 9 && !isConfigTag(x.tag));
    const ms = media.map((x) => x.tag.ms);
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThanOrEqual(ms[i - 1]);
    const firstLive = media.findIndex((x) => x.live);
    expect(firstLive).toBeGreaterThan(0);
    expect(isKeyframe(media[firstLive].tag)).toBe(true);
    expect(media.slice(-5).every((x) => !x.live)).toBe(true); // back on the loop
  }, 45_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/pipeline-flv.test.ts`
Expected: FAIL. `firstLive` is -1, because the client never sees live tags.

- [ ] **Step 3: Implement in `streamFlv`**

Add near the top of `media-routes.ts`:

```ts
import { isKeyframe } from '../media/flv-stream';
```

Inside `streamFlv`, after `let base = 0;`, add the live state:

```ts
  // The SD pipeline (spec 2026-09-29): while it runs, sub comes from it.
  let live: { gen: number; off: () => void; queue: FlvTag[]; firstMs: number | null } | null = null;
  const leaveLive = () => {
    live?.off();
    live = null;
  };
  const enterLive = (due: number) => {
    const ls = e.liveSub!;
    leaveLive();
    const gen = ls.generation();
    const entry = { gen, off: () => {}, queue: [] as FlvTag[], firstMs: null as number | null };
    for (const c of ls.configTags()) if (c.type !== 18) res.write(shifted({ ...c, ms: 0 }, due));
    entry.off = ls.subscribe((t, g) => {
      if (g !== gen) return;
      if (entry.firstMs === null) {
        if (!isKeyframe(t)) return;
        entry.firstMs = t.ms;
      }
      entry.queue.push(t);
    });
    base = due;
    live = entry;
  };
```

At the start of `pump`, before the `if (e.media !== src.media)` block, add:

```ts
    if (stream === 'sub') {
      const ls = e.liveSub;
      if (ls?.active() && (!live || live.gen !== ls.generation())) enterLive(due);
      if (live && !ls?.active()) {
        leaveLive();
        src = load(e.media, false);
        base = due;
        pass = 0;
        next = 0;
      }
      if (live) {
        for (const t of live.queue.splice(0)) {
          res.write(shifted(t, base - (live.firstMs ?? t.ms)));
          if (res.writableLength > e.limits.flvBufferBytes) return void res.destroy();
        }
        return;
      }
    }
```

In `res.on('close', …)`, add `leaveLive();`. `shifted(tag, offset)` writes `tag.ms + offset`, so live tags come out at `base + (t.ms - firstMs)`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/pipeline-flv.test.ts test/conformance/media-api.test.ts`
Expected: PASS. The existing media conformance tests are unchanged (pipeline off).

- [ ] **Step 5: Commit**

```bash
git add src/camera-api/media-routes.ts test/pipeline-flv.test.ts
git commit -m "feat(pipeline): FLV sub serves the live pipeline while it runs"
```

---

### Task 7: RTSP sub from the pipeline, and wiring in createCamSim

**Files:**
- Modify: `src/rtsp/rtsp.ts` (`publish()` at lines 226–240, plus new methods)
- Modify: `src/index.ts` (`createCamSim`: `listen()` and `close()`)
- Test: `test/rtsp.test.ts` (a new case), `test/index.test.ts` (a new case)

**Interfaces:**
- Produces, on `RtspService`:
  - `publisherUrl(stream: 'sub' | 'main'): string | undefined` (undefined when MediaMTX isn't up)
  - `setSubSource(mode: 'copy' | 'pipeline'): void`
- Consumes: `SdPipeline`'s `rtspUrl` and `onRunning` options (Task 5).

- [ ] **Step 1: Write the failing test**

Append to `test/rtsp.test.ts`, reusing its `probe()`, `freePort()`, `mediamtx` and `services` helpers:

```ts
it.skipIf(!mediamtx)('serves the pipeline on h264Preview_01_sub while it runs, and the copy again after', async () => {
  const e = await makeEngine();
  const rtsp = new RtspService(e, { port: await freePort(), mediamtx });
  services.push(rtsp);
  await rtsp.start();
  const { SdPipeline } = await import('../src/pipeline/sd-pipeline');
  const { findFonts } = await import('../src/pipeline/fonts');
  const p = new SdPipeline(e, { fonts: findFonts(), rtspUrl: () => rtsp.publisherUrl('sub'), onRunning: (r) => rtsp.setSubSource(r ? 'pipeline' : 'copy') });
  const url = `rtsp://cams:cams-pw@127.0.0.1:${rtsp.port()}/h264Preview_01_sub`;
  try {
    e.pipelineOn(5);
    for (let i = 0; i < 150 && !p.active(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(await probe(url)).toMatchObject({ codec: 'h264', width: 896 });
    e.pipelineOff();
    await new Promise((r) => setTimeout(r, 2500));
    expect(await probe(url)).toMatchObject({ codec: 'h264', width: 896 });
  } finally {
    await p.stop();
  }
}, 60_000);
```

Append to `test/index.test.ts`:

```ts
it('wires the SD pipeline into createCamSim: switched on, it reaches running', async () => {
  const sim = await createCamSim({ users: [{ name: 'u', level: 'admin', password: 'p' }] });
  await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0 }, '127.0.0.1');
  try {
    sim.engine.pipelineOn(1);
    for (let i = 0; i < 150 && !(sim.engine.pipelineState() as { running?: boolean }).running; i++) await new Promise((r) => setTimeout(r, 100));
    expect(sim.engine.pipelineState()).toMatchObject({ on: true, running: true });
  } finally {
    await sim.close();
  }
}, 60_000);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/rtsp.test.ts test/index.test.ts -t "pipeline"`
Expected: FAIL. `rtsp.publisherUrl is not a function`, and nothing in `createCamSim` creates a pipeline.

- [ ] **Step 3: Implement**

`src/rtsp/rtsp.ts`: add `private subMode: 'copy' | 'pipeline' = 'copy';` and these methods:

```ts
  // The SD pipeline publishes sub itself while it runs (spec 2026-09-29).
  publisherUrl(stream: Stream): string | undefined {
    if (!this.up || this.mtxExited) return undefined;
    return `rtsp://camsim-publisher:${this.pubPassword}@127.0.0.1:${this.boundPort}/${RTSP_PATHS[stream]}`;
  }

  setSubSource(mode: 'copy' | 'pipeline'): void {
    if (mode === this.subMode) return;
    this.subMode = mode;
    if (mode === 'pipeline') this.publishers.get('sub')?.kill('SIGTERM');
    else if (!this.publishers.has('sub')) this.publish('sub');
  }
```

In `publish()`:
- start with `if (stream === 'sub' && this.subMode === 'pipeline') return;`;
- in its `exit` handler, restart only `if (!this.stopping && !this.mtxExited && !(stream === 'sub' && this.subMode === 'pipeline'))`.

`src/index.ts`, in `createCamSim`:
- import `SdPipeline` and `findFonts`;
- add `let pipeline: SdPipeline | undefined;`;
- in `listen()`, right after `await rtsp.start();`:

```ts
      // The optional SD pipeline (off until switched on).
      pipeline = new SdPipeline(engine, {
        fonts: findFonts(config.fontDir),
        rtspUrl: () => rtsp?.publisherUrl('sub'),
        onRunning: (r) => rtsp?.setSubSource(r ? 'pipeline' : 'copy'),
      });
```

- in `close()`, before `await rtsp?.stop();`, add `await pipeline?.stop();`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/rtsp.test.ts test/index.test.ts`
Expected: PASS. In CI MediaMTX is required, so the RTSP case must run there, not skip.

- [ ] **Step 5: Commit**

```bash
git add src/rtsp/rtsp.ts src/index.ts test/rtsp.test.ts test/index.test.ts
git commit -m "feat(pipeline): RTSP sub from the pipeline; wired into createCamSim"
```

---

### Task 8: Control API, SSE and OpenAPI

**Files:**
- Modify: `src/control-api/app.ts` (after the `/faults` routes, about line 145), `src/control-api/sse.ts` (`TOPICS`), `openapi.yaml`
- Test: `test/control-api.test.ts`, `test/openapi.test.ts` (existing: it checks that routes are documented)

**Interfaces:**
- Consumes: `engine.pipelineOn/Off/State`, `config.pipelineMaxMin`.
- Produces:
  - `POST /sim/api/pipeline`: 200 with the state, or 400 `{error:'invalid', detail}`
  - `DELETE /sim/api/pipeline`: 204
  - the SSE event `pipeline`

- [ ] **Step 1: Write the failing test**

Append to `test/control-api.test.ts`, using that file's existing control-app helper and bearer-token request pattern (named here `ctl`):

```ts
describe('SD pipeline switch', () => {
  it('switches on for N minutes (default 60, 1..max), answers the state, and off with DELETE', async () => {
    const { engine, ctl } = await controlSetup({ CAMSIM_PIPELINE_MAX_MIN: '120' });
    const on = await ctl('post', '/sim/api/pipeline').send({ minutes: 15 });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ on: true, until: expect.any(Number) });
    expect((await ctl('post', '/sim/api/pipeline').send({})).body.until - Date.now()).toBeGreaterThan(59 * 60_000); // default 60
    for (const minutes of [0, 121, 1.5, '10', -1]) expect((await ctl('post', '/sim/api/pipeline').send({ minutes })).body).toMatchObject({ error: 'invalid' });
    expect((await ctl('get', '/sim/api/state')).body.pipeline).toMatchObject({ on: true });
    expect((await ctl('delete', '/sim/api/pipeline')).status).toBe(204);
    expect(engine.pipelineState()).toEqual({ on: false });
  });
});
```

If the file's helper has a different name or shape, adapt only the setup lines; the assertions stay as written.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/control-api.test.ts -t "SD pipeline"`
Expected: FAIL with 404.

- [ ] **Step 3: Implement**

`src/control-api/app.ts`, after the faults routes:

```ts
  // The SD pipeline (spec 2026-09-29): on for N minutes, then off by itself.
  api.post('/pipeline', (req, res) => {
    const minutes = req.body?.minutes ?? 60;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > e.config.pipelineMaxMin) {
      return bad(res, `minutes must be an integer from 1 to ${e.config.pipelineMaxMin}`);
    }
    e.pipelineOn(minutes);
    res.json(e.pipelineState());
  });
  api.delete('/pipeline', (_req, res) => {
    e.pipelineOff();
    res.status(204).end();
  });
```

`src/control-api/sse.ts`: add `['pipeline', 'pipeline']` to `TOPICS`.

`openapi.yaml`: add the path next to `/sim/api/faults`:

```yaml
  /sim/api/pipeline:
    post:
      summary: Switch the SD pipeline on for `minutes` (1 to CAMSIM_PIPELINE_MAX_MIN, default 60); it switches itself off then
      description: >
        Re-encodes the live SD stream (FLV channel0_sub, RTSP h264Preview_01_sub) with the camera's
        name, date and time, watermark (Osd) and flip/mirror (Isp.rotation, Isp.mirroring). Main,
        snapshots, recordings and downloads are unchanged. Never persisted: off after a restart or reset.
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { minutes: { type: integer, minimum: 1, maximum: 1440 } } }
      responses:
        '200': { description: '{on:true, until:<unix ms>, running:<bool>}' }
        '400': { description: 'invalid minutes: {error: invalid, detail}' }
    delete:
      summary: Switch the SD pipeline off
      responses:
        '204': { description: off }
```

Also mention `pipeline` in the description of the `/sim/api/state` response: `{on:false[, error]} or {on:true, until, running}`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/control-api.test.ts test/openapi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/control-api/app.ts src/control-api/sse.ts openapi.yaml test/control-api.test.ts
git commit -m "feat(pipeline): control API switch, SSE topic, OpenAPI"
```

---

### Task 9: Web UI card

**Files:**
- Modify: `web/src/lib/state.ts` (`SimState`; the feed kinds), `web/src/pages/Simulator.svelte` (a new card between the Events/Video card and Faults)
- Test: `e2e/settings-simulator.spec.ts` (a new test)

**Interfaces:**
- Consumes: `POST/DELETE /sim/api/pipeline`, and `state.pipeline`.

- [ ] **Step 1: Write the failing e2e test**

Append to `e2e/settings-simulator.spec.ts`, reusing that file's existing sign-in/goto helpers:

```ts
test('the SD pipeline card switches on for a chosen time, shows the time left, and off', async ({ page }) => {
  await page.goto('/#simulator');
  const card = page.getByTestId('pipeline-card');
  await card.getByTestId('pipeline-minutes').selectOption('15');
  await card.getByTestId('pipeline-toggle').check();
  await expect(card.getByTestId('pipeline-left')).toHaveText(/1[45] min left/);
  await card.getByTestId('pipeline-toggle').uncheck();
  await expect(card.getByTestId('pipeline-left')).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx playwright test e2e/settings-simulator.spec.ts -g "SD pipeline"`
Expected: FAIL (`pipeline-card` not found).

- [ ] **Step 3: Implement**

`web/src/lib/state.ts`:
- In `SimState`, add `pipeline: { on: false; error?: string } | { on: true; until: number; running: boolean };`.
- Add `'pipeline'` to the feed `kind` union and to the list in `connectFeed`. Its events refresh the state like the others.

`web/src/pages/Simulator.svelte`, in the script:

```ts
  let pipeMinutes = $state(60);
  let nowMs = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (nowMs = Date.now()), 15_000);
    return () => clearInterval(t);
  });
  const pipe = $derived($simState?.pipeline);
  const pipeLeft = $derived(pipe?.on ? Math.max(0, Math.ceil((pipe.until - nowMs) / 60_000)) : 0);
  const togglePipeline = (on: boolean) =>
    void run(on ? 'SD pipeline on' : 'SD pipeline off', () => (on ? api('POST', '/pipeline', { minutes: Number(pipeMinutes) }) : api('DELETE', '/pipeline')));
```

and the card, placed after the Events/Video card:

```svelte
    <div class="card" data-testid="pipeline-card">
      <h3>SD pipeline</h3>
      <label class="switch"><input type="checkbox" data-testid="pipeline-toggle" checked={!!pipe?.on} onchange={(e) => togglePipeline(e.currentTarget.checked)} /> Overlays and flip on live SD</label>
      <label>For
        <select data-testid="pipeline-minutes" bind:value={pipeMinutes} disabled={!!pipe?.on}>
          <option value={15}>15 min</option><option value={60}>1 h</option><option value={240}>4 h</option><option value={1440}>24 h</option>
        </select>
      </label>
      {#if pipe?.on}<p data-testid="pipeline-left">On{pipe.running ? '' : ' (starting)'}, {pipeLeft} min left</p>{/if}
      {#if pipe && !pipe.on && pipe.error}<p class="err" data-testid="pipeline-error">Stopped: {pipe.error}</p>{/if}
      <p class="muted small">Applies the name, time, watermark and flip/mirror to the live SD stream only. Uses about 5–10% of a CPU core while on.</p>
    </div>
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run build && npx playwright test e2e/settings-simulator.spec.ts && npm run check`
Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/state.ts web/src/pages/Simulator.svelte e2e/settings-simulator.spec.ts
git commit -m "feat(pipeline): SD pipeline card in the web UI"
```

---

### Task 10: Packaging, smoke check, CI fonts and docs

**Files:**
- Modify:
  - `Dockerfile` (the `apk add` line)
  - `scripts/container-smoke.sh` (a pipeline check before the end)
  - `.github/workflows/pr-checks.yml` (fonts in the jobs that run vitest and e2e)
  - `README.md`, `llms.txt`, `CHANGELOG.md`

- [ ] **Step 1: Write the failing check** (container smoke)

Append to `scripts/container-smoke.sh`, before the final success message:

```bash
# The SD pipeline: on for a minute, running within 20 s, no error, then off.
ctl -X POST "http://127.0.0.1:$CONTROL/sim/api/pipeline" -d '{"minutes":1}' | jq -e '.on == true' >/dev/null || fail "pipeline on"
for _ in $(seq 1 20); do
  [ "$(ctl "http://127.0.0.1:$CONTROL/sim/api/state" | jq -r '.pipeline.running')" = true ] && break
  sleep 1
done
[ "$(ctl "http://127.0.0.1:$CONTROL/sim/api/state" | jq -r '.pipeline.running')" = true ] || fail "pipeline running (fonts or drawtext missing?)"
ctl -X DELETE "http://127.0.0.1:$CONTROL/sim/api/pipeline" -o /dev/null -w '%{http_code}' | grep -q 204 || fail "pipeline off"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `scripts/container-smoke.sh`
Expected: FAIL at "pipeline running (fonts or drawtext missing?)". Without `font-dejavu`, `findFonts()` returns null and the switch turns off with an error.

- [ ] **Step 3: Implement**

`Dockerfile`: change the ffmpeg line to

```dockerfile
# ffmpeg builds the test-pattern fixtures and publishes the RTSP streams; the
# fonts are for the optional SD pipeline's on-screen text.
RUN apk add --no-cache ffmpeg font-dejavu
```

`.github/workflows/pr-checks.yml`: in each job that runs vitest or Playwright, after "Ensure ffmpeg", add:

```yaml
      - name: Ensure DejaVu fonts (SD pipeline tests)
        run: test -f /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf || (sudo apt-get update && sudo apt-get install -y --no-install-recommends fonts-dejavu-core)
```

`README.md`:
- **Control API:** a "SD pipeline" subsection with the POST and DELETE routes, `minutes`, the state shape, auto-off, and never persisted.
- **Configuration table:** `CAMSIM_PIPELINE_MAX_MIN` and `CAMSIM_FONT_DIR`.
- **Web UI:** the Simulator page lists the SD pipeline card.
- **"What differs from the real camera":** in the OSD and image-settings bullets, add "…unless the SD pipeline is on: then the live SD stream shows them (see Control API → SD pipeline). Main, snapshots and recordings never do."

`llms.txt`: a bullet "SD pipeline: optional, time-limited; applies OSD and flip/mirror to the live SD stream (`POST /sim/api/pipeline`)."

`CHANGELOG.md`, under `## Unreleased`: "SD pipeline: an optional, time-limited re-encode of the live SD stream with the camera's name, date and time, watermark and flip/mirror (control API `/sim/api/pipeline`, the Simulator page). Off by default; the main stream, snapshots and recordings are unchanged."

- [ ] **Step 4: Run the checks to verify they pass**

Run: `scripts/container-smoke.sh && npx vitest run && npm run lint:types`
Expected: the smoke test passes, all tests pass, and there are no type errors.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile scripts/container-smoke.sh .github/workflows/pr-checks.yml README.md llms.txt CHANGELOG.md
git commit -m "feat(pipeline): fonts in the image, smoke check, CI fonts, docs"
```
