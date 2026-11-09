# The encode recipe for library videos, shared by library-meva.sh and
# library-normalize.sh (source this file). Videos can only be played one after
# another in live view when their encoder parameter sets are identical, so
# every library video that should combine must come from these two functions.
#
# The RLC-1224A's streams (src/profile/rlc1224a.ts GetEnc): main H.265
# 4512x2512 at 20 fps, 8 Mbit/s, keyframe every 2 s; sub H.264 896x512 at
# 10 fps, 1 Mbit/s, keyframe every 4 s. Audio: AAC 16 kHz mono 32k.
#
#   encode_main <in> <out> <start-seconds> <seconds>
#   encode_sub  <in> <out> <start-seconds> <seconds>
#
# The audio is silent unless RECIPE_AUDIO=input (then the input's first audio
# track, resampled; the input must have one).
MAIN_W=4512 MAIN_H=2512 MAIN_FPS=20
SUB_W=896 SUB_H=512 SUB_FPS=10

# Scale to fit and pad. The scaled picture can get a sample aspect ratio that is
# not exactly 1 (a 1280x720 source into 4512x2512 does), and the source's colour
# tags would follow it as well; the encoders write both into the parameter sets
# (VUI), so setsar and setparams make every output untagged, like the MEVA clips.
recipe_fit() {
  echo "scale=$1:$2:force_original_aspect_ratio=decrease,pad=$1:$2:(ow-iw)/2:(oh-ih)/2,setsar=0,setparams=color_primaries=unknown:color_trc=unknown:colorspace=unknown"
}

# Sets the array RECIPE_IN to the ffmpeg input arguments and RECIPE_MAP to the maps.
recipe_inputs() { # <in> <start> <seconds>
  RECIPE_IN=(-ss "$2" -i "$1" -t "$3")
  if [ "${RECIPE_AUDIO:-silent}" = input ]; then
    RECIPE_MAP=(-map 0:v:0 -map 0:a:0 -af apad) # padded: -shortest must not cut the video to a shorter audio
  else
    RECIPE_IN=(-ss "$2" -i "$1" -f lavfi -i anullsrc=r=16000:cl=mono -t "$3")
    RECIPE_MAP=(-map 0:v:0 -map 1:a:0)
  fi
}

encode_main() {
  recipe_inputs "$1" "$3" "$4"
  ffmpeg -v error -y "${RECIPE_IN[@]}" "${RECIPE_MAP[@]}" \
    -vf "$(recipe_fit $MAIN_W $MAIN_H),fps=$MAIN_FPS" \
    -c:v libx265 -preset medium -b:v 8M -maxrate 8M -bufsize 16M \
    -x265-params keyint=$((MAIN_FPS * 2)):min-keyint=$((MAIN_FPS * 2)):bframes=0:log-level=error -tag:v hvc1 \
    -pix_fmt yuv420p -c:a aac -b:a 32k -ar 16000 -ac 1 -shortest -movflags +faststart "$2"
}

encode_sub() {
  recipe_inputs "$1" "$3" "$4"
  ffmpeg -v error -y "${RECIPE_IN[@]}" "${RECIPE_MAP[@]}" \
    -vf "$(recipe_fit $SUB_W $SUB_H),fps=$SUB_FPS" \
    -c:v libx264 -profile:v high -preset medium -b:v 1M -maxrate 1M -bufsize 2M \
    -g $((SUB_FPS * 4)) -keyint_min $((SUB_FPS * 4)) -sc_threshold 0 \
    -pix_fmt yuv420p -c:a aac -b:a 32k -ar 16000 -ac 1 -shortest -movflags +faststart "$2"
}
