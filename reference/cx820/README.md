# CX820 captures (2026-10-20)

Read-only captures of the real Reolink CX820 (cam4, "Backyard middle"),
firmware v3.2.0.5316_2509028854, made on 2026-10-20 from the LAN host that
runs its cam-proxy, as the user `proxy` (admin level). They mirror
`reference/rlc-1224a/` and are the source of `src/profile/cx820.ts`.

Only `Login`, `Get*`, `Search`, `CheckDownload` (for a file that doesn't
exist), an unknown command and `Logout` were sent over HTTP; over ONVIF one
pull-point session that ends with `Unsubscribe`; over Baichuan login, search,
file info, downloads (bytes counted and dropped, never stored), LinkType,
an unknown command and logout. Nothing was set, moved or tested on the camera,
and every session was logged out. The clients were small stdlib Python scripts
(framing and ciphers as in reolink_aio, MIT, like the RLC-1224A captures); they
ran on that host and were deleted afterwards.

## Files

- `*.json`: one api.cgi reply each, in the RLC-1224A files' format
  (`{contentType, reply}`). The RLC-1224A set, plus `GetNtp`, `GetDevName`,
  `GetEmailV20`, `GetZoomFocus`, `GetPtzPreset`, `GetPtzCurPos`,
  `GetAutoFocus`, `GetAiAlarm-vehicle` and `GetAiAlarm-dog_cat`, and
  `Search-sub` / `Search-main` (today's clips, for the file names).
- `onvif/`: `GetServices`, `GetCapabilities`, `GetEventProperties`,
  `CreatePullPointSubscription`, two `PullMessages` (5 s and 10 s) and
  `Unsubscribe`, the camera's replies.
- `baichuan/`: in the format of `reference/rlc-1224a/baichuan/` (README
  there): `login-proxy.txt` (all XML, the pushes too), `vod-sub.txt`,
  `vod-main.txt`, `vod-nosearch.txt`, `fileinfo.txt`, `err-notfound.txt` and
  `err-protocol.txt`.

## Redacted

- The camera's address is `192.0.2.10` (`<camera>` in the Baichuan traces);
  another LAN host (the FTP server) is `192.0.2.20`; client addresses in
  `GetOnline` are `192.0.2.10`, as in the RLC-1224A files.
- Serial `SIM000000000000`; the camera name `Cam` (DevInfo, OSD, DevName);
  user names `admin`, except the masked FTP user `c**4`, which is the point of
  that file, and the Baichuan logout's plain `proxy`; the login token
  `REDACTED`.
- ONVIF: each echoed `PasswordDigest` and `Nonce` is `REDACTED`.
- Baichuan: the nonce, the hashed user name and password, the logout
  password, `secretCode` and `bootSecret`. No media bytes: chunk payloads are
  lengths only; the one payload in hex is the 32-byte info record.
- `GetFtpV20.password` is the camera's own mask (11 stars), not the password.

## Differences from the RLC-1224A

api.cgi:

- `GetDevInfo`: model `CX820`, firmVer, buildDay `build 2509028854`, hardVer
  `IPC_NT18NA68MP`, detail `IPC_NT18NA68MPS40T2C0E1W0110000`, itemNo `P335X`
  (empty on the RLC-1224A). Same keys.
- `GetEnc`: audio 0; main H.265 3840×2160, 25 fps, 6144 kbps; sub H.264
  640×360, 10 fps, 256 kbps (RLC-1224A: audio 1, 4512×2512 at 20 fps 8192,
  896×512 at 10 fps 1024).
- `GetAbility`: `supportAllColors`, `supportIspHdr`,
  `supportLightAutoBrightness`, `supportWLLightAlarm`, `videoClip` (ver 2) and
  `ftpExtStream` on; `ispDayNight`, `ledControl` (both levels),
  `supportFLIntelligent`, `supportIspBinningModeCfg`, `supportIspCorridorMode`
  and `supportThresholdAdjust` off; `supportEncoderSelect.ver` 0, `live.ver` 1;
  no `supportCloudSchedule`, `supportCrossLineDetect`, `supportIntrusionDetect`,
  `supportLegacyDetect`, `supportLoiteringDetect`, `supportLossDetect`,
  `supportNewLightAlarm`, `supportSmart265`, `supportWLFlicker` or
  `supportYoloWorld`. The pan/tilt/zoom/focus, `supportFLswitch`,
  `supportWebhook` and `talk` entries are the same on both models (`supportPt`,
  `supportZoom`, `supportFocus` permit 6 ver 0; `ptzDirection` permit 1).
- `GetUser`: no `CurUser`, only the `User` list.
- `GetWhiteLed`: `initial` and `range` next to `value` with `action: 0`;
  `LightAlarm` (18:00–07:00) instead of `NewLightAlarm`; mode 5.
- `GetIsp`: no `bd_night`, `binningMode`, `corridorMode`; dayNight `Color`.
- `GetMdAlarm` and `GetAiAlarm`: the area grid is 120×67 (70×39). AiAlarm
  sensitivity 60 and stay_time 0 for all three types (camera values).
- `GetFtpV20`: the user `cam4` reads `c**4` (one character each side; the
  RLC-1224A shows `camera` as `ca**ra`), the password as 11 stars (the
  RLC-1224A's answer for a set password was never captured); picture size
  3840×2160.
- Camera state, not model (the profile does not take these over):
  `GetNetPort` httpEnable 0 and rtmpEnable 0; FTP on to cam-proxy (port
  2121, sub stream); `GetCertificateInfo` enable 0 with empty names (no
  certificate imported); `GetRecV20` overwrite 1 (taken over); `GetHddInfo`
  the card's size; `GetOnline` three sessions.
- The same as the RLC-1224A: `CheckDownload` (unknown file: -4), the unknown
  command (-9), `GetAiState` (face 0), `GetAudioAlarmV20`, `GetEmail` and
  `GetFtp` (-9), `GetIrLights` (with initial/range), `GetMdState`, `GetOsd`,
  `GetPushV20` (-56), `GetTime`'s shape.
- Extras: `GetNtp` is `pool.ntp.org`, 1440, 123 (the simulator's assumed
  default, now measured on this model); `GetEmailV20` answers;
  `GetPtzPreset` lists 64 empty presets; `GetPtzCurPos` all -1;
  `GetZoomFocus` -54; `GetAutoFocus` -26 (`ability error`).
- File names: `RecS0A_…_0_2B148080000000_…` and `RecM0A_…_0_67328280000000_…`
  for a motion clip (RLC-1224A `55148080000000` / `7B288280000000`): the
  model's flags, the motion bit at the same place. Only motion clips existed.

ONVIF: every reply is the same as the RLC-1224A's apart from times and the
subscription address (`PullSubManager?Idx=2656743`, the RLC-1224A capture
had `Idx=00000000`). No PTZ service is listed. PullMessages gave only the
initial states (no event during the session).

Baichuan:

- The nonce reply offers `sigV3` too (338 bytes, 311 on the RLC-1224A).
- The login reply (3505 bytes, 5136): firmVersion `219836298756096`, softVer
  `50463251`, resolution 3840×2160; three StreamInfo (3840×2160, 2560×1440,
  2304×1296 main, each with a 640×360 sub; the RLC-1224A has four); no
  `videoEncTypeList`; videoEncType 1 only for the 4K main (0 elsewhere); frame
  rates up to 25 (sub 15) and the CX820's bitrate tables.
- Pushes: the same eight cmds, but all of them come soon after the login
  (78/79 about 0.34 s and the other six about 0.70 s after the login reply
  without client messages; sooner when the client sends something). On the
  RLC-1224A 291/677/600/669 wait for the client's first message or the idle
  close. FloodlightStatus has no `brightness` (195 bytes, 224).
- Downloads as on the RLC-1224A: search 14/15/16 (the search `Id` is the HTTP
  Search name), cmd 8 with or without the search, the 32-byte info record
  (3840×2160 at 25 fps for main, 640×360 at 10 fps for sub, flag 1/0), the
  39,400 ×3 + 12,872 chunk cycle with encryptLen 1024, the request's message
  id on every chunk, cmd 9 with handle 0, nothing after cmd 9. cmd 13 with
  `<name>` again reports the main file's size for a sub `<Id>`.
- Errors as on the RLC-1224A: an unknown file 400 (cmd 8) and 400/431 (cmd 13
  with/without `<name>`); an unknown cmd 405 and the session stays usable; a
  request before login and a bad magic close the connection with no reply.
- Throughput: sub 2–3 MB/s, main 4.6–5.5 MB/s (RLC-1224A main 10.8 MB/s).

## Not captured

- Anything that needs a write: Set* replies, the partial-Set resets, valid
  WhiteLed modes, the FTP password mask's length rule, and whether a Set with
  the mask keeps the password (the profile assumes so).
- PTZ and zoom movement, the spotlight, siren and talk: they would change
  the camera.
- `TestFtp`, email and push tests, reboot, format, users: not read-only.
- ONVIF events other than the initial states: no motion, person or vehicle
  happened during the 15 s session, so the event topics' `Changed` messages
  for the CX820 are unconfirmed (GetEventProperties is the RLC-1224A's).
- Baichuan `err-badpass` (a wrong password counts down the user's remaining
  tries, and the user is cam-proxy's), `session-limit`, `idle`, `abort` and
  `err-second-download` (long or stressful for a camera in use).
- HTTP `Download` and `Playback`: refused on this firmware too (connection
  closed with no answer, measured before 2026-10-20), so not repeated.
- Trigger bits other than motion in file names (only motion clips that day).
