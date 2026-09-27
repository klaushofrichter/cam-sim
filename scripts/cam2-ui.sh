#!/usr/bin/env bash
# Opens the web UI of cam2 (the simulated camera in the cluster) on this
# machine: port-forwards cam2's control port, copies the control token to the
# clipboard for the UI's one-time login (never printed), and opens the
# browser. Until cam-sim has a web UI (Plan 3), it shows cam2's state from the
# control API instead. The forward stays open until Ctrl-C.
#
#   scripts/cam2-ui.sh [--port 9443] [--no-open]
#
# Needs: kubectl (KUBECONFIG defaults to ~/.kube/k3s-config), curl, jq, and
# CAMSIM_CONTROL_TOKEN in .env. The browser warns about the certificate: it is
# for cam2.skylar.technology, and the page is reached as 127.0.0.1.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=9443
OPEN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift ;;
    --no-open) OPEN=0 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "cam2-ui: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/k3s-config}"
NS=cam-sim
BASE="https://127.0.0.1:${PORT}"

die() { echo "cam2-ui: $*" >&2; exit 1; }
command -v kubectl >/dev/null || die "kubectl not found"
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

kubectl -n "$NS" get svc cam2 >/dev/null 2>&1 || die "service cam2 not found in namespace $NS (context: $(kubectl config current-context 2>/dev/null))"
kubectl -n "$NS" port-forward svc/cam2 "${PORT}:9443" >"$PF_LOG" 2>&1 &
PF_PID=$!

for _ in $(seq 1 50); do
  curl -sk --max-time 2 "$BASE/healthz" | grep -q '"ok":true' && break
  kill -0 "$PF_PID" 2>/dev/null || die "port-forward failed: $(tail -1 "$PF_LOG")"
  sleep 0.2
done
curl -sk --max-time 2 "$BASE/healthz" | grep -q '"ok":true' || die "cam2 did not answer on $BASE/healthz"

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
  echo "cam2 web UI: $BASE/ (accept the certificate warning: the certificate is for cam2.skylar.technology)"
  if [ "$OPEN" = 1 ]; then (command -v open >/dev/null && open "$BASE/") || (command -v xdg-open >/dev/null && xdg-open "$BASE/") || true; fi
else
  echo "cam2 has no web UI yet (cam-sim Plan 3). Its state, from the control API:"
  curl -sk --max-time 10 -H @"$HDR" "$BASE/sim/api/state" | jq '{name, serial, power, offline, faults, sd, certificate,
    counters: (.counters | {logins, activeSessions, activeStreams, streamsOpened, downloads, searches, reboots}),
    recentEvents: [.events[:5][] | {at, type, durationS}]}'
  echo
  echo "The control API stays reachable at $BASE/sim/api/… (bearer token from .env) until Ctrl-C."
fi

echo "Port-forward running; Ctrl-C to stop."
wait "$PF_PID"
