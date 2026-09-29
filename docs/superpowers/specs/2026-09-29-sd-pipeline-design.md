# SD pipeline: the camera's overlays and flip on the live SD stream (design)

Status: design approved by Klaus (2026-09-29). This is the spec for review.

## Goal

A camera's on-screen text and orientation settings are stored by cam-sim, but
they never change its picture. That is documented today in the README, under
"What differs". This feature adds an **optional** pipeline that applies those
settings to the **live SD (sub) stream**, so that a client can see them take
effect: cams' Settings, cam-proxy's stills and previews, and anyone watching
Live.

It is off by default. It is switched on for a chosen time and switches itself
off afterwards, because it costs a continuous re-encode (measured below).

## Decisions (Klaus, 2026-09-29)

| Topic | Decision |
|---|---|
| Streams | SD (sub) only. Main (4K / `CAMSIM_MAIN_SIZE`) stays as its source. |
| Outputs | Live only: FLV `channel0_sub` and RTSP `h264Preview_01_sub`. Snapshots, recordings, downloads and FTP uploads are unchanged. |
| Effects | The camera name (`Osd.osdChannel`), the date and time (`Osd.osdTime`), the watermark (`Osd.watermark`), and flip/mirror (`Isp.rotation`, `Isp.mirroring`). |
| Switching | On through the control API and the web UI, with a duration chosen when it is switched on. It switches itself off when the time runs out. It is off after every restart. |
| Sources | Library videos are expected to be free of overlays (captured with the camera's OSD off). The test pattern has no text. |

## Cost (measured 2026-09-29, Apple M4, one core, a real cam1 sub clip)

| | CPU |
|---|---|
| SD 896×512 at 10 fps: decode only | 0.2% of a core |
| SD: decode, flip, text, H.264 encode (veryfast) | 3% of a core |
| Main 1080p at 20 fps, the same steps in HEVC (for comparison; not built) | 95% of a core |

On the cluster node, and with busier footage, expect about 5 to 10% of a core
per camera while the pipeline is on.

## Behaviour

### Switching

- **On:** `POST /sim/api/pipeline` with `{"minutes": 60}`.
  - `minutes` is an integer from 1 to `CAMSIM_PIPELINE_MAX_MIN`. That setting defaults to 1440 (24 h), and is itself 1–1440.
  - A missing `minutes` means 60. Anything else answers 400 `{"error":"invalid"}`.
  - Calling it while the pipeline is on sets a new end time. It answers 200 with the pipeline state.
- **Off:** `DELETE /sim/api/pipeline` answers 204. It also happens when the end time is reached.
- **State:** `GET /sim/api/state` gains `pipeline`:
  - `{ on: false }`, or
  - `{ on: true, until: <unix ms>, running: <bool> }`.
  - `error: "<message>"` is added after a failure (see Failures). It stays until the next switch-on.

  A change emits a bus `pipeline` event, which SSE forwards, so the web UI updates live.
- The pipeline is never persisted: after a restart, power-on or `POST /sim/api/reset` it is off.
- Power off, rebooting and the camera being offline stop the ffmpeg process but keep the switch and its timer. When the camera is back and the time hasn't run out, it starts again, the same way the RTSP publishers do today.

### What is drawn

All of it is read from `settings.running`, and reapplied on every bus
`settings` event and after a reboot (`state` with `rebooting: false`):

- **Flip and mirror:** `Isp.rotation: 1` becomes `vflip` (upside down). `Isp.mirroring: 1` becomes `hflip` (left–right). Both together give 180°. This matches the real camera, measured 2026-09-29. The flip is applied before the text, so the text is never mirrored.
- **Camera name:** `Osd.osdChannel.enable`, `.name` and `.pos`.
- **Date and time:** `Osd.osdTime.enable` and `.pos`.
  - The format follows the camera's `GetTime` (`timeFmt` `MM/DD/YYYY`, `hourFmt` 1 = 12 h), in the camera's time zone (`CAMSIM_TZ`), e.g. `09/29/2026 11:51:48 am TUE`.
  - With `hourFmt` 0 it is 24 h with no am/pm. Only the formats cam-sim itself reports need to be supported.
- **Watermark:** `Osd.watermark: 1` draws "Reolink" top left, in white at about 80% opacity, bold, larger than the OSD text.
- **Positions:** the six OSD positions (`Upper Left`, `Top Center`, `Upper Right`, `Lower Left`, `Bottom Center`, `Lower Right`) map to fixed coordinates with a 10 px margin.
  - All OSD text is white, 20 px DejaVu Sans, with a thin dark border for contrast.
  - When the name and the time share a position, the time goes above the name.
  - When the watermark and a text share `Upper Left`, the text moves below the watermark.
- **Why a clock file:** ffmpeg's own time expansion can't produce the camera's style (lower-case `am`, upper-case weekday). So cam-sim writes the formatted time to a small file (`<tmp>/clock.txt`) once a second, by write-then-rename, and `drawtext` reads it with `reload=1`. The name comes from a file too (`name.txt`), which avoids escaping it into the filter.

### The process

- **One ffmpeg per camera**, while the pipeline is on and the camera is serving:
  - **Input:** `-re -stream_loop -1 -i <media.clipPath('sub')>`, the current video's SD clip.
  - **Filters:** `vflip`/`hflip` as set, then the `drawtext` filters for watermark, name and time.
  - **Encode:** libx264 `-preset veryfast`, 896×512 at 10 fps, `-g 40 -bf 0`, about 1 Mb/s, `yuv420p`, `-tune zerolatency`. The audio is copied from the clip (AAC).
  - **Output:** two outputs through `tee`:
    1. RTSP to MediaMTX's `h264Preview_01_sub`, as the publisher user. It replaces the stream-copy publisher for sub while the pipeline runs. The main publisher is unchanged.
    2. FLV to stdout.
- **A new `LiveSubSource`** parses that FLV incrementally (header, script tag, config tags, then media tags) and fans the tags out to FLV clients:
  - A client that connects gets the header and the config tags, then media from the next keyframe on.
  - Timestamps are rebased per client from its own start, so they rise monotonically across restarts.
  - Backpressure keeps today's rule: a client over `flvBufferBytes` is dropped.
- **Serving `channel0_sub`:** `/flv` uses the `LiveSubSource` while the pipeline runs, and today's looped in-memory FLV otherwise.
  - Switching between them works like a video switch today: new config tags, then a rebase.
  - The web UI's live view (`/sim/api/media/live/sub`) goes through the same code.
- **Restarts:** a settings change, a video switch or `dropReaders` restarts the process after ending the old one. The gap is about a second, as on the real camera.
  - FLV clients stay connected and continue after the restart.
  - RTSP readers are cut, as today when a publisher restarts.
- **Failures:**
  - If ffmpeg exits unexpectedly, it restarts once after 1 s.
  - A second failure within 60 s switches the pipeline off with `error` set, the ffmpeg stderr's last line, cleared of paths. The plain SD stream then returns.
  - At switch-on, a missing font or a `drawtext` that isn't available fails the same way.

### Unchanged

- The main stream, in FLV and RTSP.
- `Snap`, recordings, `Download`, FTP uploads, the web UI's snapshot and recordings.
- Everything while the pipeline is off: byte for byte today's behaviour, and no ffmpeg beyond today's publishers.

## Web UI

The Simulator page gets an **SD pipeline** card between Video and Faults:

- A switch, and a duration select: 15 min, 1 h (default), 4 h, 24 h, capped at `CAMSIM_PIPELINE_MAX_MIN`.
- While on: "On, N min left", counting down from `until`.
- A note: "Applies the name, time, watermark and flip/mirror to the live SD stream only. Uses about 5–10% of a CPU core while on."
- An error line after a failure.

It uses the existing session and CSRF header, like the fault switches.

## Configuration and packaging

- New: `CAMSIM_PIPELINE_MAX_MIN` (default 1440, range 1–1440).
- Docker: `apk add font-dejavu`. The font path is fixed at `/usr/share/fonts/dejavu/DejaVuSans.ttf` and `DejaVuSans-Bold.ttf`. `CAMSIM_FONT_DIR` overrides it, which is useful on a Mac for development.
- Alpine's ffmpeg must have `drawtext`, which needs libfreetype. cam-proxy's Alpine image already uses `drawtext` with DejaVu. The container smoke test checks it.

## Docs

- README:
  - control API (`/pipeline`) and web UI sections;
  - configuration (`CAMSIM_PIPELINE_MAX_MIN`, `CAMSIM_FONT_DIR`);
  - "What differs": the OSD and image-settings bullets say the pipeline can apply them to live SD.
- `openapi.yaml`: `/sim/api/pipeline`, and `pipeline` in the state.
- `llms.txt`: one line.
- CHANGELOG.

## Testing

- **Unit:**
  - settings to filter chain (flip combinations, each OSD part on or off, the six positions, a shared position, watermark with Upper Left);
  - clock text (12 h and 24 h, am/pm, weekday, the time zone across a DST change);
  - the switch state and timer with fake timers: on, extend, auto-off, off on reset, validation of `minutes`.
- **FLV parsing:** the incremental parser on chunked input, fed with a real ffmpeg FLV.
- **Integration with real ffmpeg on the test pattern:**
  - Pipeline on: an FLV client receives a keyframe-first stream that ffprobe reads as H.264 896×512.
  - An RTSP reader gets frames.
  - Flip: a decoded frame with rotation and mirroring on equals the pipeline-off frame turned 180°, within a tolerance, away from the text areas.
  - Text: with the name on, its area differs from the same area with the name off.
  - A settings change restarts the pipeline, and the FLV client keeps receiving.
  - Auto-off after the duration returns the plain stream.
  - A failing ffmpeg (a bad font path) turns it off with `error`.
- **Web UI (Playwright):** switch on with a duration, see the time left, switch off.
- **cams compatibility:** unchanged. The pipeline is off by default.

## Out of scope

Main-stream processing; snapshots, recordings and downloads with overlays;
day/night (black and white), IR and spotlight effects; the real Reolink logo
image; time formats cam-sim doesn't report; hardware encoders.
