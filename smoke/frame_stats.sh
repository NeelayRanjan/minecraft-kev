#!/usr/bin/env bash
# Extract the last frame of a render to PNG and print its mean luma (0-255) so day vs night can be compared.
# Usage: smoke/frame_stats.sh out/render_day.mp4
set -euo pipefail
in="$1"
png="${in%.mp4}.png"
ffmpeg -loglevel error -y -sseof -0.1 -i "$in" -frames:v 1 -update 1 "$png"
yavg=$(ffmpeg -loglevel info -i "$png" -vf "signalstats,metadata=print:file=-" -f null - 2>/dev/null | grep -oE 'YAVG=[0-9.]+' | head -1 | cut -d= -f2)
nframes=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$in")
echo "$in: frames=$nframes last_frame=$png mean_luma=$yavg"
