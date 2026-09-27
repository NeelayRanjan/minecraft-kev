# Goal tree, stay-nearby leash, waypoints, and the fixes from the third live session (design)

**Status:** requested by the user on 2026-09-27 during the building session (`out/live_s3000_0401.*`), which ran on branch `building`. The round builds on `building`. Single-block placement ("put a bed in our hut"), with code-found candidate spots and the leader choosing among them, is the round after.

## Why

The third live session showed three failures:

- **One stuck plan held up everything behind it.** The room plan's pickaxe step waited for a crafting table that was 160 m away, and the table plan the player asked for queued behind it.
- **Kevin wandered off.** He walked over 100 m away for iron, and the player had to call him back repeatedly.
- **The player could not name places.** There was no way to say "the hut", "home" or "the cobble generator".

The user asked for:

- a greedy tree of goals, so that one stuck goal does not stop everything else;
- a loose preference to stay near the player;
- waypoints ("I am at home right now", "I am at the cobble generator") that Kevin remembers and can reference.

The session's other findings ride along (section 5).

## 1. The goal tree (replaces the plan book's ordered list)

- **A node is a typed goal.** It has the fields `{ id, goal: {kind, arg, count, from}, deps: [node ids], plans: [plan ids], status }`. Status is one of `pending | ready | running | done | blocked | dropped`. A plan is a set of root nodes plus its title, source and status.
- **The recipe expander returns the tree it already builds.** Each emitted step becomes a node whose dependencies are the steps that produce its inputs. Tools hoisted to the front are dependencies of every step that needs them. Blueprint plans become two nodes: the materials, then the build or dig, which depends on them.
- **Nodes are shared across plans.** A new plan's node with the same `(kind, arg)` as an active node merges into it: its count rises to cover both plans, and both plans reference it. Counts are net at creation and recomputed against the inventory when the node becomes running. This replaces the stale-target fix.
- **Ready nodes:** a node is ready when every dependency is done. Offered options are the union of the options every ready node's goal kind offers (its filter), plus the always-kept ones (threat, eat, moves). kev picks among them, as it does now.
- **Greedy choice (the goal guard, extended):** when kev's pick does not serve any ready node and is not a threat response or eat, the guard starts the best ready node's teacher pick. A node's cost is estimated from its target distance, whether materials are in hand, its failure count, and the leash (section 2). The best node is the one with the lowest cost. The guard's current back-off rule (2 of 3 recent failures) applies per node.
- **Stuck:** a node with no progress for its kind's stuckS becomes blocked with a reason. Nodes that depend on it stay pending, and everything else continues. A plan is blocked only when every remaining node is blocked or depends on a blocked node. The leader is then asked once, as now. The guard against re-planning a blocked plan for 10 minutes stays.
- **The priority stack above the tree:** goals pushed from chat (go_to player, stay, protect, receive) and survival goals sit on the stack and preempt the tree, as today. Pushing one interrupts the running subtask unless it is a threat response. This was a session finding: "wait over here" waited 27 s for a mining job.
- **The leader's view:** PLANS renders the tree compactly: per plan, one line of nodes with marks (✓ done, ▶ running, ○ ready, · pending, ✗ blocked: reason). Edits keep their meaning: skip drops a node and every node only it needed; drop, move_front (raises the plan's priority in the greedy cost) and clear.
- **The chat word `plan`** shows the stack goals, then each plan's line, then the chain. The status page draws the tree per plan.
- **kev's forecast question** `subgoal_succeeds_60s` is asked about the node whose option kev picked, or the running node. The timeline step is the node's step. Records carry `node_id` alongside `goal_id`.

## 2. Stay-nearby leash

- While a player is online, the leash centre is the most recent requester's position, or their stay spot. Otherwise there is no leash.
- The radius defaults to 48 m. "stay close" sets 24 m, "you can roam" removes the leash, and "normal range" sets 48 m. These are leader answers `leash { radius | off }`, validated.
- **Scoring:** in the greedy cost, a node whose target (known block, entity, anchor) is outside the radius costs more. `explore_toward(...)` options that head away from the centre are withheld while any option inside the radius can serve a ready node. When no option can, the move is allowed and announced once: "Iron is 80 m out, heading there, back soon".
- **The return bias:** after a node finishes outside the radius, the next ready node inside the radius wins ties.

## 3. Waypoints

- **Chat:** "I am at home", "this is the cobble generator", "remember this as the mine" become the leader answer `waypoint_set { name }`. The runner stores the requesting player's position and facing at the moment the message arrived (section 5 applies). "forget the mine" becomes `waypoint_drop { name }`, and "where is home?" is answered with a say from facts.
- **Automatic names:** every completed blueprint is stored as `<title> #<id>` (e.g. "hut #5"), and so is the base (crafting table and furnace) as "base".
- **Use:** new goal and anchor forms take `place:<name>`: `go_to(place:home)`, and blueprint anchors "build a wall at the cobble generator" (anchor at the waypoint, facing its stored facing). A new node kind `deliver(item, count, place:<name>)` (walk there, drop the items) is added only if the round has room; otherwise the round after.
- **Storage:** `data/waypoints/<seed>.json` persists across episodes on the same world seed. Names are lowercased, 1 to 24 characters, `[a-z0-9 _-]`.
- **The prompt's WAYPOINTS section:** name, distance and direction from Kevin (e.g. "home: 34 m north-east"), up to 8 waypoints.

## 3b. Chests (added 2026-09-27, the user: "can you grab all the iron from this chest system here")

- Plugins `withdraw(<item>)` and `deposit(<item>|all)` over mineflayer containers (chest, trapped_chest, barrel; double chests count once): the containers are those within 8 m of the request's anchor (the requesting player's position and facing when the message arrived, or a waypoint: "the chests at home"); withdraw takes matching items up to the count (default all that fits, never overfilling the inventory: keep 2 free slots), deposit fills existing stacks then empty slots, "everything except tools/food" supported by a small exclude set. Results `ok (took 37 iron_ingot from 4 containers)`, `not_found (no containers)`, `nothing (no iron_ingot)`, `full`.
- Goal kinds `withdraw(item, count, place)` and `deposit(item, count, place)`; leader answers through push_goal with examples; the reply reports what moved.
- Chest index: every container Kevin opens is recorded per world (`data/chests/<seed>.json`: position, item counts, time seen); the leader's facts show a short summary per waypoint or area ("chests near home: 64 cobblestone, 12 iron ingot"); the index is refreshed on each open and marked stale after 30 min.
- Planner use (if the round has room, else first next round): the expander counts indexed items as available at a place and emits `withdraw` steps before mining/smelting for them.
- Safety: Kevin opens only containers near an explicit request's anchor or a named waypoint; never takes from containers nobody pointed it at.

## 3c. Placement: single blocks and small setups (added 2026-09-27, the user; moved into this round)

- Single blocks: "put a crafting table here", "place a torch on this wall", "put a chest next to the furnace". Code enumerates legal cells near the request's anchor (the player's position and facing when the message arrived, or a waypoint/structure): support face, 1-2 cells of clearance as the block needs, not in a door gap or walkway, not blocking the path from the door; ranks them (against a wall, in a corner, near related stations); the leader's prompt shows the local floor plan in ASCII with the top 3 marked A/B/C and one line each; the leader answers `place { item, choice: A|B|C }` (default A). Blocks with facing (bed, door, torch, chest, furnace, stairs) are placed with the correct orientation (bed: foot toward the room's interior; wall torch: on the chosen wall face). Plugin `place_block(<item>)`; goal kind `place(item, spot)`; the item is planned first if not held (expander).
- Small setups as mini-templates over the same placer: `crafting_corner` (table, furnace, chest against a wall), `bedroom_corner` (bed + torch), `storage_wall` (a row of up to 6 chests), `torch_ring(spacing 6)` ("light up the house / the mine entrance"). "set up a crafting area in the house" = crafting_corner anchored in the named structure.
- Sleep: goal `sleep`: at dusk (or on request "go to bed"), walk to the nearest known bed (a waypoint/structure or one within 32 m), use it; stays until morning or woken; if no bed exists and wool/planks allow, the planner offers "make and place a bed at home first". Nights caused most deaths in every session.
- Follow: goal `follow(player:<name>)` ("come with me"): walk behind the player within 3-5 m until released ("you can stop following"); threat rules apply; reuses go_to_player's follow.

The round is executed as two plans in sequence: Plan A = sections 1, 2, 4, 5 (tree, leash, feeding, fixes, larger blueprints); Plan B = sections 3, 3b, 3c (waypoints, chests, placement, setups, sleep, follow), because Plan B's structure references and placement anchors build on waypoints and the tree.

## 4. Food (starvation)

Kevin never ate in 24 minutes; starvation took him to exactly 1/20 health twice (Normal difficulty stops at 1). Fixes:

- When food <= 6 and no food is held: a survival goal `feed` is pushed on the priority stack. It hunts the nearest cow, pig, sheep or chicken within the leash (via the hunt plugin), then cooks the meat at a furnace if one is within 16 m and fuel is held, and eats. It pops at food >= 14.
- At food <= 3 it preempts everything except threat responses.
- Food held but not eaten (live: food 0/20 with food in the inventory, kev chose armor crafting and wood for minutes): at food <= 6 with food held, `eat` is forced by the guard before any non-threat option; at food <= 14 with food held and no threat, eat wins ties.

## 5. Findings from the third session

1. **Blueprint parameter names.** The model used names the templates do not declare, so height and depth fell back to defaults (a 3x9x3 request became 3x3x2, three times). `checkParams` accepts synonyms: width, x → w; length, depth, z, long → d (for rooms and huts; for pits, depth → depth); height, tall, y, high → h; size → w and d. The prompt lists the exact names per template.
2. **Dig anchoring.** A dig starts at the requester's feet, so standing back from a wall gave an all-air room that was "done" in 1 s (twice). A dig blueprint starts at the first solid block along the facing within 6 m. With none, it starts at the feet as today.
3. **Anchor time.** The anchor was read when the leader answered (about 4 s later), after the player moved. Record each chat request's player position and facing when the message arrives, and anchor from that.
4. **The guard covers ordinary steps.** kev picked wait or explore under pushed goals for crafting sticks, mining stone and gathering (90 s stalls). The goal guard, the greedy choice of section 1, applies to any teacher pick of a ready node, not only plugin executors.
5. **Low health.** At 1/20 hp the leader overrode to mine_stone. At health <= 4, leader overrides are limited to eat, build_shelter, flee, pillar_up and the feed goal. Other overrides are blocked with the reason `low_health`.
6. **Crafting table.** A plan step needing a table when none is within reach (the one remembered was 160 m away) had no option to make one. The craft goal kinds offer `craft(crafting_table)` plus placing it when planks >= 4 and no table is within reach. The expander's "placed" check uses 16 m, not 32 m.
7. **Climbing through gravel.** Kevin suffocated in a wall during a climb (gravel fell in repeatedly). Before each climb step, check the column above for more than one gravity block: if so, rotate the heading. Abort the climb when suffocation damage repeats twice.
8. **dirt_path is not a falling block.** It turns into dirt when a block is above it; the climb misreads that as "fell in". Exclude it.
9. **Bearings.** obs.players gains a bearing (the 8-point compass direction from Kevin to the player). The leader's "where are you" facts include "about 40 m north-east of you".
10. **Compound requests** ("where is your table; if none, make one"): the leader may answer with an action plus a reply. The prompt gets an example for "question + instruction", showing the action with the answer in the reply.
11. **Placed stations:** log where Kevin places a crafting table or furnace, and give the leader "crafting table: 12 m west" as a fact. The table is also a waypoint candidate ("base").

12. Far blueprint walk: at 232 m from the site the far-site walk returned in 0.3 s (pathfinder searchRadius 64 -> immediate NoPath) and the call reported `ok (+0 placed)` six times until the ok-result breaker withheld it. Walk in 48 m hops toward the anchor (as go_to_player's out-of-sight approach does), and a call that made no progress reports `no_path`, never ok. The leash (section 2) is what keeps Kevin from being 232 m away in the first place.

13. Leader unreachable: the desktop dropped off the tailnet mid-session; every chat request failed silently ("fetch failed"). On two consecutive leader errors, Kevin says once in chat "My brain is offline right now, I can't take requests" (rate-limited to once per 5 minutes) and, when a call succeeds again, "I'm back, what did I miss?"; pending requests are re-shown on the first successful call.

14. Best tool (the user: "make sure he equips the best tool for the job, or makes the best tool; he's mining with a wood pickaxe"). `thriftyPickaxe` spends the cheapest harvesting pickaxe first (a day-5 rule: tunnelling wore the only iron pickaxe out and reset the chain). Now that a spare pickaxe and the pickaxe top-up exist, dig with the fastest harvesting pickaxe, except: keep the last pickaxe of a tier when its durability is below 25% and a cheaper one harvests the block, and keep a diamond pickaxe for obsidian/diamond ore when another harvests the block. When the inventory holds the materials for a better pickaxe than the best held (3 iron + 2 sticks and no iron/diamond pickaxe; 3 diamonds + 2 sticks), craft it before the next mining step (a guard pick like eat). Swords/axes/shovels: the best held is used for fighting, wood and dirt/sand/gravel. Experiment-1/chain byte-identity does not hold for this change (tool choice changes wear); drive numbers after it are not comparable (as with the day-5 motor changes).

15. Threats (the user: "he just ignored a creeper walking up to him to mine"): at 2667 s a threat interrupt fired and the leader overrode to explore_toward(deep) toward diamond ore; the threat guard only blocks leaving a *running* threat response. Code rules: (a) a hostile within 8 m forces a threat response before kev or the leader: creeper -> flee (never melee; move >= 7 m away, line of sight broken if possible), other hostiles -> fight when health > 8 and a weapon or axe is held, else flee; (b) within 16 m after a threat interrupt, leader overrides must themselves be threat responses (else `blocked: threat first`), for 10 s or until the hostile is gone or beyond 16 m; (c) the goal guard never overrides a threat response pick.

16. Routes (the user: "really weird and nonsensical routes, excessively mines up and down and sometimes just ignores where to go"). kev's movement options are generic (explore_toward down: dig 4; surface: climb 8 or walk 24 m on a stored heading) with no destination, so it alternates down/up while the leader corrects one step at a time. Fixes: (a) when a ready node has a known target position (a remembered ore/block, a waypoint, a player, a blueprint site, a remembered station), a single option `go_to_target(<node>)` is offered: the pathfinder routes to it with digging allowed (a straight tunnel when underground, with the staircase's liquid checks); the generic explore options are withheld while such a target exists; (b) oscillation breaker: an explore down followed by an explore up (or the reverse) within 60 s without node progress withholds the opposite direction for 120 s; (c) leash tie-breaks toward the player. Evidence: at y -29 with diamond ore 2 m away, kev climbed toward the surface; plan #6 (diamond pickaxe) blocked at step 1 "craft 3 planks" underground with no wood while "mine 3 diamond" had no dependency on the planks (the tree, section 1, fixes the order part).

17. Flee when cornered (the user: "he tries to flee no matter what, even if he is not able to outrun; locked in a closed space he should fight"). In a tunnel the only way "away" is to dig, so flee tunnels up and down with the mob following (part of the erratic mining in item 16). Rule: before offering or forcing flee, test for an escape: a walkable path (pathfinder with digging off, 2 s budget) to a cell >= 10 m from the hostile. No escape: fight when health > 6 and the hostile is not a creeper; a creeper, or health <= 6: wall it off (place a block from the inventory in the cell between Kevin and the hostile in a 1-2 wide space, then dig away on the far side only if needed); log `flee withheld: no escape` so the leader sees why. Item 15's creeper rule defers to this when cornered.

18. Tool breaks (the user: "whatever pick he was using broke, and now is using his fist; there should be an interrupt to the LLM when a tool breaks"). Detection: a pickaxe/axe/sword/shovel count decreasing without a toss, a craft consuming it, or death -> event `tool_broke {item}`; it triggers the leader (bypassing the spacing, like death) with a fact line, and the reply channel can tell the player. Code: when no held pickaxe can harvest the current or next mining target, the guard forces the pickaxe top-up ladder (sticks -> wooden -> stone -> iron, the best the materials allow) before any mining option; mining options whose block needs a pickaxe are withheld while none is held (never mine with the fist). The same for the sword (fighting falls back to the axe, then fist only when cornered).

## 5b. Larger blueprints (added 2026-09-27, the user)

Templates accept up to 15x15 footprints (hut, wall, floor, room, pit); free-form blueprints up to 12x12x8 and 400 placed blocks. The leader's cut shows only the current layer within 9 cells of Kevin (15x15 would triple the prompt). build_check gains a 13x13x4 hut case.

## 6. Out of scope

- A terrain height-map view for the leader.
- Retraining kev (DAgger with the tree's node labels): after this round.
- The rounds after this one, in order: (1) composite houses (rooms, shared walls, door and window gaps, pitched full-block roofs, then facing blocks via section 3c); (2) structure edits against remembered structures ("knock down this wall and make another room": the wall resolved from the player's position and facing when the message arrives, a dig blueprint for the wall cells plus an extension blueprint sharing the wall line; leader answers extend / remove_part / open_doorway over the structure's floor plan in ASCII).

## 7. Testing and acceptance

- **Unit:**
  - the tree built from expander output (compass, white bed, hut plan);
  - merge of shared nodes across plans;
  - ready and blocked propagation;
  - greedy cost with the leash;
  - edits on the tree;
  - the rendered PLANS line;
  - the waypoint store (set, drop, persist, bearing and distance rendering);
  - the leash answer;
  - the feed goal;
  - each section 5 item with its own failing-first test.
- **Integration:** a two-plan arena check in which plan A's node is made unreachable while plan B completes; a leash check (iron placed at 30 m and at 80 m: the near one is mined first, and the far one is announced); safety_check with a gravel column; `player_check` extended with a waypoint request.
- **Acceptance:** a live session. Request two plans where one is impossible nearby: the other finishes. Say "I'm at home", walk away, then "build a wall at home". Say "stay close". Leave Kevin without food until the feed goal fires.
