# Running on the Windows machine (Docker)

The whole pipeline runs in one CUDA container (`docker/Dockerfile`): Paper (Java 21), Node 22 with the native
canvas/headless-gl build and Xvfb for the video recorder, ffmpeg, a Linux kev venv with flash-linear-attention, and
matplotlib for the reliability diagrams (`$CPY=/opt/cpy/bin/python`). Needs Docker Desktop (WSL2 backend) and an NVIDIA driver.

```powershell
docker compose -f docker/compose.yml up -d --build     # container "mckev"
docker exec mckev docker/setup.sh                      # once: npm ci, Paper jar + libraries, kev venv (in named volumes)
docker exec -it mckev bash                             # then every command in CLAUDE.md works unchanged
```

Layout: `minecraft-kev/` and `../overcooked-kev/` are bind-mounted at `/work/...`, so `KEV=../overcooked-kev/kev` holds.
Named volumes shadow what must be Linux-native: `overcooked-kev/kev/.venv` (the Windows host keeps its own venv
there), `node_modules/` and `servers/` (Paper worlds, symlinks). The HF cache is shared with the host
(`%USERPROFILE%\.cache\huggingface`). The viewer is published on the host's 127.0.0.1:8085
(`docker exec -d mckev python3 viewer/serve.py 8085`); kev.serve's 8009 stays inside the container.

LLM leader: Ollama runs in the container with its models in the repo's gitignored `tools/ollama`:
`docker exec -d mckev bash -c 'OLLAMA_MODELS=/work/minecraft-kev/tools/ollama OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 setsid nohup ollama serve > /tmp/ollama.log 2>&1'`.
GGUFs downloaded to `tools/models/` are imported with a one-line Modelfile (`FROM /work/minecraft-kev/tools/models/<file>.gguf`;
Ollama takes the chat template from the GGUF). `scripts/leader_bench.mjs` compares leaders offline on logged decision points.

Memory: five bots with their Paper servers take ~11 GB and kev.serve ~3.3 GB; the WSL2 VM defaults to half the RAM,
so `%USERPROFILE%\.wslconfig` sets `memory=24GB` (then `wsl --shutdown` and restart Docker Desktop).

Long jobs: `docker exec -d mckev bash -c 'setsid nohup scripts/<x>.sh > data/<x>.log 2>&1'`. There is no
systemd-inhibit; keep Windows awake for the run (Settings > Power, or a SetThreadExecutionState keeper).

Line endings: `.gitattributes` forces LF (bash in the container rejects CRLF scripts that `core.autocrlf=true` would
check out).

## Remote use over Tailscale (since 2026-09-25)

The desktop is reached from the laptop over the tailnet, not AnyDesk (the pipeline's GPU load dropped AnyDesk; SSH does
not care). Windows OpenSSH Server is enabled; from the laptop `ssh homepc` (alias in `~/.ssh/config`, user `rneel`).
The remote shell is cmd.exe, so do not quote bash in the command line: pipe a script into the container instead,
`ssh homepc 'docker exec -i mckev bash' < script.sh`. Long jobs are launched from such a script with `setsid nohup ... &`.

The LLM leader for laptop-side runs is the **native Windows Ollama** on the tailnet (`--llm-url http://100.109.91.95:11434`),
not the container's: `OLLAMA_HOST` is the Tailscale IP, and `C:\Users\rneel\.ollama\models` is a directory junction to
this repo's `tools\ollama`, so both Ollamas share the imported models. User-level variables set the container's flags
(`OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`,
`OLLAMA_KEEP_ALIVE=30m`). Restart it with `taskkill /f /im "ollama app.exe" & taskkill /f /im ollama.exe & schtasks /run /tn OllamaTray`
(a logon task that starts the tray app). Measured from the laptop with the 27B IQ2_S and the JSON schema: ~1 s per warm
call, no penalty after idle gaps up to 150 s, ~2 min for the first call after a restart (load) and ~30 s for the first
call with the schema (grammar compile), so send one warm-up call at episode start.

Before a run that records video: `docker exec mckev pgrep -a Xvfb` must show a live server, not `<defunct>` (see the
Xvfb lock lesson in CLAUDE.md).
