# Changelog

## Unreleased

- SD pipeline: an optional, time-limited re-encode of the live SD stream (FLV and RTSP) with the camera's name, date and time, watermark and flip/mirror (`POST/DELETE /sim/api/pipeline`, the Simulator page). Off by default; the main stream, snapshots and recordings are unchanged. New settings `CAMSIM_PIPELINE_MAX_MIN` and `CAMSIM_FONT_DIR`; the image adds `font-dejavu`.

- Search answers like the real camera (measured 2026-09-29): only the start day is searched, from the start to the end time of day; `Status` lists only months with recordings and is added to clips searches; empty keys are left out; `onlyStatus` with reversed months answers `-64`.
- README: image settings (day/night, rotation, mirroring, lights) are stored but don't change the video.

- `GetDevInfo.simulator` carries the build's version (`cam-sim <APP_VERSION>`), so cams can show which cam-sim a camera is.
- `GetDevInfo` answers `simulator: "cam-sim"` (the one field the real camera
  doesn't send), so clients can label the camera as simulated.

- `rtsp.refuse` only turns new RTSP readers away; connected readers keep
  watching (`rtsp.reset`, offline and RTSP off still cut them).

## v2026.09.27.2

- Named test states (#23): `POST /sim/api/actions/clear` (content only) and
  `POST /sim/api/actions/factory-reset` (everything back to the factory state,
  then a reboot), with buttons on the Simulator page.
- The sub stream (test pattern and library videos) has a keyframe every 4 s,
  as on the camera and in its `GetEnc` gop (#24); the fixture and library
  caches rebuild once.
- FTP upload follows the real camera's session (#25): CWD per folder with MKD
  when missing, PASV only, the JPEG in a parallel session; TestFtp runs a whole
  session and stores a `.txt`; recordings start 4 s before the event with
  `preRec` 1 (pre-record).
- README checked against the code and brought up to date (status, Docker
  ports, cam2 on the LAN and its library, secrets, CI), with screenshots of
  the Live and Simulator pages. The Live page no longer says the video library
  is still to come.

## v2026.09.26.4 – v2026.09.27.1

- ONVIF (Plan 5): device service (`GetDeviceInformation`, `GetCapabilities`,
  `GetServices`) and PullPoint events on `CAMSIM_ONVIF_PORT` (8000), as
  captured from the camera: WS-UsernameToken sign-in, `Initialized` state on
  subscribe, `Changed` on simulated detections (motion, person, vehicle, pet).
  The capture is in `reference/rlc-1224a/onvif` (sign-in digests redacted).

- Video library (Plan 2): `CAMSIM_LIBRARY_DIR` videos are prepared after
  start (any video converted to the camera's formats; a captured `main.mp4` +
  `sub.mp4` pair copied) and cached; `CAMSIM_VIDEO`, `PUT /sim/api/video` or
  the Simulator page's picker selects one. Live FLV switches at once, RTSP
  within a second, snapshots and new recordings follow; a recording keeps the
  video it was made from. `GET /sim/api/videos`, `/videos/{id}/poster`,
  `reset {video}`, SSE `video`, `state.video`, and `CAMSIM_MAIN_SIZE`.

- RTSP (Plan 5): `h264Preview_01_main` / `_sub` on `CAMSIM_RTSP_PORT` (8554)
  through MediaMTX (in the image), signed in with the camera users; refused
  when RTSP is off, the camera is offline or off, or under `rtsp.refuse`.

- FTP upload (Plan 6): each finished recording goes to an FTP or FTPS server
  as `<remoteDir>/YYYY/MM/DD/<Name>_00_YYYYMMDDHHMMSS.mp4` plus a `.jpg`, like
  the camera; `TestFtp` answers as measured on the real camera (`-56` for a
  partial object, `-454` when it can't connect); faults `ftp.fail` and
  `ftp.delayMs`; `CAMSIM_FTP_*` sets it up at start.

- Web UI (Plan 3, `CAMSIM_WEB_UI=true`): token sign-in with a session cookie;
  Live (sub and main, snapshot, event triggers), Playback (calendar,
  recordings, playback, downloads), Settings (whole-object writes with the
  camera's validation) and Simulator (power, events, faults, actions, reset,
  counters, live log). The control API gains the routes it uses (media,
  recordings, settings, users) and accepts the session cookie, with the
  `X-CamSim-UI` header required for writes.
- `scripts/cam-ui.sh`: finds a camera in local Docker or the cluster and opens
  its UI.
- The captured RLC-1224A reference replies are in the repository.

- cam2 runs in the cluster (Plan 4): `cam2.skylar.technology` with a Let's
  Encrypt certificate pushed daily like cam1's, and cams shows it next to Den.
  The release workflow now deploys it (pinned by digest in kube-setup) before
  tagging.
- `scripts/sync-secrets.sh`: syncs `KUBE_SETUP_DEPLOY_TOKEN` (GitHub refuses
  `GITHUB_*` names), creates `cam2-camera-credentials`, and has `--gh-login`.

## v2026.09.26.3

- Control API actions `power-off` and `power-on`: the camera goes dark
  (connections drop, sessions end, the recording in progress closes, events
  are refused) until power-on boots it like a reboot. `state.power` reports
  `on`, `off` or `booting`.
- README: API reference for the simulated camera API and the control API.

## v2026.09.26.2

- Fixture clips are 12 s (players skip 10 s), built with fast presets under a
  cross-process lock; `ensureFixtures` and `defaultFixtureDir` are exported so
  test runners can build them once in a global setup.

## v2026.09.26.1

First release: the headless core (Plan 1).

- A simulated Reolink RLC-1224A (firmware v3.2.0.6011_2607012059) on HTTP and
  HTTPS: login and sessions, device info, settings with the firmware's
  whole-object write semantics, Search, Download, Snap and FLV live (H.264 sub,
  H.265 main with the legacy codec id 12), certificates, Reboot.
- The firmware's quirks are always on: the four token-rejection shapes, one
  Search and one Download at a time, raw Download source, text/html JSON
  replies, partial writes that reset omitted keys after a reboot.
- Faults to switch on: refused, dropped or slow downloads, FLV resets, failing
  or ignored settings, offline, latency, Snap errors; one-shot token revoke,
  reboot and connection drops.
- Control API (bearer token, SSE, openapi.yaml): events that create
  recordings, seeded recordings, faults, actions, reset, request log, state.
- Fixture media from ffmpeg test patterns; no camera footage anywhere.
- Container image (amd64, arm64), compose file for three cameras, in-process
  `createCamSim()` for tests, secrets sync script.
- cams' unit and e2e suites pass against cam-sim (checked in CI).
