#!/usr/bin/env bash
# Opens the web UI of a simulated camera: a local Docker container if one is
# running for that camera, otherwise the one in the cluster (port-forward),
# otherwise an error saying what was tried. With a web UI it copies the
# control token to the clipboard for the one-time login (never printed) and
# opens the browser; until cam-sim has a web UI (Plan 3), it shows the
# camera's state from the control API instead.
#
#   scripts/cam-ui.sh [camera] [--port 9443] [--no-open]      camera: cam2 (default)
#
# Docker: a running container whose compose service or name is <camera>
# (compose.yaml: cam2, cam3, cam4), using its published control port.
# Cluster: service <camera> in namespace cam-sim (KUBECONFIG defaults to
# ~/.kube/k3s-config); the port-forward stays open until Ctrl-C.
# Needs curl, jq, and CAMSIM_CONTROL_TOKEN in .env. In the cluster the browser
# warns about the certificate (it is for <camera>.skylar.technology).
set -euo pipefail
cd "$(dirname "$0")/.."

CAMERA=cam2
PORT=9443
OPEN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift ;;
    --no-open) OPEN=0 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    -*) echo "cam-ui: unknown option $1" >&2; exit 2 ;;
    *) CAMERA="$1" ;;
  esac
  shift
done
[[ "$CAMERA" =~ ^[a-z0-9-]+$ ]] || { echo "cam-ui: camera must be a name like cam2" >&2; exit 2; }

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/k3s-config}"
NS=cam-sim
BASE=""

die() { echo "cam-ui: $*" >&2; exit 1; }
command -v jq >/dev/null || die "jq not found"
[ -f .env ] || die ".env not found (needs CAMSIM_CONTROL_TOKEN)"

# The token goes to curl through a header file, never on a command line.
umask 077
HDR=$(mktemp)
PF_LOG=$(mktemp)
PF_PID=""
cleanup() {
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  rm -f "$HDR" "$PF_LOG"
}
trap cleanup EXIT INT TERM
K=CAMSIM_CONTROL_TOKEN awk -F= 'index($0, ENVIRON["K"] "=") == 1 { v = substr($0, length(ENVIRON["K"]) + 2); sub(/[ \t]+#.*$/, "", v); printf "Authorization: Bearer %s\n", v; exit }' .env > "$HDR"
grep -q 'Bearer .' "$HDR" || die "CAMSIM_CONTROL_TOKEN is empty in .env"

healthy() { curl -sk --max-time 2 "$1/healthz" 2>/dev/null | grep -q '"ok":true'; }
tried=()

# 1. Local Docker: a container for this camera with a published control port.
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  cid=$(docker ps -q --filter "label=com.docker.compose.service=$CAMERA" | head -1)
  [ -n "$cid" ] || cid=$(docker ps -q --filter "name=^/${CAMERA}$" | head -1)
  if [ -n "$cid" ]; then
    hostport=$(docker port "$cid" 9443/tcp 2>/dev/null | head -1)
    if [ -n "$hostport" ]; then
      p=${hostport##*:}
      for scheme in https http; do
        if healthy "$scheme://127.0.0.1:$p"; then BASE="$scheme://127.0.0.1:$p"; WHERE="local Docker container $(docker ps --format '{{.Names}}' --filter "id=$cid")"; break; fi
      done
    fi
    [ -n "$BASE" ] || tried+=("Docker: container for $CAMERA found, but its control port does not answer")
  else
    tried+=("Docker: no running container for $CAMERA")
  fi
else
  tried+=("Docker: not available")
fi

# 2. The cluster: port-forward the camera's service.
if [ -z "$BASE" ]; then
  if ! command -v kubectl >/dev/null; then
    tried+=("cluster: kubectl not found")
  elif ! kubectl -n "$NS" get svc "$CAMERA" >/dev/null 2>&1; then
    tried+=("cluster: no service $CAMERA in namespace $NS (context: $(kubectl config current-context 2>/dev/null || echo none))")
  else
    kubectl -n "$NS" port-forward "svc/$CAMERA" "${PORT}:9443" >"$PF_LOG" 2>&1 &
    PF_PID=$!
    for _ in $(seq 1 50); do
      healthy "https://127.0.0.1:${PORT}" && break
      kill -0 "$PF_PID" 2>/dev/null || break
      sleep 0.2
    done
    if healthy "https://127.0.0.1:${PORT}"; then
      BASE="https://127.0.0.1:${PORT}"
      WHERE="cluster (service $NS/$CAMERA, port-forward)"
    else
      tried+=("cluster: port-forward to $NS/$CAMERA failed: $(tail -1 "$PF_LOG")")
    fi
  fi
fi

# 3. Neither.
if [ -z "$BASE" ]; then
  echo "cam-ui: $CAMERA is not reachable. Tried:" >&2
  for t in "${tried[@]}"; do echo "  - $t" >&2; done
  exit 1
fi
echo "$CAMERA: $WHERE at $BASE"

copy_token() {
  local v
  v=$(sed -n 's/^Authorization: Bearer //p' "$HDR")
  if command -v pbcopy >/dev/null; then printf '%s' "$v" | pbcopy; return 0; fi
  if command -v xclip >/dev/null; then printf '%s' "$v" | xclip -selection clipboard; return 0; fi
  return 1
}

if [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/")" = 200 ]; then
  if copy_token; then echo "The control token is on the clipboard: paste it into the login page."
  else echo "No clipboard tool: the login page needs CAMSIM_CONTROL_TOKEN from .env."; fi
  echo "$CAMERA web UI: $BASE/"
  case "$BASE" in https://*) echo "(accept the certificate warning: the certificate is for $CAMERA.skylar.technology)";; esac
  if [ "$OPEN" = 1 ]; then (command -v open >/dev/null && open "$BASE/") || (command -v xdg-open >/dev/null && xdg-open "$BASE/") || true; fi
else
  echo "$CAMERA has no web UI yet (cam-sim Plan 3). Its state, from the control API:"
  curl -sk --max-time 10 -H @"$HDR" "$BASE/sim/api/state" | jq '{name, serial, power, offline, faults, sd, certificate,
    counters: (.counters | {logins, activeSessions, activeStreams, streamsOpened, downloads, searches, reboots}),
    recentEvents: [.events[:5][] | {at, type, durationS}]}'
  echo
  echo "The control API is at $BASE/sim/api/… (bearer token from .env)."
fi

if [ -n "$PF_PID" ]; then
  echo "Port-forward running; Ctrl-C to stop."
  wait "$PF_PID"
fi
