# Video Sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let cam-sim show a sequence of compatible library videos, one after another and looped, seamlessly in live view (RTSP and FLV), selected by checkmarks in the web UI, the control API or `CAMSIM_VIDEO`.

**Architecture:** A `SequenceMedia` implements the existing `MediaSource` over the videos' own `FixtureMedia`s, with one clock (time since selection modulo total length). Live FLV is the videos' tags chained with continuing timestamps (shared buffers); RTSP and the SD pipeline read the clips through ffmpeg's concat demuxer. Library preparation records a compatibility key (H.265/H.264 parameter sets + audio settings); only videos with equal keys combine, and the test pattern never does.

**Tech Stack:** TypeScript (Node), Express, ffmpeg/ffprobe, MediaMTX, Svelte 5 (web UI), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-video-sequence-design.md`

## Global Constraints

- Live view only: recordings, downloads, SD index and events keep today's behaviour; a recording keeps one video ("the video playing when it starts, by the sequence clock").
- The test pattern is never part of a sequence (Klaus: only similar content may be mixed). A list of more than one id containing `test-pattern` → 400.
- Seamless means: no player reset, no reconnect, timestamps rising, at every switch inside a sequence. Switching *to another selection* may behave as today (FLV at once, RTSP readers reconnect within a second).
- No second copy of video data in memory for a sequence: chained FLV tags reference the videos' existing `bytes` buffers (cam-sim #152).
- No re-encoding inside the sim for sequences; the sim's own conversion (`prepare()`, libx265 `veryfast`) stays as it is.
- One id (`{ "id": "a" }` or `{ "ids": ["a"] }`) behaves exactly as today's single selection.
- Library cache: bump `LIBRARY_VERSION` to 5 (meta.json gains `compat`).
- Shared encode recipe (main and sub) lives once in `scripts/lib/recipe.sh`: scale/pad to the model's main size, 20 fps main, libx265 `medium`, `-b:v 8M -maxrate 8M -bufsize 16M`, `keyint=40:min-keyint=40:bframes=0`, `-tag:v hvc1`, yuv420p; sub libx264 high 896×512 10 fps 1M, `-g 40 -keyint_min 40 -sc_threshold 0`; AAC 16 kHz mono 32k (silent when none).
- Public repo: no media committed (CI step "No media files in the repository").

## Review Focus

1. A sequence whose video loses its cached files after selection (cache folder removed): live readers must end that stream with a log line, never crash the process — test in Task 4.
2. `ids` with duplicates (`["a","a"]`) or empty list: refuse with 400 rather than play oddly — test in Task 3.
3. RTSP publisher restart (MediaMTX or ffmpeg exits) while a sequence plays: the new publisher starts at the clock's current position, not video 1 — test in Task 5.
4. Selecting the test pattern after a sequence: everything returns to today's single-video behaviour (FLV readers switch, `sequence` reported as `["test-pattern"]`) — test in Task 3.
5. A sequence of videos whose durations differ (25 s + 60 s): the clock, FLV chaining and "playing now" use each video's own length — test in Task 2.

---

### Task 1: Compatibility key at preparation

**Files:**
- Create: `src/media/compat.ts`
- Modify: `src/media/library.ts` (`LIBRARY_VERSION` 5; `prepare()` writes `compat` into meta.json; `VideoEntry.compat?: string`; cached meta read back)
- Test: `test/compat.test.ts`

**Interfaces:**
- Produces: `compatKey(mainMp4: string, subMp4: string): Promise<string>` — a short hex hash over: the main's first VPS, SPS, PPS NAL payloads; the sub's first SPS, PPS; and the audio stream's `codec_name`, `sample_rate`, `channels` (ffprobe; `none` when absent).
- Produces: `VideoEntry.compat?: string` (set for ready library videos; never for `test-pattern`).

- [ ] **Step 1: Write the failing tests** in `test/compat.test.ts`, generating small pairs in the test with ffmpeg (640×360 main H.265, 320×180 sub H.264, 2 s, silent AAC 16 kHz):
  - `same recipe, different content → same key` (testsrc2 vs testsrc2 with `hue=h=120`, identical encoder args): `expect(a).toBe(b)`.
  - `different x265 preset → different key` (`veryfast` vs `medium`): `expect(a).not.toBe(b)`.
  - `different audio sample rate → different key` (16000 vs 48000).
  - `a prepared library video reports compat in list()`: prepare a pair through `Library` (as `test/library-edges.test.ts` does) and `expect(lib.list().find(v => v.id === 'pair')!.compat).toMatch(/^[0-9a-f]{12,}$/)`; `test-pattern` has none.
- [ ] **Step 2: Run** `npx vitest run test/compat.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `compatKey` (ffmpeg `-frames:v 1 -c copy -bsf:v hevc_mp4toannexb|h264_mp4toannexb -f hevc|h264 -` and `splitAnnexB` from `src/media/flv.ts`; sha256, first 16 hex chars). In `prepare()`, compute it from `out.clipMain`/`out.clipSub` and store `compat` in meta.json; surface it on the entry.
- [ ] **Step 4: Run** `npx vitest run test/compat.test.ts test/library.test.ts test/library-edges.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/media/compat.ts src/media/library.ts test/compat.test.ts && git commit -m "Library: compatibility key per prepared video"`

### Task 2: SequenceMedia

**Files:**
- Modify: `src/media/source.ts` (optional members on `MediaSource`)
- Create: `src/media/sequence.ts`
- Test: `test/sequence-media.test.ts`

**Interfaces:**
- Produces on `MediaSource` (all optional; `FixtureMedia` unchanged):
  - `currentId?(): string` — the video playing now.
  - `startMs?(stream: LiveStream): number` — where a new live reader joins: the clock position snapped down to the last keyframe at or before it, in the chained FLV's timeline.
  - `inputArgs?(stream: Stream): string[]` — ffmpeg input args replacing `['-i', clipPath(stream)]`.
- Produces: `class SequenceMedia implements MediaSource` with `constructor(items: Array<{ id: string; media: MediaSource }>, opts: { now?: () => number; listDir: string })`; `ids(): string[]`; `position(now?: number): { index: number; offsetMs: number }`; `release()` releases nothing of the items (they stay registered).
  - `liveFlv(stream)`: header and config/script tags of item 0; then each item's non-config, non-script, non-end-of-sequence tags as new `FlvTag` objects `{ ...t, ms: t.ms + offset }` (same `bytes` buffer), offset = sum of earlier items' `durationMs(stream)`. Cached per stream.
  - `durationMs(stream)`: sum of items' `durationMs(stream)`.
  - `snapshot()`, `clipPath()`, `clipSize()`: those of the current item (by `position()` on the main stream).
  - `inputArgs(stream)`: writes `<listDir>/<stream>.txt` once (`file '<item clipPath>'` per item, absolute paths, quotes escaped) and returns `['-ss', <position seconds, 3 decimals>, '-f', 'concat', '-safe', '0', '-i', listFile]`.
  - The clock starts at construction (`now()`), so selecting starts the sequence at video 1.

- [ ] **Step 1: Write the failing tests** with fake items (`MediaSource` stubs whose `liveFlv` returns a header, one config tag and keyframe/non-keyframe tags at 0, 50, … ms; durations 1000 ms and 2500 ms — Review Focus 5):
  - `chains tags with continuing timestamps and one config tag`: video tags' `ms` strictly rising; exactly one config tag; the first tag of item 2 at ≥ 1000; `bytes` identical objects (`toBe`) to the items'.
  - `durationMs is the sum`: 3500.
  - `position follows the clock across items of different length`: now = start + 1200 → `{ index: 1, offsetMs: 200 }`; start + 3600 → `{ index: 0, offsetMs: 100 }`.
  - `startMs snaps to the last keyframe at or before the clock`.
  - `currentId, snapshot and clipPath follow the playing item`.
  - `inputArgs writes a concat list and seeks to the position`: file content lists both clip paths in order; args contain `-f concat -safe 0` and `-ss` equal to the position in seconds.
- [ ] **Step 2: Run** `npx vitest run test/sequence-media.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/media/sequence.ts` and the optional members in `src/media/source.ts`.
- [ ] **Step 4: Run** the test — Expected: PASS. `npm run check` clean.
- [ ] **Step 5: Commit** `git commit -m "SequenceMedia: several videos as one source with one clock"`

### Task 3: Selecting a sequence (library, engine, control API, CAMSIM_VIDEO)

**Files:**
- Modify: `src/media/library.ts` (`selectSequence`), `src/engine/engine.ts` (`sequence` state; `currentVideo` for recordings), `src/control-api/app.ts` (`PUT /video`, `GET /videos`), `src/index.ts` (comma list), `src/config.ts` (comment/validation of `CAMSIM_VIDEO`), `openapi.yaml`
- Test: `test/control-videos.test.ts` (extend), `test/library.test.ts` (extend)

**Interfaces:**
- Consumes: `SequenceMedia` (Task 2), `VideoEntry.compat` (Task 1).
- Produces: `Library.selectSequence(ids: string[]): { status: 400 | 404 | 409; error: string; detail: string } | null`. One id → today's `select(id)` path (unchanged behaviour). More than one: every id known (404 `not_found`), ready (409 `not_ready`), no duplicates and not empty (400 `invalid`), no `test-pattern` (400 `invalid`, detail "the test pattern can't be part of a sequence"), all `compat` equal (409 `incompatible`, detail naming the ids that differ from the first). On success builds `SequenceMedia` (listDir: a folder in the library cache dir, e.g. `<cacheDir>/.sequence`), preloads like `select()` does, and calls `engine.setMedia(media, ids[0], ids)`.
- Produces: `Engine.setMedia(media: MediaSource, id: string, sequence?: string[])`; `engine.sequence: string[]` (`[id]` for one video); `state()` gains `sequence`; recordings' `currentVideo` → `this.media.currentId?.() ?? this.videoId`.
- Produces: `PUT /sim/api/video` accepts `{ id }` or `{ ids: string[] }` (max 32 ids, each ≤ 64 chars); answers `{ selected, sequence }`. `GET /sim/api/videos` answers `{ selected, sequence, playing, videos }`, each video with `compat` when known; `playing` = `media.currentId?.() ?? selected`.
- Produces: `CAMSIM_VIDEO=a,b,c` → `selectSequence(['a','b','c'])` after `prepareAll()`; on refusal log `video_not_selected` with the detail and keep the test pattern.

- [ ] **Step 1: Write the failing tests** in `test/control-videos.test.ts` with two compatible generated library videos (both converted by the sim, so equal `compat`) and one incompatible pair (copied pair with another preset):
  - `PUT {ids:[a,b]} selects a sequence`: 200 `{ selected: 'a', sequence: ['a','b'] }`; `GET /videos` shows `sequence` and `playing: 'a'`.
  - `refuses an incompatible video`: 409 `incompatible`, detail names it.
  - `refuses the test pattern in a sequence`: `{ids:['test-pattern','a']}` → 400.
  - `refuses duplicates and an empty list` (Review Focus 2): 400 each.
  - `one id behaves as before`: `{ids:['a']}` and `{id:'a'}` give the same answer and state.
  - `the test pattern after a sequence` (Review Focus 4): `{id:'test-pattern'}` → `sequence: ['test-pattern']`, `playing: 'test-pattern'`.
  - `CAMSIM_VIDEO list` (in `test/library.test.ts` or the index test): `a,b` selects the sequence after preparation; `a,test-pattern` logs `video_not_selected`.
- [ ] **Step 2: Run** `npx vitest run test/control-videos.test.ts test/library.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces; document the API change in `openapi.yaml`.
- [ ] **Step 4: Run** the tests — Expected: PASS; `npm run check` clean.
- [ ] **Step 5: Commit** `git commit -m "Select a sequence of compatible videos (API, CAMSIM_VIDEO)"`

### Task 4: FLV live readers join the sequence clock

**Files:**
- Modify: `src/camera-api/media-routes.ts` (`streamFlv`: `load()` and `restartLoop()`)
- Test: `test/flv-stream.test.ts` (extend)

**Interfaces:**
- Consumes: `MediaSource.startMs?(stream)` (Task 2).
- Behaviour: when the source has `startMs`, a reader (new, or after a switch to this source) gets the config/script tags first, then tags from the keyframe at `startMs`, with timestamps continuing from the reader's own `lastMs` (never backwards); loops continue with the full chained loop. Sources without `startMs` behave exactly as today.

- [ ] **Step 1: Write the failing tests** (Review Focus 1 included):
  - `a reader joining a sequence starts at the clock's keyframe`: sequence of two small videos, clock advanced past video 1; the first video tag after the config tags is a keyframe of video 2's span.
  - `timestamps rise across the switch inside a sequence`: read 1.5 loops; all video tag timestamps strictly rising, one config tag at the start only.
  - `a single video still starts at its beginning` (unchanged).
  - `a sequence video whose files vanish ends the stream, not the process`: remove one cached `main.flv` after selection, open a reader → stream closed, `flv_switch_failed` or a new `flv_source_failed` warning logged, process alive.
- [ ] **Step 2: Run** `npx vitest run test/flv-stream.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** in `streamFlv`.
- [ ] **Step 4: Run** `npx vitest run test/flv-stream.test.ts test/pipeline-flv.test.ts test/flv.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "FLV: readers join a sequence at its clock"`

### Task 5: RTSP and the SD pipeline read the sequence

**Files:**
- Modify: `src/rtsp/rtsp.ts` (`publish()`), `src/pipeline/sd-pipeline.ts` (input args)
- Create (if useful): helper `inputArgsOf(media: MediaSource, stream: Stream): string[]` in `src/media/source.ts` → `media.inputArgs?.(stream) ?? ['-i', media.clipPath(stream)]`
- Test: `test/rtsp.test.ts` (extend), `test/sequence-media.test.ts` (helper)

**Interfaces:**
- Consumes: `MediaSource.inputArgs?` (Task 2).
- Behaviour: the publisher spawns `ffmpeg … -re -stream_loop -1 <inputArgs> … -c copy` (unchanged otherwise); each (re)start of a publisher asks `inputArgs` again, so it starts at the clock's position (Review Focus 3). The SD pipeline uses `inputArgsOf(e.media, 'sub')` the same way.

- [ ] **Step 1: Write the failing tests:**
  - `inputArgsOf falls back to -i clipPath` for a `FixtureMedia`.
  - `RTSP plays a sequence without a reconnect` (needs MediaMTX like the existing RTSP tests): two compatible 2 s videos; read `rtsp://…/h264Preview_01_main` with ffprobe `-show_packets` for 6 s → packets present across ≥ 2 switches, `pts_time` strictly rising, ffprobe exit 0.
  - `a restarted publisher starts at the clock` (Review Focus 3): kill the publisher's ffmpeg; the respawn's args contain `-ss` equal (±0.1 s) to the position at that time (spy on `spawn` or read the logged args).
- [ ] **Step 2: Run** `npx vitest run test/rtsp.test.ts test/sequence-media.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** in `publish()` and the SD pipeline.
- [ ] **Step 4: Run** `npx vitest run test/rtsp.test.ts test/rtsp-sdp.test.ts test/sequence-media.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "RTSP and SD pipeline: play the sequence through concat"`

### Task 6: Web UI checkmarks

**Files:**
- Modify: `web/src/components/VideoPicker.svelte`
- Test: `e2e/video.spec.ts` (extend), `e2e/make-library.mjs` (a second generated video, e.g. `Lane.mp4`, same encode as `Yard.mp4` with another hue, so both convert compatibly)

**Interfaces:**
- Consumes: `GET /videos` `{ selected, sequence, playing, videos[].compat }`, `PUT /video { id } | { ids }` (Task 3).
- Behaviour: the test pattern is a radio-like choice ("Test pattern"); every ready library video has a checkbox. Checking/unchecking sends `PUT /video { ids }` with the checked videos in list order (unchecking the last one selects the test pattern). Once one video is checked, videos whose `compat` differs are disabled with the reason "Different encoding: run scripts/library-normalize.sh to combine it". The playing video is marked "playing now". Error details from the API are shown as today.

- [ ] **Step 1: Write the failing e2e test** `checking two videos plays them as a sequence`: check `yard` and `lane` → `GET /sim/api/videos` shows `sequence: ['lane','yard']` (list order); "playing now" visible on one of them; choosing "Test pattern" → `sequence: ['test-pattern']`.
- [ ] **Step 2: Run** `npx playwright test e2e/video.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** in `VideoPicker.svelte`.
- [ ] **Step 4: Run** `npm run build && npx playwright test e2e/video.spec.ts e2e/settings-simulator.spec.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Web UI: check library videos to play a sequence"`

### Task 7: Shared recipe, library-normalize.sh, docs

**Files:**
- Create: `scripts/lib/recipe.sh` (functions `encode_main <in> <out> <start> <seconds>` and `encode_sub …`, model sizes as in `library-meva.sh`), `scripts/library-normalize.sh <library-folder> [--seconds N]`
- Modify: `scripts/library-meva.sh` (source the recipe), `README.md` (*Video library*: sequences, compatibility, normalising, memory note linking #152; control API table), `CHANGELOG.md` (Unreleased)
- Test: manual (below); `bash -n` on the scripts.

- [ ] **Step 1:** Move the encode commands of `library-meva.sh` into `scripts/lib/recipe.sh` unchanged in effect; `library-meva.sh` sources it.
- [ ] **Step 2: Verify the recipe did not change:** rebuild `meva-parking-g340` into a temp folder with the refactored script; `compatKey` of the result (via a one-line `node -e` using `dist/src/media/compat.js` after `npm run build`) equals that of `~/Development/cam-sim/library/meva-courtyard-g638`.
- [ ] **Step 3:** Write `library-normalize.sh`: re-encodes `<folder>/main.mp4` (+ its audio) into a new folder `<folder>-normalized/` with `main.mp4`, `sub.mp4` (sub made from the main), and copies `CREDITS.txt` if present; refuses to overwrite.
- [ ] **Step 4: Verify** on a generated 5 s 1280×720 H.264 file: the normalised result's key equals the MEVA key from Step 2.
- [ ] **Step 5:** README and CHANGELOG; commit `git commit -m "scripts: shared encode recipe, library-normalize.sh; docs for sequences"`

### Task 8: End-to-end check through cam-proxy (manual, before release)

- [ ] Start the local sim stack (`~/Development/cams/scripts/livestack/start-sim-stack.sh`, cam-sim from this branch) with `CAMSIM_LIBRARY_DIR` pointing at a folder with two MEVA clips; select both as a sequence; open the camera's live view in the local cams and watch ≥ 2 switches: no freeze over 0.5 s, no player reset (the spike's probe script: `video.getVideoPlaybackQuality()` sampled every 100 ms for 150 s, no `error`/`emptied` events). Record the result in the PR.
