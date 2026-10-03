# Changelog

## Unreleased

- Web UI navigation works like cams and cam-proxy: on desktop the sidebar shows icons and labels and "Collapse" shrinks it to icons (remembered per browser); on phones (767 px and narrower) the icon rail is gone and a hamburger at the top left opens the menu as a drawer over the page. Its footer has what the phone top bar leaves out (model, firmware and serial), the theme toggle and Sign out. The drawer closes on navigation, Back or Forward, a tap outside, the close button, Escape or Sign out, and gives focus back to the hamburger. The phone top bar stays on one row: hamburger, logo, camera name and power state. The nav items are hash links (`#/live`, …, as before), so they open in a new tab.
- Baichuan: new state counter `baichuanStops` (every cmd 9 after a login, running download or not), next to `baichuanDownloads` and `droppedBaichuanDownloads`. It resets with the other history counters.
- Baichuan: at most 20 connections are held over the 12-session limit; the next one is reset at once, so a client opening thousands can't exhaust the simulator's file descriptors (before, each was held until its first message or 12.5 s).
- A `listen()` that fails to bind (port in use) now closes the listeners it had already opened (camera HTTP/HTTPS, control, ONVIF, Baichuan) before it rejects. The simulator is not usable afterwards; create a new one.
- `CertificateClear` and `ImportCertificate` take effect (camera offline, sessions revoked, new certificate) before the reply is sent, not on its `finish` event. A client reading the state right after the reply could see the old state before.
- README: a running Baichuan download keeps its session alive, measured on the real camera on 2026-10-02 (a 9 MB main file read throttled for 77.6 s, no drop).
- Tests: issue #57's four flaky tests now report the failing response; the ONVIF digest test uses a fixed nonce and time; timing bounds that failed under load are wider; the sync-secrets test no longer fails when the random token contains "PAT"; new tests for split headers (19/23 bytes), a bad magic mid-stream and `bcXor`'s byte offset.
- `GetFtpV20` returns the FTP `userName` masked like the real camera (first two characters, `**`, last two: `camera` -> `ca**ra`; measured on the Pi 2026-10-02); names under 5 characters stay as they are. `SetFtpV20` and `TestFtp` keep the full name, and the stored value is unchanged. A client that reads the Ftp object and writes it back whole now sends the masked name, as it would to the real camera.
- Baichuan server on the camera's TCP port 9000 (`CAMSIM_BAICHUAN_PORT`), as measured on the RLC-1224A (`reference/rlc-1224a/baichuan/`):
  - Commands: login (cmd 1); download (8, the file byte-equal to HTTP `Download`); stop (9); file info (13); LinkType (93); logout (2).
  - Sessions show in `GetOnline`; the 12-connection limit, the 32 s idle close and the post-login pushes work as on the camera.
  - New faults `baichuan.refuse`, `baichuan.dropMidway`, `baichuan.delayMs`, `baichuan.loginFail` and `baichuan.sessionLimit` (`max`). `offline`, `power-off`, `reboot` and `downloads.dropActive` also act on port 9000.
  - New state counters `baichuanSessions`, `baichuanLogins`, `baichuanDownloads` and `droppedBaichuanDownloads`.
  - The image exposes 9000 and sets `CAMSIM_BAICHUAN_PORT=9000`. Outside the image the CLI opens a Baichuan port only when `CAMSIM_BAICHUAN_PORT` is set, so several simulators still run side by side.
  - `createCamSim().listen()` also opens a Baichuan port (a free one unless `baichuan` is named) and returns it; `CamSimOptions.baichuan` shortens the idle timeouts for tests.
  - The reolink_aio MIT notice is in `THIRD_PARTY_NOTICES`.
  - Simulator page: the Baichuan faults (with a `max` input for the session limit); counters show in the Counters card.

## v2026.10.01.1

- FLV sub goes back to the looped video at once when the SD pipeline switches off; a client that had joined mid keyframe group paused for up to 4 s.
- Simulator page, SD pipeline card: the durations stop at `CAMSIM_PIPELINE_MAX_MIN` (the state has a new `pipelineMaxMin`), the choice starts at the maximum when that is below 60 min, the switch shows off again when a switch-on is refused, and it says it is waiting for the camera, not starting, while the camera is off.
- `POST /sim/api/pipeline` answers 400 for `{"minutes": null}`; only a missing value means 60.
- `POST /sim/api/pipeline` without a font now answers `{"on":true,…}`; the switch-off with the font error follows a moment later in the state and as an SSE `pipeline` event (it answered `{"on":false,"error":…}` at once before).
- SD pipeline: Sets that don't change what it draws (`SetRec`, `SetFtp`, …) no longer restart it, and a new camera name shows without a restart, so RTSP sub readers aren't cut for them. A failing RTSP output now counts as a pipeline failure (restart once, then off with the error) instead of leaving RTSP sub without a publisher. A font folder or `TMPDIR` path with `:`, `'`, `\`, `[`, `]`, `,` or `;` works. A new switch-on gets its own restart after a failure, and a missing `ffmpeg` switches it off with an error instead of leaving it stuck.

## v2026.09.30.2

- Recordings follow the camera's 4 s keyframe grid (measured on cam1, 37 back-to-back clips): a clip starts one step before the detection and ends at the first step after its post-record, and may start up to 4 s before the previous one ended. The FTP picture is named at the detection, 4 s after its clip. Clip names and lengths shift by up to 4 s from before.

## v2026.09.30.1

- The FTP picture (`.jpg`) is named after the event that started the recording, 4 s after the clip's name with pre-record on, like the camera (measured 2026-09-30); it was named like the clip. README: how recordings cover several events and end `postRec` after the last one.
- The manual light reports its new state late, like the camera (measured 2026-09-30): `GetWhiteLed` shows the new `state` about 1 s after switching on and 3 s after switching off; a newer write, a reboot or a factory reset replaces a switch still pending.

## v2026.09.29.3

- `SetWhiteLed` accepts only the numbers 0 and 1 for `state`, the manual light switch, and answers `-56` otherwise, like the real camera (measured 2026-09-29).

## v2026.09.29.1 – v2026.09.29.2

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
