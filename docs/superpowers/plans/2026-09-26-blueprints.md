# Blueprints (building and mining patterns): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chat requests that describe shapes ("build a small stone hut", "stairs up 6 blocks", "dig a 3x3x2 cave here", "strip mine for diamonds", "mine down to y 12") become priced, announced, resumable plans the bot executes with two blueprint executors.

**Architecture:** one pure blueprint format (`agent/blueprints.js`: legend + ASCII layers + anchor/facing, world transform, diff, validation by face-connectivity) and pure parametric templates (`agent/templates.js`, long patterns streamed in segments); a `BlueprintBook` and two goal kinds `build(<id>)` / `dig(<id>)` in the goal layer; three leader answers (`plan_build`, `plan_dig`, `plan_blueprint`); two plugins (`build_blueprint`, `dig_blueprint`) on the existing plugin registry; the runner anchors blueprints on the requesting player and shows progress in chat, the state text and the status page.

**Tech Stack:** Node 22 ESM, Mineflayer + pathfinder, minecraft-data 1.20.4, vec3, node:test; the plans-plugins branch (plans, recipe expander, plugin registry, status page) is the base.

**Spec:** `docs/superpowers/specs/2026-09-26-blueprints-building-mining-design.md`

## Global Constraints

- With no blueprint goal active, every output (options, state text, questions, timeline, records, the leader prompt) is byte-identical to the base branch; `tests/serialize.test.mjs` goldens untouched.
- Free-form blueprints: at most 9 x 9 x 9 and 150 placed blocks; full blocks only (no stairs, slabs, doors, torches, beds, panes: the validator refuses blocks whose minecraft-data `boundingBox !== 'block'` or that have facing/state variants in their default placement).
- Every placed block of a blueprint is face-connected through placed blocks to a block resting on existing ground or an existing solid world block.
- The anchor of a request from a player is that player's floored feet position and horizontal facing (yaw rounded to the nearest cardinal) at the moment the plan is made; a request with no player anchors at the bot. Build blueprints start 2 blocks in front of the anchor; dig blueprints start at the anchor.
- Executors are plugins under `agent/plugins/` following `agent/plugins/README.md`; expected failures are typed results or NoPath; each call is resumable from a fresh world diff; a build call places at most 30 blocks, a dig call digs at most 40 cells.
- The night rule: surface build/dig work pauses at night like other surface work; underground digging continues. The two override guards are unchanged.
- Nothing is parsed from free text: leader answers are JSON under `leaderSchema`; template names and parameter ranges are declared and validated in code.
- `pkill -f` only with bracketed patterns; disk is ~97% full, no `--video` in checks or smokes.

## Review Focus

1. **A hut requested by a player standing against a wall or on a slope**: the build must still start 2 blocks in front, place foundation blocks under layer-0 cells over air, clear unwanted blocks in its cells, and never build the player or the bot inside it (Task 5 check on a slope; Task 1 test for foundation cells).
2. **Upper layers out of reach**: scaffolding must place the roof and then remove every scaffold block; a build interrupted mid-scaffold must still clean up on its next call (Task 5 check: interrupt at half).
3. **A strip mine or stairs_down_to that meets lava or water**: the dig stops or turns before the liquid (never opens it), reports `hit_liquid` with the position, and the plan blocks visibly instead of looping (Task 6 check + test).
4. **A free-form blueprint from the leader that floats or is too large**: refused with the validator's reason, returned to the leader once, then a `cannot` reply to the player; never executed (Task 4 test).
5. **Death or night mid-build**: the build resumes from the world diff (nothing re-placed, nothing lost besides dropped items), and a surface build pauses at night (Task 3 test for night filtering; Task 5 resume check).

---

### Task 1: `agent/blueprints.js` (pure): format, transform, diff, materials, validation

**Files:** Create `agent/blueprints.js`, `tests/blueprints.test.mjs`.

**Interfaces produced:**
```js
export const FACINGS = ['north', 'east', 'south', 'west']
export function facingFromYaw(yaw) -> 'north'|'east'|'south'|'west'     // mineflayer yaw: 0 = north (-z), increases counter-clockwise (pi/2 = west)
export function toWorld(bp, { col, row, layer }) -> { x, y, z }         // row 0 nearest the anchor; cols centred on the anchor (col - floor(w/2)); build: row offset +2 (start 2 blocks in front), dig: +0
export function cells(bp) -> [{ col, row, layer, pos, want }]          // want = block name | 'air'; spaces skipped
export function itemForBlock(block) -> string | null                    // the minecraft-data item of the same name (stone -> stone, oak_planks -> oak_planks); grass_block -> dirt; null if no item places it
export function materials(bp) -> { [item]: count }                     // build only; dig -> {}
export function diff(bp, blockAt) -> { total, done, missing: [cell], blocked: [cell], wrong: [cell] }   // blockAt(pos) -> { name, boundingBox } | null; missing = want block but air; wrong = want block/air but a different solid block; blocked = unloaded (null)
export function foundation(bp, blockAt) -> [pos]                       // layer-0 build cells whose block below is air/liquid: one foundation block under each (same material as the cell)
export function validate(bp, { maxSize = 9, maxBlocks = 150, placeable = isPlaceable, streamed = false } = {}) -> { ok, reason }
export function isPlaceable(name) -> bool                             // minecraft-data block with boundingBox 'block', a same-name item, not in DENY (doors, beds, stairs, slabs, torches, panes, fences, signs, liquids, air)
export function layerCut(bp, layer, blockAt, botPos) -> string[]       // 9x9 ASCII around the blueprint's centre on that layer: '#' placed ok, 'o' missing, 'x' wrong/blocked, '.' dig cell still solid, ' ' dug/air-ok, '@' bot
```
Connectivity rule (validate, kind build): BFS over placed cells by face adjacency starting from every layer-0 cell (they rest on the ground or a foundation block) plus any cell flagged `ground` by the template (e.g. staircase_down step 1 rests on the anchor's block); any placed cell not reached -> `{ ok: false, reason: 'floating block at layer L row R col C' }`. Enclosed shapes: if layer 0 and 1 have a closed outer ring of placed blocks, require a door gap (a `.` or space at the same ring position on layers 0 and 1), else `reason: 'no way in (needs a door gap)'`. Size/blocks caps are skipped when `streamed` (templates stream segments that are each within the cap).

- [ ] Tests: facingFromYaw for 0, pi/2, pi, -pi/2 and in-between values; toWorld for all four facings on a 3x3 blueprint (pin exact coordinates); cells skips spaces and maps '.' to air; materials of a 3x3x2 ring = 16 of the material; diff over a fake world map (missing, wrong, done counts); foundation under two cells over air; validate: a floating block (reason names it), a 10-wide blueprint (size), 151 blocks, an oak_door in the legend (not placeable), a closed ring without a gap, a staircase-shaped blueprint where each step has its support (ok); layerCut exact strings for a small fixture.
- [ ] Implement; `npm test`; commit `feat(blueprints): blueprint format, world transform, diff, materials and validation`.

### Task 2: `agent/templates.js` (pure): building and digging templates, streaming

**Files:** Create `agent/templates.js`, `tests/templates.test.mjs`.

**Interfaces produced:**
```js
export const TEMPLATES = {   // name -> { kind, params: { p: { min, max, default } }, material: bool, streamed: bool, make(params, material) -> blueprint without anchor, segment?(params, i) -> blueprint|null }
  hut, wall, floor, tower, pillar, bridge, staircase_up, staircase_down,        // kind 'build'
  room, tunnel, strip_mine, stairs_down_to, stairs_up_to, shaft_down, pit,     // kind 'dig'
}
export function checkParams(name, params) -> { ok, params (clamped/defaulted), reason }
export function makeBlueprint(name, params, material, { anchor, facing, source, title }) -> blueprint   // streamed ones return segment 0 plus { template, params, segment: 0, segments: n|null }
export function nextSegment(bp) -> blueprint | null                                                   // streamed: the next segment anchored where the previous ends (for stairs: one level lower/higher)
export function describeTemplates() -> string                                                         // one line per template with params and ranges, for the leader prompt
```
Parameters and ranges (defaults in brackets): hut w 5-9 [5], d 5-9 [5], h 3-5 [3], material; wall len 1-9 [5], h 1-5 [3]; floor w 1-9 [5], d 1-9 [5]; tower w 3-5 [3], h 3-9 [6]; pillar h 1-9 [5]; bridge len 2-9 [8]; staircase_up height 1-24 [6] width 1-3 [1]; staircase_down depth 1-24 [6] width 1-3 [1]; room w 1-9 [3], d 1-9 [3], h 2-5 [2]; tunnel len 1-64 [16], w 1-3 [1], h 2-3 [2]; strip_mine len 8-64 [32], branch_every 2-4 [3], branch_len 2-12 [8]; stairs_down_to y -58..319 (required; must be below the anchor), stairs_up_to y (required; above the anchor); shaft_down depth 1-16 [10]; pit w 1-5 [3], d 1-5 [3], depth 1-5 [3]. Materials default `cobblestone`; any isPlaceable item accepted.

Shapes: hut = the ground is the floor; layers 0..h-1 are the wall ring with a 1-wide 2-high door gap in the middle of the near wall (row 0), layer h is the roof (full w x d). Width repeats every column across cols. staircase_down (row offset 0, not +2: it starts at the edge the anchor stands on): step k (k = 1..depth) at row k, layer -k relative to the anchor's feet; its connector at row k-1, layer -k (directly under the previous step, beside step k), so the band is face-connected; the connector of step 1 is the anchor's own standing block (existing ground: flagged `ground`, not placed); headroom '.' cells at row k, layers -k+1 and -k+2. staircase_up: step k (k = 0..height-1) at row k, layer k; for k >= 1 a support at row k, layer k-1 (beside step k-1); headroom '.' at row k, layers k+1 and k+2. Dig shapes: room/pit/tunnel boxes of '.'; strip_mine main tunnel 1 wide 2 high along rows, branches 1x2 along cols every branch_every rows to both sides; stairs_down_to: each step one row forward and one layer down, 2 high of '.', plus the headroom cell above the step so it is walkable (3 cells per step); stairs_up_to mirrored.

- [ ] Tests: each template's dimensions, block counts and door gap; every non-streamed template's blueprint passes `validate`; staircase_up(6) has 11 placed blocks (6 steps + 5 supports) and passes connectivity; staircase_down(5) passes with its ground flag; strip_mine segments: segment 0 has the first 8 blocks of main tunnel plus its branches, nextSegment continues and returns null after len; stairs_down_to from y 64 to y 40 yields segments descending 8 levels each, last one ending at y 40; checkParams clamps and rejects (unknown template, stairs_down_to above the anchor, missing y); describeTemplates exact first line.
- [ ] Implement; `npm test`; commit `feat(templates): building and digging templates with streamed segments`.

### Task 3: Goal kinds `build` and `dig`, the BlueprintBook, pricing, the state line

**Files:** Create `agent/blueprint_book.js` (pure); Modify `agent/goals.js` (kinds `build(<id>)`, `dig(<id>)` replacing the old `build(structure)` vocabulary for ids; `portal_frame` keeps its old behaviour), `agent/recipes.js` (`expandBlueprint(bp, inventory, opts) -> { steps, missing }`: materials(bp) + foundation estimate through the existing walk, then the build/dig step; dig: pickaxe tier stone), `agent/serialize.js` (one line when a blueprint goal is on top, from `obs.blueprintLine`), `tests/blueprint_book.test.mjs`, `tests/goals.test.mjs`, `tests/recipes.test.mjs`, `tests/serialize.test.mjs` (a new case; goldens untouched).

**Interfaces produced:**
```js
export class BlueprintBook { add(bp) -> id ; get(id) ; update(id, bp) ; progress(id, blockAt) -> { done, total, missing, blocked, layer, layers, segment, segments } ; line(id, blockAt, inventory) -> string ; toJSON() }
```
- `build(<id>)`: done when `diff.missing.length + diff.wrong.length === 0` and no next segment; filter keeps `build_blueprint(<id>)` (via pluginOptions), the material producers for `materials - held`, threat/eat/moves; teacher `build_blueprint(<id>)` when materials for the next layer are held, else the producer of the first missing material; stuckS 300; night: surface build withheld at night (the night rule's surface-work set), clock paused.
- `dig(<id>)`: done when no '.' cell is solid and no next segment; filter keeps `dig_blueprint(<id>)` + threat/eat/moves; teacher `dig_blueprint(<id>)`; stuckS 300; night: withheld only when the dig's anchor is on the surface (sky-lit).
- The goal layer reads blueprints through a registered accessor `registerBlueprintAccessor(fn)` (like pluginOptions) so goals.js stays pure; the runner wires it in Task 7.
- State line (serialize): `building hut (#4): layer 2 of 3, 41 of 96 blocks, 3 unreachable, need 12 cobblestone` / `digging strip mine (#5): segment 3 of 4, 22 of 30 cells`.

- [ ] Tests: BlueprintBook add/get/progress over a fake world; goal done/filter/teacher for build and dig with a stub accessor; night filtering of a surface build; expandBlueprint for a 5x5x3 cobblestone hut with 10 cobblestone held (net 60-ish, exact pinned) and a dig (pickaxe only); the state line exact strings; the serialize goldens unchanged.
- [ ] Implement; `npm test`; commit `feat(goals): build and dig goal kinds, blueprint book, pricing and the state line`.

### Task 4: Leader answers `plan_build | plan_dig | plan_blueprint`

**Files:** Modify `agent/leader.js` (schema, applyAnswer, prompt: templates list from `describeTemplates()`, rules and examples, the 9x9 cut section when a blueprint goal is active or blocked, a `BLUEPRINT FEEDBACK` line when the previous free-form blueprint failed validation), `agent/planner.js` (pass the new payload fields through); Test `tests/leader.test.mjs`.

**Interfaces produced:**
- Schema: `plan_build { template (enum of build templates), params (object of integers), material (string) }`, `plan_dig { template (enum of dig templates), params, at_y (integer, optional) }`, `plan_blueprint { title, kind ('build'|'dig'), legend (object of single-char keys to strings), layers (array of arrays of strings) }`.
- applyAnswer: `plan_build`/`plan_dig` -> `checkParams`; material must be `isPlaceable`; `plan_blueprint` -> `validate` (with anchor-free checks); results `{ kind: 'plan_build'|'plan_dig'|'plan_blueprint', ... }` or `invalid` with the reason. Goal-level (never stale; settle requests; invalid ones settle as cannot through `settleKind`).
- Examples in the rules: "build me a small stone hut" -> plan_build hut w 5 d 5 h 3 cobblestone; "stairs up 6 blocks" -> plan_build staircase_up height 6; "dig a 3x3x2 cave here" -> plan_dig room w 3 d 3 h 2; "mine down to y 12" -> plan_dig stairs_down_to y 12; "strip mine for diamonds" -> plan_dig strip_mine at_y -58; free-form only when no template fits.
- A free-form blueprint that fails validation: the runner (Task 7) records `{ reason, title }`; the next leader call shows `BLUEPRINT FEEDBACK: your blueprint "<title>" was refused: <reason>. Fix it or answer cannot.`; a second failure for the same request is settled as cannot.

- [ ] Tests: schema enums; applyAnswer valid/invalid for each (unknown template, out-of-range param clamped vs refused per checkParams, a non-placeable material, a floating free-form blueprint, a 10-wide one); the prompt contains the templates list and the cut section only when a blueprint goal is present (byte-identical prompt otherwise: compare with the base branch's prompt for a fixture).
- [ ] Implement; `npm test`; commit `feat(leader): plan_build, plan_dig and plan_blueprint answers`.

### Task 5: Plugin `build_blueprint` + motor reach and scaffold helpers + `build_check`

**Files:** Create `agent/plugins/build_blueprint.mjs`, `tests/integration/plugins/build_check.mjs`; Modify `agent/motor.js` (methods `reachSpot(pos, { avoid })`, `placeCell(pos, item)`, `scaffoldTo(pos)` / `removeScaffold()`, memory `mem.scaffold` of placed scaffold positions per blueprint id), `tests/plugin_executors.test.mjs` (pure parts).

- Order: layer ascending; within a layer, cells sorted by distance from the standing side descending (far first), ties by col; foundation cells first; wrong cells are dug before placing.
- `reachSpot(pos)`: candidate standing cells within 4.5 blocks of `pos` with solid ground, 2 air cells, a line of sight to a solid face adjacent to `pos` (`bot.world.raycast` or a block-step ray), not a future cell of the blueprint when avoidable, nearest by path estimate; `standNear` to it.
- Scaffold: when no reach spot exists for the next cell (roof layers), pillar up next to the build on the nearest outside cell (dirt or cobblestone; `pillar_up`'s placement logic), record each scaffold block in `mem.scaffold[bpId]`; after the blueprint is complete, or at the start of a call when the current layer no longer needs it, dig the scaffold blocks top down; scaffold blocks are never inside blueprint cells.
- staircase_down placement from the top: each step placed against the previous step's support (placeBlock against its face); the bot stands on the step it just placed.
- Results: `ok (+n placed)`, `no_materials (<item>)`, `unreachable (<n> cells)`, `no_path`; at most 30 placements per call; `options(obs, goal)` returns `[{ arg: goal.arg }]` for a build goal.
- [ ] `build_check.mjs` (port 25576): flat arena: plan a 5x5x3 cobblestone hut anchored on a stand-in anchor, give 80 cobblestone + 20 dirt, run build_blueprint through Motor.run until done (loop calls, cap 20), assert diff complete and no scaffold block left; the same on a 1-block slope (foundation placed); interrupt a fresh hut after ~half the blocks (motor.interrupt), then resume to done; staircase_up(6): build, then `goto` the top step (the bot can climb it); staircase_down(5) from a 6-high pillar top: build, then walk down. PASS/FAIL, non-zero exit on FAIL.
- [ ] Implement; `npm test`; the check PASS; commit `feat(plugins): build_blueprint with reach spots and scaffolding`.

### Task 6: Plugin `dig_blueprint` + `dig_check`

**Files:** Create `agent/plugins/dig_blueprint.mjs`, `tests/integration/plugins/dig_check.mjs`; Modify `agent/motor.js` only to expose helpers the plugin needs (liquid checks of the staircase digger, `openCell`, `digSafe`), `tests/plugin_executors.test.mjs`.

- Order: within a segment, layer descending (top first), near rows first; before digging a cell, check its 6 neighbours and the cell above for lava/water (source or flowing): liquid -> for stairs templates turn the stream 90 degrees right (re-anchor the next segment) once, else stop with `hit_liquid (<pos>)`; never dig a cell whose removal exposes a liquid.
- Vein mining: after digging a cell, any ore block (MINE ores and legacy coal/iron/diamond ores) face-adjacent to it and within reach is mined too when `bp.veins` is true; counts reported.
- Streamed: when the current segment is complete, `bb.update(id, nextSegment(bp))` through the accessor; `ok (+n dug, segment i/n)`.
- Results: `ok (+n dug)`, `hit_liquid (<pos>)`, `needs_tool`, `no_path`; at most 40 cells per call; the bot walks the dug cells (tunnels/stairs) to stay in reach.
- [ ] `dig_check.mjs` (port 25577): a stone arena: room 3x3x2 dug fully; a 12-block tunnel with one iron_ore and one coal_ore set into its walls: both collected; a room with a lava source placed beside one side: `hit_liquid`, no lava released (no lava cell inside the dug area afterwards); stairs_down_to 10 levels below: walked down by the bot and back up. PASS/FAIL.
- [ ] Implement; `npm test`; the check PASS; commit `feat(plugins): dig_blueprint with vein mining, liquid stops and streamed segments`.

### Task 7: Runner wiring, anchor on the player, announcements, status page grid, smoke

**Files:** Modify `agent/run_episode.mjs` (BlueprintBook; `registerBlueprintAccessor`; leader results plan_build/plan_dig/plan_blueprint -> anchor from the requesting player (`bot.players[name].entity` position + `facingFromYaw(yaw)`, else the bot) -> `makeBlueprint`/free-form -> `expandBlueprint` -> a plan titled "<template> (<dims>)" via the existing addPlan path; `at_y` prefixes `go_to(y:<n>)` and the dig is re-anchored at the bot when that step completes; free-form validation failure -> feedback for the next call, second failure -> cannot; `obs.blueprintLine`; the 9x9 cut in the leader context while a blueprint goal is active/blocked; announcements "Building <title> in front of you" / "Digging <title> here"), `agent/status_page.js` (a grid per layer of the active blueprint with cell states and scaffold marks), `CLAUDE.md` (status paragraph, how-to-run examples, repo layout lines), `agent/leader_report.js` (blueprint plans appear in the Plans section with progress); Test `tests/status_page.test.mjs`, a pure anchor helper test.

- [ ] Smoke (kev.serve mc-v3 started as scripts/leader_live.sh does, the desktop leader; 10 minutes; `--goal nether --leader subgoals --status-port 3008 --out blueprint_smoke`; a scripted second player bot via a scratch script under /tmp/claude-1000 that `/give`s itself nothing, stands on flat ground facing north and sends in order with 30-60 s pauses: `build me a small stone hut`, `plan`, `dig a 3x3x2 cave here`, `mine down to y 40`): the log shows three plans created with the right templates, the hut anchored 2 blocks in front of the player, build/dig subtasks running, state lines, and at least one of them done or progressing; include a state.json excerpt with the grid. Report exactly what the leader answered.
- [ ] `npm test`; commit `feat(runner): blueprint plans anchored on the player, progress in chat and on the status page`.
