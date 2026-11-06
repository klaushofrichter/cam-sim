# Video sequence: several library videos played one after another

Status: design, 2026-11-06. Agreed with Klaus in chat; marked calls are mine.

## Why

A simulated camera that loops one 60 s clip looks artificial in live view.
Klaus wants to pick several library videos and have the camera show them
one after another, endlessly, so a cams live view of cam2 looks like a
camera watching a place where things happen.

It is for **live view** (Klaus: "This is for the Live view"). Recordings,
downloads, events and detections are not the goal.

## What Klaus decided

- In the web UI's Simulator page, each library video gets a **checkmark**.
  The checked videos play **one after another**, then start again.
- The camera shows **either the test pattern or a sequence** of library
  videos, never both. The test pattern is not part of a sequence, so
  there is no switch between the test pattern and a stored video.
- The switch from one video to the next must be **seamless** in live view.
- Klaus's own captured footage stays out for now (only the MEVA clips).

## What the spike measured (2026-11-06)

Throwaway chain like live view: MediaMTX fed by
`ffmpeg -re -stream_loop -1 -f concat … -c copy` → go2rtc (as cam-proxy runs
it) → go2rtc's MSE player in Chrome, watched 40 s per case:

| Sequence | Result |
|---|---|
| MEVA clip → MEVA clip (same encode recipe) | seamless: no freeze over 0.2 s, no player error, 3 switches |
| 1280×720 test pattern → 4512×2512 clip | `PIPELINE_ERROR_DECODE`, player resets, up to 17 s blank per switch |
| 4512×2512 test pattern (other encoder settings) → clip | the same failure |

The deciding property is the H.265 **parameter sets** (VPS, SPS, PPS): the
four MEVA clips have byte-identical ones (made by `scripts/library-meva.sh`)
and switch seamlessly; any difference breaks MSE. A real-camera capture
(Backyard Left) differs as captured, and is identical once re-encoded with
the MEVA recipe (scale/pad to 4512×2512, 20 fps, libx265 `medium`, 8 Mbit/s
max, keyint 40, no B-frames, yuv420p).

## Goals

1. Select a sequence of one or more library videos (control API, web UI,
   and `CAMSIM_VIDEO` at start); a sequence of one is today's single video.
2. Live view of the sequence is seamless on every stream a client watches
   live: RTSP main and sub (what cam-proxy's go2rtc reads), FLV main, sub
   and ext (the Reolink app's path, cam-proxy's ext feed).
3. Only videos that can follow each other seamlessly can be combined: the
   sim knows which library videos are compatible and refuses (API) or
   greys out (UI) the others.
4. One documented way to make a video compatible: the encode recipe, in a
   script that runs on the Mac (heavy work stays off the cluster).

## Non-goals

- Recordings, downloads, the SD card index and events: unchanged in
  behaviour. A recording keeps one video (see *Recordings* below).
- Mixing the test pattern into a sequence, or a "seconds" setting for it.
- Transitions, fades, per-video durations or trimming inside the sim.
- Re-encoding inside the sim at selection time (about 1 GB of memory and
  minutes of CPU per camera-sized minute; cam2 has 1 GiB in all).

## Anti-goals

- A sequence that glitches, freezes or resets the player at a switch is a
  failure even if it "works".
- Making cam2 in the cluster need more memory than a single video does
  today beyond what the sequence's own videos cost (see *Memory*).

## How it works

### Compatibility (the gate)

- When a library video is prepared, the sim records the parameter sets of
  its main (VPS/SPS/PPS) and sub (SPS/PPS) streams, and its audio settings
  (codec, sample rate, channels: a mismatch also breaks `-c copy` concat
  and MSE), in the cached `meta.json`, as a short key (*my call*).
- Two videos are compatible when both hashes match. A sequence is valid
  when all its videos are compatible with each other.
- The ext stream is made by the sim itself from the main copy (x264, fixed
  settings), so its parameters follow from the main's size; no extra check
  (*my call*; the builder confirms ext stays seamless in the test below).
- The test pattern is never compatible with anything (not offered).

### Making videos compatible

- `scripts/library-meva.sh` already produces compatible pairs.
- A new `scripts/library-normalize.sh <folder>` (*my call* on the name)
  re-encodes any library pair or video file with exactly the same recipe
  (main and sub), so captures from `capture-clip.py` become compatible.
  The recipe lives once, shared by both scripts.
- Pairs copied unchanged by the sim (today's behaviour) stay as they are;
  they are simply incompatible with others unless their sets happen to
  match.
- The sim's own conversion of dropped-in files (`prepare()`: libx265
  `veryfast`) stays as it is (*my call*): the shared recipe uses the slower
  `medium` preset, and heavy encoding stays off the cluster. Converted
  videos are therefore compatible only with each other; the UI's greyed-out
  reason and the README say to run `library-normalize.sh` on the Mac. The
  recipe is per camera model (main size, frame rates), taken the way
  `library-meva.sh` takes it.

### Selecting

- Control API: `PUT /sim/api/video` accepts `{ "ids": ["a", "b", …] }`
  besides today's `{ "id": "a" }` (one id = a sequence of one). `GET
  /sim/api/videos` reports `selected` as today (the first, for old
  clients) plus `sequence` (the ids), and per video `compatibleWith` or a
  compatibility group key (*builder's choice*).
- Refusals: an id that isn't ready → as today; incompatible ids → 409
  `incompatible`, naming the videos; `test-pattern` inside a list of more
  than one → 400.
- `CAMSIM_VIDEO` accepts a comma-separated list (*my call*), applied once
  all its videos are ready, refused with a warning (and the test pattern)
  when they're incompatible.
- Order: the order given (the API list; in the UI, the list's order).
  Reordering in the UI is not required (*my call*: list order is enough
  for now).
- The selection survives a restart the same way a single selection does
  today (*builder to check what that is and keep it consistent*).

### Playing

**One sequence clock** (*my call*: a real camera shows every viewer the
same moment). The engine keeps the sequence's position as the time since
the sequence was selected, modulo its total length. Every live reader
joins at that position, at the next keyframe: a new FLV reader does not
start at video 1 (today each FLV reader starts its fixture from the
beginning; that changes for sequences), and "playing now" (snapshot, UI,
recordings) is that position. The RTSP publisher starts at the position
when (re)started and then runs on; a small drift between RTSP and the
clock is acceptable (*builder: keep it within a few seconds*).

- **RTSP** (main, sub): one publisher per stream reading the sequence as one
  input (ffmpeg concat of the clips, `-c copy`, looped), so MediaMTX and
  its readers see one continuous stream with no reconnect at a switch.
  This is what the spike ran.
- **FLV** (main, sub, ext): the live FLV of a sequence is the clips' tags one
  after another, timestamps continuing across the switch, one sequence
  header at the start (the sets are identical, so none is needed at a
  switch), looped as today.
- **Snapshot**: the snapshot of the video playing now, by the clock.
- **SD pipeline** (live sub with the drawn OSD, `src/pipeline/sd-pipeline.ts`):
  while it is on, it reads the same looped concat input as the RTSP
  publisher, so sub follows the sequence too (*my call*).
- Changing the selection switches as today (FLV at once, RTSP within a
  second, readers reconnect); only switches *inside* a sequence must be
  seamless.

### Recordings

A recording made while a sequence plays is made from the video playing when
it starts, by the sequence clock, as today's recordings keep the video they were made from (*my
call*: simplest, and recordings are not this feature's goal).

### Memory

Each video's live FLV is held in memory once watched (cam-sim #152). A
sequence of N videos therefore holds N videos' FLV (about 60 MB per minute
of main at 8 Mbit/s, plus sub and ext). The design must not add a second
copy: the sequence's FLV is built from the videos' own tags (references,
not copies). cam2 (1 GiB, four 60 s clips) fits; the README's deployment
notes say how to size it.

## Web UI

- Simulator page: the video list shows a checkbox per library video and the
  test pattern as a separate option (radio-like: test pattern *or* the
  checked sequence).
- Incompatible videos: greyed out once a video is checked, with a short
  reason ("different encoding; run scripts/library-normalize.sh").
- The page shows which video of the sequence is playing now (*my call*,
  small text; nice to have).

## Tests the builder needs

- Unit: compatibility hash from parameter sets; sequence validation and
  refusals; FLV tag concatenation with continuous timestamps; `CAMSIM_VIDEO`
  list parsing.
- Integration: two small compatible pairs (made in the test with one
  recipe) played as a sequence over RTSP and FLV: frames and timestamps
  continue across the switch, no reconnect; an incompatible pair is
  refused.
- A manual check like the spike before release: cams live view of a local
  sim with two MEVA clips, through cam-proxy (livestack), watched across
  two switches.

## Left to the builder

- Data shapes in `meta.json` and the API (within the above).
- How the RTSP publisher gets its concat input (list file in the cache,
  or another ffmpeg input).
- UI layout details.

## Deployment

- cam2 in the cluster: load only compatible videos (the four MEVA clips
  already are). Release as usual; nothing in kube-setup changes.
