#!/usr/bin/env bash
# Re-encodes a library video with the shared recipe (scripts/lib/recipe.sh), so it
# can be played in a sequence with the MEVA clips (equal encoder parameter sets).
#
#   scripts/library-normalize.sh <library-folder> [--seconds N]
#
# Reads <folder>/main.mp4 (and its audio, if it has any; else silent AAC) and writes
# <folder>-normalized/ with main.mp4 (H.265, 4512x2512, 20 fps), sub.mp4 (made from
# the main: H.264, 896x512, 10 fps) and a copy of CREDITS.txt if present. Refuses to
# overwrite. --seconds N cuts the video to N seconds (default: the whole video).
# Smaller or different-shaped sources are scaled to fit and padded.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/recipe.sh

usage() { echo "usage: $0 <library-folder> [--seconds N]" >&2; exit 2; }
[ $# -ge 1 ] || usage
SRC=${1%/}; shift
SECONDS_LONG=
while [ $# -gt 0 ]; do
  case "$1" in
    --seconds) [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -gt 0 ] || usage; SECONDS_LONG=$2; shift 2 ;;
    *) usage ;;
  esac
done

[ -f "$SRC/main.mp4" ] || { echo "library-normalize: $SRC/main.mp4 not found" >&2; exit 1; }
OUT=$SRC-normalized
[ ! -e "$OUT" ] || { echo "library-normalize: $OUT exists; remove it first" >&2; exit 1; }

if [ -z "$SECONDS_LONG" ]; then
  SECONDS_LONG=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC/main.mp4" | awk '{ printf "%d", ($1 == int($1)) ? $1 : int($1) + 1 }')
fi
if [ -n "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$SRC/main.mp4")" ]; then
  export RECIPE_AUDIO=input
fi

mkdir -p "$OUT"
trap 'rc=$?; [ $rc -eq 0 ] || rm -rf "$OUT"' EXIT
echo "Encoding main ..."
encode_main "$SRC/main.mp4" "$OUT/main.mp4" 0 "$SECONDS_LONG"
echo "Encoding sub ..."
encode_sub "$SRC/main.mp4" "$OUT/sub.mp4" 0 "$SECONDS_LONG"
[ ! -f "$SRC/CREDITS.txt" ] || cp "$SRC/CREDITS.txt" "$OUT/CREDITS.txt"
echo "Done: $OUT (main.mp4, sub.mp4$([ -f "$OUT/CREDITS.txt" ] && echo ", CREDITS.txt"))"
