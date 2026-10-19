# Tank tactics

HARD (2026-09-16). Source of truth for armour in the **core**.
Deterministic. Same integers on every signer node. No live LLM. No `Math.random`.

Truck rules and tank-vs-tank rules are **not the same**.

Reviewed 2026-09-16 18:22 (spec review, the owner's order): holes closed, numbers fixed, nothing of
the owner's HARD rules changed. Where this file **rules** something the owner did not say, the line is marked
**RULED HERE** so he can overrule it. Where the code on the branch does not yet do what this file says,
the line is marked **GAP**.

Implementation: `packages/core/src/rules/tactics.js` (assignment, roles, slots, scoot) and the army step
`packages/core/src/rules/army.js` (moves a tank to what tactics.js hands it, picks the hull-down spot).
`sim.js` wires spawn, respawn, fire and touch. No other file decides where a tank goes.

---

## 0. What the player must see (2026-09-16, addendum)

The tanks must **not look dumb among themselves**. They must read as **smart**, an **active
battlefield** - to the player, from the cab. This section is what "smart" means here, in numbers, so
that a probe can fail it. Every number is measured over 5 seeds x 3600 ticks with the truck held in its
bay unless said otherwise.

| The player sees | The rule that makes it | Probe passes when |
|---|---|---|
| A line of tanks, not a pile | frontage slots §2.4 | no 3 living tanks of one side inside 20 m of each other, on more than 2% of tank-ticks (was: groups of 9 to 20) |
| Hulls that hold still on a post, no wiggle | hold = stand, §4.1 | a tank on its post moves < 0.02 m/tick; a tank reverses its travel direction (x or z sign flip) at most once in any 2 s, outside a separation push |
| Nobody pressed against anybody | 12 m bubble §1.1 | the separation push undoes a tank's own step on < 5% of tank-ticks (was 42.5%) |
| Something is always happening | role swap §2.6 (a leg is 6 to 10 s) and scoot §4.3 | in any 10 s window at least one tank per side changes post; at no tick are more than half a side's living tanks moving |
| Leapfrog, in pairs | bounding overwatch §2.6 | of a pair, never both bounding; the bounding one is 14 m nearer the seam than its partner when both are on post |
| Fire, then move - cause and effect | shoot-and-scoot §4.3 | after a team's shot, that team changes slot within 1 tick unless hemmed in (§4.3) or inside its 10 s scoot cool-down |
| A tank faces what it fights | heading rule §4.5 | a holding tank's hull points at the enemy side (heading within 30 degrees of the seam normal) on > 95% of holding ticks |
| Relocation reads as a decision, not a drift | adjacent-slot rule §4.3 | a team never crosses another team's lane while relocating; a slot change moves a team exactly 27 m in x |
| The kill zone is covered | slots and gun range §4.2 | every metre of the seam with x in [-81, 81] is inside 46 m of at least 2 living tanks of each side while that side has >= 6 alive |
| Nobody runs from the truck, nobody chases it | §1.2 | a tank's x and z targets are the same with the truck present and absent (bit-identical posts, truck parked vs truck driving) |
| **A war, not a shooting gallery: ground changes hands** | pressure §4.10 | in every 60 s window at least one team of each side crosses the seam in its lane, and at least one team of each side gives ground; the forward line of some team differs from its 16 m default on > 30% of ticks |
| Losses and replacements, both sides, all round | gun §4.4, reinforce §3 | neither side is at full 12 with zero losses over any 60 s window while the other side has a tank inside 46 m; neither side falls below 4 living tanks on more than 5% of ticks |
| The two lines are not mirror images | §2.4, §4.10 | the two sides' slot orders differ on every seed; the two sides' mean push depth differs by >= 4 m on > 50% of ticks |

2026-09-16 (during this review): *"We want an exciting game for the player and the war must
really look like war - not tanks stood in a row playing each other dumb. A DYNAMIC WAR."* The last
three rows are that order. A static line of six slots that never moves in z is **not** this spec, even
if every other row passes. §4.10 is the rule that moves it.

If a probe on this table fails, the doctrine is not live, whatever the code says.

---

## 1. Two relations

### 1.1 Tank vs tank (keep)

- Never inside **12 m** hull to hull. Hull to hull = centre to centre distance `d < 12.00 m`
  (Q16.16 `786432`). Exactly 12.00 m is allowed. Same side and other side alike.
- Enforced by the separation pass at the top of the army step, over every living armour pair in index
  order, before any tank moves: each of the two is pushed half of `(12 m - d)` apart. Coincident
  (`d <= 0.01 m`) is skipped, as C# skips it.
- No clip, no ram **between tanks**. A tank has no collision with another tank other than that push.
- Flank / spacing / clip-ram rules that exist for armour vs armour **stay**: crowded (an enemy tank inside
  24 m) gives 6 m of ground on z at 0.35 walk and then holds; overrun (more than 14 m past its own seam)
  falls back to 34 m behind the seam at full walk.
- They do **not** apply to the truck.

### 1.2 Tank vs truck (exception)

- Do **not** dodge, flee, get pushed, or keep 12 m from the truck. **No movement rule reads the truck's
  position.** `postOf`, `isBounding`, `scoot`, the hold line, the hull-down search and the separation
  pass take no truck argument. The truck is pushed out of the tank (`resolveArmour`); the tank never moves
  for the truck.
- **Shoot** the truck (especially a dangerous load). The gun rule (§4.4): the truck outranks the tank's
  picked enemy when it is inside 34 m and nearer than that enemy; heat widens both (reach `+1.4 x heat`,
  outranks up to `2.5 x heat` nearer).
  **GAP / RULED HERE:** today a tank with **no enemy tank inside 46 m** picks no target and so never fires
  on the truck at all. That contradicts "shoot the truck". Rule: a tank with no enemy in range and the
  truck inside its (heat-widened) 34 m reach fires on the truck on its normal reload. Same draws as a
  shot at a foe: one hit roll, one damage roll, one reload roll - in that order - so the stream keeps its
  shape.
- Otherwise **ignore** the truck.
- **Touch either way = truck dies immediately** (WRECKED). That used to work and it stays. Touch = a
  living tank's hull circle (radius 3.0 m) overlaps either of the truck's two body circles (radius 1.275 m,
  centres +2.0 m and -1.8 m along the nose): `d < 4.275 m`. Tested against last tick's tank positions,
  which is where `resolveArmour` runs. In a **live, scored** run (`S_STATE == RUN_LIVE`, not practice) the
  truck's HP goes to 0 that tick and the run ends WRECKED. In practice the truck is pushed out and drives
  on. Not conditional on speed: a truck leaning on a tank at 0 m/s is a wreck.
- After a shot, relocate to the **next hashed slot** (shoot-and-scoot, §4.3). That is not fleeing the
  truck: the next slot is decided from (seed, side, team, tick), never from where the truck is.

---

## 2. Assignment (bit-identical on every node)

### 2.1 Roster

- 96 unit slots. Every 4th index is armour (`index & 3 == 0`); the side is bit 2 (`0` = bull, side -1,
  spawns at negative z, faces +z; `4` = bear, side +1). So **12 tanks a side**, roster numbers `k = 0..11`
  per side, `k = (index >> 3) & 15`.
- Teams are **roster ids**, fixed for the round: `team = k >> 1`, `member = k & 1`. Six teams a side.
- A unit index maps to (side, team, member) with integer shifts only. No table, no draw.

### 2.2 Seed

- `hash = mix(seedWord, 0x7a3c5e11)`, `mix` a 32-bit integer mixer (`Math.imul`, xor-shift). Stored in
  the state at `O_TACTICS + 0`. Every other tactics value is `mix` of that hash with small integer
  constants and ids. **No draw is taken from the round's RNG**: the stream does not shift, every transcript
  replays.

### 2.3 Stable pairs

- **Stable pairs:** sorted roster ids `(0,1), (2,3), … (10,11)` per side. Partner of `k` is `k ^ 1`.
- Do **not** re-pair from whoever is alive (that reshuffles the line).
- With 12 a side there is no odd tank at full strength. The **singleton** rule (§2.5) is for a widow
  (§3) and for any future roster with an odd count.

### 2.4 Frontage slots

- **7 slots a side**, `x = -81 m + 27 m x slot`, `slot = 0..6` → `-81, -54, -27, 0, 27, 54, 81`.
  The outer hull sits at 87 m, inside the 88 m x-clamp of the field.
- **Permutation** hashed from `(seed, side)`: Fisher-Yates driven by `mix`, no draw. Team `t` starts
  on `order[t]`. Six teams take six of the seven slots; **one slot a side is free** and that free slot is
  what a scoot moves into.
- A team holds one slot. **No two teams of a side hold the same slot** - by construction at init, and
  the scoot (§4.3) only moves into a slot no other team of that side holds.
- The two sides' permutations are **independent** → the two lines are offset from each other, every slot
  sees the other side's slots from angles: **crossfire**.
- Within a team the two hulls sit **6 m either side of the slot centre**: 12 m apart in x. That is the
  bubble boundary, not inside it (§1.1). Neighbouring teams' inner hulls are 15 m apart.

### 2.5 Roles

- In a pair: one **OVERWATCH**, one **BOUNDING**. Never both bounding, never both overwatch while both are
  alive and on post.
- OVERWATCH holds the **overwatch line**, 30 m from the seam on its own side, hull-down (§4.1). It fires.
- BOUNDING holds the **forward line**, 16 m from the seam on its own side. It fires only when it did not
  move in that tick (§4.4).
- Singleton (odd tank, or a widow §3) = **OVERWATCH** on its own team's slot, overwatch line. It fires.
  It never bounds.

### 2.6 Role clock (bounding overwatch)

- Per team: `period` in ticks = `360 + (h % 240)` → **6 to 10 s** at 60 ticks/s; `phase = h' % period`;
  first bounding `member = bit`, all from `h = mix(mix(hash, sideConst), team)`.
- `leg = floor((tick - roleStart) / period) & 1`; the member bounding in this tick is `firstMember ^ leg`.
  At init `roleStart = -phase`, so the teams of a side do not all swap on the same tick.
- At a leg change the roles **swap**: the new BOUNDING tank drives from the overwatch line to the forward
  line and the new OVERWATCH tank from the forward line back. They are 12 m apart in x while they pass,
  so the pass never enters the bubble. That is the leapfrog.
- **RULED HERE:** the swap is simultaneous (both move on the leg tick). It is 14 m at 6.8 m/s, about 2 s.
  The one going **back** is OVERWATCH from the leg tick and may fire while it goes; the one going
  **forward** is BOUNDING and does not fire until it stands. So at every tick of the swap one of the pair
  is covering.

---

## 3. Death and respawn

- Teams stay on **roster id**, not the living set. A dead id keeps its team, slot and member bit.
- One of a pair **dies:** the survivor is a **widow**: it holds **OVERWATCH** on the team's slot, on the
  overwatch line, from the tick of the death (`isBounding` is false while the partner's `U_STATE == 0`).
  No suicide rush, no advance to the forward line, no change of slot except by its own shoot-and-scoot.
- Replacement clock: Army.Reinforce. The side's armour clock runs only while the side is short and runs
  `deficit` times faster; when it fires, the **lowest dead armour index** of that side spawns (`wait` 6 s
  at deficit 1). So the order ids come back in is fixed by index, not by who died first.
- That **id respawns:** it rejoins the **same** pair as **BOUNDING** (partner already holding):
  `roleStart = respawn tick`, `firstMember = the respawned member`. The team's role clock restarts, the
  first leg is a full `period`.
- It **enters in its own lane**: the spawn's x draw is taken (stream unchanged) and its value replaced by
  the team's slot x ± 6 m; z is the spawn's own back edge (76 to 79 m from the centre on its side). It
  drives to the forward line at 6.8 m/s and fires only once it stands (§4.4).
- If **both** of a pair are dead the first back is BOUNDING with no partner: it holds the forward line
  and fires when standing until the partner returns; then the partner is the one that respawned, restarts
  the clock as BOUNDING, and the first one becomes OVERWATCH.
- A new hull **never** steals another team's partner. There is no code path that changes `team` or
  `member` of an index.
- A tank's slot does **not** change on death or respawn. What the team held, it holds.

---

## 4. When which tactic

### 4.1 Default hold - hull-down / reverse slope on the kill zone

- **Fires:** every tick a tank is not swapping, scooting, crowded or overrun.
- The tank's target is `(slot x ± 6 m, seam z at its own x ± its line)`, the seam read per x (the
  front is a curve, not a number). On the target it **stands**: step 0, no wobble (the heading draw is
  taken and discarded).
- **Hull-down** (OVERWATCH only): five candidate z, the hold line and ±2 m, ±4 m; for each, the ground
  rise from the candidate to 6 m toward the enemy; the tank holds the candidate with the **largest
  rise** (ties → the first, nearest the hold line, in scan order -4, -2, 0, +2, +4). That is the point
  behind the crest with the gun over it.
- **Reverse slope** is the same rule seen from the other side: sit behind the crest, gun just over. It is
  **not** a second behaviour in this core.
- BOUNDING holds the forward line as given, no crest search: it is the one that moves.
- **Kill zone:** there is no road in the core; the kill zone every slot covers is the **seam band** the
  truck has to cross. With a 46 m gun and 27 m slot pitch, every metre of the seam between the outer
  slots is inside the reach of at least 3 slots of a side at full strength, from 3 different x: several
  hulls, same stretch, different angles.

### 4.2 Crossfire

- **Fires:** always; it is geometry, not a state. The two sides' slot permutations are independent
  (§2.4), so the lines are staggered against each other and a tank that stands on the seam is seen from
  both sides at angles.

### 4.3 After a shot - shoot-and-scoot to the next hashed slot

- **Fires:** on the tick a tank of the team **fires** (hit or miss, at a tank or the truck), after the
  reload is set; at most **once per 10 s (600 ticks) per team** (`TAC_SCOOT`).
- **Next hashed slot** (RULED HERE, from measurement): the **adjacent** slot, `here ± 1`, the side hashed
  from `(seed, side, team, tick)`; if that one is held by another team of the side or off the end, the
  other side; if both are held or off the end, **hold** and try again after the next shot. Not the next
  slot of the permutation: measured, that was a median 66 m (p90 132 m) across the field and the pair drove
  through the other teams' lanes (the separation push undid 92.8% of their steps). A scoot is exactly
  27 m in x and never crosses a lane.
- The whole **team** moves: both hulls keep their ±6 m and their own depth lines. That is the **staggered
  column** while moving (§4.6). Roles do not change on a scoot.
- Not away from the truck, not toward it: the truck is not an input.
- The scoot is written on the shooter's tick; the partner reads the new slot on its own step of the same
  tick if its index is higher, else the next tick. One tick of skew, protocol.

### 4.4 Fire

- Gun 46 m, reload 1.4 to 3.2 s, hit 55%, damage 11 to 24 against 60 to 100 HP (the C# 6 to 10 at x10).
  Target: the nearest living enemy tank inside 46 m; the truck outranks it per §1.2.
- **OVERWATCH fires** in every tick its reload is 0 and it has a target, standing or moving.
- **BOUNDING fires only standing:** a bounding tank whose position changed by more than 0.02 m (x + z,
  `1310` Q16.16) in the tick does not fire in that tick. Its reload still counts down.
- Drawn in index order, always: a tank that fires earlier changes what the ones after it see.

### 4.5 Heading (RULED HERE)

- Moving: the hull points along its step, as it does today (below the floor speed the heading is held).
- Standing on post: the hull points at the enemy side - the seam normal, `-side x z`. The heading word
  is what the renderer draws; a line of hulls all facing the seam is what a held line looks like.

### 4.6 Moving between slots - staggered column

- **Fires:** whenever a team's slot changes (scoot) and, per hull, during a swap or a respawn drive-in.
- Both hulls of the team move to the new x at once, each on its **own** depth line (16 m and 30 m) and its
  own side of the slot (±6 m). So the two are offset 12 m in x and 14 m in z: a staggered column, not
  bumper-to-bumper, and never inside the bubble.
- Walk 6.8 m/s in x and z on separate controllers (z is never spent on the x chase). A 27 m scoot takes
  about 4 s.

### 4.7 Engaged - no chase

- A tank does **not** leave its lane for a foe (`LANE_LEASH = 0`): the slot is a position held; the gun
  reaches 46 m, the hull stays. Crowded / overrun (§1.1) move the hull in z only.

### 4.8 Singleton / widow

- Overwatch on the team's own slot, overwatch line, hull-down, until the partner respawns (§3). It still
  fires, still scoots after a shot, never bounds.

### 4.9 Forbidden in this game

- **Sidescrape.** No angling of the hull for armour; the heading rule is §4.5.
- **Smoke.** None exists.
- **Kiting away from the truck.** No rule may read the truck's position to move a tank (§1.2).
- **Stop** (seam parking lot): no tank holds nearer than its forward line (16 m) to the seam except while
  overrun-fallback or crowded rules are moving it; two tanks never share a metre (§1.1, §2.4).

### 4.10 The front moves - pressure (2026-09-16: DYNAMIC WAR)

The lines of §2 are where a team **starts** and what it **returns to**. They are not where it stays. A
team that is winning its stretch takes ground across the seam; a team that is losing it gives ground.
All of it from the living set at the start of the tick and from `(seed, side, team, tick)` - no draw,
no truck. **RULED HERE**, numbers included, so it can be built without guessing; the owner can retune.

- **Local odds**, per team, read at the start of the tick from last tick's positions: `own` = living
  tanks of its side inside 46 m of its slot centre on the seam; `foe` = living enemy tanks inside 46 m of
  the same point. Integers.
- **Push depth** `push`, per team, in 8 m steps, held in the state (`TAC_PUSH`, one word per team,
  init 0). Both of the team's lines are `push` nearer the enemy: forward line `16 - push`, overwatch
  line `30 - push`. The seam itself is `push = 16`; `push = 24` is 8 m across.
- **Re-read every 5 s (300 ticks) per team**, on a tick hashed from `(seed, side, team)` so the teams do
  not all step together:
  - `own >= foe + 2` → `push += 8`, up to **24** (the forward hull 8 m across the seam, the overwatch
    hull 6 m short of it). Taking ground.
  - `foe >= own + 2` → `push -= 8`, down to **-8** (forward line 24 m, overwatch 38 m). Giving ground.
  - otherwise `push` steps one 8 m **toward 0**. The line drifts home when nobody has the upper hand.
- **Overrun** (§1.1) is measured from the team's own forward line, not from the seam: a hull more than
  14 m past `16 - push` falls back to `34 - push`. Otherwise every push across the seam would be undone
  by the fall-back rule the same tick.
- A widow (§3) never pushes: its `push` steps toward 0 on every re-read. A respawn (§3) rejoins at the
  team's current `push`.
- The swap (§2.6), the scoot (§4.3) and the hull-down search (§4.1) all use the pushed lines. The
  bounding tank of a pushing team therefore leapfrogs **across the seam**, in its lane, its partner
  covering from behind: that is an assault the player sees, and it stops on its own when the enemy's
  odds at that stretch turn.
- **Crowded** (§1.1: an enemy inside 24 m gives 6 m) stays and is what makes two pushing teams meet and
  stand off instead of driving through each other.
- Why this is enough for "dynamic": the two sides' slot orders are independent, so the local odds are
  never equal everywhere; some stretch is always being taken and some other given. The §0 rows above
  are the check that it actually happens; if they fail, the steps or the thresholds are retuned, not
  the rows.

---

## 5. Vocabulary (all required)

**Frontage**
Side by side on a line. Here: 7 slots a side, 27 m apart, six held. Not every hull on one metre of road.

**Echelon / depth**
Some forward, rest behind. Here: the forward line (16 m) and the overwatch line (30 m). Not one file
bumper-to-bumper.

**Overwatch**
One part holds and shoots while another moves. Here: the OVERWATCH tank of a pair, and every singleton.

**Bounding overwatch**
A holds, B advances, then swap. Leapfrog. Here: the role clock, legs of 6 to 10 s per team.

**Hull-down**
Turret over crest / cover, hull hidden. Here: the best-rise candidate of five about the overwatch line.

**Reverse slope**
Sit behind the crest, gun just over. Here: the same rule as hull-down.

**Kill zone**
Several hulls cover the same stretch from different angles. Here: the seam band, >= 3 slots a side
inside 46 m of any metre of it.

**Crossfire**
Both sides of the road / seam. Here: independent slot permutations per side.

**Shoot-and-scoot**
Fire, then next slot. Here: adjacent free slot, hashed side, once per 10 s per team.

**2-tank fire team**
The stable pair. Here: roster ids `(2t, 2t+1)` of a side.

**Staggered column**
Offset on the road when moving. Here: 12 m in x and 14 m in z between the two hulls of a team.

**Stop**
Seam parking lot. Wiggle-to-death because hulls almost touch. Forbidden (§4.9).

**Widow**
The living tank of a pair whose partner is dead. A singleton until the id respawns.

**Lane**
The x band of a team's slot, 27 m wide, centred on the slot. A team never crosses another's.

**Tick**
1/60 s. Every time in this file is in ticks in the code: 6 s = 360, 10 s = 600.

---

## 6. WASTED

- The core ends the run: `S_STATE = RUN_WRECKED`, `T_HP = 0`, on the touch tick (§1.2) or when the
  truck's HP reaches 0 from fire.
- The client: on RUN_WRECKED the **WASTED screen first** - the truck's burn, at least 3 s and measured at
  ~5 s (live 0.0.1403: WASTED on screen at 1 s and 3 s, lobby at 5.07 s) - **then** the lobby.
  Not lobby immediately. The lobby is never shown while WASTED is on screen.
- WASTED is not a core state. The core says WRECKED once; the client owns the sequence and the timing.
  A client that shows the lobby first has skipped WASTED, whatever the core said.

---

## 7. Tests that must fail if this is wrong

Each test names the section it guards. All run on the core alone, seeds fixed, no client.

- Two living tanks of a side hold the same slot at any tick (§2.4, §4.3).
- A widow bounds, or holds nearer than the overwatch line (§3).
- A respawn changes any index's team or member, or restarts another team's role clock (§3).
- A respawn is not BOUNDING on its first leg, or its partner is (§3).
- A tank's post differs between a run with the truck parked and one with the truck driven through the
  line, seed equal (§1.2: no rule reads the truck).
- Touch truck-tank in a live scored run does not set RUN_WRECKED on that tick (§1.2).
- Touch in practice sets RUN_WRECKED (§1.2).
- A tank with the truck inside 34 m and no enemy tank in range never fires on the truck (§1.2 GAP).
- A bounding tank fires in a tick it moved (§4.4).
- Both tanks of a living pair are bounding in the same tick (§2.5).
- A scoot moves a team more than 27 m, or into a held slot, or fires twice inside 600 ticks for one team
  (§4.3).
- Two different seeds give the same slot order on a side, or one seed gives different orders on two
  nodes (§2.2, §2.4: the order is a pure function of the seed).
- Any tactics value is computed from a draw of the round's RNG (§2.2: the stream must be identical with
  tactics on and off).
- A team's push changes by other than one 8 m step per re-read, or leaves [-8, 24], or a widow's push
  moves away from 0 (§4.10).
- A pushing team's forward hull is thrown back by the overrun rule while inside 14 m of its own pushed
  forward line (§4.10).
- Over 5 seeds x 3600 ticks no team of a side ever crosses the seam, or no team ever gives ground (§4.10,
  §0 rows 11-13).
- A §0 probe row fails.
- WASTED skipped, lobby first (§6; client test).

Implement in `packages/core/src/rules/tactics.js` and the army step.
