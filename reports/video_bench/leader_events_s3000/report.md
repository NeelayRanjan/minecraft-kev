# Video replay bench: leader_events_s3000

40 leader calls from run 1 (strata: continue 15, nopath 10, ok 10, threat 5), replayed with the live prompt rebuilt from the log.
Vision arms add the last 120 s of first-person video (36 frames: 1 per 10 s, then 1 per 4 s, then 1 per s for the last 20 s).

| arm | answered | valid | agrees with teacher | same as run 1 | bad re-push | left a threat response | latency p50 |
|---|---|---|---|---|---|---|---|
| run 1 (live, iq3xxs) | 40/40 | 1.00 | 0.35 | 1.00 | 10 | 3 of 8 | 3.3 s |
| text27b (qwen38-27b-iq2s) | 40/40 | 1.00 | 0.28 | 0.40 | 0 | 0 of 8 | 3.6 s |
| vl_text (qwen3-vl:8b) | 40/40 | 1.00 | 0.35 | 0.45 | 7 | 2 of 8 | 1.1 s |
| vl_mosaic (qwen3-vl:8b) | 40/40 | 1.00 | 0.35 | 0.47 | 5 | 2 of 8 | 2.9 s |
| vl_frames (qwen3-vl:8b) | 40/40 | 0.00 | - | - | 0 | 0 of 0 | 1.4 s |

Agreement compares the subtask each answer leads to (continue = keep the current one). Bad re-push: picking a subtask whose last attempt failed to path. Left a threat response: a non-threat subtask while fleeing, fighting or pillaring.

## Close-ups

### t = 637.7 s (continue)

![mosaic](../../../data/video_bench/leader_events_s3000/mosaic_637.7.jpg)

current: `explore_toward(surface)`; teacher: `mine_iron`

- run 1: `continue` (continue): The bot has already secured the required iron ingots and is currently exploring the surface to secure materials for the next stage, so letting kev proceed is appropriate.
- text27b: `continue`: The bot is on the surface at dusk with no hostiles nearby and is making steady progress toward the base, so letting kev continue exploring is appropriate.
- vl_text: `mine_iron`: The bot has 0 iron ingots and known iron ore nearby, so mining it directly is fastest to progress toward the goal.
- vl_mosaic: `continue`: The bot is on the surface near known iron ore, so mining it is the fastest way to get the raw iron needed to smelt the remaining ingots.
- vl_frames: `invalid` (error: 400: {"error":"{\"error\":{\"code\":400,\"message\":\"request (40057 tokens) exceeds the available context size (16384 tokens), try increasing it\",\"type\":\"exceed_context_size_error\",\"n_prompt_tokens\): 

### t = 698.9 s (nopath, run 1's override ended no_path)

![mosaic](../../../data/video_bench/leader_events_s3000/mosaic_698.9.jpg)

current: `explore_toward(surface)`; teacher: `mine_iron`

- run 1: `mine_iron` (override): The bot is underground at night with iron ore visible nearby, so mining it is the safest and most direct way to secure the raw iron needed for the current stage.
- text27b: `continue`: The bot is safely underground at y52 with iron ore known 14m away and the current explore_toward(down) subtask is making progress toward the iron level.
- vl_text: `mine_iron`: Iron ore is visible nearby and the bot has an iron pickaxe, so mining it directly is the fastest way to get the required ingots.
- vl_mosaic: `mine_iron`: Iron ore is known and reachable 14m southeast, so mining it directly avoids the no_path failure from previous attempts.
- vl_frames: `invalid` (error: 400: {"error":"{\"error\":{\"code\":400,\"message\":\"request (40101 tokens) exceeds the available context size (16384 tokens), try increasing it\",\"type\":\"exceed_context_size_error\",\"n_prompt_tokens\): 

### t = 1144.3 s (nopath, run 1's override ended no_path)

![mosaic](../../../data/video_bench/leader_events_s3000/mosaic_1144.3.jpg)

current: `mine_stone`; teacher: `mine_iron`

- run 1: `mine_iron` (override): The bot needs raw iron to smelt the 20 ingots required for the armor stage, and iron ore is known to be nearby.
- text27b: `continue`: The bot is safely underground at the base with iron ore visible nearby, so mining stone to secure cobblestone is a sensible next step before smelting more iron for the armor stage.
- vl_text: `mine_iron`: Iron ore is visible 17m southeast and the bot needs 20 iron ingots for armor, so mining it directly is efficient and avoids looping.
- vl_mosaic: `mine_iron`: Iron ore is visible 17m southeast and the bot needs raw iron to smelt the 20 ingots required for the armor stage.
- vl_frames: `invalid` (error: 400: {"error":"{\"error\":{\"code\":400,\"message\":\"request (40100 tokens) exceeds the available context size (16384 tokens), try increasing it\",\"type\":\"exceed_context_size_error\",\"n_prompt_tokens\): 

### t = 1302.3 s (nopath, run 1's override ended no_path)

![mosaic](../../../data/video_bench/leader_events_s3000/mosaic_1302.3.jpg)

current: `explore_toward(surface)`; teacher: `mine_iron`

- run 1: `mine_iron` (override): The bot is now at y24, significantly below the known iron ore at y42, which should finally resolve the persistent no_path errors and allow it to mine the iron needed for the armor.
- text27b: `continue`: The bot is already executing explore_toward(down) which has succeeded 11/11 times and is the only reliable way to reach a reachable iron vein after mine_iron repeatedly failed with no_path.
- vl_text: `explore_toward(down)`: The bot is stuck in a loop of failed mine_iron attempts due to pathing issues, and digging further down is necessary to reach a reachable iron vein.
- vl_mosaic: `explore_toward(down)`: mine_iron keeps failing with no_path despite being below the known ore, so digging further down is necessary to reach a reachable iron vein.
- vl_frames: `invalid` (error: 400: {"error":"{\"error\":{\"code\":400,\"message\":\"request (40202 tokens) exceeds the available context size (16384 tokens), try increasing it\",\"type\":\"exceed_context_size_error\",\"n_prompt_tokens\): 

### t = 1993.2 s (threat, run 1's override ended ok)

![mosaic](../../../data/video_bench/leader_events_s3000/mosaic_1993.2.jpg)

current: `flee(threat)`; teacher: `flee(threat)`

- run 1: `craft(crafting_table)` (override): The bot has 8 planks and needs a crafting table to craft the wooden pickaxe, which is the current stage goal.
- text27b: `continue`: The bot is fleeing a creeper at 13 m and must get out of range before any crafting or mining can proceed safely.
- vl_text: `flee(threat)`: Creeper is 13m away and night is ongoing, so fleeing to safety is critical before crafting continues
- vl_mosaic: `flee(threat)`: Creeper is 13m away and the bot is in the open at night with low health, so fleeing is necessary to avoid immediate danger.
- vl_frames: `invalid` (error: 400: {"error":"{\"error\":{\"code\":400,\"message\":\"request (40120 tokens) exceeds the available context size (16384 tokens), try increasing it\",\"type\":\"exceed_context_size_error\",\"n_prompt_tokens\): 

### t = 2257 s (continue)

![mosaic](../../../data/video_bench/leader_events_s3000/mosaic_2257.0.jpg)

current: `mine_iron`; teacher: `explore_toward(down)`

- run 1: `continue` (continue): The bot is safely sealed in a shelter and the iron ore is known to be very close, so kev's pick to mine it is the correct next step to progress.
- text27b: `continue`: The bot is sealed in a shelter and the iron ore is only 7 m away, so kev's pick to mine it is the correct next step to progress.
- vl_text: `build_shelter`: Night is ongoing with hostile mobs nearby, and the bot is on the surface with low survival odds requiring immediate shelter.
- vl_mosaic: `build_shelter`: Night with hostile mobs nearby and the bot is on the surface, so sealing in is the safest way to survive until morning.
- vl_frames: `invalid` (error: 400: {"error":"{\"error\":{\"code\":400,\"message\":\"request (40121 tokens) exceeds the available context size (16384 tokens), try increasing it\",\"type\":\"exceed_context_size_error\",\"n_prompt_tokens\): 

### t = 2937.8 s (threat, run 1's override ended ok)

![mosaic](../../../data/video_bench/leader_events_s3000/mosaic_2937.8.jpg)

current: `flee(threat)`; teacher: `flee(threat)`

- run 1: `pillar_up` (override): The bot is at 1 HP and repeatedly taking damage from zombies while trying to fight or flee; pillar up is the only way to escape the melee range and survive until dawn.
- text27b: `continue`: The bot is at 1/20 health with multiple zombies within 3 m and a 0.70 death forecast, so fleeing is the only safe immediate action to avoid death before it can fight or mine.
- vl_text: `flee(threat)`: Zombies are within 2m and the bot has low health (1/20), so fleeing immediately prevents further damage while the threat is still close.
- vl_mosaic: `flee(threat)`: Zombie is 2m away and the bot has low health (1/20), so fleeing is necessary to avoid immediate damage.
- vl_frames: `invalid` (error: 400: {"error":"{\"error\":{\"code\":400,\"message\":\"request (40087 tokens) exceeds the available context size (16384 tokens), try increasing it\",\"type\":\"exceed_context_size_error\",\"n_prompt_tokens\): 

### t = 3211.3 s (continue)

![mosaic](../../../data/video_bench/leader_events_s3000/mosaic_3211.3.jpg)

current: `fight(threat)`; teacher: `gather_wood`

- run 1: `fight(threat)` (continue): A zombie is 1m away and the bot has no tools, so engaging the immediate threat is necessary to stop taking damage and survive until morning.
- text27b: `continue`: The bot is trapped underground at night with a zombie 2 m away and no inventory, so continuing lets kev keep fighting or fleeing the immediate threat to survive until morning.
- vl_text: `gather_wood`: The bot needs wood to craft tools and a shelter to survive the night, and gathering wood is a necessary step that has been interrupted repeatedly.
- vl_mosaic: `gather_wood`: The bot needs wood to craft a wooden pickaxe and survive the night, and the nearby tree is reachable with no path to the surface.
- vl_frames: `invalid` (error: 400: {"error":"{\"error\":{\"code\":400,\"message\":\"request (39936 tokens) exceeds the available context size (16384 tokens), try increasing it\",\"type\":\"exceed_context_size_error\",\"n_prompt_tokens\): 

## What it saw (vl_mosaic, asked to describe the mosaic, no schema)

- t = 637.7 s: The bot has been descending through a Minecraft underground structure, transitioning from a dark cave to a sunlit surface, and then moving across a coastal area with water and trees. It appears to have been exploring or navigating through the terrain, with the final moments showing it near the water's edge.
- t = 698.9 s: The bot has been exploring a Minecraft landscape, starting with open grassy areas and water bodies, then moving through forests and into a cave system, as evidenced by the progression from surface terrain to underground tunnels. It appears to have been digging or navigating through the cave, with the final frames showing the bot deep within the cave structure.
- t = 1144.3 s: The bot has been exploring a Minecraft-like underground cave system, moving downward through progressively deeper layers marked by decreasing time labels, and eventually reaching a section with wooden structures and chests. It appears to have been navigating through the cave while collecting or interacting with resources, as evidenced by the transition from empty stone corridors to areas with wooden architecture and storage blocks.
- t = 1302.3 s: The bot has been navigating through a Minecraft cave system, moving steadily downward from the top-left (oldest) to the bottom-right (newest) as indicated by the decreasing time labels, with its path showing a mix of stone, gravel, and occasional wooden structures. It appears to have been exploring the cave while avoiding or interacting minimally with the sparse mobs present in the environment.
- t = 1993.2 s: The bot has been exploring a Minecraft world, moving from an underground stone structure through forested areas with trees and water, and eventually reaching a beach with sand and stone structures. It appears to have been navigating through various biomes while collecting resources or exploring the environment, as indicated by the progression from enclosed spaces to open landscapes and finally to a coastal area.
- t = 2257 s: The bot has been navigating through a Minecraft-like underground structure, moving downward and exploring tunnels and chambers with stone and cobblestone walls. It appears to have been collecting resources like coal (visible as brown blocks) and possibly interacting with the environment, as seen in the progression from older to newer frames.
- t = 2937.8 s: The bot has been descending through a Minecraft cave system, starting from a surface area with grass and trees and progressively moving deeper underground, encountering stone, dirt, and eventually reaching a large underground structure with water, lava, and various mobs. It then appears to have explored the lower levels of the cave, including areas with water and lava, before arriving at a room with a blue structure and more mobs.
- t = 3211.3 s: The bot has been exploring a Minecraft forest biome, moving through grassy terrain and near trees while occasionally encountering passive mobs like sheep and pigs. It appears to have been navigating through the area for about 120 seconds, with the sequence showing its progression from darker, more enclosed spaces toward brighter, open forest areas.
