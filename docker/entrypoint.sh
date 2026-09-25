#!/usr/bin/env bash
# A virtual display for headless-gl (prismarine-viewer's video recorder), then the command.
if ! pgrep -x Xvfb > /dev/null; then
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99   # a restarted (not recreated) container keeps /tmp, and the stale lock makes Xvfb exit at once
  Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp > /tmp/xvfb.log 2>&1 &
fi
exec "$@"
