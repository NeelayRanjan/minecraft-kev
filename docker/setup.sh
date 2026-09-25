#!/usr/bin/env bash
# One-time setup inside the container (idempotent): node_modules, the Paper jar and its unpacked libraries, the kev venv.
# docker exec mckev docker/setup.sh
set -euo pipefail
cd /work/minecraft-kev
KEV=${KEV:-../overcooked-kev/kev}
say() { echo "[$(date '+%F %T')] setup: $*"; }

if [ ! -d node_modules/mineflayer ] || [ ! -d node_modules/node-canvas-webgl ]; then
  say "npm ci"; npm ci --no-audit --no-fund
fi

JAR=server/paper-1.20.4-499.jar SHA=e84aa4943cc51d7545b1c9b669bb1e0b143323d248ebb89012182f5554bc13d7
if [ ! -f "$JAR" ] || ! echo "$SHA  $JAR" | sha256sum -c --quiet; then
  say "download Paper"; curl -sL -o "$JAR" "https://fill-data.papermc.io/v1/objects/$SHA/paper-1.20.4-499-mojang.jar"
  echo "$SHA  $JAR" | sha256sum -c
fi
if [ ! -d server/libraries ] || [ ! -d server/versions ]; then
  say "first Paper start (unpacks libraries/ versions/ cache/)"
  rm -f /tmp/paper-first.log
  ( cd server && { until grep -q 'Done (' /tmp/paper-first.log 2>/dev/null; do sleep 2; done; echo stop; } | java -Xmx2G -jar paper-1.20.4-499.jar --nogui > /tmp/paper-first.log 2>&1 ) || true
  grep -q 'Done (' /tmp/paper-first.log && say "Paper unpacked" || { tail -20 /tmp/paper-first.log; exit 1; }
fi

if [ ! -x "$KEV/.venv/bin/python" ]; then
  say "kev venv (Linux, in the kev-venv volume)"
  ( cd "$KEV" && uv sync --frozen --extra serve --python 3.13 && uv pip install --python .venv/bin/python flash-linear-attention "triton>=3.7.1" )
fi
"$KEV/.venv/bin/python" -c "import torch, fla; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0))"
say "done"
