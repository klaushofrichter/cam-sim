#!/usr/bin/env bash
# Builds the image and checks it end to end: login over HTTPS, device info,
# live FLV, an event found by Search, its Download, and a Baichuan login. Throwaway secrets only.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-cam-sim:smoke}
NAME=cam-sim-smoke-$$
HTTPS=${SMOKE_HTTPS_PORT:-28443}
CONTROL=${SMOKE_CONTROL_PORT:-29443}
PW=$(openssl rand -hex 12)
TOKEN=$(openssl rand -hex 24)
WORK=$(mktemp -d)
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

fail() { echo "smoke: FAIL: $*" >&2; docker logs "$NAME" 2>&1 | tail -20 >&2 || true; exit 1; }

[ "${SKIP_BUILD:-}" = 1 ] || docker build -q -t "$IMAGE" . >/dev/null
docker run -d --name "$NAME" \
  -e CAMSIM_USERS="smoke:admin:$PW" -e CAMSIM_CONTROL_TOKEN="$TOKEN" -e CAMSIM_WEB_UI=true \
  -p "127.0.0.1:$HTTPS:8443" -p "127.0.0.1:$CONTROL:9443" "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] || fail "container not healthy"

cam() { curl -sk -X POST "https://127.0.0.1:$HTTPS/cgi-bin/api.cgi?cmd=$1${3:+&token=$3}" -H 'Content-Type: application/json' -d "[{\"cmd\":\"$1\",\"action\":0,\"param\":${2:-{\}}}]"; }
ctl() { curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

T=$(cam Login "{\"User\":{\"Version\":\"0\",\"userName\":\"smoke\",\"password\":\"$PW\"}}" | jq -r '.[0].value.Token.name')
[ -n "$T" ] && [ "$T" != null ] || fail "login"
[ "$(cam GetDevInfo '{}' "$T" | jq -r '.[0].value.DevInfo.model')" = RLC-1224A ] || fail "GetDevInfo"

curl -sk --max-time 2 "https://127.0.0.1:$HTTPS/flv?port=1935&app=bcs&stream=channel0_sub.bcs&token=$T" -o "$WORK/live.flv" || true
[ "$(head -c 3 "$WORK/live.flv")" = FLV ] || fail "FLV live"

ctl -X POST "http://127.0.0.1:$CONTROL/sim/api/events" -d '{"type":"motion","durationS":2}' | jq -e '.recording.id' >/dev/null || fail "trigger event"
# The camera works in its own zone (CAMSIM_TZ, default America/Chicago).
Y=$(TZ=America/Chicago date +%Y); M=$((10#$(TZ=America/Chicago date +%m))); D=$((10#$(TZ=America/Chicago date +%d)))
DAY="{\"year\":$Y,\"mon\":$M,\"day\":$D}"
NAME_=$(cam Search "{\"Search\":{\"channel\":0,\"onlyStatus\":0,\"streamType\":\"sub\",\"StartTime\":$DAY,\"EndTime\":$DAY}}" "$T" | jq -r '.[0].value.SearchResult.File[0].name')
[[ "$NAME_" == /mnt/sda/Mp4Record/* ]] || fail "Search found no recording"

curl -sk "https://127.0.0.1:$HTTPS/cgi-bin/api.cgi?cmd=Download&source=$NAME_&output=x.mp4&token=$T" -o "$WORK/clip.mp4"
[ "$(dd if="$WORK/clip.mp4" bs=1 skip=4 count=8 2>/dev/null)" = ftypmp42 ] || fail "Download"

curl -s "http://127.0.0.1:$CONTROL/" | grep -q '<div id="app">' || fail "web UI not served"

# RTSP: pull the sub stream through MediaMTX with the camera user (inside the
# container, which has ffprobe).
docker exec "$NAME" ffprobe -v error -rtsp_transport tcp -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 \
  "rtsp://smoke:$PW@127.0.0.1:8554/h264Preview_01_sub" | grep -q h264 || fail "RTSP"

# Baichuan (port 9000, on because the image sets CAMSIM_BAICHUAN_PORT): the
# nonce exchange and a login, from inside the
# container with the image's own frame codec and ciphers.
BC=$(docker exec -i -e BC_USER=smoke -e BC_PW="$PW" "$NAME" node - <<'JS'
const net = require('net');
const { encodeFrame, FrameParser, CLS_NONCE_REQUEST, CLS_CLIENT, ENC_OFFER } = require('/app/dist/src/baichuan/frame.js');
const { bcXor, md5_31 } = require('/app/dist/src/baichuan/cipher.js');
const s = net.connect(9000, '127.0.0.1');
const p = new FrameParser();
setTimeout(() => { console.log('timeout'); process.exit(1); }, 5000).unref();
s.on('error', (e) => { console.log(e.code); process.exit(1); });
s.on('connect', () => s.write(encodeFrame({ cmd: 1, msgId: 0x1fa, status: ENC_OFFER, cls: CLS_NONCE_REQUEST })));
s.on('data', (d) => {
  for (const f of p.push(d)) {
    if (f.header.msgId === 0x1fa) {
      const nonce = /<nonce>([^<]*)</.exec(bcXor(f.body, 250).toString())[1];
      const xml = ['<?xml version="1.0" encoding="UTF-8" ?>', '<body>', '<LoginUser version="1.1">',
        `<userName>${md5_31(process.env.BC_USER + nonce)}</userName>`, `<password>${md5_31(process.env.BC_PW + nonce)}</password>`,
        '<userVer>1</userVer>', '</LoginUser>', '<LoginNet version="1.1">', '<type>LAN</type>', '<udpPort>0</udpPort>', '</LoginNet>', '</body>']
        .map((l) => l + '\n').join('');
      s.write(encodeFrame({ cmd: 1, msgId: 0x2fa, status: 0, cls: CLS_CLIENT, body: bcXor(Buffer.from(xml), 250) }));
    } else if (f.header.msgId === 0x2fa) {
      console.log(f.header.status);
      s.destroy();
    }
  }
});
JS
)
[ "$BC" = 200 ] || fail "Baichuan login on 9000: $BC"

# The SD pipeline: on for a minute, running within 20 s, no error, then off.
P=$(ctl -X POST "http://127.0.0.1:$CONTROL/sim/api/pipeline" -d '{"minutes":1}')
echo "$P" | jq -e '.on == true' >/dev/null || fail "pipeline on: $P"
for _ in $(seq 1 20); do
  [ "$(ctl "http://127.0.0.1:$CONTROL/sim/api/state" | jq -r '.pipeline.running')" = true ] && break
  sleep 1
done
[ "$(ctl "http://127.0.0.1:$CONTROL/sim/api/state" | jq -r '.pipeline.running')" = true ] || fail "pipeline running (fonts or drawtext missing?): $(ctl "http://127.0.0.1:$CONTROL/sim/api/state" | jq -c .pipeline)"
ctl -X DELETE "http://127.0.0.1:$CONTROL/sim/api/pipeline" -o /dev/null -w '%{http_code}' | grep -q 204 || fail "pipeline off"

echo "smoke: OK"
