# CLAUDE.md

## What this is

**minecraft-kev**: a Minecraft survival agent where a scripted Mineflayer motor layer acts, **kev** (a 0.8b typed-decision model: Qwen3.5 base + LoRA + pointer head, upstream https://github.com/jaredpalmer/kev) picks the next subtask from a declared list and forecasts outcomes with calibrated probabilities, and a planner above it sets goals. Sister project of `overcooked-kev` (Overcooked and air-combat tracks); the lessons and recipe carry over from there.

The acceptance criterion: **every decision comes with a calibrated probability that can be displayed and checked.** Playing well is secondary. If a change makes the agent stronger but the probabilities less legible or less calibrated, it is the wrong change. New here: the probabilities are meant to be *used*, a planner replans when kev forecasts failure (milestone 2).

Repo: https://github.com/NeelayRanjan/minecraft-kev (private). Trained checkpoint and data are release assets, not in git (see Setup).

## Status (2026-09-24, end of day 2; day 3 below)

Experiment 1 (iron pickaxe from spawn, text state) is built, trained once, evaluated, and its definition-of-done item 1 is met. Everything runs on the 8 GB laptop; the next session should move to the 16 GB machine.

- **Built:** option list with preconditions, tech-tree teacher, serializer (golden-text test), question schema with post-hoc labelers and censoring, Mineflayer motor layer with typed results, 1 Hz runner, parallel data generation on one Paper server per bot, video recorder, replay viewer, split/train/eval/drive/reliability pipeline, a local-LLM leader policy (Ollama). 70 unit tests (`npm test`).
- **mc-v1** (kev-0.8b fine-tuned on 7,948 records, 40 teacher-driven seeds, 80 min on the laptop): held-out dev (12 unseen seeds) acc 0.80 / ECE 0.09 vs baseline 0.68 / 0.21. `next_subtask` 0.95. `subgoal_succeeds_60s` 0.56 acc, ECE 0.28: overconfident in states where the bot was stuck. `reports/mc-v1/`.
- **Driving on 20 unseen seeds after the motor fixes** (`reports/mc-v1/compare.txt`): kev alone **13/20 (65%)** iron pickaxe within 15 min, teacher 14/20, a local Qwen3 4B leader 0/20. The same checkpoint scored 2/20 before the fixes: the gain was entirely the motor/option layer (livelock breaker, make-room placement, walk to a remembered table).
- **Open:** the headline forecast is not yet calibrated on the states kev itself visits (DAgger round pending); `survive_until_morning` has no labels yet (20-minute episodes end before sunrise); the combined "LLM leader + kev forecasts in the prompt" mode exists but was never measured at scale (both models do not fit on 8 GB beside the desktop).

Full results, the bugs found and why they mattered: see "Results (2026-09-24)" further down.

## Status (2026-09-25, day 4: remote setup done, DAgger night running, supervisor test negative)

**Remote setup (next step 1) is done.** Tailscale on both machines, `ssh homepc` from the laptop, the native Windows Ollama serving the imported models on the tailnet (`--llm-url http://100.109.91.95:11434`; ~1 s per warm 27B call from the laptop). Details and quirks: `docker/README.md`, "Remote use over Tailscale". Minecraft + kev run on the laptop, GPU jobs run in the desktop's container over SSH.

**The DAgger night (next step 3) ran on the desktop** (`scripts/night_mc3.sh`, launched 00:09 after `rebuild_data` made `data/mc1_dagger.jsonl` from the 15 finished DAgger episodes: 2,959 records, `subgoal_succeeds_60s` 46% true, `survive_until_morning` 52% true). Phase B: **mc-v2** (mc-v1 + DAgger, 2 h) on the old holdout: `next_subtask` 0.96, `threat_response` 0.92, `subgoal_succeeds_60s` acc 0.59 / ECE 0.23 (mc-v1: 0.56 / 0.28). The 22-minute recollection finished (40 train + 20 holdout seeds; seeds 0-1 were rerun after the Xvfb crash below and appended: 8,265 teacher records). Phase C: **mc-v2 drives 16/20 within 15 min (18 ever)** on 1000-1019; the teacher runs and phase D (mc-v3 with `survive_until_morning`) were still running when this was written. Check `data/night_mc3.log`, `reports/mc-v2/`, `reports/mc-v3/` on the desktop; `data/night_mc3.done` marks the end.

**Leader viability (next step 2a, 2b): the forecasts are not yet actionable.**
- `scripts/reliability.py` now reports AUROC and the Brier decomposition (resolution / uncertainty) beside ECE. mc-v1's `subgoal_succeeds_60s`: AUROC 0.63 on the dev split, **0.68 on the states kev itself drives** (`reports/mc-v1/driven-postfix/`, the post-fix compare records scored offline), resolution 0.02 of a possible 0.19. `survive_until_morning` 0.51 (untrained, as expected).
- The scripted supervisor (`agent/supervisor.js`, `scripts/supervisor_eval.sh`, `reports/mc-v1/supervisor.txt`): abandon the running subtask when p < 0.25 for 15 s, withhold it at the next decision. Four arms of mc-v1 on seeds 1000-1019, iron pickaxe within 15 min: **off 13/20, off again 10/20, real forecasts 14/20 (1.9 replans/episode), shuffled forecasts 15/20 (0.8/episode)**. The real arm does not beat the shuffled one, and the two off runs differ by 3 episodes, so **this 20-seed evaluation cannot resolve differences under about 4 episodes** (compare kev with the teacher inside a run only, and treat 13 vs 16 as suggestive). Read: with mc-v1's forecasts a threshold rule gains nothing over random abandons; any abandon that breaks a stuck state helps a little. Redo the test with mc-v3 (better forecasts) and more seeds before building a leader that replans on forecasts.
- The first shuffled arm drew an independent pool value every second and never fired (0.24^15); the arm now holds one draw per subtask, redrawn every 15 s. Keep that in mind for any future "shuffled control".

**Next (the user's plan):** randomised starting states (inventory drawn from a tech-tree stage, time of day, spawn offset, a typed task) as *supervised* data collection, with a start spec that can also replay a state captured from a hand-played session (the user wants to put the bot into odd situations by hand). RL was considered and set aside: calibration is a supervised objective and the real-time server yields ~300 episodes a night.

## Status (2026-09-24, day 3, Windows machine): stopped mid-run, plan changed

**Why it stopped.** The user works on the Windows machine remotely over AnyDesk. The full pipeline (5 bots with their Paper servers, kev.serve, an LLM on the GPU) drops the AnyDesk session, and with it all control of the machine. At about 18:20 PDT everything was stopped on request: the overnight job, the leader bench, kev.serve, Ollama. The `mckev` container is stopped (`docker compose -f docker/compose.yml up -d` brings it back; Ollama and the viewer must be restarted by hand, see `docker/README.md`).

**New plan (the user's).** Reach this machine over **Tailscale** from the personal laptop instead of AnyDesk, and have this machine **host Ollama with a larger Qwen3.8-27B variant (a distilled build)** as the LLM leader. The rest of the loop would then call it over the tailnet (`--llm-url http://<tailscale-name>:11434`; `askPlanner` already takes a URL). *To confirm with the user:* where the Minecraft/kev side runs under this plan (the laptop, calling this machine only for the leader, is the reading here). What the plan needs:
- **Ollama reachable on the tailnet:** `OLLAMA_HOST=0.0.0.0` (or the Tailscale IP), and a Windows firewall rule for 11434 limited to the Tailscale interface. Running Ollama natively on Windows is simpler than in the container for this role.
- **VRAM:** with no kev.serve beside it, the desktop leaves about 14 GB (1.9 GB used at idle once Medal, the NVIDIA overlay, SteelSeries GG and the Xbox apps were closed). That fits a larger 27B quant than tonight's: UD-IQ3_S 12.0 GB, UD-Q3_K_XL 13.2 GB; UD-IQ4_XS at 14.3 GB is too tight. Check which quants the chosen distillation ships.
- **Load:** hosting only the leader is a far lighter load than the full pipeline, so the remote session should survive it. The Minecraft side is the heavy part.

**Where the work was left.**
- Step 1 (setup) and step 3 (widened breaker) are done; see the day-3 lessons.
- **DAgger (step 2): 15 of 24 episodes finished** (`out/dagger_s2000`–`s2014.json`, mc-v1 driving, 22 min each, no crashes once CPU boost was off). The merged `data/mc1_dagger.jsonl` was never written (gen_data writes it at the end). Rebuild it with `node agent/rebuild_data.mjs --prefix dagger --seed0 2000 --seeds 15 --thin 8 --out data/mc1_dagger.jsonl`, then `scripts/night_mc3.sh` skips phase A and continues. Phases B–D (mc-v2, the 22-minute recollection, mc-v3) never ran.
- **Leader bench (`scripts/leader_bench.mjs`, `reports/leader_bench/`, table via `scripts/leader_bench_report.mjs`):** logged kev-driven decision points replayed through candidate leaders with the live prompt. 200 points (half right after a failed subtask) from seeds 2000–2004, scored before the goal (91 points; afterwards the teacher idles). All candidates ran fully on the GPU beside kev.serve serving 5 bots:

  | leader | valid | agrees with teacher | threat decisions agree | re-picks a just-failed subtask (teacher 0.49, kev 0.66) | answers changed without kev's forecasts | latency p50 | kev p50 while it runs |
  |---|---|---|---|---|---|---|---|
  | qwen3:8b (Q4, 5.1 GB) | 1.00 | 0.37 | 0.28 | 0.31 | 0.18 | 0.9 s | 155 ms |
  | Qwen3.8-27B UD-IQ2_S (8.4 GB) | 0.99 | **0.49** | **0.53** | **0.20** | 0.17 | 3.0 s | 167 ms |

  With about ±0.10 on each rate, the 27B is better across the board, even at 2 bits. Sharing the GPU costs kev almost nothing. Both models read the forecasts only weakly: removing them changes about 1 answer in 6. Some disagreements come from the prompt, not the model: `planner.js`'s tech-tree line "mine_stone until 11 cobblestone" lumps the furnace's 8 in with the pickaxe's 3, and the 27B followed it literally. Fix that before the next bench. UD-Q2_K_XL and UD-IQ3_XXS are downloaded (`tools/models/`) and imported into Ollama (`tools/ollama`, as `qwen38-27b-q2kxl` and `qwen38-27b-iq3xxs`) but not benchmarked; the Q2_K_XL run was interrupted.

**Changes made to the Windows machine** (so they can be undone):
- CPU boost is off in the Ultimate Performance plan (see the crash lesson below). To revert: `powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PERFBOOSTMODE 2`, `PROCTHROTTLEMAX 100`, `PROCTHROTTLEMAX1 100`, then `powercfg /setactive SCHEME_CURRENT`. The real fix is a BIOS update (MSI PRO Z790-P WIFI, microcode 0x12B or later) when someone is at the machine.
- `%USERPROFILE%\.wslconfig` sets memory=24GB.
- A native-Windows kev-4b server (overcooked-kev) was stopped.
- Medal, the NVIDIA overlay, SteelSeries GG, the Xbox apps and Phone Link were closed; AnyDesk was never touched.

## Repo layout

```
agent/
  subtasks.js      declared subtask list, option ids "name(arg)", preconditions, gathering caps, livelock breaker   (pure)
  teacher.js       techStep(obs) 1..8, teacherSubtask(obs), teacherThreat(obs)                                     (pure)
  serialize.js     serialize(obs) -> the state text (tests/serialize.test.mjs holds the golden text)               (pure)
  questions.js     questionFor(qid), buildQuestions(obs,{decision}), labelDecisions(decisions, timeline)          (pure)
  summary.js       summarize(bot, mcData, mem, ctx) -> obs (the only Mineflayer reader); EpisodeMemory
  motor.js         Motor.run(id, obs) -> {result, detail}; interrupt(reason); typed results; all the Mineflayer workarounds
  policy.js        chooseAction (validates the choice against the offered list), interruptFor                     (pure)
  logger.js        EpisodeLog (frames / decisions / events / timeline), oneHot, fromKev, toRecords, censoring     (pure)
  relabel.js       injectDeaths, reconstructQs, rebuildRecords: kev records from a raw log with the current labelers
  thin.js          record thinning shared by gen_data and rebuild_data
  planner.js       LLM leader: buildPlannerMessages, answerSchema (JSON schema over the offered ids), askPlanner (Ollama)
  supervisor.js    scripted supervisor: abandon the running subtask when p(step done in 60 s) < 0.25 for 15 s; off / real / shuffled arms (pure)
  kev_client.js    POST /v1/systemone
  recorder.js      first-person video at a fixed fps over prismarine-viewer's headless internals (entity whitelist)
  server_ctl.js    startServer({port, seed}) -> one Paper instance per bot (servers/<port>/, shared libraries)
  run_episode.mjs  one episode; gen_data.mjs many in parallel; rebuild_data.mjs records from raw logs
docker/            Dockerfile, compose.yml, setup.sh, README.md: the whole pipeline in one CUDA container (the Windows machine)
tests/             node --test tests/*.test.mjs ; tests/integration/{motor_check,mem_probe}.mjs start their own server (no GPU)
scripts/           collect_mc1.sh, overnight_mc1.sh, split.sh, train_mc1.sh, eval_mc1.sh, bench_ctx.py, drive_eval.sh,
                   compare_mc1.sh (3 drivers), dagger_mc1.sh, night_mc3.sh (DAgger + recollection, day 3), warm_kev.mjs,
                   leader_bench.mjs + leader_bench_report.mjs (offline LLM-leader comparison), supervisor_eval.sh (3 supervisor arms on the same seeds),
                   base_rates.py, reliability.py (ECE, AUROC, Brier resolution), drive_summary.py
viewer/            python3 viewer/serve.py 8085 ; http://127.0.0.1:8085/?run=<name> plays out/<name>.mp4 with the probability bars
server/            Paper template: eula.txt, server.properties, ops.json, run.sh (the jar is downloaded, see Setup)
reports/<run>/     dev reports, reliability diagrams + table, drive/compare tables (tracked)
data/, out/, servers/, tools/, media/   gitignored (data and checkpoints travel as release assets)
docs/superpowers/plans/2026-09-23-experiment-1.md   the plan that built experiment 1
```

## Setup on a new machine

Tested on Fedora (laptop). **The 16 GB machine (Windows 11, RTX 4070 Ti SUPER, 32 GB) runs everything in a Docker container: see `docker/README.md`** (`docker compose -f docker/compose.yml up -d --build`, `docker exec mckev docker/setup.sh`, then every command below inside `docker exec -it mckev bash`). Git Bash alone is not enough: the scripts use `pkill`, `setsid`, `realpath` and symlinks. The steps below are the bare-Linux route.

```bash
# 1. system packages (Ubuntu/WSL2)          Fedora: dnf install libXi-devel mesa-libGL-devel pango-devel libjpeg-turbo-devel giflib-devel cairo-devel ffmpeg
sudo apt install -y build-essential pkg-config ffmpeg libxi-dev libgl1-mesa-dev libpango1.0-dev libjpeg-dev libgif-dev libcairo2-dev libxext-dev libx11-dev curl git

# 2. the parent project (for kev, its venv, split_data.py, and a python with matplotlib)
git clone git@github.com:NeelayRanjan/overcooked-kev && cd overcooked-kev
git clone https://github.com/jaredpalmer/kev && cd kev && uv sync --extra serve && uv pip install flash-linear-attention "triton>=3.7.1" && cd ..   # see overcooked-kev/CLAUDE.md
cd client && uv venv --python 3.10 .venv && uv pip install --python .venv/bin/python matplotlib numpy requests && cd ../..
# scripts default to KEV=../overcooked-kev/kev and CPY=../overcooked-kev/client/.venv/bin/python; export both if the layout differs

# 3. this repo
git clone git@github.com:NeelayRanjan/minecraft-kev && cd minecraft-kev
npm install && npm install github:PrismarineJS/node-canvas-webgl      # native build: needs the packages from step 1
mkdir -p tools && curl -sL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk" | tar xz -C tools   # Java 21 (25 is untested with Paper 1.20.4)
curl -sL -o server/paper-1.20.4-499.jar https://fill-data.papermc.io/v1/objects/e84aa4943cc51d7545b1c9b669bb1e0b143323d248ebb89012182f5554bc13d7/paper-1.20.4-499-mojang.jar
sha256sum server/paper-1.20.4-499.jar   # e84aa4943cc51d7545b1c9b669bb1e0b143323d248ebb89012182f5554bc13d7
(cd server && ../tools/jdk-21*/bin/java -Xmx2G -jar paper-1.20.4-499.jar --nogui)   # first start unpacks libraries/ versions/ cache/ (shared by every instance); stop it with "stop" once you see "Done"
npm test                                             # 70 unit tests, no server needed
node tests/integration/motor_check.mjs --seed motor-1   # ~4 min, starts its own server; must print PASS

# 4. the LLM leader (optional): Ollama; on 16 GB use the 8B model
curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen3:8b
sudo mkdir -p /etc/systemd/system/ollama.service.d && printf '[Service]\nEnvironment="OLLAMA_CONTEXT_LENGTH=2048"\n' | sudo tee /etc/systemd/system/ollama.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart ollama

# 5. checkpoint and data from the GitHub release (v0.1-mc-v1)
gh release download v0.1-mc-v1 --repo NeelayRanjan/minecraft-kev --dir /tmp/mc-v1-assets
tar xzf /tmp/mc-v1-assets/mc-v1-checkpoint.tar.gz -C ../overcooked-kev/kev/runs/     # -> runs/mc-v1
tar xzf /tmp/mc-v1-assets/mc1-data.tar.gz -C .                                        # -> data/mc1.jsonl, mc1_holdout.jsonl, mc1_ep/, compare_*.jsonl
```

Disk: each Paper instance is ~60 MB plus its world; a 20-minute episode writes ~1.5 MB of logs and ~30 MB of video when recorded. The laptop ran out of disk once (Steam and model caches); check `df` before an overnight run.

## How to run

```bash
npm run server / npm run server:stop            # the template server alone (smoke tests); every pipeline starts its own instances
node agent/run_episode.mjs --seed 7 --port 25580 --policy teacher --minutes 3 --out t7 --video     # one episode -> out/t7.{json,jsonl,mp4}
node agent/run_episode.mjs --seed 7 --port 25580 --policy kev --kev-url http://127.0.0.1:8009 --minutes 22 --out k7
node agent/run_episode.mjs --seed 7 --port 25580 --policy llm --llm-model qwen3:8b --kev-url http://127.0.0.1:8009 --minutes 22 --out l7   # LLM leader, kev forecasts in its prompt
node agent/run_episode.mjs --seed 7 --port 25580 --policy kev --kev-url http://127.0.0.1:8009 --supervisor real --minutes 22 --out sup7      # + scripted supervisor (shuffled needs --supervisor-pool)
scripts/supervisor_eval.sh mc-v1 20 1000 22     # arms off / real / shuffled on seeds 1000-1019 -> reports/mc-v1/supervisor.txt
node agent/gen_data.mjs --seeds 40 --seed0 0 --procs 5 --minutes 22 --eps-action 0.1 --thin 8 --out data/x.jsonl --prefix x [--video --video-seeds 3]
node agent/rebuild_data.mjs --prefix x --seed0 0 --seeds 40 --thin 8 [--drop survive_until_morning] --out data/x.jsonl   # relabel from out/x_s*.json
python3 scripts/base_rates.py data/x.jsonl       # every noul should sit between 20% and 80% true; rare labels teach nothing
scripts/split.sh data/x.jsonl data/x_holdout.jsonl data/x_ep && scripts/train_mc1.sh <run> data/x_ep/train.jsonl [init] && scripts/eval_mc1.sh <run> data/x_ep
scripts/drive_eval.sh <run> 20 1000 22           # kev vs teacher on seeds 1000-1019 ; scripts/compare_mc1.sh <run> adds the LLM leader
../overcooked-kev/client/.venv/bin/python scripts/reliability.py $KEV/runs/<run>-dev/rows.json --censoring data/x_holdout.report.json --out reports/<run>
python3 viewer/serve.py 8085                     # replay viewer (the parent project's viewer uses 8080)
# long jobs: setsid nohup systemd-inhibit --what=sleep:idle --who=minecraft-kev --why=x --mode=block scripts/<x>.sh > data/<x>.log 2>&1 &   (drop systemd-inhibit where it does not exist)
```

Shell trap (bit us four times): `pkill -f pattern` kills the shell whose own command line contains the pattern, including a commit message. Use `pkill -f '[p]aper-1.20.4'` (bracketed first letter) and never put the pattern text elsewhere in the same command.

## Next steps, in order

1. ~~Decide the remote setup~~ Done on day 4: Tailscale, native Ollama on the desktop, Minecraft/kev on the laptop (`docker/README.md`).
2. **Leader viability, before building a real leader** (from the day-3 discussion):
   - (a) ~~Add AUROC/resolution to `scripts/reliability.py`~~ Done (day 4): mc-v1 `subgoal_succeeds_60s` AUROC 0.63 dev / 0.68 on kev-driven states, resolution near zero.
   - (b) ~~A scripted supervisor against off and shuffled arms~~ Done (day 4), negative for mc-v1: real 14/20 vs shuffled 15/20 vs off 13 and 10 (`reports/mc-v1/supervisor.txt`). Rerun with mc-v3 and 40+ seeds (`scripts/supervisor_eval.sh mc-v3 40 1000 22`) before any forecast-driven leader.
   - (c) Rebuild the leader to the design of record: typed subgoals at low cadence, with kev choosing subtasks inside them. Today's `--policy llm` makes the LLM do kev's per-decision job, and at 3 s per call a 27B leader only works at subgoal cadence.
   - (d) Milestone 2 (the night) is where a leader has real decisions to make. Experiment 1 is fully scriptable.
   - (e) Fix the cobblestone line in `planner.js`'s system prompt, then bench the distilled 27B (and Q2_K_XL / IQ3_XXS) on the same pinned sample (`--seeds 2000-2004 --n 200 --ablate 60`).
3. **Finish DAgger and the recollection** on a machine where the load does not cut remote access: rebuild `data/mc1_dagger.jsonl` (see the day-3 status) and run `scripts/night_mc3.sh`. It (A) lets mc-v1 drive DAgger seeds 2000-2023, (B) trains mc-v2 on mc1 + DAgger against the old holdout while the teacher recollects seeds 0-39 plus a 20-seed holdout (1000-1019) at 22 minutes with `survive_until_morning` labelled, (C) drives mc-v2 on 1000-1019 against the teacher, and (D) trains mc-v3 from mc-v2 on the recollection + DAgger records (the old 20-minute mc1 data is left out), evaluates it on the new holdout and drives it. Reports: `reports/mc-v2/`, `reports/mc-v3/`, each with `driven/`. The drive numbers use the widened breaker and the two motor fixes below, so compare kev with the teacher inside a run, not with mc-v1's `compare.txt`. The phases are restartable: A skips if `data/mc1_dagger.jsonl` exists, B skips if the checkpoint or `data/mc3_collect.done` exists.

   Targets once it has run: `subgoal_succeeds_60s` ECE well under 0.1 on the dev split *and* on the driven records; `survive_until_morning` base rate between 20% and 80% (`reports/mc-v3/base_rates*.txt`). Its holdout is only 20 episodes, and the labels within an episode are nearly all the same, so its reliability diagram is noisy. Update Status and Results.
4. **Measure the combined mode**: LLM leader with kev's forecasts in its prompt. On 16 GB both fit (kev.serve ~2-4 GB under 5 bots, qwen3:8b ~6 GB). `scripts/compare_mc1.sh` currently runs the LLM batch *without* `--kev-url` (laptop GPU); on the big machine add `--kev-url http://127.0.0.1:8009` to that gen_data line and start kev.serve before it. Compare against kev alone and the teacher; the thesis question is whether the leader's replans on low forecasts beat the teacher.
5. **Experiment 2 (vision)** needs a kev fork (image tokens through the processor; see "Experiment 2" below) and the 16 GB GPU; prismarine-viewer renders no day/night lighting, so pixel arms need our own darkening or must skip the night question. Not started.
6. Housekeeping: `reports/` and the plan are tracked; raw episode logs (`out/`) are not, so archive interesting runs (videos) manually. The `.superpowers/` ledger of the build is local only.

## Lessons from this project (add to the ones below)

- **mineflayer-collectblock + mineflayer-tool** recurse forever (4 GB heap in a minute) when asked to collect a block the held item cannot harvest. `Motor.collectOne` refuses such blocks.
- **mineflayer-pathfinder** with digging enabled and an unbounded `searchRadius` allocates without limit on a buried goal: keep `searchRadius` 64. Never call `bot.pathfinder.stop()` when no path exists (its flag survives and kills the next goto); `setGoal(null)` is the safe stop. collectblock replaces the Movements on every call and its `cancelTask` sets that flag.
- **Paper + mineflayer crafting:** Paper answers every window click with a full inventory resync and mineflayer shares one state id across windows; 3x3 crafts failed ~60% until clicks were serialised behind the server's reply (`clickWindow` wrapper in `Motor`). Read inventory counts only after the packet burst settles (`settleInventory`).
- **Livelocks are the enemy of both driving and calibration.** An instantly failing subtask repeated every second produces hundreds of identical states labelled "no progress" and a bot that never finishes; the option layer must withhold it (lesson 7 from Overcooked, again).
- **The 1 Hz sampler never sees the death tick** (immediate respawn): deaths are injected from events before labelling (`relabel.injectDeaths`), otherwise damage and survival labels miss every death.
- **Walking to a remembered station while carrying one** ate the whole 20 s craft timeout (a climb back to the surface table from a staircase); `findStation` now places the carried one and walks only if placing fails. **Pillaring in a 2-high tunnel** was refused by the server every time (the jump hits the ceiling); `pillar_up` opens the ceiling block first. Both found by `motor_check` on day 3; the check's spawn varies between runs of the same seed, so it hits different terrain each time (a 60 s `gather_wood` timeout from a y 52 spawn is by design).
- **The Windows machine's i9-14900KF (microcode 0x120, pre Raptor Lake fix) crashes native code under load**: 3 of the first ~7 JVM/node starts segfaulted (C2 JIT, GC worker). CPU boost is disabled in the power plan until the BIOS is updated (the pipeline runs in real time and barely needs it). `run_episode` now ends at once on a dropped connection or a dead server, and `gen_data` retries an episode that crashed before its summary (twice, fresh world).
- **Windows checkouts with `core.autocrlf=true` give CRLF shell scripts** that bash in the container rejects; `.gitattributes` forces LF.
- **The first kev.serve requests compile the fla/Triton kernels** (>10 s, past the runner's 10 s timeout, so the first decisions of a batch fell back to `kev_error`); `scripts/warm_kev.mjs` runs after every serve start. Warm latency on the 4070 Ti SUPER: p50 130 ms, p90 170 ms.
- **A restarted (not recreated) container keeps /tmp, and Xvfb refuses to start over the stale `/tmp/.X99-lock`**: every `--video` episode then crashes in `WebGLRenderer` and gen_data drops the seed after two retries (the first two recollection seeds on 2026-09-25). `docker/entrypoint.sh` now clears the lock; `pgrep -a Xvfb` must not show `<defunct>` before a run that records video.
- **Working on the Windows desktop over SSH lands in cmd.exe**: `|` inside a quoted remote command is taken by cmd, `timeout /t` fails without a console, and there is no `head`/`tail`. Pipe a bash script into `docker exec -i mckev bash` over SSH stdin instead of quoting commands (see the day-4 status).
- **A 4B local LLM is a poor leader** at this granularity: it needs a JSON schema over the offered ids to answer validly at all, cannot do the wood arithmetic (caps in the option list fix that for every driver), and still agrees with the scripted teacher on ~20% of decisions. Use it for what it does well, breaking loops, only after the option layer already does that.

---

The design of record follows (written before anything was built; "Results" and the status above supersede its estimates).

## Why this project, and when

In every earlier domain the probabilities were shown and scored, never acted on. Minecraft has goals that take minutes, uncertainty kev can't see past (unexplored terrain, night, mobs), and a natural place for a slow planner. A forecast like "p(subgoal succeeds in 60 s) = 0.2" that triggers an early replan is the first time calibration changes behaviour.

Recommended order (not a blocker): finish the air combat track's reliability diagrams first (air-v2 `missile_will_hit_me` ~56% base rate, dogfight maneuver 0.58 acc / 0.59 conf, Overcooked soup-out). The parent project's definition of done asks for a reliability diagram over ≥200 episodes and none exists yet; having one makes this project's pitch credible.

## Lessons from the earlier domains

Numbers are from `overcooked-kev` (see its CLAUDE.md and `reports/`). Each lesson is a design rule below.

1. **Imitating a deterministic teacher saturates.** Overcooked `oc-v1` reached 1.00 on subtask choice and pot urgency on held-out seeds (ECE 0.001). Useful for driving, useless as a calibration exhibit: the reliability diagram is one point at 1.0. *Rule: choice questions labelled by a script are for driving; calibration claims come from outcome questions.*
2. **Outcome labels with sane base rates are where calibration lives.** air-v2's "will this missile hit me" (56% true) and the dogfight maneuver question (teacher uses lookahead the text does not show; 0.58 acc at 0.59 confidence, ECE 0.02) are the good exhibits. *Rule: pick horizons so every noul sits roughly between 20% and 80%.*
3. **Rare labels teach nothing.** Dogfight/airsim "guns first within 20 s" was 2-4% true; the tuned model's 0.98 equals always-no. *Rule: check base rates before training; thin or reframe.*
4. **ECE without accuracy misleads.** Zero-shot dogfight choice ECE was 0.005 at 37% accuracy (a near-uniform prior). *Rule: always report accuracy, base rate and ECE together.*
5. **Zero-shot kev commits to the first or safest option.** Overcooked cooks waited forever at 0.52; the 2D dogfight circled left for 400 ticks; kev-4b was no better at choosing, only more confident. *Rule: plan to fine-tune from the start; zero-shot is a baseline row, not a milestone.*
6. **Schema dead ends kill episodes.** A cook holding an onion with no pot room had only `wait`; one wrong choice deadlocked 380 ticks. *Rule: every option list includes an escape (abandon, return, wait) and only offers options whose preconditions hold.*
7. **The motor layer needs a livelock breaker and a yield rule.** Overcooked's teacher scored 0 on two layouts until cycles of up to 10 ticks triggered a random step, and a waiting cook blocked the dish dispenser until it learned to step aside. *Rule: motor layer returns typed failures, has timeouts, and breaks cycles.*
8. **Words beat numbers for a 0.8b model.** Zero-shot kev could not turn "37 deg right of nose" into a turn; after the serializer said "blue is behind you, to the left", the fine-tune learned the maneuver question. *Rule: the serializer states relations in words ("reachable", "12 m north-east, below you") and keeps numbers short; Qwen tokenizes digits one per token.*
9. **Training cost is state length × questions.** On hybrid Qwen3.5 each question is its own row that re-reads the whole state. The 3v3 dogfight (~640 tokens, 14 questions) OOM'd on 8 GB and ran ~2 h/epoch with 6 questions per record; air-v2 at 576 tokens needed questions split into groups of 4. Laptop rates: 0.8-2.2 s/record. *Rule: budget tokens × questions per record before designing the schema.*
10. **Consecutive ticks are near-duplicates.** Subsampling every 3rd tick cost nothing measurable in Overcooked; splits must be episode-disjoint (by seed), not by state, or dev leaks.
11. **DAgger is needed once the model drives.** Teacher rollouts never contain the states a bad driver wanders into (the dogfight's mutual circle). *Rule: after the first fine-tune, label the states kev visits and retrain.*
12. **Operational.** kev's `split_data.py` checks labels and splits; `calibrate_checkpoint.py` fits temperature; `kev.benchmark` scores; `kev.compare` crashes on a NaN for these runs (read `report.json` directly); `kev.calibrate --rows` refuses remote rows; `pkill -f` from a shell containing the pattern kills that shell; long jobs run detached with `setsid nohup` and a sleep inhibitor.

## Architecture

```
LLM planner (low cadence, async)          kev 0.8b (event-driven choice + 1-2 Hz forecasts)          Mineflayer motor layer (20 Hz)
  typed subgoal from a declared list  -->   state text (+ image in experiment 2)                -->   pathfinder, collectblock, pvp, auto-eat
  <-- forecast history, events              choice: next subtask   noul/score: forecasts        <--   typed result: ok | no_path | timeout | target_gone | took_damage
```

- **Motor layer (scripted).** Mineflayer plus mineflayer-pathfinder, mineflayer-collectblock, mineflayer-pvp, mineflayer-auto-eat. Executes one subtask at a time, returns a typed result, enforces timeouts, breaks livelocks. Never learned.
- **Decision layer (kev).** Picks the next subtask from a declared, precondition-filtered option list when the motor layer finishes, fails, or hits an interrupt (hostile within 16 m, health drop, subgoal change). Emits forecasts at 1-2 Hz. Never waits on the planner.
- **Planner (LLM).** Sets mid- and long-term goals as typed subgoals. Out of the tick loop.

Decision cadence: not "several times a second" for subtask choice. Subtasks last seconds to minutes; re-picking at 3 Hz invites thrashing. Choice is event-driven with the current subtask in the state; forecasts run at 1-2 Hz. Serving budget on the laptop: ~200 ms per request for 5-6 questions on a ~400-token state, one request at a time.

## Labels

| Source | Use it for | Notes |
|---|---|---|
| Game outcomes | Every forecast (noul, outcome score) | Free and honest. Beware the feedback loop below. |
| Scripted teacher | `next_subtask` and `threat_response` in milestone 1 | The iron-pickaxe tech tree is scriptable (Mineflayer bots already do it). Exact labels, saturates, drives well. |
| LLM teacher, distilled offline | `next_subtask` for goals no script covers (milestone 2+), and DAgger labels | Sample k times per state, use vote fractions as soft labels (kev's `target` field). Measures teacher disagreement and avoids saturation. Log prompts, cache by state hash. |
| Human data (MineRL/VPT) | Deferred; maybe a "what will the human do next" headline later | Keyboard/mouse level, Minecraft 1.16. Converting to subtasks needs inventory/block events (verify which the files record). Ore distribution changed in 1.18, so location knowledge does not transfer. |

**The feedback-loop trap (new in this project).** The planner reacts to kev's forecasts, which changes the outcomes kev is scored on: if kev says 0.2 and the planner abandons the subgoal, "succeeds in 60 s" is never observed. Collect forecast training data with replanning frozen, or label only windows where the plan ran for the full horizon; report the censoring rate beside every forecast metric.

## State serializer (text, experiment 1 and arm A)

Summarised and relational, never a voxel dump. Most static first, most volatile last. Relative, rounded numbers. Facts computable by rule go in the state, not in a question. Budget ~300-400 tokens on the laptop; up to ~800 on the 16 GB machine (candidate additions: an ASCII top-down map of the 9×9 area around the player, more entities, longer memory). One serializer, the same code at data generation and play.

```
Minecraft survival, day 1. Goal from planner: get iron pickaxe (step 5 of 7: find and mine 3 iron ore). Deadline: before dusk.
time: afternoon, dusk in 2 min 40 s. weather clear. biome: forest, hills to the west.
you: health 16/20, food 13/20, standing on grass at y 71, in the open, light 15.
inventory: stone pickaxe (worn 40%), wooden pickaxe, 14 cobblestone, 9 oak planks, 3 coal, 2 bread, crafting table. no iron yet.
holding: stone pickaxe.
base: crafting table and furnace 38 m east, 2 m below you. bed: none.
memory: iron ore seen 3 min ago in a cave mouth 55 m west, 12 m below; path last tried: ok. died: never.
nearby blocks: cave entrance 22 m west (dark inside); coal ore 6 m north, reachable; exposed stone 4 m south.
nearby creatures: cow 12 m north-east (passive); nearest hostile: none within 32 m.
current subtask: explore_toward(cave west), 14 s so far, 60% of the way. last subtask result: mine coal ok.
```

Never emit `<|` or `|>` (kev rewrites them).

## Question schema (first set)

All asked in one request; each asked only when meaningful.

| id | type | options / levels | label | asked when | saturates? |
|---|---|---|---|---|---|
| `next_subtask` | choice | precondition-filtered: gather_wood, mine_stone, mine_coal, mine_iron, craft(item), smelt(item), explore_toward(target), return_to_base, eat, build_shelter, sleep, fight(threat), flee(threat), abandon_subgoal, wait | teacher | on motor-layer finish, failure or interrupt | yes with a scripted teacher; for driving |
| `threat_response` | choice | fight / flee / pillar_up / ignore | teacher | a hostile within 16 m | partly |
| `subgoal_succeeds_60s` | noul | | outcome | 1-2 Hz while a subgoal is active | no: the headline forecast |
| `iron_found_3min` | noul | | outcome | while exploring for iron | no |
| `damage_next_20s` | score | none / minor (<4 hp) / major / death | outcome | 1-2 Hz | no; ordered, use `--ord_w` |
| `survive_until_morning` | noul | | outcome | from dusk | no; few samples per episode |

Tune horizons until each noul sits between ~20% and ~80% true in the teacher data. Report accuracy, base rate, ECE and censoring rate per question.

## Planner-kev interface

- **Planner output:** one typed subgoal from a declared list, generated through a JSON schema or tool call, validated before use. Nothing is parsed from free text; the `why` field is logged, never read by code.
  ```json
  {"subgoal": "craft_item", "item": "iron_pickaxe", "deadline_s": 400, "stay_within_m": 64, "why": "..."}
  ```
  Initial list: craft_item(item), gather(item, count), find(block), return_to_base, build_shelter, sleep_through_night, flee_to_safety.
- **Planner input:** the current state text, the last N forecasts per question, and recent events (subgoal done/failed, damage, death).
- **Planner triggers:** every 3-5 minutes; subgoal done or failed; `subgoal_succeeds_60s` < 0.25 for 15 s; `survive_until_morning` < 0.5 at dusk; `damage_next_20s` major-or-death > 0.4; death.
- **Isolation:** the planner runs asynchronously; kev and the motor layer keep executing the current subgoal until a new one arrives. The subgoal is part of kev's state, so forecasts are conditioned on the current plan, and kev's option list is filtered by it.

## Infrastructure

- **Server:** local Paper or vanilla server, offline mode, pinned to a version Mineflayer and minecraft-data support well (1.20.4 is the likely pick; **verify** against minecraft-data's support list before committing). Many seeds, several bots/servers in parallel on the CPU for data collection. `/tick sprint` (1.20.3+) might speed collection if the pathfinder keeps up; treat as an experiment.
- **Language:** Node for the whole agent process (Mineflayer, plugins, serializer, kev HTTP client, planner client). Python for data splitting, training, evaluation and plots, as in the parent project.
- **kev:** same fine-tune recipe as air-v1/air-v2 (`--init_from jaredpalmer/kev-0.8b`, base Qwen3.5-0.8B-Base with its pinned revision, batch 1, accum 8, gradient checkpointing, lr 2e-5, `--perm_kl 0.5`, replay 1000, bf16, `--max_state` sized to the data). Served with `kev.serve` on port 8009.
- **Logging:** the air combat trajectory contract, adapted: `meta`; `frames` at 2-5 Hz (position, look direction, vitals, inventory deltas, entities); `decisions` (state text, image path in experiment 2, full distribution per question, labels filled post hoc); `events` (subgoal set/done/failed, damage, death, planner calls with prompt hash). The kev-format JSONL for training is written from the same run.
- **Viewer:** prismarine-viewer for the bot's view. Record video during the run (**verify** its headless mode), then a small HTML page that plays the video and drives the probability panels from the log by timestamp, in the style of `viewer/index.html` and `airviewer/`.

## Results (2026-09-24)

**mc-v1** (kev-0.8b fine-tuned on 7,948 records from 40 teacher-driven seeds; `reports/mc-v1/`): held-out dev (12 unseen seeds) overall acc 0.80 / ECE 0.09 vs baseline 0.68 / 0.21. Per question: `next_subtask` 0.95 (majority 0.42); `damage_next_20s` 0.89 vs 0.88 none-rate (rare-label problem, as predicted); `subgoal_succeeds_60s` 0.56, ECE 0.28 with one overconfident bin (states where the bot was stuck in a livelock: text says the ingredients are present, so it forecasts success). `survive_until_morning` was dropped from this round: 20-minute episodes never reach sunrise, so survivors were all censored.

**The first drive evaluation (night of 09-23) found the motor bug that dominated everything:** three instantly-failing subtasks repeated ~1,000 times per episode (smelt with no furnace in a 1-wide tunnel, craft at a table remembered at 8 m but searched within 8 blocks, gather wood with no path). Teacher 7/20, kev 2/20 on seeds 1000-1019. Fixed in `agent/subtasks.js` (livelock breaker: an option that failed the same way 3 times in a row is withheld, and the count is in the state text; gathering caps) and `agent/motor.js` (make-room placement, walk to a remembered station within 32 m).

**Three drivers on the same 20 unseen seeds (1000-1019), 22-minute episodes, after the fixes (`reports/mc-v1/compare.txt`):**

| driver | iron pickaxe within 15 min | ever | median time | deaths | subtasks failing |
|---|---|---|---|---|---|
| LLM leader (local Qwen3 4B via Ollama, `--policy llm`) | 0/20 | 1 | - | 69 | 36% |
| kev mc-v1 alone (`--policy kev`) | **13/20 (65%)** | 13 | 3.1 min | 40 | 29% |
| scripted teacher, no noise | 14/20 (70%) | 15 | 3.2 min | 47 | 15% |

Definition-of-done item 1 is met: kev drives at the teacher's level on unseen seeds (same checkpoint that scored 2/20 before the motor fixes). The 4B leader never loops but plays badly (chases unreachable coal, gathers wood on the surface at night, agrees with the teacher on ~20% of decisions); its only advantage, breaking loops, is now provided by the option layer for every driver. Its records (`data/compare_mc-v1_llm.jsonl`, next_subtask labelled by the LLM; the scripted teacher's label is kept as `teacher_label` in the log) are LLM-teacher data of poor quality. kev scored offline on the leader's states: `subgoal_succeeds_60s` ECE 0.35 with a 0.19 true rate (off-distribution overconfidence; `reports/mc-v1/llm-led/`).

**Next:** DAgger round on the kev-driven records with the fixed motor layer (`data/compare_mc-v1_kev.jsonl`, 5,148 records, teacher labels) -> `mc-v2` from `mc-v1`; recollect with 22-minute episodes so `survive_until_morning` gets labels; the breaker's window should count identical failures among the last few attempts, not only consecutive ones (the leader chased coal 51 times in one episode with other attempts in between).

## Experiment 1: iron pickaxe from spawn (text)

- **Scope:** fixed subgoal, no LLM planner. Scripted tech-tree teacher (wood, planks, crafting table, wooden pickaxe, cobblestone, stone pickaxe, find iron, furnace and fuel, smelt, iron pickaxe). kev drives `next_subtask` and emits the forecasts.
- **Data:** teacher rollouts on many seeds with epsilon noise (random actions and random valid subtasks; labels are always the teacher's choice or the true outcome), thinned consecutive ticks, episode-disjoint holdout by seed; then one DAgger round.
- **Definition of done:**
  1. kev drives to an iron pickaxe on ≥60% of 20 unseen seeds within 15 in-game minutes; the teacher's success rate is reported beside it.
  2. Every decision logged with its full distribution.
  3. Reliability diagram for `subgoal_succeeds_60s` and `iron_found_3min` over ≥200 subgoal attempts, with accuracy, base rate and censoring rate beside ECE.
  4. One replay clip with the probability bars.
- **Estimate:** infrastructure 1 day; motor layer and teacher 2-3 days (mostly pathfinder debugging); serializer, schema and data 1 day; training overnight; evaluation and viewer 1 day. About a week of agent-built work; plan for 1.5-2 weeks.

## Experiment 2: vision replaces the location report

**Question:** can kev decide and forecast from what the player sees, or only from what the game engine reports?

**What changes and what doesn't.** Only kev's input. The motor layer still uses Mineflayer's world state (pathfinding needs coordinates: kev chooses `gather_wood`, the motor layer finds the log). Labels still come from full game truth: a privileged teacher, a pixel-only student. The write-up states both.

**Arms** (same schema, same labels, same held-out seeds, same training recipe and data volume):

| Arm | kev input |
|---|---|
| A. Text | The full serializer (experiment 1's model), the control |
| B. Image + self | Front-view frame plus 3-4 text lines: vitals, inventory, goal, time. No positions, memory, nearby-block or entity lists. |
| C. Image only | Front-view frame with a drawn HUD (hearts, food, hotbar). No text except the questions. |

B is the fair test of "pixels instead of the location report". The gap between B and C shows whether the image carries the HUD information or only the scene.

**Decision rule, written before the result:**
- Vision earns a place if B is within ~2 points of A on accuracy and ECE for the in-view questions: `damage_next_20s`, `threat_response`, and `next_subtask` when the target is in view.
- It is a clear loss if B is worse even on those.
- Out-of-view questions (`iron_found_3min`, anything needing the base or memory) are expected to lose; report the size of the loss as the cost of dropping the location report.
- Also compare driving success rate and the forecast reliability diagrams across arms.

**Parameters:**
- Resolution: try 224×224 (~50 image tokens) and 448×448 (~200). Iron ore at 10 m is a few pixels at 224.
- Field of view: a single front view (~70°) sees nothing behind. Optional variant: 2-3 past frames for motion and short memory (~200 tokens each).
- Cost: each question row carries the full image in training, so 5 questions × 200 image tokens ≈ 1,000 extra tokens per record. Fine on 16 GB, slower than text runs. Serving is cheaper: the state, image included, is computed once and shared across questions.
- Storage: one JPEG per decision, ~300 MB per 10k records. Rendering speed may cap collection speed.

**kev changes needed** (the base already supports images: Qwen3.5-0.8B-Base's config is `Qwen3_5ForConditionalGeneration` with a `vision_config`; kev currently loads only the text stack via `AutoModelForCausalLM(...).model` and encodes with the tokenizer):
1. Use Qwen's processor instead of the tokenizer; place image tokens in the state prefix ahead of the text.
2. Load the vision-capable model and pass `pixel_values` through the forward call, in both the row form (training) and the prefix-cache path (serving).
3. Freeze the vision encoder; LoRA on the language layers learns to read image tokens. The pointer head is unchanged: it reads hidden states at option boundaries.
4. Extend the request format with an image field; keep text-only requests working.
5. The released adapter never saw images, so the fine-tune starts cold on the vision side. Keep the same recipe otherwise so arms are comparable.

**Things to verify before building:**
- prismarine-viewer renders darkness at night (if night renders bright, `survive_until_morning` cannot be tested from pixels).
- prismarine-viewer draws no HUD (expected); arm C then needs our own HUD overlay drawn onto the frame.
- Headless frame rendering speed per decision.
- The Qwen3.5 processor's image-token count at each resolution (the numbers above are estimates).

## Milestones after the experiments

- **Milestone 2: survive the first night + iron pickaxe, with the LLM planner.** Replanning on forecasts is the point; the feedback-loop protocol above applies. LLM teacher and DAgger for subtask labels.
- **Later:** human next-subtask prediction from converted VPT data; kev-4b on the 16 GB machine only if 0.8b plateaus; multi-bot scenarios.

## Risks

- **Pathfinding and motor failures** are the biggest time sink: stalls, dig loops, falls, water. Typed failure reasons, hard timeouts, livelock breaker. Failures double as labels for `subgoal_succeeds_60s`.
- **Partial observability.** Memory lines carry what cannot be seen in arm A; arms B and C lose them by design.
- **Compute.** On the 8 GB laptop a ~400-token state with 6 questions is near the question-splitting fallback; expect 1.5-2.2 s/record (~5 h overnight for 8k records). Vision runs belong on the 16 GB machine.
- **Version lag.** Mineflayer and minecraft-data trail releases; pin everything. VPT is 1.16.
- **Planner cost and non-determinism.** Low call rate; log and cache.
- **The feedback loop** biasing forecast labels (see Labels).

## Conventions

- Motor layer scripted, decision layer typed, no LLM in the per-tick loop.
- Every question declares its options; never parse model output text.
- Log the full distribution for every decision; the distributions are the deliverable.
- One question-schema module and one serializer, shared by data generation and play.
- Episode-disjoint splits by seed; temperature fitted on a calibration split disjoint from dev.
- Report accuracy, base rate, ECE and censoring rate together.
