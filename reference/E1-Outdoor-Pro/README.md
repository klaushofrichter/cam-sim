# E1 Outdoor Pro captures (2026-10-30)

Captures of the real Reolink E1 Outdoor Pro, a pan/tilt/zoom camera, on
firmware v3.1.0.5714_2511271366, made on 2026-10-30: a read-only probe of
the Get commands, plus a PTZ measurement with Klaus's OK (the camera moved,
zoomed and saved two presets, which the measurement deleted again). They are
the source of `src/profile/E1-Outdoor-Pro.ts`.

## Files

- `<Cmd>.json`: **one reply entry each**, `{cmd, code, [initial], [range],
  value | error}`. This differs from the `{contentType, reply: [...]}` files
  of `reference/rlc-1224a/` and `reference/cx820/`: the probe did not keep
  the HTTP content type. The commands:
  - `GetAbility`, `GetDevInfo`, `GetEnc`, `GetAiState`, `GetIrLights`,
    `GetWhiteLed`, `GetIsp`, `GetMdAlarm`, `GetOsd`;
  - `GetPtzPreset`, `GetZoomFocus`, `GetPtzGuard`, `GetPtzCheckState`,
    `GetAutoFocus`, `GetPtzPatrol`, and the refusals `GetPtzCurPos`,
    `GetPtzTattern`, `GetPtzSerial`, `GetPtzTraceSection`.
- `ptz-exchanges.json`: the PTZ measurement, in order: an array of
  `{cmd, param, res, ms}` (request param, the camera's reply entry, round
  trip in ms). The time between two exchanges was not recorded, except that
  `ZoomInc` ran about 1.5 s before its `Stop`.

- `ptz-zoom-overlap.json`: a zoom while a zoom runs, measured 2026-10-30,
  as `{cmd, param, res}` in order (no round trip times). Written down from
  that measurement's results; see Measured PTZ.

Not kept (not modelled, and several carry redactions): Wifi, LocalLink,
RtspUrl, Email, Ftp, Push, Channelstatus, Certificate and the other Gets of
the probe.

## Redacted

- `GetDevInfo.serial` is `SIM000000000000`.
- The camera's name is `Cam` (`GetDevInfo.name`, `GetOsd` `osdChannel.name`
  in `value`; the `initial` name `E1 Outdoor Pro` is the factory name).
- `imgName` (presets, PtzGuard) is `<redacted>`; the simulator answers `""`.

## Differences from the CX820

- `GetDevInfo`: model `E1 Outdoor Pro`, `exactType` `WIFI_SOLO_IPC`,
  `wifi` 1, itemNo `E560`, hardVer `IPC_560SD88MPW`, detail
  `IPC_560SD88MPWS38A9T460E1W13110`, cfgVer `v3.1.0.0`. Same keys.
- `GetEnc`: main H.265 3840×2160 at 20 fps, 4096 kbps; sub H.264 640×360 at
  10 fps, 256 kbps; audio 1.
- `GetMdAlarm`: the area grid is 60×33.
- `GetIsp`: with `bd_night`, `encType` `CBR`, `dayNight` `Auto`.
- `GetIrLights`: range `Auto`/`Off`.
- `GetWhiteLed`: mode 1, bright 85, no `LightAlarm`; initial
  `wlAiDetectType` all 1.
- `GetAbility`: `ptzCtrl`, `ptzPreset`, `ptzPatrol`, `ptzTattern` permit 7;
  `supportPtzSpeed`, `supportZoom`, `supportFocus`, `supportPtzCheck` set;
  `supportPtz3DLocation` and `supportDigitalZoom` 0; `ptzType` 0.

## Measured PTZ (2026-10-30)

- `PtzCtrl` (`{channel: 0, op, speed}`): ops `Left`, `Right`, `Up`, `Down`,
  `LeftUp`, `LeftDown`, `RightUp`, `RightDown`, `Stop`, `ZoomInc`,
  `ZoomDec`, `FocusInc`, `FocusDec`, `ToPos` (with `id`) answer
  `{rspCode: 200}`. Speed 1–64; 0 or above 64 → `-4` "param error"; `speed`
  may be left out. An unknown op → `-4`.
- `ZoomInc` at speed 32 for 1.5 s took zoom 7 → 26 (of 0–27); `GetZoomFocus`
  follows. Zoom 0–27, focus 0–97; at the start zoom 7, focus 49.
- Absolute zoom: `StartZoomFocus {ZoomFocus: {channel, op: "ZoomPos", pos}}`.
- Preset slots are ids 0–63, although `GetPtzPreset`'s `range` says 1–64;
  id 64 → `-4`. `SetPtzPreset {PtzPreset: {channel, enable: 1, id, name}}`
  saves the current position including zoom; delete with `enable: 0, name: ""`.
- A name longer than 31 characters is accepted but stored as `pos<id+1>`.
- `ToPos` to an empty slot answers 200 without moving.
- `ToPos` to a saved slot restored its zoom (20) but not its focus.
- `GetPtzCurPos` → `-1` "not exist"; `GetPtzTraceSection` → `-1` "not
  exist"; `GetPtzTattern` and `GetPtzSerial` → `-12` "get config failed".
- How long a move runs without `Stop` was not measured.
- A zoom while a zoom runs (measured 2026-10-30): after `ZoomInc` or
  `ZoomDec` with no `Stop` since, any further `ZoomInc` or `ZoomDec`, the
  same direction too, → `{"code":1,"error":{"detail":"set config failed",
  "rspCode":-13}}`. Accepted mid-motion: repeated or reversed moves (`Left`,
  `Right`, `Up`, `Down`, the diagonals), `FocusInc`/`FocusDec` (also repeated
  or reversed), a zoom after a move or a focus, and a move or focus after a
  zoom. `Stop` then a zoom at once is accepted. The simulator keeps the
  running zoom on a refusal (not measured whether the camera's zoom goes on).

## Not measured: the simulator's choices

- Pan 0–355 and tilt 0–50 (simulator degrees), starting at pan 180, tilt 25.
  The camera reports no pan/tilt position (`GetPtzCurPos` is refused).
- Rates per speed unit: pan/tilt 1.5°/s, zoom 0.4 steps/s, focus 0.4
  steps/s (speed 32 `ZoomInc` for 1.5 s takes zoom 7 → 26, as measured).
- `Left`/`Right` change pan, `Up`/`Down` change tilt (`Up` increases it), the
  diagonals change both at full rate.
- A move lasts until `Stop`, another op or `ToPos`, and is clamped at the
  limits; it stays "moving" while held at a limit.
- `ToPos` and `ZoomPos` apply at once.
- Omitted speed means 32. A speed that is not an integer → `-4`. `Stop`
  ignores speed.
- Presets store pan/tilt/zoom; focus is not stored or restored.
- `enable: 0` resets the slot's name to `pos<id+1>`. `enable: 1` with an
  empty or non-string name keeps the slot's name.
- `StartZoomFocus` also takes `FocusPos`. Any other op, or a pos out of
  range → `-4`.
- The PTZ Get commands answer with `initial` and `range` for any `action`
  (captured with action 1).
- Reboot and power-on stop a move and keep the presets.
- Everything else about the model that was not captured is the CX820's: the
  AiAlarm grid (60×33, like MdAlarm), GetUser, the FTP masks, the WhiteLed
  modes, the record file flags, and the Baichuan auth types, login reply and
  pushes.
