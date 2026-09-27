#!/usr/bin/env bash
# Syncs cam-sim's deployment secrets from .env to GitHub Actions secrets and a
# Kubernetes Secret. Generates missing values (and placeholders) in .env first.
# Prints key names only, never values. Klaus runs this; agents don't.
#
#   scripts/sync-secrets.sh [--dry-run] [--only github|kube] [--gh-login] [--rotate KEY | --rotate CAMSIM_USERS:<user>]... [--env-file PATH]
#
# Synced:  GitHub  CAMSIM_CONTROL_TOKEN, CAMSIM_USERS, and GITHUB_KUBE_SETUP_PAT as KUBE_SETUP_DEPLOY_TOKEN
#                  (GitHub refuses secret names starting with GITHUB_)
#          Kube    CAMSIM_CONTROL_TOKEN, CAMSIM_USERS (Secret $KUBE_SECRET in $KUBE_NAMESPACE), and the
#                  admin user's credentials as username/password (Secret $KUBE_CAMERA_SECRET, for the
#                  certificate push CronJob, like cam1-camera-credentials)
# Never synced: REOLINK_PASSWORD, CAMSIM_GITHUB_PAT (used as GH_TOKEN for gh unless --gh-login).
set -euo pipefail
umask 077

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
DRY=0
ONLY=all
GH_LOGIN=0
ROTATE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --gh-login) GH_LOGIN=1 ;;
    --only) ONLY="$2"; shift ;;
    --rotate) ROTATE+=("$2"); shift ;;
    --env-file) ENV_FILE="$2"; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "sync-secrets: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ONLY" in all|github|kube) ;; *) echo "sync-secrets: --only must be github or kube" >&2; exit 2 ;; esac

die() { echo "sync-secrets: $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found; copy .env.example to .env first"
perms=$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")
case "$perms" in *00) ;; *) die "$ENV_FILE is readable by others (mode $perms); run: chmod 600 $ENV_FILE" ;; esac

# Values never go on a command line (ps shows argv): awk reads them from ENVIRON.
# An inline comment (whitespace, then #) is not part of the value.
get() { K="$1" awk -F= 'index($0, ENVIRON["K"] "=") == 1 { v = substr($0, length(ENVIRON["K"]) + 2); sub(/[ \t]+#.*$/, "", v); print v; exit }' "$ENV_FILE"; }
has() { grep -q "^$1=" "$ENV_FILE"; }
put() {
  local tmp
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  K="$1" V="$2" awk '
    index($0, ENVIRON["K"] "=") == 1 { print ENVIRON["K"] "=" ENVIRON["V"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["K"] "=" ENVIRON["V"] }' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}
# Empty, containing whitespace, or <like this>: not a real value.
placeholder() { [ -z "$1" ] || [[ "$1" =~ [[:space:]] ]] || [[ "$1" =~ ^\<.*\>$ ]]; }
gen_token() { openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'; }
gen_password() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c 24; }

rotating() { local r; for r in "${ROTATE[@]+"${ROTATE[@]}"}"; do [ "$r" = "$1" ] && return 0; done; return 1; }

say() { if [ "$DRY" = 1 ]; then echo "would $*"; else echo "$*"; fi; }

# 1. Control token.
token=$(get CAMSIM_CONTROL_TOKEN)
if placeholder "$token" || rotating CAMSIM_CONTROL_TOKEN; then
  token=$(gen_token)
  [ "$DRY" = 1 ] || put CAMSIM_CONTROL_TOKEN "$token"
  say "generate CAMSIM_CONTROL_TOKEN" | sed 's/^generate/generated/;s/^would generated/would generate/'
fi

# 2. Camera users: name:level:password;… — fill empty passwords.
users=$(get CAMSIM_USERS)
has CAMSIM_USERS || users='admin:admin:;cams:admin:'
new_users=""
changed=0
IFS=';' read -r -a entries <<< "$users"
for e in "${entries[@]}"; do
  [ -n "$e" ] || continue
  name=${e%%:*}; rest=${e#*:}; level=${rest%%:*}; pw=${rest#*:}
  if placeholder "$pw" || rotating CAMSIM_USERS || rotating "CAMSIM_USERS:$name"; then
    pw=$(gen_password)
    changed=1
    say "generate password for camera user $name" | sed 's/^generate/generated/;s/^would generated/would generate/'
  fi
  new_users="${new_users:+$new_users;}$name:$level:$pw"
done
users=$new_users
if [ "$changed" = 1 ] && [ "$DRY" = 0 ]; then put CAMSIM_USERS "$users"; fi

REPO=$(get GITHUB_REPO); REPO=${REPO:-klaushofrichter/cam-sim}
NS=$(get KUBE_NAMESPACE); NS=${NS:-cam-sim}
SECRET=$(get KUBE_SECRET); SECRET=${SECRET:-cam-sim-secrets}
CAMERA_SECRET=$(get KUBE_CAMERA_SECRET); CAMERA_SECRET=${CAMERA_SECRET:-cam2-camera-credentials}
CONTEXT=$(get KUBE_CONTEXT)

# 3. GitHub Actions secrets, values on stdin.
if [ "$ONLY" != kube ]; then
  pat=$(get CAMSIM_GITHUB_PAT)
  [ "$GH_LOGIN" = 1 ] && pat=""
  gh_set() {
    say "set github secret $1"
    [ "$DRY" = 1 ] && return 0
    if [ -n "$pat" ]; then printf '%s' "$2" | GH_TOKEN="$pat" gh secret set "$1" --repo "$REPO" >/dev/null
    else printf '%s' "$2" | gh secret set "$1" --repo "$REPO" >/dev/null; fi
  }
  gh_set CAMSIM_CONTROL_TOKEN "$token"
  gh_set CAMSIM_USERS "$users"
  kube_pat=$(get GITHUB_KUBE_SETUP_PAT)
  if [ -n "$kube_pat" ]; then gh_set KUBE_SETUP_DEPLOY_TOKEN "$kube_pat"; fi
fi

# 4. Kubernetes Secret with the CAMSIM_ values only.
if [ "$ONLY" != github ]; then
  [ -n "$CONTEXT" ] || die "set KUBE_CONTEXT in $ENV_FILE (there is no default context)"
  say "apply kubernetes secret $SECRET in $NS (context $CONTEXT): CAMSIM_CONTROL_TOKEN, CAMSIM_USERS"
  if [ "$DRY" = 0 ]; then
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    printf 'CAMSIM_CONTROL_TOKEN=%s\nCAMSIM_USERS=%s\n' "$token" "$users" > "$tmp"
    kubectl --context "$CONTEXT" -n "$NS" create secret generic "$SECRET" --from-env-file="$tmp" --dry-run=client -o yaml \
      | kubectl --context "$CONTEXT" apply -f - >/dev/null
  fi
  admin_pw=""
  IFS=';' read -r -a entries <<< "$users"
  for e in "${entries[@]}"; do
    [ "${e%%:*}" = admin ] && admin_pw=${e#*:*:}
  done
  if [ -n "$admin_pw" ]; then
    say "apply kubernetes secret $CAMERA_SECRET in $NS (context $CONTEXT): username, password"
    if [ "$DRY" = 0 ]; then
      ctmp=$(mktemp)
      trap 'rm -f "$tmp" "$ctmp"' EXIT
      printf 'username=admin\npassword=%s\n' "$admin_pw" > "$ctmp"
      kubectl --context "$CONTEXT" -n "$NS" create secret generic "$CAMERA_SECRET" --from-env-file="$ctmp" --dry-run=client -o yaml \
        | kubectl --context "$CONTEXT" apply -f - >/dev/null
    fi
  fi
fi
