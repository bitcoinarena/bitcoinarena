# War tactics

HARD (the owner 2026-09-16). Source of truth for the **army** in the **core**: armour (part A) and infantry
(part B). Renamed from TANK_TACTICS.md on the owner's order (2026-09-16) when the soldiers were added.
Deterministic. Same integers on every signer node. No live LLM. No `Math.random`.

Truck rules and tank-vs-tank rules are **not the same**.

Reviewed 2026-09-16 18:22 (spec review, the owner's order): holes closed, numbers fixed, nothing of
the owner's HARD rules changed. Where this file **rules** something the owner did not say, the line is marked
**RULED HERE** so he can overrule it. Where the code on the branch does not yet do what this file says,
the line is marked **GAP**.

Amended 2026-09-16 19:02-19:05 (the owner's order, items 1 and 3 of his list, nothing else): **objectives**
(§4.11: RIDGE, HOLLOW, GAP - no truck is an objective, §1.2) and **infantry that hides** (§11.3-§11.5:
cover in craters and wrecks, prone, suppression; the earlier "no cover" ruling of §11.3 is **OVERRULED**).
Item 2 of his list (wrecks as cover for tanks, side pressure, whole-line retreat) is **not** in this file:
no rule below lets a tank, a gun or the truck read a wreck. Everything added by that order is **GAP** until
the core does it.

Revised 2026-09-16 19:20 (the owner: *"Do we have an absolutely dynamic war? Is it immersive? What is
missing?"*): the verdict is §0.1 - **not yet** - with the four reasons and the sections that answer them:
supply (§3), the assault (§4.12), the tape as the general (§4.13), the client's list (§0.2). Rulings only the owner can make are parked in §15. All of it GAP, all of it RULED HERE.

Implementation: `packages/core/src/rules/tactics.js` (assignment, roles, slots, scoot, push, objectives -
armour and, per part B, the infantry's fire teams, rush clock, cover claims and suppression) and the army
step `packages/core/src/rules/army.js` (moves a unit to what tactics.js hands it, picks the hull-down spot,
walks a man, writes his posture). `sim.js` wires spawn, respawn, fire, touch, run-over, wrecks. No other
file decides where a tank or a man goes.

Sections 0-7 are armour (part A). Sections 8-14 are infantry (part B). §0 and §6 cover both.

---

## 0. What the player must see (the owner 2026-09-16, addendum)

The tanks - and the men, §8 on - must **not look dumb among themselves**. They must read as **smart**, an **active
battlefield** - to the player, from the cab. This section is what "smart" means here, in numbers, so
that a probe can fail it. Every number is measured over 5 seeds x 3600 ticks with the truck held in its
bay unless said otherwise.

How the rows are read (RULED HERE, after the first probe run, so two probes cannot disagree):
- **Holding** = the rules gave the tank no step of its own this tick (dx = dz = 0 before separation,
  craters and the field clamp). A hull moved only by the separation push is still holding.
- **A direction flip** counts the tank's **own** step only, outside separation: the sign of dx or of
  dz reversing between two ticks in which the tank stepped.
- **On the line** = a living tank within 40 m (z) of its post. A hull further than that - a respawn
  walking in from the back edge - is a **column**, and rows about the line (2, 4b, 7) do not count it.
- **Tolerances.** A row written "at no tick" / "every metre" is read at the tolerance given in the row;
  where none is given it is 100%. A tolerance is a measurement allowance for respawns and transit, not
  a licence: a row that fails at its tolerance is red.

| The player sees | The rule that makes it | Probe passes when |
|---|---|---|
| A line of tanks, not a pile | frontage slots §2.4 | no 3 living tanks of one side all within 12 m of each other (the tank-tank minimum, §1.1), on more than 2% of tank-ticks. RULED (the owner 2026-09-16): §2.4 puts a pair's hulls 12 m apart and neighbouring inner hulls 15 m apart, so every interior tank is in a 20 m triple by design - that is formation, not a clump. Two tanks at 12 m is a legal pair; three inside 12 m is a pile. The geometry is not spread to suit a probe. (was: groups of 9 to 20 within 20 m) |
| Hulls that hold still on a post, no wiggle | hold = stand, §4.1 | a tank on its post moves < 0.02 m/tick of its own step; a tank on the line reverses its own travel direction (x or z sign flip) at most once in any 2 s window - a second flip inside 2 s is a fidget, and fidgets are < 2% of all flips |
| Nobody pressed against anybody | 12 m bubble §1.1 | the separation push undoes a tank's own step on < 5% of tank-ticks (was 42.5%) |
| Something is always happening | role swap §2.6 (a leg is 6 to 10 s) and scoot §4.3 | (a) in any 10 s window at least one tank per side changes post; (b) on >= 98% of ticks no more than half of a side's tanks on the line are moving (columns walking in do not count) |
| Leapfrog, in pairs | bounding overwatch §2.6 | of a pair, never both bounding; the bounding one is 14 m nearer the seam than its partner when both are on post |
| Fire, then move - cause and effect | shoot-and-scoot §4.3 | after a team's shot, that team changes slot within 1 tick unless hemmed in (§4.3) or inside its 10 s scoot cool-down |
| A tank faces what it fights | heading rule §4.5 | a holding tank on the line points its hull at the enemy side (heading within 30 degrees of the seam normal) on > 95% of holding ticks |
| Relocation reads as a decision, not a drift | adjacent-slot rule §4.3 | a team never crosses another team's lane while relocating; a slot change moves a team exactly 27 m in x |
| The kill zone is covered | slots and gun range §4.2 | on the ticks on which a side has >= 6 alive, >= 95% of the seam-metre samples (x in [-81, 81], every metre, every tick) are inside 46 m of at least 2 of that side's living tanks - a tank in transit counts if its gun reaches; a tank still walking in from the back edge does not reach. RULED (the owner 2026-09-16): coverage is the share of seam-metre samples, not "every metre covered on >= 95% of ticks"; that tick-union reading cannot coexist with bounding overwatch, scoot or respawn. The bar stays 95%. |
| Nobody runs from the truck, nobody chases it | §1.2 | a tank's x and z targets are the same with the truck present and absent (bit-identical posts, truck parked vs truck driving) |
| **A war, not a shooting gallery: ground changes hands** | pressure §4.10 | in every 60 s window at least one team of each side crosses the seam in its lane, and at least one team of each side gives ground; the forward line of some team differs from its 16 m default on > 30% of ticks |
| Losses and replacements, both sides, all round | gun §4.4, reinforce §3 | neither side is at full 12 with zero losses over any 60 s window while the other side has a tank inside 46 m; neither side falls below 4 living tanks on more than 5% of ticks |
| The two lines are not mirror images | §2.4, §4.10 | the two sides' slot orders differ on every seed; the two sides' mean push depth differs by >= 4 m on > 50% of ticks |
| **An assault goes for something** | objectives §4.11 | of team-ticks with push >= 16 (forward hull on or across the seam), >= 60% are teams on an objective's own lane (by chance: 3 lanes of 7 slots); the mean push of teams on objective lanes exceeds the mean push of all other teams by >= 6 m |
| Every objective is fought over | §4.11 | on >= 60% of ticks each of the three objectives has a living tank of **each** side inside 46 m of its point |
| Objectives change hands | holder §4.11 | on >= 4 of 5 seeds at least one objective's holder goes from one side to the other inside the 3600 ticks |
| The player knows what the war is for | markers §4.11 (client) | the client draws RIDGE, HOLLOW and GAP at the core's points in the holder's colour, within 1 tick of the core's words (client test) |
| No truck is an objective | §1.2, §4.11 | objective lanes, points and holders are bit-identical with the truck parked and the truck driven through the line, seed equal |

the owner 2026-09-16 (during this review): *"We want an exciting game for the player and the war must
really look like war - not tanks stood in a row playing each other dumb. A DYNAMIC WAR."* The three
rows from "A war, not a shooting gallery" are that order. A static line of six slots that never moves in
z is **not** this spec, even if every other row passes. §4.10 is the rule that moves it. The five
objective rows are his 19:02 order - *"an assault visibly goes for something, not a seam with no
reason"* - and §4.11 is the rule that aims it.

Infantry rows (part B, §8-§12), same probe conditions:

| The player sees | The rule that makes it | Probe passes when |
|---|---|---|
| Men move in groups, not as 36 loners | fire teams §9.2, rush clock §11.2 | each living man is within 18 m of another living man of his fire team on > 80% of ticks; the 4 of a fire team move (step > 0.02 m) in the same tick or halt in the same tick on > 90% of ticks |
| Fire and movement: some run while others shoot | rush / halt per fire team §11.2 | in any 5 s window every squad has at least one fire team halted and, unless all on post, at least one moving |
| A ragged line with depth, not a fence | standoff scatter §11.1 | z spread (sd) of a side's men on post between 4 m and 12 m; x spread between 20 m and 60 m |
| Infantry goes where the armour goes | follow the push §12.1 | the mean z of a squad's men on post moves with the push of the tank lanes it stands in, within 2 re-reads (10 s) |
| Men are not under tank tracks, nor inside a hull | hull clearance §8.3 | no living man inside 3 m of a living tank's centre on more than 0.5% of man-ticks |
| Men fall, columns walk in | rifle §11.6, respawn §10 | every 60 s window each side loses >= 3 men and receives >= 3; a replacement walks in from the back edge, never appears on the line |
| Nobody flees the truck, the truck runs men down | §8.2 | a man's target post is identical with the truck present or absent, and no cover claim or posture rule takes a truck argument; a man inside 3.6 m of a truck at >= 2.5 m/s is dead that tick |
| **Men hide** | posture §11.4 | of man-ticks of living men on the line (within 40 m of post) who did not step, >= 85% are PRONE or COVER; a man in the open who did not step while his fire team is under fire (§11.5) is PRONE on 100% of those man-ticks |
| Wrecks and craters are used | cover places §11.3 | on >= 70% of the ticks on which a side has a free eligible place within 12 m of the post of one of its men on the line, at least one man of that side is on a place (within 0.5 m) |
| Fire pins men down | suppression §11.5 | each side has at least one pinned fire team on 10% to 70% of ticks; a pinned man is never STAND and never steps more than 0.01 m in a tick (a crawl) |
| **Tanks are feared by men** | coax §4.4 | coax kills are >= 20% of a side's rifle-side deaths per 60 s; a coax burst is never fired with an enemy tank inside 46 m or a fireable truck in reach |
| **Men are feared by tanks** | AT man §11.7 | AT hits are 15% to 50% of a side's tank deaths per 60 s (below 15% the launcher is decoration, above 50% the tanks are the fodder); every AT shot is from PRONE or COVER at a tank inside 30 m; the §0 floor row (never below 4 tanks on more than 5% of ticks) is re-measured with both arms on and stands |
| **The sky is not weather** | calls §12.3 | on 25% to 60% of ticks no gunship is aloft (was: airborne 69-93%, two at once); a gunship of the attacking side is aloft within 300 ticks of >= 90% of assault starts; no launch before the first call |
| **Bombs go where the attack goes** | run-in §12.3 | >= 80% of a side's bombs land inside 27 m (x) of the called lane; during CAS >= 60% land inside 16 m of the objective's point |
| **Air spares its own** | own-troops check §12.3 | men of a side killed by its own bombs are <= 10% of that side's bomb kills (was 15-40%) |
| **Air can be driven off** | AT vs gunship §12.3 | over 5 seeds at least 3 gunships are hit and leave without another drop; <= 50% of sorties are driven off (above that the air is decoration) |
| **Not cannon fodder** | §11.3-§11.5 | a side loses <= 20 men per 60 s, mean over 5 seeds (measured 2026-09-16 on the working tree before these rules: 26.5 to 41.5 a side, mean 32.7 - both sides 53, 60, 61, 70, 83 on seeds 1-5); rifle deaths per man-tick of STAND men are >= 2x those of PRONE and COVER men together |

If a probe on this table fails, the doctrine is not live, whatever the code says.

### 0.1 Verdict (the owner 2026-09-16 19:20: "Do we have an absolutely dynamic war? Is it immersive? What is missing?")

**Not yet.** With §1-§14 as written above and built, the war does not look dumb, it fights over three
named places and its men hide. It is still not a war that **goes anywhere**, for four reasons, each
measured or read from the core on the branch, each with a section below that fixes it:

1. **The front is frozen and identical on every round.** `sim.js` `tape()` builds the price tape from
   the sample index alone (`Math.imul(i + 1, 2654435761)`), takes no seed and is never written again
   during a run. So the seam - the thing the whole game is named for, the market as a front line - is
   the same curve on seed 1 and seed 5 and does not move a centimetre in 3600 ticks. §4.13.
2. **The war is homeostatic.** Respawn runs `deficit` times faster the more a side has lost (§3), the
   push drifts home whenever nobody has the upper hand (§4.10) and its ceiling is 24 (a hull 8 m across
   the seam). Every swing is undone in 5 to 10 s. From a cab 8 m is nothing. Nothing accumulates,
   nothing is ever won or lost, and a war in which nothing is at stake is a screensaver. §4.12, §3
   (supply).
3. **No tempo.** Six teams re-read their odds every 5 s on their own clocks, so the whole front
   breathes at once, all the time, at the same amplitude. No lull, no build-up, no assault that is
   declared and then happens, no climax, no "they are coming for HOLLOW". §4.12.
4. **The objectives have no consequence.** A holder colours a marker (§4.11). Nothing in the war gets
   better for holding RIDGE or worse for losing GAP, so nothing is worth defending and the marker is a
   label on a lane. §3 (supply), §4.12.

And what the **player** sees is under-specified: the §0 rows keep the war from looking dumb; they do not
make it look like war. §0.2 is the client's list. Tanks that fire on men and men that hurt tanks are ruled in (§4.4, §11.7); the
air is a called arm (§12.3); what only the owner can rule - bombs on the truck, a winner, item 2 - is in §15.

Rows for the four points, same probe conditions, plus the moved-tape probe named in §4.13:

| The player sees | The rule that makes it | Probe passes when |
|---|---|---|
| **Every round is a different war** | seeded tape §4.13 | the seam z at x = 0, -54 and 54 differs between any two of seeds 1-5 by >= 10 m at at least one of the three |
| **The market moves the front, and the armies follow** | live tape §4.13 | with the tape stepped +20 m at tick 1800 (the moved-tape probe): every living tank on the line is within 10 m of its new post by tick 2100 and every man on the line within 10 m of his by tick 2400; nobody's slot, team, objective lane or claim order changes |
| **An assault is declared, then it happens** | tempo §4.12 | within 600 ticks of an assault's start the attacking side's mean push on the assaulted lane is >= 8 m higher than at the start, on >= 80% of assaults |
| **The front moves visibly** | assault ceiling §4.12 | on every seed at least one forward hull stands >= 16 m across the seam (push >= 32) at some tick |
| **Lulls exist** | assault clock §4.12 | on 25% to 60% of ticks no assault is running on either side; no assault starts inside 20 s of the previous one on the same side |
| **Assaults can fail and can win** | §4.12 | over 5 seeds, between 30% and 70% of assaults end with the objective's holder flipped to the attacker |
| **Losses bite** | supply §3 | on ticks where one side holds more objectives than the other, that side has more living tanks on >= 55% of them; a side down to 2 objectives lost never falls below 4 tanks on more than 8% of ticks (the floor row above stays) |

### 0.2 What the client must draw and play (client tests; the core gives every word)

The core hands the client, every tick: posts, postures, claims, the three objectives and their holders,
each side's assault and its phase, every shot, every wreck. If the client does not show them, the war
the owner ordered is in the state and not on the screen. Each is a client test.

- **Wrecks stay.** A dead tank is drawn as a hulk where it died until its id respawns (§3, §11.3): men
  lie behind it. A dead tank that vanishes leaves men lying behind nothing.
- **Men are drawn down.** PRONE and COVER (§11.4) are two poses, not one; a pinned team (§11.5) is visibly
  flat, and a crawl is a crawl.
- **Every shot is seen.** Muzzle flash and a tracer for every tank round and every rifle round, a
  different tracer for a suppressing round (§11.5); a shell's fall is a burst on the ground where the
  core says it landed.
- **The three names are on the map.** RIDGE, HOLLOW, GAP at the core's points, in the holder's colour,
  grey when unheld, readable from the cab at 100 m (§4.11).
- **An assault is announced.** On the tick the core's assault word is set: a banner - `BEARS ASSAULT
  HOLLOW` - and a sound; on the flip, `HOLLOW TAKEN`; on the end without a flip, `ASSAULT ON HOLLOW
  FAILS`. Nothing else in the HUD may be louder than this while it runs (§4.12).
- **The front is a line the player can see** - the seam drawn on the ground, and when the tape moves
  it, the line moves and the armies drive after it (§4.13). That is the market on the ground and it is
  the picture the game is named for.
- **The front is drawn as a chart: candles and the line (the owner 2026-09-16 19:50, RULED HERE on the
  form).** The tape (§4.13) is a price series and the seam is its 21-sample box average - an **SMA(21)**.
  So the client draws what a trader already knows: **candlesticks** on the ground for the raw tape and
  the seam as the moving-average line the armies fight on. A candle is 4 samples (20 s at the 5 s
  cadence): 16 candles across the 260 m map, each 16.5 m wide, body from open-z to close-z, wick from
  low to high, green when close > open (a rising price - the bulls' ground) and red when it fell (the
  bears'). The newest candle, at the miner's end, is **forming**: it grows as samples arrive, and the
  whole chart scrolls 4.13 m toward the post office per sample. From above - map, minimap, gunship - it
  reads as a TradingView chart with two armies on it; from the cab the ground under the truck is a red
  or a green band and the line ahead is the front. **Decoration, not geometry**: candles are decals or
  light on the ground and change nothing in the core - no collision, no cover, no hull-down, no rule
  reads a candle. The bucket size is the client's (a 3- or 6-sample candle is the same tape); the core
  hands the client the 64 samples and nothing else. Client test: the candles' open, high, low, close
  equal the tape's per bucket, and the drawn line equals `seam(x)` within 0.5 m at every metre.
- **Sound carries and lags.** A gun 100 m off is heard 0.3 s late and quieter; a bomb is felt in the cab.
- **The air is announced and answered.** Rotor 3 s before entry, the call's banner with its lane, the
  run-in along that lane, smoke on a driven-off gunship (§12.3).
- WASTED as §6.

---

# Part A - Armour

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
  **RULED (the owner 2026-09-16): no fire before roll-out.** The kill zone is the road, not the loading bay. No gun
  chooses the truck - not the tank's no-enemy rule above, not the truck outranking a picked enemy, not a
  rifle - until the truck has **rolled out**: its best x reached (`S_BESTX`) is at least 22 m (`APRON_RADIUS`)
  past its start. It latches: backing into the bay after roll-out does not make it safe again. A truck idling on
  the ramp takes no hit and is never wrecked by fire (measured: 8 seeds, 60 s idle in the bay, 0 hits, 0 wrecks).
  The outer slots are **not** moved away from the bay to hide this. After roll-out the truck-fire rule stands.
- **A bomb hits the truck (the owner 2026-09-16 19:40: yes; GAP).** A truck inside 16 m of a blast (§12.3)
  takes `shell x (1 - d/16)`, `shell` the courier damage of a hit at the truck's heat (`shellForHeat`,
  the 5 to 11 band at heat 0), **no draw** (the band's midpoint, so the stream does not shift), after
  roll-out only (a truck idling in the bay is never wrecked by anything, above). A wreck takes nothing.
  The gunship still never aims at, follows or avoids the truck: the bomb was going there anyway.
- Otherwise **ignore** the truck.
- **No truck is an objective (the owner 2026-09-16 19:05).** One war carries many trucks and ghosts; a war
  that moved toward a truck would move toward one player. So no objective (§4.11) is placed, weighted,
  held or re-read from a truck - not its position, its crossing of the seam, its route, its load. The
  guns answer a truck that comes near (above); the war's movement ignores every truck.
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
- **Supply (RULED HERE, 2026-09-16 19:20, GAP): the objectives feed the clock.** The `deficit` scaling
  above is what makes the war homeostatic (§0.1): the more a side loses, the faster it is whole again,
  and no swing survives ten seconds. It stays (KEEP, C#), but it is multiplied by **supply**:
  `held - lost` over the three objectives (§4.11), -3 to +3, read at the clock's own tick from the
  holder words. The wait is `wait x 4 / (4 + supply)`: holding all three against none, 4/7 of the wait
  (a tank every 3.4 s at deficit 1); holding none against three, 4/1 - four times the wait (24 s). Both
  armour and rifle clocks. The floor of §0 ("never below 4 tanks on more than 5% of ticks") stands and
  is measured with this on: if the floor fails, the divisor is retuned, not the rule.
- So losing an objective is felt: the side that lost GAP replaces its dead more slowly along the whole
  front, and the side that took it is fuller. That is what makes an objective worth defending and an
  assault worth mounting (§4.12), and it is bounded - nothing runs away, because a holder is re-read
  every 5 s and the fuller side's tanks are what flip it back.
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

- **Fires:** on the tick a tank of the team **fires the gun** (hit or miss, at a tank or the truck; not
  the coax, §4.4), after the
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
- **Toward the objective** (§4.11, GAP): a team that has an objective and is **not** on its lane takes the
  side nearer the lane instead of the hashed side, if that slot is free; otherwise the rule above as
  written. A team **on** its objective lane scoots as written: teams rotate through the lane, and the one
  next to it moves in behind. The objective is a place fought over, not a parking lot, and the
  shoot-and-scoot row of §0 holds for it too.
- The scoot is written on the shooter's tick; the partner reads the new slot on its own step of the same
  tick if its index is higher, else the next tick. One tick of skew, protocol.

### 4.4 Fire

- Gun 46 m, reload 1.4 to 3.2 s, hit 55%, damage 11 to 24 against 60 to 100 HP (the C# 6 to 10 at x10).
  Target: the nearest living enemy tank inside 46 m; the truck outranks it per §1.2.
- **OVERWATCH fires** in every tick its reload is 0 and it has a target, standing or moving.
- **BOUNDING fires only standing:** a bounding tank whose position changed by more than 0.02 m (x + z,
  `1310` Q16.16) in the tick does not fire in that tick. Its reload still counts down.
- Drawn in index order, always: a tank that fires earlier changes what the ones after it see.
- **Coax (the owner 2026-09-16 19:25: yes; GAP).** A tank with **no** enemy tank inside 46 m and **no**
  truck it may fire on (§1.2: inside its heat-widened 34 m reach and rolled out) fires its **coaxial
  machine gun** on its normal reload at the nearest living enemy **man** inside **30 m**. Priority is
  fixed: enemy tank, then the truck, then a man - the main gun never waits for the coax. Same three
  draws in the same order as a shot at a tank - hit, damage, reload - so the stream keeps its shape;
  the damage draw is taken and discarded, a coax hit kills the man (10 HP). Hit by the man's posture
  (§11.4): **STAND 40%, PRONE 20%, COVER 10%** (400 / 200 / 100 per mil). The burst is a round aimed at
  him: +60 to his fire team's suppression word (§11.5). OVERWATCH and BOUNDING rules above apply to the
  coax as to the gun (a bounding tank fires it only standing). A coax burst does **not** trigger the
  scoot (§4.3): the scoot answers the main gun's flash, and a tank facing infantry only would otherwise
  scoot every 10 s for the rest of the round. No tank moves for a man (§8.3, §12.2 stand): the coax is
  the only thing a tank does about infantry, and it is what the infantry hides from.

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

### 4.10 The front moves - pressure (the owner 2026-09-16: DYNAMIC WAR)

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
  not all step together. `w` is the team's objective weight (§4.11): 2 on an objective's lane, 1 next
  to it, 0 elsewhere.
  - `own + w >= foe + 2` → `push += 8`, up to **24** (the forward hull 8 m across the seam, the overwatch
    hull 6 m short of it), on an objective's lane up to that objective's **goal** (§4.11), and in an
    assault lane up to the assault's **ceiling** (§4.12). Taking ground.
  - `foe >= own + 2 + w` → `push -= 8`, down to **-8** (forward line 24 m, overwatch 38 m). Giving ground.
  - otherwise `push` steps one 8 m **toward its rest**: 0, or +8 on an objective's lane (§4.11). The line
    drifts home when nobody has the upper hand - and home, at an objective, is leaning in.
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

### 4.11 Objectives - what the assault goes for (the owner 2026-09-16 19:02-19:05)

the owner: *"an assault visibly goes for something. Not a seam with no reason."* Three named objectives on
the seam band, **exactly three**, hashed from the round seed and the ground the seed made, so every signer
node holds the same three. Not the truck's crossing: the owner overruled that at 19:05 (§1.2) - the war has
many trucks and ghosts and must never move toward one. So all three are **ground**, and ground is a pure
function of the seed (`groundFromSeed`). **GAP**, all of it, and **RULED HERE** where he gave no number.

- **Where they can be.** On the five inner slot lanes, `slot = 1..5` (x = -54, -27, 0, 27, 54). The outer
  lanes (±81) are levelled apron (`LEVEL_X` 86 m) and one of them holds the bay: nothing is fought for
  there. Each objective is a **lane** and a **point** on it, `(slot x, seam(slot x))`, read at init; the
  point rides the seam's curve like every post, so it moves when the tape moves and the lane does not.
- **Reading the ground**, per lane, over the seam band: the 21 samples `z = -40 .. +40 m` in 4 m steps at
  the lane's x, `heightAtWorld` of the round's ground (the relief, craters excluded - a crater is not
  there at init and an objective does not move for one). Per lane: `top` = the highest, `bottom` = the
  lowest, `relief = top - bottom`.
- **The three, in this order, each the best of the lanes still free**, where "free" is: not taken, and
  not next to a taken lane while a lane at least two away is still free (so the three do not sit on
  three neighbouring lanes and leave half the front without a reason):
  1. **RIDGE** - the lane with the highest `top`. The crest: the hull-down gun over it (§4.1) sees the
     most of the seam. Ties → the lower slot number.
  2. **HOLLOW** - the lane with the lowest `bottom`. The dip: the ground that hides an assault going
     across, and the one a crater usually deepens. Ties → the lower slot number.
  3. **GAP** - the lane with the smallest `relief`. The flat: the fastest way across for anything on
     tracks or wheels. the owner's name for it was ROAD; there is no drawn road in the core (§4.1) and the
     truck's route is not an input, so GAP is the driveable stretch the ground itself offers.
  Measured on seeds 1-5 (working tree, 2026-09-16), lane = slot, x in metres:

  | seed | RIDGE | HOLLOW | GAP |
  |---|---|---|---|
  | 1 | 3 (x 0, top 6.23 m) | 1 (x -54, bottom 1.91 m) | 5 (x 54, relief 2.41 m) |
  | 2 | 2 (x -27, top 6.09 m) | 4 (x 27, bottom 1.92 m) | 1 (x -54, relief 1.62 m) |
  | 3 | 4 (x 27, top 6.31 m) | 1 (x -54, bottom 2.03 m) | 5 (x 54, relief 1.47 m) |
  | 4 | 5 (x 54, top 5.58 m) | 1 (x -54, bottom 1.21 m) | 3 (x 0, relief 1.59 m) |
  | 5 | 2 (x -27, top 5.98 m) | 4 (x 27, bottom 1.59 m) | 3 (x 0, relief 2.76 m) |

  Five seeds, five different triples, three lanes apart or more on every one of them. Without the
  "not next to a taken lane" clause seeds 1 and 2 put two of the three on neighbouring lanes.
- **State:** three words in `O_TACTICS` (`TAC_OBJ`, one per objective: lane in the low byte, holder in the
  next: 0 none, 1 bull, 2 bear). Written at init and by the holder re-read; read by `pressure`, `scoot`
  and the client. No draw.
- **Weight `w`** (read by §4.10): a team is **on** an objective when its slot is the objective's lane
  (`w = 2`), **next to** one when its slot is the lane ±1 (`w = 1`), else `w = 0`. A team next to two
  objectives is still `w = 1`. So the odds are weighted toward the objectives, as the owner ordered, without
  a tank ever leaving its lane for one: the line is still §2.4, the scoot still 27 m (§4.3, "toward the
  objective"). What changes is **who pushes and how far**.
- **Rest** (read by §4.10): a team on an objective's lane drifts to `push = +8` when nobody has the upper
  hand, not to 0. Its forward hull leans in 8 m short of the seam. Nowhere else.
- **Goal** (read by §4.10): the push ceiling on an objective's lane is 24 (the general one) for HOLLOW and
  GAP, and **16** for RIDGE - a team on the crest holds the crest, it does not roll down the far side of
  it. Off an objective's lane the ceiling is 24 as before.
- **Holder**, re-read every 5 s (300 ticks) on the tick hashed from `(seed, objective)`: the side with
  more living tanks inside 46 m of the point holds it; equal counts (0-0 included) leave the holder as it
  was. Rifles do not count (§12.2). The holder is what the client colours the marker with; it changes
  nothing in the odds - the odds already see the tanks that took it. It is **information for the
  player**, and the player must see it: the client draws the three names at the three points, in the
  holder's colour, grey when nobody holds. That is a client row in §0.
- **Nothing here reads a truck** (§1.2). A probe that drives the truck through RIDGE must find the same
  three words as one that leaves it in the bay.
- Why three and not one: with one objective every push would go to one lane and the rest of the front
  would be the static line the owner refused (§0). With three at least two lanes apart, both sides have
  something to take at both ends and the middle, the independent slot orders (§2.4) put different teams
  on them, and the §0 rows "an assault goes for something", "every objective is fought over" and
  "objectives change hands" are what a run must show.

### 4.12 Tempo - the assault (RULED HERE, 2026-09-16 19:20, for §0.1 points 2-4)

§4.10 breathes; it never charges. An assault is a **declared** attempt by one side on one objective it
does not hold, with a start, a length, an end and a result the player is told. It is the war's tempo:
between assaults there is a lull, the line breathes as §4.10, and men crawl into holes. **GAP**.

- **Assault clock**, per side: the next assault starts `2700 + (h % 2700)` ticks (45 to 90 s) after the
  last one ended, `h = mix(mix(hash, sideConst), n)` for the side's n-th assault; the first at
  `1200 + (h % 1200)` (20 to 40 s) from init, so the two sides never start together and the first minute
  has a lull, a build-up and an attack in it.
- **Target**: of the objectives the side does **not** hold at the start tick, the one hashed from
  `(seed, side, n)`. A side that holds all three mounts none: its clock re-arms 20 s and it defends. Both
  sides may assault at once, on different objectives or on the same one (then it is a meeting battle on
  one lane, and that is fine).
- **Length**: 1800 ticks (30 s), or until the holder (§4.11) flips to the attacker - **success** - after
  which 900 ticks (15 s) of **consolidation**; or the 30 s run out - **failure** - and the clock re-arms.
- **What it does**, for the attacking side while it runs:
  - the objective's lane and both neighbouring lanes are the **assault lanes**: `w = 3` on the lane,
    `w = 2` beside it (§4.10, §4.11), the rest is `+16` on the lane, and the push **ceiling is 40**
    (forward hull 24 m across the seam, overwatch 10 m across) on the lane and 32 beside it - RIDGE
    included (a crest is taken by going over it; the 16 cap of §4.11 is for holding it, and returns at
    consolidation). At 8 m per 5 s a team on the lane goes from rest to ceiling in 15 s: the player sees
    it build.
  - the infantry in the assault lanes has its lead clamp raised from 8 m to **24 m** across the seam
    (§12.1) and its fire teams are pinned at **240** instead of 120 (§11.5): under fire they still rush;
    only a burst stops them. Men go with the tanks.
  - the start tick **calls a CAS sortie** (§12.3): a gunship for the objective's lane, bombs on its point,
    ahead of the side's own men.
  - a team **not** in an assault lane changes nothing: the rest of the front holds as §4.10, which is
    what keeps an assault from being a whole-line stampede (item 2, not done).
- **Consolidation** (after success): the lane's rest is 16 (the forward hull on the seam), ceiling back to
  §4.11's, `w` back to §4.11's. The men dig in: claims re-read with the lane's new craters and wrecks.
- **The defender** gets no weight: its advantage is that it was there first, hull-down, with supply (§3)
  if it holds more. A defence that holds is the attacker's odds never reaching `own + w >= foe + 2` on
  the lane, and that happens - §0.1 "Assaults can fail and can win" says how often it must.
- **State**: per side `TAC_ASSAULT` (3 words: objective id + phase in one, start tick, next tick).
  Written by the assault clock at the top of `pressure`; read by `pressure`, the infantry clamp, the
  sortie aim and the client. No draw, no truck (§1.2): an assault never targets, waits for or avoids a
  truck, and the truck driving through an assault lane is shot at as §1.2 and otherwise ignored.
- **Why this and not a smarter general**: a general that read the whole board would be one rule that
  moved everything, and it would move it the same way every time. The assault clock is dumb on purpose:
  hashed side, hashed target, fixed length. What makes it look decided is that the objective is named,
  the build-up is visible, and the outcome is not known in advance - the odds on that lane decide it.

### 4.13 The market is the general - the tape moves the front (GAP, 2026-09-16 19:20)

The seam is the price tape laid across the map (`rules/frontline.js`): the oldest sample at -x, the
newest at +x, z is the price against the window's midpoint, box-averaged over 21 samples so a man can
walk to it. Every post in this file - slot, line, objective point, man's post, cover eligibility - is
measured from `seam(x)`. So the tape is the general: when the price moves, the whole front moves, both
sides drive, and the player sees the market on the ground. **That is the picture the game is named
for, and the core does not draw it yet:**

- **Measured on the branch:** `tape()` in `sim.js` is 64 samples from `i` alone, no seed, written at
  init and never again. The seam is the same curve on every seed and moves 0 m in a round.
- **Rule 1 - seeded (GAP).** The init tape is `mix(seedHash, 0x7e5a1c3d + i)` per sample, walked as
  today (the step's shape stays), so every round has its own front. §0.1 row "Every round is a
  different war".
- **Rule 2 - live (GAP, protocol).** The host feeds the newest price each time it has one; the core
  shifts the tape one sample (oldest out at -x, newest in at +x) on the tick the sample arrives, as
  `PriceHistory` did. A sample is protocol input, hashed like a load: every node gets the same sample on
  the same tick or the transcript replays differently. **No move rule reads the tape's future**; the
  armies read `seam(x)` on the tick, as they do now.
- **Sample cadence (RULED HERE): one sample per 5 s (300 ticks).** A sample shifts the whole tape one
  slot toward -x, 4.13 m of map (260 m / 63), so the front's shape **scrolls** left at 0.83 m/s and the
  newest price enters at the miner's end. That is inside a man's 2.8 m/s and a tank's 6.8; at one sample
  a second the scroll would be 4.13 m/s and the men could never close on the line. 64 samples at 5 s is
  5 min 20 s of price on the ground. A new sample can also move the window's low or high, and then the
  whole curve rescales in one tick - that is the market re-drawing the front, and it is allowed: the
  filter's 1.42 m/m limit is on the shape, not on how fast the shape changes.
- **The armies follow at walk speed**, nothing more: a moved seam moves the posts (every rule already
  reads the seam per tick), a tank drives at 6.8 m/s and a man at 2.8 m/s to its new post, in its lane,
  with its roles, slots, objectives and claims unchanged. A 20 m step is 3 s of driving and 7 s of
  walking, a line visibly advancing. **The moved-tape probe** (§0.1): seed 1, the truck in its bay, the
  tape stepped so that `seam(0)` moves +20 m at tick 1800, and nothing else.
- **What must not happen:** the seam jumping faster than 1.42 m per m of x (the filter's own limit, so
  a man can walk to it), objective lanes changing (they are lanes, the point rides the seam), a cover
  claim dropping because the post moved (a claim is re-read on eligibility each tick, so a place more
  than 12 m from the **new** post is dropped and the man walks - that is correct and is what "the men
  follow" looks like).
- Rising market: the bulls' seam runs +z, the whole bull line advances and the bear line gives ground,
  across the lanes, with the objectives and their holders riding along. Falling market, the reverse.
  Nothing in §4.10-§4.12 needs to know: they are all relative to `seam(x)`.
- **The price is the only winner (the owner 2026-09-16 19:40).** There is no front winner, no round score
  for the war, no side that "won": it is bears against bulls and the game runs no simulation of its own
  - the Bitcoin price decides, and the game depends on it. The objectives, the assaults and the holders
  (§4.11-§4.12) are the **local** fight about a line the market draws; the market moves the line, the
  armies fight where it is. Nothing may compute a winner from the war; the seam's position is the score,
  and it is the price.

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

**Coax**
The tank's machine gun: nearest enemy man inside 30 m when there is no tank and no truck to shoot.
Kills; pins; never moves the tank; never scoots it.

**Widow**
The living tank of a pair whose partner is dead. A singleton until the id respawns.

**Lane**
The x band of a team's slot, 27 m wide, centred on the slot. A team never crosses another's.

**Objective**
One of three named lanes and points on the seam - RIDGE (highest crest), HOLLOW (lowest dip), GAP
(flattest stretch) - from the seed's ground, never from a truck. Weights the push of the teams on and
beside it (§4.11). Has a holder the player sees.

**Holder**
The side with more living tanks inside 46 m of an objective's point at its last re-read. Colours the
marker; moves nothing.

**Assault**
A side's declared 30 s attempt on one objective it does not hold: weight 3 on the lane, ceiling 40,
men and the next bomb with it. Ends in success (holder flips; 15 s consolidation) or failure (§4.12).

**Lull**
Ticks on which neither side assaults. The line breathes as §4.10; men crawl into holes.

**Supply**
`held - lost` over the objectives; divides a side's replacement wait (§3). Losing ground is felt as
fewer tanks.

**Tape / front**
The price series across the map; `seam(x)` is read from it every tick. Seeded per round, moved by the
market during it; every post in this file is relative to it (§4.13).

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

## 7. Tests that must fail if this is wrong (armour)

Each test names the section it guards. All run on the core alone, seeds fixed, no client. The infantry's
tests are §14.

- Two living tanks of a side hold the same slot at any tick (§2.4, §4.3).
- A widow bounds, or holds nearer than the overwatch line (§3).
- A respawn changes any index's team or member, or restarts another team's role clock (§3).
- A respawn is not BOUNDING on its first leg, or its partner is (§3).
- A tank's post differs between a run with the truck parked and one with the truck driven through the
  line, seed equal (§1.2: no rule reads the truck).
- Touch truck-tank in a live scored run does not set RUN_WRECKED on that tick (§1.2).
- Touch in practice sets RUN_WRECKED (§1.2).
- A tank with the truck inside 34 m and no enemy tank in range never fires on the truck after roll-out (§1.2 GAP).
- Any gun hits a truck that has not rolled out; over 8 seeds x 60 s idle in the bay any hit or wreck (§1.2 ruling).
- A blast inside 16 m of a rolled-out truck leaves its HP unchanged, or takes a draw, or touches a truck
  in the bay or a wreck; a gunship's call, lane, aim or release reads the truck (§1.2, §12.3).
- Any word computes a winner, a front score or a "side ahead" from the war (§4.13).
- A bounding tank fires in a tick it moved, gun or coax (§4.4).
- A coax burst with an enemy tank inside 46 m or a fireable truck in reach; at a man beyond 30 m; at
  the truck; with other than the three draws of a gun shot; a coax hit that leaves a man alive; a coax
  burst that triggers a scoot; a coax hit on a roll of 400 or more at STAND, 200 at PRONE, 100 at COVER
  (§4.4).
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
- Two seeds give the same three objectives, or one seed gives different objectives on two nodes, or an
  objective is on an outer lane (±81), or two objectives share a lane (§4.11).
- Two objectives sit on neighbouring lanes while a lane two or more away was free (§4.11).
- Any objective word - lane, point, holder - differs between the truck parked and the truck driven
  through RIDGE, seed equal (§1.2, §4.11).
- A team on RIDGE's lane has `push > 16`; a team on an objective's lane rests at 0, or a team off one
  rests at 8 (§4.11).
- A team's `w` is other than 2 on an objective's lane, 1 beside it, 0 elsewhere (§4.11).
- The holder changes on a tick that is not that objective's re-read tick, or changes on equal counts
  (§4.11).
- A side's assault starts while it holds all three objectives, targets one it holds, runs past 1800
  ticks without a flip, or starts inside 2700 ticks of its last one's end (§4.12).
- A team outside the assault lanes has `w`, rest or ceiling other than §4.10-§4.11's during an assault;
  a team on the assaulted lane has `push > 40` (§4.12).
- The assault word, target or phase differs between the truck parked and the truck driven through the
  assaulted lane, seed equal (§1.2, §4.12).
- The replacement wait ignores supply, or supply reads anything but the three holder words (§3).
- Two seeds give the same tape; the tape changes on a tick with no sample; a sample changes anything
  but the tape (§4.13).
- In the moved-tape probe any slot, team, objective lane or claim order changes (§4.13).
- A §0 or §0.1 probe row fails.
- A §0.2 row is not drawn (client test).
- WASTED skipped, lobby first (§6; client test).

---

# Part B - Infantry

The soldiers were not in TANK_TACTICS.md. the owner 2026-09-16: *"Also make a concept for the soldiers."*
What the core does today for a rifleman is the C# `Army.StepInfantry` port, and it stays where this part
does not say otherwise: those lines are marked **KEEP**. What is new is marked **RULED HERE** and is
built the same way as part A: integer hashes of (seed, roster id, tick), no draw, no truck, so the stream
does not shift and every signer node computes the same bits.

## 8. Three relations of a rifleman

### 8.1 Man vs man

- No spacing rule, no push, no collision between men (KEEP: C# `Separate` runs on armour pairs only).
  Men may stand close; a fire team is 4 men inside 18 m of each other (§9.2).
- Rifle: 26 m, reload 2.5 to 4.5 s, look again after 0.4 to 1.1 s when nobody is in range, hit **4.5%**,
  one round kills a man (10 HP at scale, damage 10). Target: the nearest living enemy **rifleman** inside
  26 m. The **rifle** never fires at a tank (KEEP); the AT man's launcher does (§11.7).
- No crowded, no overrun, no fall-back (KEEP: `StepInfantry` has none).

### 8.2 Man vs truck (the truck exception, infantry form)

- **No movement rule reads the truck.** A man does not dodge, scatter or flee from it (KEEP: `ClearPath`'s
  corridor branch never ran in the game and is not ported).
- **Shoot** the truck: only once he has a rifle target, and only when the truck is inside 26 m
  (`+0.8 x heat`) and nearer than that target (`outranks` up to `2.5 x heat` nearer). A round at the truck
  is 1.5 to 3.5 (KEEP). A man with nobody in 26 m looks again after 0.4 to 1.1 s and fires at nothing -
  **not** at the truck. **RULED HERE:** that stays for the rifle (the tank's GAP in §1.2 is the tank's:
  a rifle that fired at every passing truck would put 246 rounds into a parked one, measured).
- **Run over:** a man inside 3.6 m of the truck's centre while the truck moves at >= 2.5 m/s (its own
  core velocity, never `T_WHEEL`) dies that tick. Below 2.5 m/s nothing happens (KEEP).
- **Cleared:** a living man inside 1.6 m of a truck that is not a wreck is pushed out to 1.6 m (KEEP).
  A wreck clears nobody and runs nobody down.
- A man never wrecks the truck: touch man-truck is not touch tank-truck (§1.2).

### 8.3 Man vs tank (RULED HERE)

- **Hull clearance:** a living man inside 3.0 m of a living tank's centre - either side - is pushed out to
  3.0 m along the line between them; the tank does not move. Today there is no such rule (**GAP**):
  measured before, men stood inside hulls. A man does not stop a tank and the tank does not kill him;
  he steps aside.
- A man **is** a tank's target - of its coax only, inside 30 m, when it has no tank and no truck to
  fire on (§4.4; the owner 2026-09-16 19:25 overruled the KEEP). A tank is the AT man's target (§11.7).
  A rifleman's rifle and a tank's gun still never meet.
- A man is never crowded by a tank and a tank never gives ground to a man (KEEP).

## 9. Organisation (bit-identical on every node)

### 9.1 Roster

- 36 riflemen a side: every index with `index & 3 != 0`, side on bit 2. A rifle index is
  `8k + 4s + j` with `k = 0..11`, `s` the side bit and `j = 1..3`; the dense roster number is
  `r = 3k + j - 1`, 0..35 within the side in index order. (Corrected 2026-09-16: the earlier
  `((index >> 3) << 2 | (index & 3)) - 1` left gaps and made twelve teams of three.)
  Same integer shifts as the armour, no table.

### 9.2 Squads and fire teams

- **Squads:** three a side, `k = 0..2`, each with a drawn, drifting **anchor** x (KEEP, protocol: the
  anchor is `Rand(-80, 80)` at init and walks `sin(t x 0.12 + k x 2.4) x 3.6 m/s`, clamped to ±80 m).
  A man's squad is **drawn at spawn** (`nextBelow(3)`, KEEP: protocol) and lives in his `U_TARGET`.
- **Fire teams (RULED HERE):** four men. A fire team is `f = r >> 2` (nine a side), stable for the
  round like a tank pair. It is **not** the squad: the squad says where a man's post is, the fire team
  says **when he moves**. Two men of a fire team can be in different squads; that is fine - the rush
  clock is what they share, and what the player reads as a group is men running and stopping together.
  (Making the squad stable too would move a spawn draw, which is protocol. Not done.)
- **A fire team takes its post from its first man's squad.** RULED (the owner 2026-09-16): every man of fire team
  `f` stands on the anchor of the squad drawn for the team's first roster number (`r = 4f`), not his own - so
  the four stand together (row B1). No draw moves: the squad is still drawn at spawn and kept in `U_TARGET`; only
  which man's squad the post reads changes.
- **Post:** `x = anchor + hash(index) in [-9, +9]`, `z = seam(x) - side x (4 + hash(index) in [0, 8])
  + hash(index) in [-5, +5]` (KEEP). So 4 to 12 m short of the seam, ±5 m of depth scatter, ±9 m about
  the anchor. A man walks to his post and stands there.

### 9.3 Pace and gait

- Walk 2.788 m/s x pace, pace `0.82..1.18` hashed from the index (KEEP). x and z on separate controllers,
  each clamped to its own walk (KEEP).

## 10. Death and respawn

- Death: rifle round (§8.1, at the posture's threshold §11.4), run over (§8.2), bomb (16 m blast, both
  sides, KEEP; 8 m against a man in COVER, §11.4), crater fallout is the truck's only.
- A dead man frees his cover place that tick (§11.3). A dead tank is a wreck and a place for men until
  it respawns (§3, §11.3).
- Replacement clock: Army.InfantryReinforceSeconds, **2.5 s** at deficit 1, `deficit` times faster,
  lowest dead rifle index of the side first (KEEP).
- A replacement spawns at the back edge (`z = ±(76..79) m`), at his squad's post x (his squad drawn at
  that spawn), and **walks in** at 2.8 m/s: 60 to 70 m, about 25 s. Visible columns walking to the
  line are the doctrine, not a fault (KEEP).
- Fire team membership never changes: `f` is the roster number's. A replacement rejoins its fire team's
  rush clock at the current leg (§11.2).

## 11. When which tactic

### 11.1 Default hold - the line

- **Fires:** whenever a man is on post and his fire team's clock says halt, or he has nowhere to go.
- Holds his post (§9.2) - or his cover place, if he has a claim (§11.3) - facing the enemy side, **down**
  (§11.4), fires per §8.1. The ±5 m depth scatter is the "ragged line": men do not stand on a fence, and
  they do not stand at all when they are not running.

### 11.2 Fire and movement - rush and halt by fire team (RULED HERE)

- Today each man has his own halt clock hashed from his index: rests of 3 to 11 s (the first 2 to 9 s)
  and halts of 0.4 to 1.8 s, re-hashed per cycle (KEEP the numbers). **Changed:** the clock is hashed from
  the **fire team** `(seed, side, f, cycle)`, not the man, so four men rest and halt together. Same cost,
  no draw.
- While halted a man stands (step 0 in x and z) and fires. While resting (moving) he walks to his post;
  once on it he stands until the post moves (drift, push §12.1) and fires.
- **Bounding:** neighbouring fire teams `f` and `f + 1` of a side never halt in the same tick: the
  odd teams' clock runs **half a rest (210 ticks, 3.5 s) behind**, and a team whose lower neighbour
  `f - 1` halts in this tick does not halt in it. **RULED HERE**, so that of any two neighbouring teams
  one is covering while the other runs. The clock key is `mix(seedHash, 500 + 16 x sideBit + f)`, the
  cycle's rest and halt hashed from `(key, cycle)` exactly as the per-man clock was.
- A moving man **fires** (KEEP: C# fires on the move; a 4.5% rifle on the move is what it is). A halted
  man is not more accurate than that - but he is **harder to hit**, because he is down (§11.4), and a
  team under fire does not rush (§11.5). (The earlier "no suppression, no prone. None exists." is
  OVERRULED, the owner 2026-09-16 19:02.)

### 11.3 Cover - wrecks and craters (the owner 2026-09-16 19:02; OVERRULES the earlier §11.3)

the owner: *"they must not stay cannon fodder. They take cover, go prone, suppress, use wrecks and craters.
Real infantry hides."* The earlier ruling here - no prone, no crater cover, a man pushed out of a crater -
was made because the core had none of it. It is **OVERRULED**: this section and the two after it are in
the spec and go in the core. **GAP**, all of it. Deterministic like everything else: a cover place is a
function of the state, a claim is a function of the seed and the unit id, no draw, no truck.

- **A wreck** is a dead armour index (§3). Its hull words keep the place it died until the id respawns,
  and that hull, either side's, is the wreck. It is a **place for men only**: no rule in part A reads it
  (item 2 of the owner's list, not done). It is gone the tick the id respawns (§3).
- **A crater** (`O_CRATERS`, radius `C_R` > 0, 16 to 40 m) is cover from the tick its bowl opens (dig
  tick). The `AvoidWrecks` push that moved a man out of a crater **no longer applies to a man**; it still
  applies to a tank (3.2 m). Fallout is the truck's only (§10) and stays so: a man lies in a crater unhurt.
- **Cover places**, each 0.5 m wide, on the man's **own side** (the side he belongs to, `U_SIDE`, never the
  side he stands on):
  - a wreck has **2** places: `(wreck x ± 2 m, wreck z + side x 3.6 m)` - behind the hull, 0.6 m clear of
    its 3 m circle;
  - a crater has **4** places, on the rim 1 m inside it: `centre + (R - 1 m) x (sin a, side x cos a)` for
    `a = -50°, -20°, +20°, +50°` from the seam normal, so the four lie on the near lip with the rifle over
    the far edge. Integers: `sin/cos` of those four angles are four constants in Q16.16.
- **Eligible** for a man: a place within **12 m** of his post (§9.2, §12.1 - his post, not his position,
  so a man does not wander to cover), inside his clamp (`[seam - side x 40, seam + side x 8]`), and not
  inside 3 m of a **living** tank's centre (§8.3). A place further than 12 m from his post is not his:
  the line stays a line, with men in the holes it has.
- **Claims** (the owner: *"nearest cover slot from seed + unit id"*): per side, per tick, the living men are
  visited in the order of `mix(seedHash, 600 + index)` ascending (a fixed order for the round, hashed
  from seed and unit id, not the index order, so the same eight men do not always get the holes), and
  each takes the **nearest** free eligible place; ties by the place's own order (wrecks by index, then
  craters by slot, then place number). A man with none is **in the open**. A dead man's claim is free
  the tick he dies; a wreck's places are free the tick it respawns; a crater's the tick it expires. A
  man keeps his claim while it stays eligible and free, so a claim does not flicker: the visit is
  "keep it if you have it, else take the nearest", and a man who keeps one is skipped by the others.
- **On his place** a man **walks** to it (his own gait, §9.3) when his fire team's clock says rush, and
  is COVER (§11.4) once within 0.5 m. It is his post while he holds the claim: the line's post (§9.2) is
  where he stands when he has no hole.
- State: one word per rifle index, `TAC_COVER` (72 words, appended to `O_TACTICS`; no offset above
  moves): the claimed place id, or NONE. Written by the claim pass at the top of the infantry step,
  after the armour's separation pass and before any man moves.

### 11.4 Posture - stand, prone, cover (RULED HERE, from the owner's order)

- Three postures, derived, not chosen, and written for the renderer into the `TAC_COVER` word's high
  bits each tick (the client draws the man down or up from it, §0 "Men hide"):
  - **STAND**: the man stepped this tick - his own step over **0.01 m** (x + z), so a crawl (§11.5) is
    not a step - a rush leg, a walk to his post or his place, a column walking in. Running men run
    upright.
  - **COVER**: within 0.5 m of his claimed place, not stepping.
  - **PRONE**: everything else that did not step - a halt on the line in the open, a man on post with no
    hole, a man waiting on a post that has not moved. A halt is a firing halt, and it is fired from the
    ground. the owner: *"Prone when in the open under fire"* - and under fire is where the line is, so a
    halted man in the open is prone whether a round has reached his team yet or not. Pinned men (§11.5)
    add the crawl.
- **What it is worth** - the rifle's hit roll (§8.1) is one draw, `< 45` per mil; the threshold is what
  changes, the draw count never does, so the stream keeps its shape:
  - at a STAND man: **45** per mil (4.5%, KEEP);
  - at a PRONE man: **22** per mil (half);
  - at a COVER man: **11** per mil (a quarter).
  - A bomb (16 m, §12.3) reaches a COVER man only inside **8 m** of the blast; a PRONE or STAND man at 16 m
    as before. A wreck or a crater lip is what a bomb's splinters stop; the open is not.
  - A tank's gun never fires at a man (§8.3 KEEP); nothing to halve there.
- A man's own fire does not change with posture (KEEP: the rifle is 4.5% standing, walking or down).
  What posture buys him is time alive, and time alive is rounds fired.
- Posture never reads the truck: a man does not go prone for a truck, and run-over (§8.2) kills a
  prone man as it kills a standing one.

### 11.5 Suppression - fire pins men down (RULED HERE, from the owner's order)

- **Suppression word** `TAC_SUPP`, one per fire team (18 words, appended): **+60 per round aimed at one
  of the team's living men** (a rifle round, hit or miss; a coax burst, §4.4; a suppressing round,
  below), **-1 per tick**,
  clamped to `[0, 600]`. Integers, written on the shooter's tick, read at the top of the next.
  - **Under fire**: `TAC_SUPP > 0` (a round in the last second or so, decaying).
  - **Pinned**: `TAC_SUPP >= 120` (two rounds inside three seconds, or one heavy burst).
- **A pinned fire team does not rush.** Its clock (§11.2) keeps ticking, but a rest leg moves nobody;
  the four stay down where they are and fire. A man in the open **crawls** instead: toward his claimed
  place if he has one, else toward his post, at **0.5 m/s** (0.0083 m/tick, one sixth of a walk) - so a
  pinned man is never STAND (§11.4: he is PRONE or COVER while he crawls; a crawl is under the 0.01 m
  probe threshold and does not count as a step). A pinned man **fires at half rate**: his reload draw is
  taken as always and its value doubled.
- Being pinned ends by decay: no round for 2 s (120 ticks) and the team is under fire but free to rush;
  no round for 10 s and it is clear. The bounding rule of §11.2 still holds for a pinned team's
  neighbour: it may halt when the pinned team's clock says halt, and it rushes when its own clock says
  rush - the pinned team is the one covering, from the ground.
- **Suppressing fire**: a man with **no** rifle target inside 26 m (§8.1) but a living enemy **man**
  inside **34 m** fires a **suppressing round** at the nearest such man: it takes the look-again draw
  (0.4 to 1.1 s, KEEP) and no other, never hits, kills nobody, and adds 60 to that man's fire team's
  `TAC_SUPP`. A man with nobody inside 34 m looks again and fires at nothing, as today. A suppressing
  round is **never** fired at a truck (§8.2 stands: the rifle fires at a truck only with a rifle target
  in 26 m, and only after roll-out, §1.2). The stream shifts only where a man suppresses, by the same
  look-again draw he took before - the round is what changed, not the draw.
- **A shell** (§4.4) that lands - hit or miss - inside 8 m of a man adds 60 to his team's word too; a
  tank's fire pins infantry, which is what infantry hides from. A bomb blast (§12.3) adds 300 to every
  team with a living man inside 16 m of it: after a bomb, everybody is down.
- No morale (§12.3 stays): a team pinned to two men is still a team, still fires, still rushes when the
  word decays. Suppression is time, not fear.

### 11.6 Fire

- §8.1 and §8.2, hit thresholds per §11.4, suppressing rounds per §11.5. Drawn in index order after the
  armour's shots of the same tick (KEEP: protocol).

### 11.7 The AT man - men hurt tanks (the owner 2026-09-16 19:25: yes; GAP)

- Man `j = 3` of every fire team - roster `r` with `r & 3 == 3`, nine a side, fixed for the round like
  the team itself - carries an **AT launcher** beside his rifle. He is the **AT man**. Replacement of
  that id is an AT man too (§10: the role is the roster number's).
- **Fires:** when the launcher is loaded, he is **PRONE or COVER** (§11.4: he did not step this tick;
  a crawl is not a step) and a living enemy **tank** is inside **30 m**: at the nearest one, in that tick,
  instead of his rifle. His rifle's clock (§8.1) is not touched by a launcher shot and the rifle is what
  he fires on every other tick it allows. Pinned (§11.5): half rate, like the rifle.
- **Round:** hit **25%** (250 per mil), damage **20 to 35** against 60 to 100 HP (three to five hits kill;
  a tank that pushes into a lane alone and stays there dies), reload **8 to 12 s** (480 + draw below
  240 ticks). Three draws in the same order as a tank's shot - hit, damage, reload - taken from the
  round's RNG in index order with the rifles' shots (§11.6). A hit's damage is a shell's for the
  crater/heat rules: none (it is a tank being hit, not the truck).
- **Never at the truck** (RULED HERE): §8.2 stands as written for the rifle and the launcher fires at
  tanks only. A 25% rocket of 20 to 35 against a 100 HP truck would end most runs that pass an AT man
  at 30 m; not measured, because it is not allowed. the owner can overrule.
- Never at a man, never at a wreck (§11.3: a dead index is not a target). At an enemy **gunship** inside
  30 m when no enemy tank is inside 30 m: 15%, one hit drives it off (§12.3).
- **State:** `TAC_AT`, one word per AT man (18 words, appended): the tick the launcher is loaded again,
  0 at spawn (loaded). No offset above moves.
- **What it is for:** with the coax (§4.4) the two arms now fear each other. A tank kills men in the
  open, so men hide (§11.3-§11.5); hidden men kill tanks that come close alone, so tanks bound in pairs
  with one covering (§2.6) and an assault (§4.12) is a thing that can be stopped by the men in the
  holes. That is combined arms, and the player sees both halves of it from the cab.

### 11.8 Forbidden

- Scattering from the truck. Going prone for the truck. Charging a tank. Using a **living** tank as cover
  (§8.3; a wreck is another thing, §11.3). Smoke. Morale, routing, a man who runs from the line. Men
  walking through a tank's hull. A tank, a gun or the truck reading a wreck (item 2, not done).

## 12. Combined arms - infantry follows the armour (RULED HERE, for "DYNAMIC WAR")

### 12.1 The push moves the men

- A squad's men stand in the lanes of the tank teams whose slots are within 18 m of the squad's anchor
  x (0, 1 or 2 teams). Their standoff is shifted by the **mean push** of those teams (§4.10), rounded to
  8 m steps toward 0: post `z = seam(x) - side x (4 + hash - meanPush) + scatter`. No team in reach →
  push 0, the line as today.
- So an assault reads as an assault: the bounding tank crosses the seam, the overwatch tank covers, and
  the fire teams in that lane rush forward behind it in the next legs; a team giving ground takes its
  men back with it.
- A man's post is clamped to `[seam - side x 40, seam + side x 8]`: infantry never leads the armour
  across the seam by more than 8 m and never sits more than 40 m behind it. In an **assault lane** of
  his own side (§4.12) the lead is **24 m**: the men go across with the tanks.

### 12.2 Infantry does not move the armour

- No **movement** rule in §4 reads a rifleman; the coax (§4.4) is a gun, not a step. Local odds (§4.10),
  holders (§4.11) and assaults (§4.12) count tanks only. A lane full of AT men (§11.7) is not seen by
  the armour's rules - it is felt in the losses, and bounding overwatch is the answer the doctrine
  already gives.

### 12.3 The air arm - called, not weather (the owner 2026-09-16 19:30: "the helicopters must act
tactically and be part of the whole concept"; RULED HERE, GAP)

**What the core does today** (`rules/air.js`, its own header): both sortie clocks start at zero, a
gunship launches every 17 s x [0.7, 1.4) per side, enters at ±104 m, flies straight across the map at
20 m/s along the seam on its own side (26 ± 9 m off it, 19 m up), drops on a timer (1.5 to 4 s, then
every 1.6 to 3.2 s) while |x| < 92, aims each bomb's z at the densest enemy clump near where it is
already going, and leaves at |x| > 104. Measured: a gunship is airborne 69 to 93% of the round, two are
up at once on every seed, 26 to 42% of the bombs land on nobody, bombs kill 60 to 76 men a round and 11
to 29 of them are the bomber's own side. Nothing calls a sortie, nothing stops one, nothing on the
ground can touch one, and the first sortie of every round bombs an empty seam. The file's own word for
it is "weather". Weather is not tactical. This section makes the air a **third arm** of the same war:
it comes when the war needs it, goes where the attack goes, spares its own men, and can be driven off
by the men in the holes.

- **Bombs** (KEEP): 16 m, every man inside dies whatever his side (8 m against COVER, §11.4), armour takes
  `120 x (1 - d/16)`, every team inside 16 m is pinned +300 (§11.5). The blast is not what changes; the
  **when, where and whether** are.
- **A sortie is called, never clocked** (the standing clock is gone; both `O_AIR` words become
  cool-downs). Three calls, per side, each writing `TAC_AIR` (3 words a side: kind, lane, tick):
  1. **CAS** - the tick a side's assault starts (§4.12): a gunship for the objective's lane. The bomb
     goes where the attack goes.
  2. **COUNTER** - the tick an objective's holder flips **against** a side (§4.11): a gunship for the
     lost lane, launched 300 ticks (5 s) later. Losing ground calls the air; the player sees the answer
     come.
  3. **INTERDICTION** - in a lull (no assault by this side, no call pending) 1800 + (h % 1800) ticks
     (30 to 60 s) after the side's last sortie ended, `h = mix(mix(hash, sideConst), 900 + n)`: a
     gunship for the lane of the objective the side does **not** hold with the most enemy tanks inside
     46 m (ties → the lower objective number). Not the densest clump anywhere: the lane the war is
     about.
  **One gunship per side aloft** (was two); a call while one is up is queued (one deep, newest wins)
  and launches the tick the aloft one is gone. **Cool-down 900 ticks (15 s)** per side between launches,
  calls included. No launch before a call: the first sortie of the round is the first CAS, COUNTER or
  interdiction, not tick 1 (the recording's wasted first sortie is **not** copied; `csharp-gunships.json`
  is re-pinned for the new launch rule, and that is a deliberate departure from the vectors, said here).
- **The run-in is along the lane** (RULED HERE): the gunship enters at the corridor end drawn as today
  (the `dir` draw stays, protocol) and flies the seam as today, but its **drop window** is the called
  lane ±27 m in x (one lane either side), not |x| < 92. Inside the window it drops on its timer as
  today, aimed at: CAS - the objective's point; COUNTER - the densest enemy clump within 27 m of the
  lane's x (the `aimPoint` scan, windowed); interdiction - the same, windowed. Outside the window it
  holds its bombs. So a sortie is three to four bombs on one lane, 60 m apart at most, and the player
  who watches the banner (§0.2) knows where they will fall.
- **Own troops** (RULED HERE): a bomb is **not released** if a living man or tank of the gunship's own
  side is inside 16 m of the aim point (landing x, aim z) at the release tick; the drop timer is re-armed
  (its draw taken, so the stream keeps its shape) and the next window is tried. Measured before: 11 to
  29 of a side's own men a round died under its own bombs; the §0 row below caps it at 10% of a side's
  bomb kills. A CAS gunship over an assault lane full of its own men therefore drops **ahead** of them -
  on the objective's far side - or not at all, which is what close air support is.
- **Driven off** (RULED HERE, from the owner's "2. yes" §11.7): the AT man's launcher fires at an enemy
  gunship inside **30 m** horizontally when **no** enemy tank is inside 30 m (tank first, always), from
  PRONE or COVER, same three draws, hit **15%**; a hit sets the gunship to **LEAVING** (`H_STATE = 2`):
  it drops nothing more, flies out on its track at 20 m/s and is gone at |x| > 104, and the side's
  cool-down starts from the hit tick. No wreck, no debris, no second hit: one rocket is enough to send
  a gunship home, and the sky over a lane full of hidden infantry is not the bomber's. Nothing else
  touches a gunship: no rifle, no coax, no gun.
- **A gunship reads no truck** (§1.2): not for the call, the lane, the aim, the own-troops check or the
  release. A truck under a bomb is a truck under a bomb: it takes the blast per §1.2 (the owner 19:40:
  yes), after roll-out; today `detonate` reads units only (GAP).
- **What the player sees** (§0.2): the rotor is heard 3 s before the gunship enters the corridor; the
  banner names the call (`BEAR CAS - HOLLOW`, `BULL COUNTER - RIDGE`); the run-in is along the named
  lane; a driven-off gunship trails smoke and climbs out; a held bomb is a gunship that crosses its own
  men and does not drop. A sortie is again "an event you look up for" - the sentence the C# claimed and
  the recording measured false.
- State: `TAC_AIR` 6 words (3 a side) appended; `H_STATE` gains value 2 (LEAVING); `O_AIR`'s two words
  are cool-down ticks. No offset above moves.

## 13. Vocabulary (infantry, all required)

**Squad**
12 men on one drawn, drifting anchor. Says where a man's post is.

**AT man**
Man 3 of a fire team (`r & 3 == 3`); carries the launcher: 30 m, 25%, 20 to 35, 8 to 12 s, fired only
from the ground at a tank. Never at the truck.

**Fire team**
4 men by sorted roster id. Says when a man moves. Stable for the round.

**Rush**
The resting leg of the fire team's clock: the four walk to their posts.

**Halt**
The halted leg: the four stand and fire. 0.4 to 1.8 s.

**Fire and movement**
Neighbouring fire teams alternate rush and halt; one covers, one runs.

**Line**
A side's men on post: 4 to 12 m short of the seam, ±5 m ragged.

**Column**
Replacements walking in from the back edge to the line.

**Follow the push**
A squad's line moves with the push of the tank lanes it stands in (§12.1).

**Sortie / call**
A gunship launched for a reason: CAS (an assault's lane), COUNTER (a lost objective's lane, 5 s later),
INTERDICTION (in a lull, the contested objective). One aloft per side, 15 s between (§12.3).

**Driven off**
A gunship hit by an AT rocket: LEAVING, no more bombs, out on its track.

**Hull clearance**
3 m about any living tank; a man steps out of it.

**Wreck**
A dead armour index, where it died, until it respawns. Two cover places for men behind it; nothing for
a tank.

**Cover place**
A 0.5 m spot behind a wreck (2) or on a crater's near lip (4), on the man's own side. Claimed by the
nearest eligible man in seed-hashed order (§11.3).

**Posture**
STAND (stepping), PRONE (halted in the open), COVER (halted on a place). Derived every tick; the
renderer draws it; the rifle's hit threshold reads it (§11.4).

**Under fire / pinned**
A fire team's suppression word above 0 / at 120 or more. Pinned: no rush, crawl, half rate of fire
(§11.5).

**Suppressing fire**
A round at a man 26 to 34 m off: never hits, pins his team.

**Crawl**
0.5 m/s toward cover or post while pinned; not a step.

## 14. Tests that must fail if this is wrong (infantry)

- A man's post differs between a run with the truck parked and one with it driven through the line, seed
  equal (§8.2).
- A man inside 3.6 m of a truck at 2.5 m/s or more survives the tick; a man inside 3.6 m of a wreck or of
  a truck at 2.4 m/s dies of it (§8.2).
- A living man ends a tick inside 3.0 m of a living tank's centre (§8.3, GAP today).
- A fire team's four men have different halt clocks (§11.2).
- Two neighbouring fire teams (same side, posts overlapping in x) are both halted off post in the same
  tick (§11.2).
- A squad's line does not move with the push of the tank teams in its lane within 10 s (§12.1).
- A man's post leads the seam by more than 8 m or trails it by more than 40 m (§12.1).
- The armour's local odds count a rifleman (§12.2).
- Any infantry tactics value is computed from a draw of the round's RNG (§9: the stream must be
  identical with tactics on and off, spawn draws included).
- Two living men hold the same cover place, or a man holds a place more than 12 m from his post, or a
  place on the enemy's side of a wreck or crater, or one inside 3 m of a living tank (§11.3).
- A wreck's places survive the tick its id respawns; a crater's the tick it expires; a dead man's claim
  survives his death tick (§11.3).
- A man is pushed out of a crater by the `AvoidWrecks` rule, or a tank is not (§11.3).
- A man's claim, posture or suppression word differs between the truck parked and the truck driven
  through the line, seed equal (§8.2, §11.3-§11.5).
- A man who stepped is PRONE or COVER, or a man who did not step is STAND (§11.4).
- The rifle's hit roll is taken a different number of times, or a shot at a PRONE man connects on a roll
  of 22 or more, or at a COVER man on 11 or more, or at a STAND man misses on a roll under 45 (§11.4).
- A bomb kills a COVER man 8 m or more from the blast (§11.4).
- A suppression word rises by other than 60 per round (300 per bomb), falls by other than 1 per tick, or
  leaves [0, 600] (§11.5).
- A pinned fire team's man steps more than 0.01 m in a tick, or is STAND, or reloads in less than twice
  his drawn reload (§11.5).
- A man fires a suppressing round with a rifle target inside 26 m, at a man beyond 34 m, at a truck, or
  with any draw but the look-again draw; or a suppressing round changes a man's HP (§11.5).
- A man's own hit chance changes with his posture (§11.4 KEEP).
- A man in an assault lane of his side leads the seam by more than 24 m, or a man elsewhere by more than
  8 m; a fire team in an assault lane of its side is pinned below 240, or one elsewhere at or above 120
  is not (§4.12, §11.5, §12.1).
- A side's CAS bomb aims anywhere but the objective's point; any bomb is released outside the called
  lane ±27 m, or with an own living unit inside 16 m of its aim point; a gunship launches without a call
  or inside 900 ticks of the side's last launch, or two of a side are aloft; a LEAVING gunship drops;
  a launcher fires at a gunship with an enemy tank inside 30 m, or beyond 30 m, or a hit does not set
  LEAVING; any air word differs with the truck parked and driven, seed equal (§12.3).
- A launcher fired by a man with `r & 3 != 3`, or while STAND, or at a tank beyond 30 m, at a truck, a
  man or a wreck; a reload outside 480 to 719 ticks; a hit on a roll of 250 or more; damage outside 20
  to 35; a launcher shot that moves the man's rifle clock; a launcher fired in a tick the rifle also
  fired (§11.7).
- A §0 infantry row fails.

## 15. Parked rulings - the owner's, not mine (2026-09-16 19:20)

Each one breaks a KEEP or decides what the game is; each has my recommendation so the ruling is one
word.

1. **Tanks fire on men.** RULED yes (the owner 2026-09-16 19:25) → §4.4 coax, §8.3.
2. **Men hurt tanks.** RULED yes (the owner 2026-09-16 19:25) → §11.7 AT man, §8.1. Open inside it: the
   launcher at the truck - RULED HERE never; one word from the owner changes it.
3. **Bombs on the truck.** RULED yes (the owner 2026-09-16 19:40) → §1.2, §12.3.
4. **A winner.** RULED **no** (the owner 2026-09-16 19:40): *"it is bears against bulls and we start no
   simulation of our own. The Bitcoin price decides, and we depend on it."* → §4.13. No front winner,
   ever; the recommendation was wrong on the game's own terms.
5. **Item 2 of the 19:02 list** - wrecks as cover for tanks, side pressure, whole-line retreat - stays
   parked as the owner ordered. With §4.12 in, a whole-line retreat is not needed for movement; side
   pressure would be a second general fighting the assault clock. **Recommend: leave out.**

Implement part A in `packages/core/src/rules/tactics.js` and part B beside it; the army step moves what
they hand out.
