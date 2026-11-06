#!/usr/bin/env bash
# Builds a library video from the MEVA dataset (Kitware, CC BY 4.0): downloads
# one ground-camera file from MEVA's public S3 bucket (no account needed),
# cuts 60 s, and encodes it as a main/sub pair in a camera model's formats,
# with a CREDITS.txt. The result goes to library/<name>/ (gitignored); the
# video never goes into the repository.
#
#   scripts/library-meva.sh [name|all]      name: a preset below (default: meva-parking-g340)
#   LIBRARY_OUT=<dir> changes the output folder (default: library).
#
# Presets: name | MEVA file key | start offset in seconds
# Needs curl, ffmpeg with libx265 and libx264. Re-running rebuilds the folder.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=${1:-meva-parking-g340}
case "$NAME" in
  meva-parking-g340)
    KEY=drops-123-r13/2018-03-07/16/2018-03-07.16-50-00.16-55-00.bus.G340.r13.avi
    START=41
    WHAT="ground camera G340 (one fixed camera over a parking lot)" ;;
  meva-lot-g424)
    KEY=drops-123-r13/2018-03-07/16/2018-03-07.16-50-06.16-55-06.school.G424.r13.avi
    START=62
    WHAT="ground camera G424 (a parking lot: vans, pickups, people walking)" ;;
  meva-transit-g341)
    KEY=drops-123-r13/2018-03-07/16/2018-03-07.16-50-05.16-55-05.hospital.G341.r13.avi
    START=0
    WHAT="ground camera G341 (a transit stop and a road: cars driving through)" ;;
  meva-courtyard-g638)
    KEY=drops-123-r13/2018-03-07/16/2018-03-07.16-50-00.16-55-00.school.G638.r13.avi
    START=82
    WHAT="ground camera G638 (a building entrance and courtyard: people walking)" ;;
  all) for n in meva-parking-g340 meva-lot-g424 meva-transit-g341 meva-courtyard-g638; do "$0" "$n"; done; exit 0 ;;
  *) echo "library-meva: unknown preset $NAME" >&2; exit 2 ;;
esac

# The encode recipe (RLC-1224A formats) is shared with library-normalize.sh.
source scripts/lib/recipe.sh
SECONDS_LONG=60

BUCKET=https://mevadata-public-01.s3.amazonaws.com
OUT=${LIBRARY_OUT:-library}/$NAME
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "Downloading $KEY ..."
curl -fsS --retry 3 -o "$WORK/source.avi" "$BUCKET/$KEY"

mkdir -p "$OUT"
echo "Encoding main ..."
encode_main "$WORK/source.avi" "$OUT/main.mp4" "$START" "$SECONDS_LONG"
echo "Encoding sub ..."
encode_sub "$WORK/source.avi" "$OUT/sub.mp4" "$START" "$SECONDS_LONG"

cat > "$OUT/CREDITS.txt" <<EOF
$NAME

Source: MEVA - Multiview Extended Video with Activities, Kitware, Inc.
        https://mevadata.org/
        K. Corona et al., "MEVA: A Large-Scale Multiview, Multimodal Video
        Dataset for Activity Detection", WACV 2021.
File:   $KEY
        (s3://mevadata-public-01), $WHAT,
        $SECONDS_LONG s from offset $START s.
Changes: cut to $SECONDS_LONG s; scaled to ${MAIN_W}x${MAIN_H} (main.mp4, H.265, $MAIN_FPS fps)
        and ${SUB_W}x${SUB_H} (sub.mp4, H.264, $SUB_FPS fps); silent AAC 16 kHz added.
License: Creative Commons Attribution 4.0 International (CC BY 4.0)
        https://creativecommons.org/licenses/by/4.0/
EOF
echo "Done: $OUT (main.mp4, sub.mp4, CREDITS.txt)"
