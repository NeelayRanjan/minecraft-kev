# Blueprints: building and mining patterns (design)

**Status:** approved in conversation on 2026-09-26 (evening, after the plans-plugins round); built on branch `building` from `plans-plugins`.

## Why

After the plans round the bot can make any item whose materials it can produce, but every spatial request is refused: "build a small stone hut", "a wall here", "dig a 3x3x2 cave", "strip mine for diamonds", "dig out a room where you are". The user wants the bot to build and dig described shapes, planned layer by layer in ASCII, with the LLM designing only what no template covers. The same rule as before: **code decides everything it can; the LLM chooses among templates and composes only when none fits.**

## 1. The blueprint (one format for building and digging)

`agent/blueprints.js` (pure).

```js
{ id, kind: 'build' | 'dig', legend: { '#': 'cobblestone', 'P': 'oak_planks', ... },
  layers: [ ['#####', '#...#', ...], ... ],   // bottom layer first; rows run away from the viewer (z'), columns left to right (x')
  anchor: { x, y, z }, facing: 'north' | 'south' | 'east' | 'west', title, source }
```

- Characters: a legend key = that block must be there; `.` = must be air (dug out / kept clear); ` ` (space) = don't care.
- Blueprint-local coordinates (col, row, layer) map to world coordinates through the anchor and facing: the blueprint is laid out in front of the anchor, row 0 nearest, centred on the anchor's column.
- `cells(bp) -> [{ pos, want: <block name> | 'air' }]`, `materials(bp) -> { item: count }` (block names mapped to the item that places them, e.g. `grass_block`→`dirt`), `diff(bp, blockAt) -> { done, missing: [cell], blocked: [cell], total }`.
- `validate(bp) -> { ok, reason }`: at most 9 x 9 x 9 and 150 placed blocks for a free-form blueprint; legend items must be placeable blocks the option layer can produce (the recipe expander's `producerOf` or a held item); every placed block is connected face to face, through placed blocks, to a block that rests on existing ground or on an existing solid block of the world (no floating blocks; a free-standing staircase is valid because each step touches its support block, which touches the step below); a `build` blueprint of an enclosed shape needs a door gap (two stacked `.` cells in its outer ring on layer 0 and 1).

## 2. Sources: templates first, free-form second

`agent/templates.js` (pure): parametric generators returning blueprints (anchor/facing filled in by the runner).

Building:
- `hut(w=5, d=5, h=3, material='cobblestone')`: walls, flat roof, a door gap on the near side, 5 <= w,d <= 9, 3 <= h <= 5.
- `wall(len=5, h=3, material)`, `floor(w=5, d=5, material)`, `tower(w=3, h=6, material)` (solid walls one block thick, hollow inside, open top, no ladder), `pillar(h=5, material)`, `bridge(len=8, material)` (a 1-wide floor; connected through its first block to the ground at the anchor, so it passes the connectivity rule).
- `staircase_up(height=6, width=1, material)`: a free-standing staircase of full blocks rising away from the anchor, one step up per block forward; every step above the first has one support block directly beneath it (2 blocks per step, so the chain is face-connected to the ground); streamed in segments of 8 steps when taller than 8.
- `staircase_down(depth=6, width=1, material)`: the same shape descending away from the anchor into open air (from a cliff edge, a tower top, a pillar); step 1 touches the block the anchor stands on, each lower step hangs from the one above through its support; the executor places from the top down (each new step is placed against the previous one). Streamed like staircase_up.

Digging (kind `dig`, all `.` cells):
- `room(w=3, d=3, h=2)`: a box starting at the anchor's feet level, in front of the anchor (the user's "3x3x2 cave").
- `tunnel(len=16, w=1, h=2)`: straight ahead along the facing.
- `strip_mine(len=32, branch_every=3, branch_len=8)`: a 1x2 main tunnel with 1x2 side branches every `branch_every` blocks to both sides; at the anchor's y; with `at_y` set (see section 6) the plan first moves the bot to that depth with `go_to(y:<n>)` and anchors the pattern where it arrives, facing the direction it last walked ("strip mine for diamonds" = strip_mine with at_y -58).
- `stairs_down_to(y)`: a walkable 1-wide, 2-high dug staircase down to the given y (-58..<anchor y), one block down per block forward, turning 90 degrees right when the next segment would hit liquid; streamed in segments of 8 steps; the existing staircase digger's lava/water checks apply. "mine down to y 12" / "dig down to diamond level" = this template.
- `stairs_up_to(y)`: the same dug upward (from a cave or a mine to a higher level or the surface), stopping at open sky or the target y.
- `shaft_down(depth=10)`: a 1x2 vertical-ish staircase for short drops (kept for small depths); `pit(w=3, d=3, depth=3)`.

Long patterns (tunnel, strip_mine) exceed the 9x9x9 cap: they are **streamed** as segments of at most 8 blocks of main tunnel (with their branches); the executor asks the template for the next segment when the current one is done. Progress counts segments.

Free-form: the leader may answer with its own `legend` + `layers` (schema-constrained: legend map of single characters to item names, layers as arrays of strings); code validates it (section 1); a failed validation is returned to the leader once in the next prompt with the reason, then answered `cannot` to the player.

While digging, ore blocks exposed in the walls, floor or ceiling of a dig blueprint (any `MINE`/legacy ore within reach of the dug cells) are mined too (vein mining one block deep), so a strip mine collects what it uncovers; this is a flag on dig blueprints, on by default for `strip_mine` and `tunnel`, off for `room`/`pit`.

## 3. Where: the anchor

- The anchor is the requesting player's position (feet, floored) and the facing is the player's horizontal look direction rounded to the nearest cardinal, **fixed when the plan is made** (bot.players[name].entity position and yaw at that moment). "here" / "where you are" / "where I am" all mean the player; a request from the leader itself (no player) anchors at the bot.
- A build blueprint is placed in front of the anchor starting 2 blocks away (so the player is not built into); a dig blueprint starts at the anchor itself (the player asked to dig where they stand or ahead of it).
- Ground: for a build, the layer-0 y is the anchor's feet y; cells of layer 0 over air get a foundation block placed under them (counted in the materials); cells of any layer occupied by a block that is not wanted are dug first (grass, flowers, snow are cleared as part of the build).

## 4. Pricing and plans

`materials(bp)` feeds the recipe expander: "build a stone hut" becomes a plan `gather(cobblestone, 60)` (net of the inventory) then `build(<blueprint id>)`; dig blueprints need only a pickaxe (the tier the hardest expected block needs: stone for anything above y 0, stone for deepslate) and have no material steps. Plans, announcements, the stack view and edits work as in the plans round. A blueprint is kept by id in a `BlueprintBook` in the runner (blueprints are too big for a goal arg); `build(<id>)` and `dig(<id>)` are new goal kinds whose `done` is `diff(bp).missing.length === 0` (plus, for streamed patterns, no segment left).

## 5. Executors (plugins)

`agent/plugins/build_blueprint.mjs` and `agent/plugins/dig_blueprint.mjs`, resumable: each call recomputes the diff and works on what is missing, so interrupts and deaths cost nothing.

- **build_blueprint**: order = layer by layer from the bottom; within a layer, cells far from the standing side first so the bot never walls itself in; for each cell: a standing position within 4.5 blocks, with line of sight to a face of a solid neighbour, reachable by the pathfinder (`standNear`), not inside the blueprint's own future cells when avoidable; clear the cell if something unwanted is there; `placeAt(pos, item)`. When no standing spot reaches the next cell (upper layers), the executor **scaffolds**: pillars up on dirt (or cobblestone) next to the build, places what it can reach, and removes its scaffold blocks afterwards (tracked in the executor's memory, cleared on completion). At most 30 blocks placed per call (the driver repeats the subtask); typed results `ok (+n placed)`, `no_materials`, `unreachable (n cells)`, `no_path`.
- **dig_blueprint**: order = top layer down within each segment, near cells first; digs each `.` cell with the best tool (`digSafe`), refuses cells next to lava/water sources (the staircase's liquid checks), waits out falling gravel/sand (`openCell`), mines exposed ore when the flag is set; at most 40 cells per call; `ok (+n dug)`, `hit_liquid`, `needs_tool`, `no_path`.
- Both honour the night rule for surface work (a surface build at night pauses like other surface work; a dig underground continues).

## 6. State and the leader

- kev's state text gains one line only when a build/dig goal is on top: `building hut (#4): layer 2 of 3, 41 of 96 blocks, 3 unreachable, need 12 cobblestone` / `digging strip mine (#5): segment 3 of 4, 22 of 30 cells`. Nothing else changes (golden tests untouched without a blueprint).
- The leader's prompt, only while a blueprint goal is active or blocked, gets a 9x9 ASCII cut of the current layer around the build: `#` placed, `o` missing, `x` blocked/unreachable, `.` must-be-air still solid, `@` the bot.
- Leader answers: `plan_build { template, params, material }` (template from the declared list; params validated per template), `plan_dig { template, params, at_y? }` (at_y prefixes a go_to(y:<at_y>) step and re-anchors at arrival), and `plan_blueprint { title, kind, legend, layers }` for free-form. All three become plans through the same path as `plan_item`. The prompt lists the templates with their parameters and ranges and two examples ("build me a small stone hut" → plan_build hut w 5 d 5 h 3 cobblestone; "strip mine for diamonds" → plan_dig strip_mine at_y -58; "dig a 3x3x2 cave here" → plan_dig room w 3 d 3 h 2; "mine down to y 12" → plan_dig stairs_down_to y 12; "build stairs up 6 blocks" → plan_build staircase_up height 6).

## 7. Viewing

The status page shows the active blueprint's layers as a grid per layer with each cell's state (placed / missing / blocked / to dig / dug) and the scaffold cells; `plan` in chat includes the progress line.

## 8. Out of scope

- The terrain/height-map view for the leader (a later round).
- Schematic files (prismarine-schematic is not installed; a later round).
- Doors, beds, torches, glass panes and other blocks with orientation or state: the legend accepts full blocks only this round (stairs/slabs are refused by the validator).
- Building from memory of a previous build, multi-bot builds.

## 9. Testing and acceptance

- Unit (`npm test`): templates (dimensions, door gap, materials count), validator (floating block, size cap, unknown item, missing door), anchor/facing transform for all four facings, diff over a fake world, build order (bottom-up, far-first), reach-spot geometry, strip_mine segmentation, ore-in-wall detection, leader schema/applyAnswer for the three answers, the state line, the 9x9 cut.
- Integration (arena, own servers): `build_check` (5x5x3 hut on flat ground; the same on a 1-block slope; resume after a forced interrupt at half; a staircase_up of 6 climbed by the bot afterwards; a staircase_down of 5 from a 6-high pillar), `dig_check` (3x3x2 room; a 12-block tunnel with an ore block in the wall, collected; a room next to a lava source refuses the lava side; stairs_down_to 10 blocks lower, walked down and back up), both through Motor.run with the plugin registry.
- Acceptance: a live session: "build me a small stone hut" in front of the player, "dig a 3x3x2 cave here", "strip mine for diamonds" from the surface.
