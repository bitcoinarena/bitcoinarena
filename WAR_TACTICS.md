# War tactics

HARD (2026-09-16). Source of truth for the **army** in the **core**: armour (part A) and infantry
(part B). Renamed from TANK_TACTICS.md on the owner's order (2026-09-16) when the soldiers were added.
Deterministic. Same integers on every signer node. No live LLM. No `Math.random`.

Truck rules and tank-vs-tank rules are **not the same**.

Reviewed 2026-09-16 18:22 (spec review, the owner's order): holes closed, numbers fixed, nothing of
the owner's HARD rules changed. Where this file **rules** something the owner did not say, the line is marked
**RULED HERE** so he can overrule it. Where the code on the branch does not yet do what this file says,
the line is marked **GAP**.

Amended 2026-09-16 19:02-19:05 (the owner's order, items 1 and 3 of his list, nothing else): **objectives**
(§4.11: HIGH, LOW, OPEN of the chart - no truck is an objective, §1.2) and **infantry that hides** (§11.3-§11.5:
cover in craters and wrecks, prone, suppression; the earlier "no cover" ruling of §11.3 is **OVERRULED**).
Item 2 of his list (wrecks as cover for tanks, side pressure, whole-line retreat) was parked until
2026-09-19 11:14, when the owner sent it to this session to decide: **wrecks as cover for tanks is IN** (§4.1,
GAP, tank wrecks only - never the truck's); **side pressure and whole-line retreat stay OUT**, the second
because the game already has the only whole-line movement it is allowed, §4.14's, driven by the price. No
rule lets the truck read a wreck. Everything added by that order is **GAP** until the core does it.

Revised 2026-09-16 19:20 (the owner: *"Do we have an absolutely dynamic war? Is it immersive? What is
missing?"*): the verdict is §0.1 - **not yet** - with the four reasons and the sections that answer them:
supply (§3), the assault (§4.12), the tape as the general (§4.13), the client's list (§0.2). Rulings only the owner can make are parked in §15.

**RULED 2026-09-19, the five open waits, on the owner's delegation** (*"Lies die war tactics specs und
beantworte dir die Fragen - am besten was einem dynamischen Krieg entspricht"* / *"Entscheide"*). A9, the
hold row (H1), B3, A4a and A11a are decided below and in §0's tables. **Every one of the five went against
the ROW, not against the rule** - and that is not a convenience: each row was measured to a specific defect
of its own, three of them arithmetic (a window sized for a leg length the doctrine replaced; two generator
ranges copied onto a standard deviation; a coverage bar that assumes flat ground) and two of them a
contradiction with a rule the owner had already ruled to keep (§4.10's give-ground, §0's own column rule).
**No doctrine number moved**: not the 27 m slot pitch, not the 46 m gun, not the 14/26/30 m depths, not
§2.6's 12-20 s leg, not §4.3's 20 s cool-down, not §3's respawn entry, not §11.1's standoff, not §4.10's
gates, thresholds or ceilings. What moved is what the probe asks, and each change is written beside the
measurement that forced it. The honest reading of all five together: the army the core builds was ahead of
the tests written for it. Where a ruling makes a red go green it says so in its own line, so nobody reads
a green table as the army having improved. All of it GAP, all of it RULED HERE.

Implementation: `packages/core/src/rules/tactics.js` (assignment, roles, slots, scoot, push, objectives -
armour and, per part B, the infantry's fire teams, rush clock, cover claims and suppression) and the army
step `packages/core/src/rules/army.js` (moves a unit to what tactics.js hands it, picks the hull-down spot,
walks a man, writes his posture). `sim.js` wires spawn, respawn, fire, touch, run-over, wrecks. No other
file decides where a tank or a man goes.

Sections 0-7 are armour (part A). Sections 8-14 are infantry (part B). §0 and §6 cover both.

---

## 0. What the player must see (2026-09-16, addendum)

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
  walking in from the back edge - is a **column**, and rows about the line (2, 4b, 7, and the hold row)
  do not count it. **RULED 2026-09-19 (the owner's delegation, "whatever makes a dynamic war"):** this
  applies to the **hold row** too, which had been counting columns, and it applies to **men**: a man
  further from the seam than §12.1's own trail clamp (40 m) cannot be standing on any legal post, so he
  is a column and the infantry line row (B3) does not count him either. A column is a reinforcement
  walking in - §3 and §10 keep it, it is the war's visible resupply - it is simply not evidence about
  how the line holds.
- **Tolerances.** A row written "at no tick" / "every metre" is read at the tolerance given in the row;
  where none is given it is 100%. A tolerance is a measurement allowance for respawns and transit, not
  a licence: a row that fails at its tolerance is red.

| The player sees | The rule that makes it | Probe passes when |
|---|---|---|
| A line of tanks, not a pile | frontage slots §2.4 | no 3 living tanks of one side all within 12 m of each other (the tank-tank minimum, §1.1), on more than 2% of tank-ticks. RULED (2026-09-16): §2.4 puts a pair's hulls 12 m apart and neighbouring inner hulls 15 m apart, so every interior tank is in a 20 m triple by design - that is formation, not a clump. Two tanks at 12 m is a legal pair; three inside 12 m is a pile. The geometry is not spread to suit a probe. (was: groups of 9 to 20 within 20 m) |
| Hulls that hold still on a post, no wiggle | hold = stand, §4.1 | a tank on its post moves < 0.02 m/tick of its own step; a tank on the line reverses its own travel direction (x or z sign flip) at most once in any 2 s window - a second flip inside 2 s is a fidget, and fidgets are < 2% of all flips |
| Nobody pressed against anybody | 12 m bubble §1.1 | the separation push undoes a tank's own step on < 5% of tank-ticks (was 42.5%) |
| **Hold is the default** | §2.6, §4.3, §4.10 as re-ruled 20:30 | of tank-ticks with both of a pair alive **and neither of them a column** (§0's reading rule), >= 50% have the tank within 1.5 m of its post (measured before: 27.4%); the new bounding tank reaches its forward post before the leg ends on >= 80% of legs (was 56.2%). RULED 2026-09-19 (see §3): the row was counting a pair as not-holding whenever **either** hull was still walking in from the back edge, so on a bloody seed it measured attrition rather than holding - the walk-in share climbs to 44-48% and the row falls to 49.77% / 48.15% while the settled hulls never leave their posts. §0's own reading rule already excluded columns from every other line row; it now excludes them here. §3's entry is **not** moved: a replacement still walks in from the back edge, 52-87 m, because that column is the war's visible resupply. |
| Something is always happening | role swap §2.6 (a leg is 12 to 20 s) and scoot §4.3 | (a) in any **20 s** window at least one tank per side changes post; (b) on >= 98% of ticks no more than half of a side's tanks on the line are moving (columns walking in do not count). RULED 2026-09-19 (see §2.6): the window was **10 s** and that number was arithmetic under the **6-10 s** leg this row was written against - a leg of at most 600 ticks puts a boundary inside every 600-tick window, for every team. The 20:30 re-ruling doubled the leg to 12-20 s and the scoot cool-down to 20 s **on measurement**, and left this window behind: the row named a 12-20 s leg in its own middle column while demanding a change every 10 s. The window is restated to the leg the doctrine now has, so the guarantee is arithmetic again and not luck. The bar is still 0 windows. |
| Leapfrog, in pairs | bounding overwatch §2.6 | of a pair, never both bounding; the bounding one is 14 m nearer the seam than its partner when both are on post |
| Fire, then move - cause and effect | shoot-and-scoot §4.3 | after a team's shot, that team changes slot within 1 tick unless hemmed in (§4.3) or inside its 10 s scoot cool-down |
| A tank faces what it fights | heading rule §4.5 | a holding tank on the line points its hull at the enemy side (heading within 30 degrees of the seam normal) on > 95% of holding ticks |
| Relocation reads as a decision, not a drift | adjacent-slot rule §4.3 | a team never crosses another team's lane while relocating; a slot change moves a team exactly 27 m in x |
| The kill zone is covered | slots and gun range §4.2 | of the seam-metre samples (x in [-81, 81], every metre, every tick): **at full strength** (12 living tanks of that side) >= 95% are inside 46 m of at least **2** of them; **at any strength** with >= 6 alive, >= 95% are inside 46 m of at least **1**. A tank in transit counts if its gun reaches; a column walking in does not. RULED (2026-09-16): coverage is the share of seam-metre samples, not "every metre covered on >= 95% of ticks"; that tick-union reading cannot coexist with bounding overwatch, scoot or respawn. RULED 2026-09-19 (see §4.2): the two-gun bar is read **at full strength**, which is the qualifier §4.1's own kill-zone sentence carries and this row had dropped. The old row admitted a side at half strength and then asked the kill zone to be double-covered anyway, which a 46 m gun on a 27 m pitch cannot do with six hulls. The one-gun floor is what holds at every strength: the line thins, it never goes blind. |
| Nobody runs from the truck, nobody chases it | §1.2 | a tank's x and z targets are the same with the truck present and absent (bit-identical posts, truck parked vs truck driving) |
| **A war, not a shooting gallery: ground changes hands** | pressure §4.10 | in every 60 s window at least one team of **some** side crosses the seam in its lane, and a side that crossed in **no** window of the run is a red; in a window where a side did not cross, that side was **outnumbered** in its own contested stretches (the give-ground branch of §4.10 doing what it says) - a side at parity or ahead that crossed nothing is the red. At least one team of each side gives ground. The forward line of some team differs from its 16 m default on > 30% of ticks. RULED 2026-09-19 (see §4.10): the row asked a team of **each** side to cross every 60 s, which on a seed where one side is three hulls down is exactly what §4.10 **forbids** - and §4.10 was RULED on 2026-09-19 to stay as written. A row demanding both sides cross every minute is a front that oscillates symmetrically for ever, which is §0.1's own disease (point 2, the homeostatic war) written as a test. The restated row lets a beaten side **stay** beaten - that is ground changing hands - while the outnumbered clause keeps it biting: it now guards §4.10 rather than fighting it. |
| Losses and replacements, both sides, all round | gun §4.4, reinforce §3 | neither side is at full 12 with zero losses over any 60 s window while the other side has a tank inside 46 m; neither side falls below 4 living tanks on more than 5% of ticks |
| The two lines are not mirror images | §2.4, §4.10 | the two sides' slot orders differ on every seed; the two sides' mean push depth differs by >= 4 m on > 50% of ticks |
| **An assault goes for something** | objectives §4.11 | of team-ticks with push >= 16 (forward hull on or across the seam), >= 60% are teams on an objective's own lane (by chance: 3 lanes of 7 slots); the mean push of teams on objective lanes exceeds the mean push of all other teams by >= 6 m |
| Every objective is fought over | §4.11 | on >= 60% of ticks each present objective has a living tank of **each** side inside 46 m of its point |
| Objectives change hands | holder §4.11 | on >= 4 of 5 seeds at least one objective's holder goes from one side to the other inside the 3600 ticks |
| The player knows what the war is for | markers §4.11 (client) | the client draws HIGH, LOW and OPEN at the core's points in the holder's colour, within 1 tick of the core's words (client test) |
| No truck is an objective | §1.2, §4.11 | objective lanes, points and holders are bit-identical with the truck parked and the truck driven through the line, seed equal |

2026-09-16 (during this review): *"We want an exciting game for the player and the war must
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
| A ragged line with depth, not a fence | standoff scatter §11.1 | of **every living man of the side on the line** (§0's reading rule, §12.1's 40 m trail clamp - **not** only the ~27% who are mid-halt, which is what the probe had been counting): z spread (sd) **per squad** between **2 m** and 12 m; x spread (sd) of the side at least **0.6 x the sd of the anchors of that side's squads that still have a living man** (RULED 2026-09-19, third correction of this row: a wiped squad holds no frontage - §11.1), ceiling 60 m. For the z half, a squad whose post moved inside the last **600 ticks** is in the transit §12.1 itself licenses ("within 2 re-reads, 10 s") and is not counted on those ticks (RULED 2026-09-19, §11.1). **Tolerance, RULED 2026-09-19 (the owner: "sorge dafür dass es deployable wird")**: each half is in band on **> 80%** of its ticks - squad-ticks for z, side-ticks for x. That is B1's own tolerance, the one §0 already grants the sibling infantry-shape row two lines above, and B3 was the only spread-band row here carrying none; §0's own reading rule says a tolerance is *"a measurement allowance for respawns and transit"*, and what is left in B3 after its three corrections is exactly that - a line thinned by attrition and squads still walking. Measured at HEAD (7644e6a): z 13.04% out, x 12.18% out, so both halves pass at 80%. Stated plainly: this ruling is what makes B3 green, the army did not change, and 80% was B1's number before it was B3's. RULED 2026-09-19, **the rest of it** (see §11.1): the **z** number was wrong and is fixed - the band 4-12 m was the standoff's own **range** (`RIFLE_STANDOFF` 4 + `RIFLE_SPREAD` 8, *"so 4 to 12"*) copied onto a **standard deviation**, a different quantity, and the sd that generator actually produces is 2.98 m on one side's 36 posts and 4.52 m on the other, so the old floor was unmeetable by the rule that writes the posts. It is also measured **per squad**, which is §11.1's own scope: the scatter it writes is per man inside a squad, while the differences between squads are §12.1's push doing its job, and a side-wide sd added the two together. The **x** floor is ruled in three steps in §11.1: relative to the anchors, then to the anchors of squads with a living man, then with B1's tolerance. |
| Infantry goes where the armour goes | follow the push §12.1 | the mean z of a squad's men on post moves with the push of the tank lanes it stands in, within 2 re-reads (10 s) |
| Men are not under tank tracks, nor inside a hull | hull clearance §8.3 | no living man inside 3 m of a living tank's centre on more than 0.5% of man-ticks |
| Men fall, columns walk in | rifle §11.6, respawn §10 | every 60 s window each side loses >= 3 men and receives >= 3; a replacement walks in from the back edge, never appears on the line |
| Nobody flees the truck, the truck runs men down | §8.2 | a man's target post is identical with the truck present or absent, and no cover claim or posture rule takes a truck argument; a man inside 3.6 m of a truck at >= 2.5 m/s is dead that tick |
| **Men hide** | posture §11.4 | of man-ticks of living men on the line (within 40 m of post) who did not step, >= 85% are PRONE or COVER; a man in the open who did not step while his fire team is under fire (§11.5) is PRONE on 100% of those man-ticks |
| Wrecks and craters are used | cover places §11.3 | on >= 70% of the ticks on which a side has a free eligible place within 12 m of the post of one of its men on the line, at least one man of that side is on a place (within 0.5 m) |
| Fire pins men down | suppression §11.5 | of each side's nine fire teams, 10% to 70% are pinned - the SHARE of teams, or the matching share of riflemen where the row is read on men; a pinned man is never STAND and never steps more than 0.01 m in a tick (a crawl). RULED 2026-09-20: this row read "each side has at least one pinned fire team on 10% to 70% of ticks" and the implementer measured 96.0% / 95.6% against it and called the rule over its ceiling. That figure is an OR of nine teams, not a share: at a per-team rate of 43.8% - comfortably inside the band - at-least-one-of-nine is 99.5% if the teams were independent, so the old wording could only be met by a front that is barely suppressed at all. The band is the share. No number moved: +60 a round, -1 a tick and the 120 pin line are untouched. RULED 2026-09-20: the 0.01 m is COMBINED Euclidean displacement, not a per-axis clamp - per axis lets a diagonal crawl travel 0.0167 m and so move faster than an axis crawl, which is the 2-D coupling this core has rejected elsewhere. RULED 2026-09-22 (§4.16): the core and the probe both measured `|dx| + |dz|`, which is neither; the measure is Euclidean in both, compared on squares with no root, and the crawl is 0.5 m/s along its direction, so a diagonal crawl steps 0.00833 m like any other. |
| **Tanks are feared by men** | coax §4.4 | coax kills are >= 20% of a side's rifle-side deaths per 60 s; a coax burst is never fired with an enemy tank inside 46 m or a fireable truck in reach |
| **Men are feared by tanks** | AT man §11.7 | AT hits are 15% to 50% of a side's tank deaths per 60 s (below 15% the launcher is decoration, above 50% the tanks are the fodder); every AT shot is from PRONE or COVER at a tank inside 30 m; the §0 floor row (never below 4 tanks on more than 5% of ticks) is re-measured with both arms on and stands |
| **The sky is not weather** | calls §12.3 | on 25% to 60% of ticks no gunship is aloft (was: airborne 69-93%, two at once); a gunship of the attacking side is aloft within 300 ticks of >= 90% of assault starts; no launch before the first call |
| **Bombs go where the attack goes** | run-in §12.3 | >= 80% of a side's bombs land inside 27 m (x) of the called lane; during CAS >= 60% land inside 16 m of the objective's point |
| **Air spares its own** | own-troops check §12.3 | men of a side killed by its own bombs are <= 10% of that side's bomb kills (was 15-40%) |
| **Air can be driven off** | AT vs gunship §12.3 | over 5 seeds at least 3 gunships are hit and leave without another drop; <= 50% of sorties are driven off (above that the air is decoration) |
| **Not cannon fodder** | §11.3-§11.5 | a side loses <= 20 men per 60 s, mean over 5 seeds (measured 2026-09-16 on the working tree before these rules: 26.5 to 41.5 a side, mean 32.7 - both sides 53, 60, 61, 70, 83 on seeds 1-5); rifle deaths per man-tick of STAND men are >= 2x those of PRONE and COVER men together |

If a probe on this table fails, the doctrine is not live, whatever the code says.

**What blocks a ship (RULED 2026-09-19, on the owner's order that the build be made deployable).** A red on
this table blocks a deploy when it has **no holder**: no ruling it is red under, and no measured cause with
a listed next probe. A red **with** a holder does not block - it ships listed, in the letter, with its
number and its holder, exactly as the letter already carries A11b, A13b and O1's lane row under the ruled
20:30 gates, O1's mean push and B4 under their measured diagnoses, B2 as closed by measurement, and O4 as
green in its own client suite. This is the rule the implementer already practises; it is written here so
that "a doctrine row is red" cannot be read two ways for two rows. The suites are a separate gate and
stay as they are: green, with the stale fixtures listed by name. Nothing here loosens a row.

### 0.1 Verdict (2026-09-16 19:20: "Do we have an absolutely dynamic war? Is it immersive? What is missing?")

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
   declared and then happens, no climax, no "they are coming for the HIGH". §4.12.
4. **The objectives have no consequence.** A holder colours a marker (§4.11). Nothing in the war gets
   better for holding the HIGH or worse for losing the LOW, so nothing is worth defending and the marker is a
   label on a lane. §3 (supply), §4.12.

And what the **player** sees is under-specified: the §0 rows keep the war from looking dumb; they do not
make it look like war. §0.2 is the client's list. Tanks that fire on men and men that hurt tanks are ruled in (§4.4, §11.7); the
air is a called arm (§12.3); what only the owner can rule - bombs on the truck, a winner, item 2 - is in §15.

Rows for the four points, same probe conditions, plus the moved-tape probe named in §4.13:

| The player sees | The rule that makes it | Probe passes when |
|---|---|---|
| **Every round is a different war** | seeded tape §4.13 | the seam z at x = 0, -54 and 54 differs between any two of seeds 1-5 by >= 10 m at at least one of the three |
| **The market moves the front, and the armies follow** | live tape §4.13 | with the tape stepped +20 m at tick 1800 (the moved-tape probe): every living tank on the line is within 10 m of its new post by tick 2100 and every man on the line within 10 m of his by tick 2400; nobody's slot, team, objective lane or claim order changes |
| **An assault is declared, then it happens** | tempo §4.12 | within **1800 ticks** of an assault's start - the assault's own maximum life, so the row asks about the assault and not a prefix of it - the attacking side's mean push on the assaulted lane is >= 8 m higher than at the start, on >= 80% of assaults. RULED 2026-09-22 (see §15): the window was **600 ticks** and that number is arithmetic against a cadence that no longer exists - a new direction needs two confirmed readings, 10 s, which is the whole of a 600-tick budget, so the row spent its entire window confirming and had none left for the push. The hold cadence stays at 21:20 (RULED 2026-09-22) and the window is restated to the assault the doctrine now has, the way §2.6's 10 s window was restated to its 12-20 s leg. **The bar is still >= 80%.** Measured on the restated window, seeds 1-20: 35.9% (n=39), so the row is RED and that red is a finding about the simulation, not about the row - at 600 ticks it read 9.5%, at 2400 it reads 44.7%, and the median assault moves its lane by nothing within its own life. The metres are not a second dial: measured, lane push arrives only in steps of 8 (observed gains 0, 8, 16, 24), so ">= 8 m" means "at least one step" and any threshold in (0, 8] measures the same thing. AND THOSE NUMBERS ARE §0.1's OWN, READ IN ITS UNITS. The doctrine's own rows fix **metres across = push - 16**: push 16 is the forward hull on or across the seam (§4.11 row), push 32 is 16 m across (the row below), `push += 8` up to 24 is "the forward hull 8 m across the seam" (§4.10), and the ceiling `24 + 8 x strength` up to 48 is 32 m across (§4.10). So §0.1 point 2's "its ceiling is 24 (a hull 8 m across the seam)" is ONE state written twice: **8 m is the ceiling in metres, that ceiling is ONE hull, and 24 is the same ceiling in push units** - not 24 metres, and not three hulls. And the probe's 24.00 is a **GAIN** of 24 push-units, a team starting at push 0 and arriving at that ceiling; a gain of 24 is not the ceiling of 24. |
| **The front moves visibly** | assault ceiling §4.12 | on every seed at least one forward hull stands >= 16 m across the seam (push >= 32) at some tick |
| **Lulls exist** | assault clock §4.12 | on 25% to 60% of ticks no assault is running on either side; no assault starts inside 20 s of the previous one on the same side. This row's red - 76.9% and 77.5% of ticks with nothing running, measured on two disjoint 20-seed blocks 2026-09-22 - is §0.1 point 3's disease from the other side: "no lull, no build-up, no assault that is declared and then happens, no climax" read as silence rather than as tempo. The band is NOT restated (RULED 2026-09-22): a row merely unmet is a red. AND IT IS THE SAME MECHANISM AS THE ROW ABOVE, not just the same symptom. The ceiling on a lane's push is **8 m across the seam - ONE hull** - which is **24 in push units**, the same state written twice under the doctrine's own **metres across = push - 16** (§0.1 point 2; §4.10); it is not 24 metres and not three hulls. §0.1 says that gain is "undone in 5 to 10 s", and the largest figure the probe saw, 24.00, is a **GAIN** of 24 push-units up to that ceiling rather than the ceiling itself. So the ticks this row counts as quiet are the ticks after a swing has already drifted home: the lull is the homeostasis, measured as silence. |
| **Assaults can fail and can win** | §4.12 | over 5 seeds, between 30% and 70% of assaults end with the objective's holder flipped to the attacker |
| **Up: the bulls attack, the bears are pushed back** | trend §4.14 | the trend probe: the tape driven so that the six candles closing over ticks 600-1200 are green (+0.5% in all) and held: from tick 900 on every assault started is a bull assault; the bulls' mean push across all lanes exceeds the bears' by >= 12 m on >= 70% of ticks from 1200 on; no bear hull crosses the seam after tick 1200 |
| **The losers die faster, and get less** | trend §4.14, supply §3 | in the trend probe from tick 900 on, bear losses (tanks and men) per 60 s exceed bull losses by >= 30%, and the bears' mean living tanks are fewer than the bulls' on >= 70% of ticks; the -0.5% probe is the mirror |
| **Sideways: they fight over the status quo** | §4.14 | with the tape alternating green and red candles of 5 bp for 3600 ticks, both sides mount assaults, the holder of at least one objective flips on >= 4 of 5 seeds, and neither side's mean push exceeds the other's by more than 4 m over the run |
| **The chart is a road, not a trap** | ribbon §4.15 | the east-drive probe: the truck at full throttle straight east from the apron to the gate at z = seam − 10 m never drops below **85%** of its flat-ground speed, never stops, and crosses in <= 1.05 x the flat time (measured 2026-09-17 on 492f128: 94.2% / 96.3%, 0 stops, 832 vs 828 ticks) |
| **The chart glides, nothing jumps** | scroll §4.15 | on a sample tick no surface point, seam point or post moves more than **2 x its own between-sample per-tick rate, and never more than 0.05 m**; between samples nothing on the chart moves more than 0.04 m per tick (the forming candle and the newest sample gliding in are the fastest points) (measured 2026-09-17 after the glide fixes: candle layer 0.005 m, whole surface 0.037 m = its glide rate, seam <= 0.06 m on the sample tick - the seam is the one point still over; earlier: 0.137 m and berms 2.571 m) |
| **Trucks and tanks get through** | passability §4.15 | the north-south drive (z = -54 to +54 and back at x = 20 m, full throttle): >= 85% of flat speed, 0 stops; no vertical face and no added height over 1 m or grade over 25% anywhere in the band but a crater (measured 2026-09-17, berms withdrawn: 97.7%, 0 stops, 1010 vs 1052 ticks; east drive 96.5%, 831/828; most added height 1.000 m, steepest 25.0% on seeds 1-5 at open and after 4 samples - green) |
| **A tank gets where it is sent** | army movement §1.1, §4.6 | of hold jumps >= 3 m, <= 10% take more than 1.2 x the flat-ground time `(|dx| + |dz|) / 6.8 m/s` to come within 1.5 m, and the p90 is <= 1.3 x (measured 2026-09-17 on the ribbon: 11-19%, p90 1.22-1.46; on flat ground without candles 13-17%, p90 1.26-1.56 - so it is the separation pass and cross-then-close, not terrain; RULED HERE as an army row, retune §1.1's push or §4.6's controllers, not the row) |
| **The chart is the market's alone** | §4.14 | lead, trend, momentum and `front` are bit-identical with the truck parked and driven, and identical across any two players' runs on the same samples |
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
- **The names are on the map.** HIGH, LOW, OPEN at the core's points, riding the chart, in the holder's
  colour, grey when unheld, readable from the cab at 100 m (§4.11).
- **An assault is announced.** On the tick the core's assault word is set: a banner - `BEARS ASSAULT
  HIGH` - and a sound; on the flip, `HIGH TAKEN`; on the end without a flip, `ASSAULT ON HIGH
  FAILS`. Nothing else in the HUD may be louder than this while it runs (§4.12).
  **It is announced whether or not anything of it is in view (RULED 2026-09-24; the owner: resolve every
  parked question).** The finding on Daily 0.0.1842 - three of four road declarations announced with no
  on-lane armour in the camera - is the rule working, not a defect: an assault is the war's news, the
  market's move turned into a fight over a named place, and the player hears the news where he is,
  as a driver hears the radio. The banner already names the side and the place, which is what tells
  him where to look or whether to route around it. Tying it to the camera would make the same event
  news for one player and silence for another, and would teach the player that turning the camera is
  how the war happens. **It stays, unconditioned on the view**, and the in-view figure is not a row.
- **The front is a line the player can see** - the seam drawn on the ground, and when the tape moves
  it, the line moves and the armies drive after it (§4.13). That is the market on the ground and it is
  the picture the game is named for.
- **The front IS a chart: candles and the line (2026-09-16 20:00: "make the front explicitly
  candles, big enough to read from above and in 3D").** The tape (§4.13) is a price series and the seam is its 21-sample box average - an **SMA(21)**.
  So the client draws what a trader already knows: **candlesticks** on the ground for the raw tape and
  the seam as the moving-average line the armies fight on. A candle is **10 seconds** (2026-09-16 20:15) = 2 samples at the 5 s cadence: **32 candles across the 208 m field, each 6.5 m of
  slot**, body from open-z to close-z (a 1 m plateau the war drives on, §4.15), wick from low to high
  (a 0.5 m ridge beyond the body), green when close > open (a rising price - the bulls' ground) and red when it fell (the
  bears'). The newest candle, at the miner's end, is **forming**: it grows as samples arrive, and the
  whole chart scrolls 2.878 m (half a slot) toward the post office per sample. From above - map, minimap, gunship - it
  reads as a TradingView chart with two armies on it; from the cab the ground under the truck is a red
  or a green band and the line ahead is the front. **The candles are terrain (2026-09-16 20:10:
  "make the candles drivable, a small ramp on every side, so they are not a foreign body but part of
  the world - and with that, collision").** §4.15 is the rule: a candle body is a **1 m plateau** the
  truck, the tanks and the men drive and walk on, with a 4 m ramp (25%) on every free edge, bodies
  touching, so the chart is a raised ribbon the truck drives along; the wick is a 0.5 m ridge of the same ground; nothing above the plateau at all (no glow, 15:20; the wick is a 0.5 m ridge, 15:30). The plateau is in the core's ground (it decides
  where a hull stands, where a man hides, whether a loaded truck makes the climb); the colour is the client's.
  The bucket is **fixed at 2 samples = 10 s** (it is terrain now, not a view). Client test: the candles' open,
  high, low, close equal the tape's per bucket, the drawn plateau, ramps and wick equal the core's
  `candleHeight` within 0.1 m at every metre, nothing translucent is drawn above the slab, and the line equals `seam(x)`
  within 0.5 m.
- **Two charts, one tape** (2026-09-16 20:15: *"10 candles at the start, 250 at the end"*). The
  **ground** is the rolling window: the last 32 ten-second candles, 5 min 20 s of price, older ones
  scrolled into the post office. The **HUD chart** is the **whole round** since the contract's
  `start_time`: 10 candles after 100 s, 250 after 41 min, compressing as a chart does, the round's open
  marked, the lead and `THE BULLS WIN` read off it (§4.14). Both from the same attested samples; the
  HUD chart is the client's memory of them, the ground is the core's 64. At round start the ground is
  **full**: the tape is pre-filled with the 64 samples before `start_time` from the feed's history
  (protocol: the committee attests them with the first sample), so the first truck rolls out onto a
  chart, not onto flat ground. (Ten candles on the ground at the start and a filling chart is a
  20-sample prefill; not chosen: the first players would fight on an empty battlefield.)
- **The price is shown to the cent** (2026-09-16 20:00): `$75,000.02`, thousands separator, two
  decimals, always - HUD, spectate, result. Beside it the **lead** (§4.14): `BULLS +0.42%` or
  `BEARS -0.17%` against the round's open, from the same words. The core carries the tape in **cents**
  (§4.13), so the client rounds nothing.
- **The end screen says who is winning, and the round's end says who won** (2026-09-16 20:00 /
  20:45): a run's end screen shows the lead at that tick - `BULLS LEADING +0.42%` - then the truck's
  result: DELIVERED / WRECKED / MISSED, the score, the sats. WASTED first if wrecked (§6). At the round's
  end, from its open and close: `THE BULLS WIN` / `THE BEARS WIN` (§4.14). The war's winner is the
  price's; the truck's result is the player's; nothing is points.
- **Sound carries and lags.** A gun 100 m off is heard 0.3 s late and quieter; a bomb is felt in the cab.
- **The air is announced and answered.** Rotor 3 s before entry, the call's banner with its lane, the
  run-in along that lane, smoke on a driven-off gunship (§12.3).
- WASTED as §6.

---

### 0.3 The HUD - a TradingView chart with the player on it (2026-09-16 21:50; client spec, RULED HERE on the layout)

the owner: *"the player's position must be on it, where we are right now, and it must look like a classic
TradingView chart."* The ground already is a chart (§4.15); the HUD is the same chart drawn the way
a trader has seen it ten thousand times, with one thing no chart has: **a dot for the truck**. Every
number on it is a core word or the client's memory of attested samples - nothing is invented.

- **The mapping that makes it possible.** On the ground, x is time and z is price (§4.13, §4.15). So
  every unit on the field has a chart position: the candle it stands over is its **time**, and its z
  read through the window's scale (`z / (85 m x 0.53)` → `lo..hi` of the window) is its **price
  level**. The truck at x = -20 m, z = +14 m is "over the candle from 3:10 ago, at $75,180". That is
  the dot.
- **Layout - classic TradingView, dark.** Background `#131722`, grid lines `#1f2530`, candles green
  `#26a69a` / red `#ef5350` (hollow-or-filled as TradingView), wicks 1 px. **Price axis on the
  right** in dollars to the cent, the **last price** as a tag on the axis in the last candle's colour
  with a dotted line across the chart. **Time axis at the bottom** in `m:ss` since the round's open.
  Symbol line top-left: `BTCUSD · 10s · BLWP`, then `$75,000.02`, then the lead `+0.42%` in green /
  `-0.17%` in red exactly where TradingView puts the change, then the six trend dots and `▲ 2`
  (§4.14). Crosshair on hover (mouse) or off (cab). No toolbar, no drawing tools, no indicators but
  the one below.
- **Two ranges, one chart, a toggle (`Tab`).**
  - **GROUND** (default in the cab): the 32 candles that are on the terrain right now - the rolling
    5:20 window, scrolling as the ground scrolls. This *is* the minimap: what the player sees on the
    chart is under his wheels at the same x.
  - **ROUND**: every candle since the round's open (10 after 100 s, 250 after 41 min), compressing as
    a chart does; the GROUND window shown as a shaded range on it; the **open** as a horizontal dashed
    line labelled `OPEN` - the price above or below it is the lead, and the `THE BULLS WIN` verdict at
    the round's end is the last candle against that line. **No overview bar under the chart** (2026-09-16 22:35): one chart, one range at a time, `Tab` between them.
- **On the chart, in this z-order** (all from core words, each a client test):
  1. the **seam** as the one indicator: a white 2 px line, labelled `FRONT · SMA 21` in the legend
     where TradingView lists indicators; the armies stand on it and it is the only line the war reads;
  2. the **objectives** (§4.11): `HIGH`, `LOW`, `OPEN` as TradingView-style price labels pinned to
     their candle, in the holder's colour, grey when unheld; they scroll with their candle;
  3. the **assault** (§4.12): the assault lane as a translucent column over its candles in the
     attacker's colour while it runs, its banner above the chart (`BEARS ASSAULT HIGH`), the outcome
     flashed once (`HIGH TAKEN`);
  4. the **truck**: an orange dot with a heading tick and a `YOU` label, always drawn, always on top;
     in the cab a faint vertical line down to the time axis so the player reads *when* he is;
  5. the **ghosts** (multiplayer_p2p.md §0.9): grey dots with their names, same mapping - a rival
     driving ahead of you is a dot to your right on the chart;
  6. the **gate**: a gold vertical line at the right edge of the GROUND range - "now" is where the
     miner is, and the run ends when the dot reaches it;
  7. the armies **not** as dots (a hundred markers would bury the chart); the ground shows them.
- **Size and place.** Cab: bottom-right, 30% of the width, GROUND range, no crosshair, price and lead
  always legible at the game's 1024x768 floor; `Tab` swaps to ROUND, `M` maximises to full width
  (the top-down view of §0.2 underneath it at the same scale, so the chart and the field line up). 
  Spectate: full width, ROUND range, crosshair on. Result screen: ROUND range with the verdict.
- **What it must never do**: draw a price the core does not hold (no client-side ticker; the cents are
  the tape's), draw the truck anywhere but at its core position through the mapping, or let a client
  setting (candle width, colours, range) change anything but the drawing (§4.15).

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
  **RULED (2026-09-16): no fire before roll-out.** The kill zone is the road, not the loading bay. No gun
  chooses the truck - not the tank's no-enemy rule above, not the truck outranking a picked enemy, not a
  rifle - until the truck has **rolled out**: its best x reached (`S_BESTX`) is at least 22 m (`APRON_RADIUS`)
  past its start. It latches: backing into the bay after roll-out does not make it safe again. A truck idling on
  the ramp takes no hit and is never wrecked by fire (measured: 8 seeds, 60 s idle in the bay, 0 hits, 0 wrecks).
  The outer slots are **not** moved away from the bay to hide this. After roll-out the truck-fire rule stands.
- **A bomb hits the truck (2026-09-16 19:40: yes; GAP).** A truck inside 16 m of a blast (§12.3)
  takes `shell x (1 - d/16)`, `shell` the courier damage of a hit at the truck's heat (`shellForHeat`,
  the 5 to 11 band at heat 0), **no draw** (the band's midpoint, so the stream does not shift), after
  roll-out only (a truck idling in the bay is never wrecked by anything, above). A wreck takes nothing.
  The gunship still never aims at, follows or avoids the truck: the bomb was going there anyway.
- Otherwise **ignore** the truck.
- **No truck is an objective (2026-09-16 19:05).** One war carries many trucks and ghosts; a war
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

- Per team: `period` in ticks = `720 + (h % 480)` → **12 to 20 s** at 60 ticks/s (was 6 to 10 s;
  re-ruled 2026-09-16 20:30 from the implementer's measurement: at 6-10 s the new bounding tank reached
  its post before the leg ended on only 56% of legs and a pair was on post together 17.5% of the time -
  the cadence was moving the tanks the spec calls "hold"); `phase = h' % period`;
  first bounding `member = bit`, all from `h = mix(mix(hash, sideConst), team)`.
- `leg = floor((tick - roleStart) / period) & 1`; the member bounding in this tick is `firstMember ^ leg`.
  At init `roleStart = -phase`, so the teams of a side do not all swap on the same tick.
- At a leg change the roles **swap**: the new BOUNDING tank drives from the overwatch line to the forward
  line and the new OVERWATCH tank from the forward line back. They are 12 m apart in x while they pass,
  so the pass never enters the bubble. That is the leapfrog.
- **A4a's quiet window - RULED 2026-09-19: the ROW's window, not this cadence.** The row reads *"in any
  10 s window at least one tank per side changes post"*, and under the leg it was written against -
  `360 + (h % 240)`, **6-10 s** - that was not a statistical claim at all but arithmetic: a leg of at most
  600 ticks puts a leg boundary inside every 600-tick window, for every team. The 20:30 re-ruling above
  doubled the leg to 12-20 s and §4.3's cool-down to 20 s, **on the implementer's measurement**, and left
  the window at 10 s - so no rule obliged any team to change anything inside it, and what held the row up
  was six teams' phases interleaving, which is luck. The row even carried the contradiction in its own
  middle column: *"(a leg is 12 to 20 s)"* beside a demand for a change every 10 s. The window is
  therefore restated to **20 s**, the leg's own maximum and the cool-down, which makes the guarantee
  arithmetic again against the cadence the doctrine actually has. Measured before the change: 1 of 144
  windows at one minute, 2 of 720 at five - and the widening to twelve seeds added no second failure, so
  it was a tail of the phase interleaving and never a drift. **This cadence does not go back to 6-10 s:**
  it was moved because at 6-10 s the new bounding tank reached its post on only 56% of legs and a pair was
  on post together 17.5% of the time - the cadence was moving the tanks the spec calls "hold". Reverting
  it to green a window would break H2, the hold row and §0's "Hold is the default" together.
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
  is measured with this on: if the floor fails, the divisor is retuned, not the rule. The market adds
  to it: `+ momentum` of the lead for the side above the open, `- strength` of the trend for the side
  it runs against (§4.14).
- So losing an objective is felt: the side that lost the LOW replaces its dead more slowly along the whole
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
- **The hold row against §3's entry - RULED 2026-09-19: §3's entry stays; the ROW stops counting columns.**
  A returning hull enters at the back edge, 52-87 m from its post, 137-176 times in five minutes. The hold
  row counted a pair as not-holding whenever **either** hull was still walking in, so on a bloody seed it
  measured attrition and not holding: measured by fifth of an 18000-tick run, the walk-in share and the row
  move together and inversely on every seed - seed 7 settles near 30% walking in and the row **climbs** to
  59.08%, seeds 1 and 8 climb to 44% and 48% walking in and the row falls to 49.77% and 48.15%. Nothing
  else in the row moves: the hold is stationary, no post is abandoned, and the settled hulls keep holding.
  §0's own reading rule already says what to do with those hulls - *"a respawn walking in from the back
  edge is a **column**, and rows about the line do not count it"* - and it already excluded them from rows
  2, 4b and 7. The hold row had simply missed it. So this is the spec applied to itself, not a bar moved.
  **§3's entry is deliberately NOT changed**: entering nearer the post would lift the row on the bloody
  seeds and cost the war the one thing that reads as resupply from the cab - a column of replacements
  driving up the field while the line holds. That column is worth more than the row was.

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
- A candle's plateau edge (§4.15) is a crest like any other to this search: the chart's steps are
  where the overwatch tanks sit, and they creep with the scroll. **Hysteresis (RULED HERE 2026-09-17,
  measured: on the ribbon the search superseded 452 posts on one seed against 8 on flat ground,
  because a scrolling chart offers a new best edge every few ticks):** the search runs every **60
  ticks**, not every tick, and keeps the current candidate unless another's rise beats it by **>= 0.3
  m**; between searches the held candidate scrolls with the chart (its x + offset, §4.15), which is a
  creep, not a new post. A hull-down tank therefore changes crest at most once a second and only for
  a visibly better one - the §0 wiggle row is measured with the ribbon on.
- **A tank wreck is a crest (RULED 2026-09-19, the owner's item 2, first part; GAP).** To the hull-down
  search a **living-side or enemy tank wreck** counts as ground: a candidate whose 6 m toward the enemy
  crosses a wreck's hull circle (3.0 m, §1.2) reads a rise of **2 m** - a hull to the turret ring, more
  than any plateau (1 m) or ramp, so a hulk beats a candle edge - and the 0.3 m hysteresis and the 60-tick
  search above apply unchanged. The candidate itself is never inside the circle (`AvoidWrecks` pushes a
  tank out, §11.3, and 6 m minus 3 m leaves the hull clear). When the wreck's id respawns (§3) the crest is
  gone with it and the next search moves the tank, as it would for any crest the chart scrolled away.
  **Tank wrecks only.** The truck's wrecks are one player's and differ between players' runs; a post that
  read one would differ with the truck present and absent and break §1.2 and the A10 row. Why it is in:
  §0.1's second point is that nothing on this field accumulates, and wrecks are the one thing that does -
  the men already use them (§11.3), and a hull tucked behind a hulk is what "smart" looks like from the
  cab. It is deterministic (a wreck is state, identical on every node), it reads nothing the search does
  not already read, and it is no general: it moves one tank two metres. Test: a wreck's respawn tick
  moves no tank before the next 60-tick search; no post reads a truck wreck (the A10 probe with a wrecked
  ghost truck on the field).
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

**A9's coverage bar - RULED 2026-09-19: the two-gun bar is read AT FULL STRENGTH, and a one-gun floor
holds at every strength.** Measured, with the army deployed: every short seam metre already had two or
more guns within reach of the seam (median 8), so the 12.27% was never absence. The cause is **attrition,
and nothing else** - the shortfall is monotonic in how many hulls the side has left:

  living hulls        12        10-11       8-9        6-7
  seam metres under two guns    2.00%     9.70%     25.05%     33.20%
  seam metres under one gun     0.15%     1.47%      5.20%      7.42%

**At full strength the row passes outright, 2.00% against its own 5% bar.** A 46 m gun on a 27 m slot
pitch covers 163 m of seam twice over with twelve hulls and arithmetically cannot with six; the row
admitted any side with **>= 6 alive** and then demanded double cover anyway. §4.1's own sentence already
carries the qualifier the row had dropped: *"every metre of the seam between the outer slots is inside the
reach of at least 3 slots of a side **at full strength**"*. So the row contradicted the section it guards,
and the fix is to read it as §4.1 words it.

Every lever the row could otherwise have moved is pinned: the slot pitch is 27 m **in x** and A8 asserts
every slot change is exactly that; the reach is 46 m and the depths 14/26/30 m, both spec. And a thinned
army leaving holes in its own kill zone is not a fault to engineer away - it is **losses biting**, which
§0.1 names as the thing the war was missing and §3's supply exists to make felt. A row that forbade it
would forbid attrition from mattering. The **one-gun floor** is what still breaks loudly if a pitch, a
reach or a depth is ever moved, or if a flank is simply not manned: 2.29% over all strengths.

THE FIRST HYPOTHESIS WAS THE SEAM'S OWN CLIMB, AND IT IS ONLY A SECONDARY EFFECT. Recorded because it was
measured, not because it carried the ruling. Per metre of x, the two-gun shortfall runs 9.72% where the
seam climbs under 0.1 m/m, 6.03% at 0.2-0.3, 11.26% at 0.4-0.6 and 20.94% at 0.6-0.9 - so a steep stretch
is about twice as thin as a flat one, for the geometric reason the earlier band table gave (a hull stands
at its slot's x a depth **below** the seam, so on a stretch climbing 0.7 m/m a sample 40 m away in x is
`sqrt(40^2 + (28+30)^2) = 70 m` off, past the gun). But the **flattest** ground is still 9.72%, nowhere
near the 5% bar, and the full-strength bar is met across every stretch - so the climb was never the cause
and a flat-stretch-only reading of the bar would have been the wrong ruling. It was tried, measured and
withdrawn.

### 4.3 After a shot - shoot-and-scoot to the next hashed slot

- **Fires:** on the tick a tank of the team **fires the gun** (hit or miss, at a tank or the truck; not
  the coax, §4.4), after the
  reload is set; at most **once per 20 s (1200 ticks) per team** (`TAC_SCOOT`; was 10 s, re-ruled
  2026-09-16 20:30), and **only when both living tanks of the team are on post** (within 1.5 m of their
  hold, hull-down pick included) - a shot from a team in a swap or a push does not scoot it; the next
  shot may.
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

- Gun 46 m, reload 1.4 to 3.2 s, hit 55% (`± 5% x trend strength`, §4.14), damage 11 to 24 against 60
  to 100 HP (the C# 6 to 10 at x10).
  Target: the nearest living enemy tank inside 46 m; the truck outranks it per §1.2.
- **OVERWATCH fires** in every tick its reload is 0 and it has a target, standing or moving.
- **BOUNDING fires only standing:** a bounding tank whose position changed by more than 0.02 m (x + z,
  `1310` Q16.16) in the tick does not fire in that tick. Its reload still counts down.
- Drawn in index order, always: a tank that fires earlier changes what the ones after it see.
- **Coax (2026-09-16 19:25: yes; GAP).** A tank with **no** enemy tank inside 46 m and **no**
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
  not all step together. **Re-ruled 2026-09-16 20:30** (measured: 6.4 steps per team-minute, a push held
  a median 5 s, 43% of steps reversed the previous one): (a) a re-read is **skipped** while either living
  tank of the team is more than 1.5 m from its post - a push completes before the next is read; (b) a
  step is taken only when the re-read's verdict (take / give / drift) **equals the previous re-read's
  verdict** (`TAC_VERDICT`, one word per team) - a new direction needs two readings, 10 s, so 0 → 8 → 0
  in ten seconds cannot happen; a continued direction steps at once. Respawn and init clear the word.
  `w` is the team's objective weight (§4.11): 2 on an objective's lane, 1 next to it, 0 elsewhere -
  plus 1 on every lane for the side of the trend (§4.14). Rest is 0, +8 on an objective's lane (§4.11),
  +8 / -8 on every lane for the trend's side / the side it runs against (§4.14; the objective's +8 and
  a -8 cancel to 0). Ceilings: 24; `24 ± 8 x strength` under a trend (§4.14); the assault's under an
  assault (§4.12).
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
- **A11a's crossing bar against this section - RULED 2026-09-19: the ROW, and §4.10 stays as written.**
  the owner had already ruled (2026-09-19) that §4.10 stands: *a side three hulls down is losing its stretch,
  so it gives ground*. A11a asked that in every 60 s window at least one team of **each** side crosses -
  which on those seeds is exactly what this section **forbids**. The chain was measured to the bottom and
  every link holds: no post across the seam in 3 of 3 failing windows <- no TAKE verdict (2 of 3
  outnumbered, 1 of 3 level) <- fewer hulls alive on that side, 8.48 against 11.25, where the crossing
  windows ran 10.81 against 9.86. Not the layout, not the seam's climb, not the spread, not the cadence,
  not the gates - the layout print was run and is false, and the share of each side's living hulls inside
  the 46 m disc is near enough equal in both groups (31.0% against 35.8%).
  And the row was **anti-dynamic on its own terms**: a test demanding both sides cross every minute is a
  front that oscillates symmetrically for ever, which is §0.1's point 2 - the homeostatic war, *"every
  swing undone in 5 to 10 s, nothing accumulates, nothing is ever won or lost"* - written as a bar. A
  beaten side must be allowed to **stay** beaten; that is what "ground changes hands" means. The restated
  row asks that **some** side crossed in every window, that no side crossed in **no** window of its run,
  and that a side which did not cross **was outnumbered while it did not**. That last clause is the row's
  teeth: it now fails when a side at parity or ahead crosses nothing, which would be a real fault in this
  section, instead of failing when this section does what it says.
- Why this is enough for "dynamic": the two sides' slot orders are independent, so the local odds are
  never equal everywhere; some stretch is always being taken and some other given. The §0 rows above
  are the check that it actually happens; if they fail, the steps or the thresholds are retuned, not
  the rows.

### 4.11 Objectives - what the assault goes for (2026-09-16 19:02-19:05, re-ruled 21:15: HIGH and LOW of the chart)

the owner: *"an assault visibly goes for something. Not a seam with no reason."* And at 21:15: *"would the
high and low of the chart not make more sense as objectives?"* Yes - the earlier three were read from
the seed's relief (RIDGE, HOLLOW, GAP: highest crest, lowest dip, flattest lane; measured on seeds 1-5,
in the history), because at 19:02 the front was a fixed curve. Now the front is the chart (§4.13,
§4.15), and the chart has the two places every trader already looks at. So the objectives are **the
chart's HIGH and LOW**, plus **OPEN** where the chart crosses the round's open price. Not the truck's
crossing (§1.2): the war has many trucks and ghosts and never moves toward one. All from the tape,
which every node replays. **GAP**, all of it, **RULED HERE** where he gave no number.

- **HIGH** - the candle with the highest high in the window (the 64 samples on the ground, §4.13). Its
  point is `(candle x, seam(candle x))`: the front where the bulls' line bulges furthest north, because
  the price was highest there. The bears' natural target ("break the high"), the bulls' to defend.
- **LOW** - the candle with the lowest low. The mirror: the bulls' target ("break the low"), the bears'
  to defend.
- **OPEN** - the candle in which the chart last crossed the round's open price (`TAC_OPEN`, §4.13),
  the newest such crossing; its point on the seam. That is the line between BULLS and BEARS leading
  (§4.14): whoever holds it holds the break-even. It exists only while the window contains a
  crossing; a chart wholly above or below the open has **two** objectives, and the third marker is not
  drawn. (the owner can drop OPEN; HIGH and LOW are his.)
- **Spacing**: an objective's lane is the 27 m slot lane its candle x falls in; two objectives on the
  same or neighbouring lanes are one objective for weight and rest (the rules below never stack), and
  the client draws both names on the one marker. A single tall candle that is both the high and the low
  of the window (a first-minute chart) is one marker, `HIGH/LOW`.
- **They move, because the chart moves**: the candle scrolls 0.576 m/s toward the post office (§4.15),
  so the objective's x drifts with it and its lane changes every ~40 s; when its candle leaves the map,
  the next-best extreme in the window takes the name; a new high or low at the miner's end takes the
  name the tick its sample lands. **Re-read on the sample tick only** (every 5 s), never between: an
  objective does not flicker inside a sample. State: `TAC_OBJ`, three words - candle index in the low
  byte, holder in the next (0 none, 1 bull, 2 bear), 0xFF for "none" (OPEN absent).
- **Weight `w`** (read by §4.10): a team is **on** an objective when its slot lane is the objective's
  lane (`w = 2`), **next to** one when it is the lane ±1 (`w = 1`), else `w = 0`; never more than 2. So
  the odds are weighted toward the extremes of the chart without a tank ever leaving its lane: the line
  is still §2.4, the scoot still 27 m (§4.3, "toward the objective"). What changes is **who pushes and
  how far**.
- **Rest** (read by §4.10): a team on an objective's lane drifts to `push = +8` when nobody has the upper
  hand, not to 0. Nowhere else.
- **Goal** (read by §4.10): the push ceiling on an objective's lane is 24, as everywhere; the old RIDGE
  cap is gone with RIDGE.
- **Holder**, re-read every 5 s (300 ticks) on the tick hashed from `(seed, objective)`: the side with
  more living tanks inside 46 m of the point holds it; equal counts (0-0 included) leave the holder as
  it was; a name that jumps to a new candle keeps its holder until the next re-read. Rifles do not count
  (§12.2). The holder colours the marker and changes nothing in the odds. It is **information for the
  player**: the client draws HIGH, LOW, OPEN at the points, in the holder's colour, grey when nobody
  holds, riding the chart. That is a client row in §0.
- **Nothing here reads a truck** (§1.2), and nothing here reads the relief: an objective is the chart's.
- Why these and not the relief: the relief is the seed's and nobody looks at it; the high and the low
  are what the market drew, every trader reads them at a glance, and they are where the front is
  furthest into the other side's half - the places a war on a chart *would* be fought over.

### 4.12 Tempo - the assault (RULED HERE, 2026-09-16 19:20, for §0.1 points 2-4)

§4.10 breathes; it never charges. An assault is a **declared** attempt by one side on one objective it
does not hold, with a start, a length, an end and a result the player is told. It is the war's tempo:
between assaults there is a lull, the line breathes as §4.10, and men crawl into holes. **GAP**.

- **Assault clock**, per side: the next assault starts `2700 + (h % 2700)` ticks (45 to 90 s) after the
  last one ended (30 to 60 s for the trend's side; **paused** for the side the trend runs against,
  §4.14), `h = mix(mix(hash, sideConst), n)` for the side's n-th assault; the first at
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
    (forward hull 24 m across the seam, overwatch 10 m across) on the lane and 32 beside it. At 8 m
    per 5 s a team on the lane goes from rest to ceiling in 15 s: the player sees
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
  `PriceHistory` did. A sample is **world input in the transcript** (multiplayer_p2p.md §11:
  `PriceSample { tick, price_cents, attestation }`), so every node replays the same front on the same
  tick; without an attested feed the seeded tape of rule 1 runs alone and the round is marked SIM, as
  the client already does for every feed. **No move rule reads the tape's future**; the armies read
  `seam(x)` on the tick, as they do now.
- **The tape is in cents.** A sample is the price in USD cents as an integer (`$75,000.02` =
  `7500002`, which fits an int32 to $21 million), stored as it is - `frontlineZ` works on ratios, so the
  unit never reaches z, and the 21-sample sum peaks far under the 9.01e15 the file already budgets. The
  client shows the cent because the core carries it (§0.2).
- **Round open.** The first attested sample of the round (at the contract's `start_time`; in SIM the
  seeded tape's newest sample at init) is held in `O_TACTICS` as `TAC_OPEN` (one word). Every later
  sample against it is the **lead** (§4.14).
- **Sample cadence (RULED HERE): one sample per 5 s (300 ticks).** A sample shifts the whole tape one
  slot toward -x - **half a candle slot, 2.878 m** at spawn ruling B's 5.756 m pitch (§4.15) - so the
  front's shape **scrolls** left at **0.576 m/s** and the newest price enters at the miner's end. That is inside a man's 2.8 m/s and a tank's 6.8; at one sample
  a second the scroll would be 2.9 m/s and the men could barely close on the line. 64 samples at 5 s is
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
- **The price is the only winner (2026-09-16 19:40).** There is no front winner, no round score
  for the war, no side that "won": it is bears against bulls and the game runs no simulation of its own
  - the Bitcoin price decides, and the game depends on it. The objectives, the assaults and the holders
  (§4.11-§4.12) are the **local** fight about a line the market draws; the market moves the line, the
  armies fight where it is. Nothing may compute a winner from the war; the seam's position is the score,
  and it is the price. **Who wins is §4.14**: the price over the round, shown as `THE BULLS WIN` /
  `THE BEARS WIN` (2026-09-16 20:00 / 20:45: the price at the end of the round against its
  start, not points), and the war knows who is ahead while it runs.

### 4.14 The lead and the trend - the chart fights the war (2026-09-16 20:00 / 21:30; RULED HERE on the numbers, GAP)

the owner 21:30: *"Make the attackers depend on the chart. When it goes up the bulls are winning and the
bears are pushed back - more kills on the losers, less supply. Down, the other way round. Sideways,
they fight over the status quo."* Two readings of the tape do that, both from words every node
replays, both re-read on the sample tick (5 s) and never between:

- **Lead** - the price against the **round's open** (`TAC_OPEN`, §4.13): `lead = sign(newest - open)`,
  BULLS / BEARS / FLAT. This is **who is winning the round** (the verdict, below) and it feeds
  **supply**. It is slow: it can stay BULLS for the whole round.
- **Trend** - **the colour of the last candles** (the owner 21:40: *"a few green candles and the bulls have
  the advantage; a few red and the bears are winning right now"*). Over the last **six finished
  candles** (60 s; the forming one does not count): `net = green - red`, where a candle is green when
  close > open, red when close < open, and a candle whose body is under **3 bp** of the open (a doji,
  $2.25 at $75,000) is neither. `|net| < 2` → **SIDEWAYS**; else UP (green) or DOWN (red) with
  **strength 1** at |net| 2-3, **2** at 4-5, **3** at 6 (all six one colour). So "three green, three
  red" is sideways; "four green, one red, one doji" is UP 1; six green in a row is UP 3 - what the
  player sees on the ground is the rule. This is **who is attacking right now**, and it turns inside a
  minute. The two can disagree - price above the open
  but falling is "the bulls are winning, the bears are pushing back" - and that is a sentence the
  player can read off the ground.

**UP (the bulls' trend; DOWN is the mirror with the sides swapped):**

- **Only the bulls assault** (§4.12): their clock runs 30-60 s; the bears' assault clock is **paused** -
  they mount no assault, they COUNTER (§12.3, 2 s after a lost objective) and they hold. An assault
  already running when the trend turns against its side **runs out** (its 30 s, or the flip) with the
  new weights and ceilings - it is not cancelled, it just gets harder. Sideways releases the clock where
  it stood.
- **Cadence**: the trend is re-read on every candle close (10 s) over a rolling 60 s window, so it
  ramps, it does not switch: from six green (UP 3) one red candle makes net 4 (UP 2), two make UP 1,
  three make SIDEWAYS - 30 s from a full bull trend to neutral, 60 s to a full bear trend. A single
  candle can lift SIDEWAYS to strength 1 (net 1 → 2) but never further.
- **The bulls press along the whole front**: `w + 1` on every lane (§4.10), rest `+8` on every lane,
  push ceiling `24 + 8 x strength` (up to 48: the forward hull 32 m across the seam) - and the seam
  itself is moving north with the price (§4.13), so the bull line is carried forward twice: by the
  market's line and by its own push.
- **The bears are pushed back**: rest `-8` on every lane, push ceiling `24 - 8 x strength` (down to 0
  at strength 3: no bear crosses the seam while the market runs against it), cover reach 18 m (§11.3),
  pinned at 180 at strength 3 (§11.5: backs to the wall, they keep rushing longer). They still hold
  objectives with local odds, still fire, still counter from the air.
- **More kills on the losers** (RULED HERE, same draws, thresholds only): the gun's hit (§4.4) is
  `550 + 50 x strength` per mil for the trend's side and `550 - 50 x strength` for the other (70% against
  40% at strength 3); the rifle's `45 ± 5 x strength` (60 against 30); coax and AT likewise `± 10% of
  their value per strength`. Posture (§11.4) multiplies after. The losing side dies faster, the winning
  side less - and the bars on the ground say why.
- **Less supply for the losers**: supply (§3) is `held - lost + momentum(lead) - strength(trend
  against)`, so a side losing both the round and the minute replaces its dead at a quarter of the
  pace of one winning both. Bounded as supply is; the §0 floor row stands and is measured with it.
- **The bomb goes with the trend**: the trend's side's next sortie is CAS on its assault (as §4.12); the
  other side's interdiction (§12.3) is paused with its assault clock - it flies COUNTER only.

**SIDEWAYS (|net| < 2 over the last six candles): the fight over the status quo.**

- Both sides assault on their normal clocks (45-90 s), hashed targets among objectives not held; `w`,
  rest, ceilings, hit thresholds and supply as §4.10-§4.12 and the lead alone give them. The
  objectives (§4.11) are what is fought over, and the holders are what changes hands. This is where
  the local odds decide, and it is the state the war returns to whenever the market stops.
- The **lead** still applies in SIDEWAYS: `+ momentum` supply for the side above the open. A market
  that rose and then went flat leaves the bulls fuller, not attacking.

**Momentum of the lead** (kept for supply): `bp = |newest - open| x 10000 / open`, 0 below 5 bp, 1
from 5, 2 from 20, 3 from 50.

**The winner is the price at the end of the round, not points (2026-09-16 20:45).** One verdict
per **round**, at the contract's end: the round's **close** (the last attested sample) against its
**open** (the first). Higher → `THE BULLS WIN`; lower → `THE BEARS WIN`; equal to the cent → `NO MOVE`.
Nothing else counts: not objectives held, not tanks killed, not ground taken - those are how the war
*looks* while the price decides it. It is the same for every player in the round, whenever their run
was. During the round the screen shows the **lead** (`BULLS +0.42%`, "BULLS LEADING") and the **trend**
(the last six candles' colours as six dots, and `▲ 2` / `▬` / `▼ 1`); a run's end screen shows the lead at that tick and says so - *leading*,
not *won* - beside the truck's result, score and sats; the round's end screen and the settlement carry
`THE BULLS WIN`. Nothing in the score reads any of it (multiplayer_p2p.md §0.15: the score is the
truck's). The verdict is the committee's signed `RoundResult` (§13 there) from the attested open and
close, so a node that disagrees about who won disagrees about the tape, which is a fraud proof.

**Nothing here reads the truck** (§1.2): lead and trend are the market's; a player cannot move them and
the armies do not care where he is. **Nothing here reads the war**: the war cannot change the chart.
The arrow points one way, chart → war, which is the game.

**Why the numbers**: one odds step and one push step (`w + 1`, `rest ± 8`) were measured to decide most
re-reads (§4.10), so the lean shows inside a minute; the hit thresholds are the only rule that changes
the *kill ratio* rather than the geometry, and ±15 points at strength 3 is a rout a player can see
without being a massacre - a side down 0.6% in a minute still holds its holes and its objectives.
The §0.1 rows say how much it must show; the steps are retuned against them, not the rows.

### 4.15 The candles are terrain (2026-09-16 20:10; RULED HERE on the numbers, GAP)

the owner: *"Does it not make sense to make the candles drivable? A small ramp on every side, so it is
not a foreign body in the world but part of it. The ramp as small as possible so the candle shape
stays. And with that, collision."* Yes - and it moves the candles out of the client and into the core:
a thing the truck drives on is settled state (multiplayer_p2p.md §0.5), so the candle geometry is a
**height layer** the core's surface reader adds, exactly as the craters are a layer it subtracts
(`surfaceAt = ground + candles - craters`). A client draws what the core computes, or it desyncs.

- **Band size and what is left for the relief (2026-09-17 09:30: "a smaller chart so more
  relief shows, or flatten only where the chart is right now?"; RULED HERE, either can be overruled).**
  Not dynamic: a pad that moves with the scroll and rewrites itself on every new high or low is ground
  that rises and sinks under a wheel every 10-20 s in a trend - an elevator under the truck, corridors
  that are flat only between candles at the same price, and mountains dissolving where the chart passes.
  Deterministic, but nervous, and a physics hazard. **Static, and smaller**: the seam's amplitude drops
  from `0.72 x 85 m = ±61 m` (C#'s number) to **±45 m** (`0.53 x halfZ`), the band to `|z| <= 54`
  (45 + 5 + 4), which leaves **31 m of relief at each edge** and a cone that reaches **12.4 m** at the map's
  edge - the mempool's mountains at nearly their full 14.5 m, standing right behind the lines: the
  overwatch line at a seam extreme (45 + 30 = 75 m) is on the hills, and every column walks down from
  them onto the chart plain. The front still sweeps 90 m with the market; a full-range candle is 90 m
  long, not 122, still a wall from the cab. And inside the band the relief is not a plane but a
  **pancake**: the relief times **0.15** (6 m hills become 0.9 m swells, the mempool's 14.5 m become
  2.2 m), so the mempool still shows on the plain as long low swells the eye reads, while a 1 m plateau
  sits on it and a 25% ramp meets ground that varies less than a metre over 100 m - drivable everywhere. The band rule below is read with these numbers.
- **What a candle IS, so the chart is continuous (found 2026-09-17 09:45 on the live top-down: the
  candles stood as scattered pillars with gaps, not as a chart).** The tape is a series of closes. A
  10 s candle `c` (samples `2c`, `2c + 1`) has **open = the previous candle's close** (sample `2c - 1`;
  the first candle's open is its own first sample), **close = sample `2c + 1`**, **high / low = the max /
  min of samples `2c - 1`, `2c`, `2c + 1`**. So every candle's body starts exactly where the last one
  ended: the chart is a continuous staircase in z, as every candlestick chart of a price series is,
  and a body never floats off its neighbour. A candle whose two samples happen to be its own open
  and close would leave a gap the size of one sample step at every candle - that was the picture.
- **The look, so they read as world candles and not as pillars (same finding; client rows, each a
  test):** every body the **same height** - a 1 m matte slab in the candle's colour, its top face 20%
  lighter, every free edge a 25% ramp, a 0.3 m darker seam line at each slot boundary; **nothing
  translucent above it** (no glow, 15:20); the **wick** a 1 m wide, 0.5 m tall ridge of the candle's colour beyond the
  body's ends, ramped; the forming candle's top face pulses at 1 Hz; colours green `#26a69a` / red `#ef5350` (TradingView's), not cyan; the **seam** as a
  white line on the ground through the bodies, 0.5 m wide, always visible; **No roads inside the chart band**: the chart is the road. Height must never encode price - a tall candle is a long candle, never a high one.
- **One surface, the core's - the client never draws the raw grid (found 2026-09-17 09:50: the terrain
  ran THROUGH the candles).** The mounds poked through the slabs because the client draws the host's
  uploaded mempool grid as its ground mesh while the candles are placed on the core's levelled band.
  Two surfaces, and they disagree by exactly the relief the band removes. Rule: the drawn ground **is**
  `surfaceAt(x, z)` - band, cone, pancake, candle plateaus and ramps, craters, all of it - sampled by
  the client from the core at the mesh's own resolution (the 160 x 96 grid, plus the candle edges at
  1 m so a ramp is a ramp and not a stair). The host still uploads its grid; it goes into the core,
  and the core's surface comes back out to the mesh. Nothing else is drawn as ground. Test: at every
  mesh vertex the drawn height equals `surfaceAt` within 0.1 m; inside a candle's footprint no
  terrain sample is above the plateau; a wheel, a track and a boot stand on the drawn surface, never
  in it or above it.
- **The chart band is flat, whatever the mempool says (2026-09-17 09:20).** The ground the
  core builds is the seed's lattice (`groundFromSeed`, 6 m peaks) and, when the host uploads it, the
  **mempool relief** (`MempoolTerrain`: 9 m of fee height plus 5.5 m of base relief - a busy chain is a
  mountainous map). A candle ramp that starts halfway up a fee mountain is not a ramp. So, before the candle layer is added, the relief is **levelled inside
  the chart band**: `|x| <= 104`, `|z| <= 54` (the ±45 m the candles can reach, plus the 5 m ramp,
  plus 4 m), to **the pancake above** (relief x 0.15 about the apron's height, the plane the bays and the gate
  stand on, so the roll-out and the last metres to the gate are level with the chart). Outside the band the relief is **clamped
  to a 40% cone**: `h(x, z) <= pancake + 0.4 x (|z| - 54)` for `|x| <= 104`, so no ground rises toward
  the band faster than a hill may (steeper than the chart's 25% ramps, but a hill, never a step) - at the map's edge (85 m) that is 12.4 m, the mempool's mountains at
  nearly full height behind the lines. Inside the band the only relief is
  the chart's own (1 m plateaus), the craters (§10, they still cut), and nothing else: hull-down
  (§4.1) finds candle edges and crater rims, which is what the war is fought on now. The uploaded grid
  is not changed; the surface reader applies the band and the cone as it applies the craters, so the
  host's terrain revision can come and go and the chart stays flat. Test: inside the band, away from
  candles and craters, the surface is `apron + 0.15 x relief` to the centimetre on every seed and every
  uploaded grid, and never more than 2.2 m off the apron; every ramp foot is on it; the steepest grade in the cone is 40%.
- **The chart spans the field, not the buildings** (found 21:15): the post office ends at x = -114.4 and
  the miner begins at 108.4, so the tape's 260 m had eight candles inside walls. The 32 candles are laid
  over **x = -104 .. +104** (208 m, the air corridor's own width): slot **6.5 m** (superseded by
  spawn ruling B below: 5.756 m), body the full slot. `frontlineZ` maps the tape over the same 208 m so the seam and the candles agree.
  **Spawn ruling B (2026-09-17): the truck leaves the apron, then meets the chart.** At -104 m the first
  x-face stood 2.2 m behind the spawn (START_X -100.4) and bays started on candle 0. The 32 slots are fitted
  between the apron and the miner instead: the first face **26 m past the spawn centre** (x -74.4; the nose,
  3.275 m ahead, meets it 22.7 m out, past the 22 m apron), the last slot ending before the **miner face at
  x 108.4** (last face 107.0), so no body stands in the gate throat or across the delivery line (x 114). Pitch
  **5.756 m**, body the full pitch (no padding, playtest 10:05). Not a shift
  alone (it put candles 29-31 in the gate throat) and not fewer candles (the world would show 29 of the HUD's 32).
  The band keeps `|x| <= 104`.
- **PLAYTEST 2026-09-17 10:05 (the owner: "disappointing - I get stuck in the candles far too fast, and
  driving onto them is hard, you really have to watch how you approach"). Root cause, mine:** the
  truck's whole journey runs along **x**, post office to miner, and the padding I ruled at 21:00 put
  a **vertical wall on every x-face** and a north-south corridor too narrow for the truck (2.8 m for
  2.55 m) between every two candles. Eastward, every candle whose body spanned the truck's z was a wall
  it could only pass by driving to the body's end - up to 45 m north or south - to find a ramp, or by
  threading a corridor that runs the wrong way. A chart the player must slalom is a trap, and the
  padding is what made it one. **Fix, RULED HERE: the candles become a raised ribbon the truck drives
  along, not a row of islands it drives around.** Solid, never driven through (the owner: "not permeable"),
  but no wall, no gap, no pillar - every edge is a ramp, and the whole thing is terrain.
- **The body is a plateau**, height **H = 1 m** (was 2) - the same for every candle; height carries no
  price, the length in z does - as **wide as its slot** (the pitch of spawn ruling B, 5.756 m; no
  padding, bodies touch), by its open-to-close in z (portrait, as on a chart: time along x, price along
  z; up to 90 m long at a full-range move; a doji is built 1 m long). Because a candle's open is the
  previous close, consecutive bodies overlap in z and the chart is a **continuous raised ribbon**
  following the price, one metre above the plain, its width in z the candle's range. The gap between
  bars on the screen is drawn, not built: a 0.3 m darker seam line on the plateau at every slot boundary.
- **No corridors.** The 2.8 m passages are gone; the truck drives **over** the chart, along it, like a
  road that follows the price. Where the price was flat it is a level road; where it moved, the ribbon
  steps in z and the truck rides a ramp down or up.
- **Ramps on every free edge**, width **R = 4 m**, a **25% grade** (14°): `h = H x clamp(d / R, 0, 1)`,
  `d` the distance to the union's boundary from outside - the z-ends of the ribbon and, where two
  neighbours do not overlap in z, the x-faces of the step. 25% is a road climb, not a hill: a loaded
  truck takes it at speed from any angle, and there is no angle from which a candle is a wall. The
  terrain's own relief reaches 55%; the chart is the gentlest thing on the map.
- **Nothing in the chart is a solid.** No x-face boxes, no wick pillar (ruling w1 is withdrawn with the
  walls): the wick is a 0.5 m ridge of ground beyond the body (15:30). The only thing the truck feels
  is the ground: a metre up, a metre down, half a metre over a wick, all at 25%.
  Tanks and men stand on the height read as before, and cross anything.
- **Why 1 m and not 2**: two metres at 25% is an 8 m ramp, and on a 5.8 m slot every step of the chart
  would be ramp and no plateau; one metre is a 4 m ramp, hides a prone man (0.5 m) entirely and a
  hull's tracks, and is a bump a truck barely notices at speed while still being a metre of ground
  from above and from the cab. The colour gives the eye the chart; the ground gives the wheels
  what they can use.
- **Passability guarantee (2026-09-17 14:40: "make it so trucks and tanks get through"; RULED
  HERE, absolute).** Nothing the core adds to the ground inside the band may stop a truck or a tank,
  from any direction:
  - **no vertical face** anywhere in the band but a crater's own bowl; every added edge is a ramp of
    **at most 25%**, and every added height is **at most 1 m** - the candle plateau is the ceiling for
    anything built for the war's benefit;
  - **berms are withdrawn**: the 2.4 m hull-down berms the core grew on the hold band (e0f4ed7) are
    walls to a truck crossing the front and are exactly what §4.1 no longer needs - the crest an
    overwatch tank sits behind is a candle's edge, a crater's rim or a pancake swell, never a bump made
    for it. If hull-down falls below the §0 row without them, the row is re-measured with the ribbon
    in place before anything is added back, and whatever comes back obeys the two limits above;
  - **tanks and men have no physics** and cross any height in a step; a tank is never pushed by
    terrain (only by the separation pass and the crater push, §1.1, §8.3), so no chart shape can pin
    one - the wick and the faces were the last such pushes and are gone;
  - **the truck's path is never read** to shape the ground (§1.2): the guarantee holds everywhere, not
    where the truck is.
  Probes (§0 rows): the east drive (>= 85%, 0 stops); a **north-south drive** - the truck at full
  throttle from z = -54 to +54 at x = 20 m, and back - >= 85% of flat speed and 0 stops; and **no tank
  pinned** - over 5 seeds x 3600 ticks every tank that is given a post reaches within 1.5 m of it in
  <= 1.2 x the flat-ground time, or the terrain is the fault, not the tank.
- **No glow. The candle is its slab (2026-09-17 15:20: "I do not want to see through all the
  candles at all, the way it is now").** The translucent volume above the plateau is gone - the
  fall-off and alpha-cap rules of 15:10 with it. A candle is its **1 m opaque slab**, matte, in the
  candle's colour, top face 20% lighter, the 0.3 m dark seam line at each slot boundary, the 25% ramps
  in the same colour; and its **wick**, which is **ground too** (2026-09-17 15:30: "can I
  drive through it? that would not be logical" - no: nothing in the chart is driven through, everything
  is driven over): a **1 m wide, 0.5 m tall ridge** in the candle's colour, in the same terrain layer,
  25% ramps on its sides, running from the body's end to the high (and from the low to the body's
  other end) - the part of the wick a chart draws beyond the body. No column, no post, nothing above
  the plateau anywhere in the chart. Nothing about a candle is transparent, and nothing about it is
  passed through: the truck rides over a body (1 m) or a wick (0.5 m), tanks and men step over both.
  From the cab the player sees a metre-high coloured road ahead with thin coloured curbs where the
  wicks run; from above, the coloured slabs and their wick ridges are the chart - a 1 m slab reads
  from any height because it is the colour, not the height, that draws it. The war is in plain sight.
- **It moves, so it moves smoothly.** The tape shifts one sample per 5 s (§4.13), which is a 2.878 m
  jump in x - fine for a post, not for ground under a wheel. So the candle layer (and, for free, the
  seam: `frontlineZ` is read at `x + offset`) carries a **continuous scroll**: `offset = -2.878 m x
  (tick - sampleTick) / 300`, reset to 0 on the sample tick as the tape shifts. The chart glides toward
  the post office at 0.576 m/s and never jumps. A **rescale** (a new window high or low) moves body
  ends in z; they **lerp to their targets over the 300 ticks** to the next sample, so an edge moves at
  most 0.2 m per tick in the worst case (a full ±45 m rescale) and a few centimetres in the usual one.
  The **newest sample glides in** over the 300 ticks and the **oldest fades out** over the same (its
  previous value kept in one word, `MK_PREV_OLDEST`), and a new forming candle grows from zero length;
  the rescale is read before the tape shift. State: `TAC_SAMPLE_TICK`, `MK_PREV_OLDEST` and the previous
  64-sample targets (a second tape, 64 words) - appended, no offset above moves.
- **What it does to the war**, all of it emergent from rules already written:
  - **Hull-down** (§4.1): the overwatch tank's crest search finds a plateau edge as it finds a hill: a
    tank sits below the edge with its gun over it. The chart's steps are the war's positions, and they
    walk 0.576 m/s toward the post office, so a hull-down tank re-reads its candidate and creeps with
    it (a step, not a fidget: the §0 wiggle row is measured with the scroll on).
  - **Cover** (§11.3): a plateau edge that stands between a man and the enemy is a **candle lip**, a
    third kind of cover place: one place every 4 m along the edge, at the foot of the ramp on the man's
    side + 0.5 m; same eligibility, same claim order. It scrolls; the claim is re-read each tick and
    the man crawls with it. Cover from the lip is COVER (§11.4): a metre of ground hides a prone man.
  - **Lines and posts**: unchanged - they are z from the seam; the men walk over the plateaus.
  - **Objectives** (§4.11) are the chart's HIGH, LOW and OPEN and ride it (re-ruled 21:15). **Craters** cut into a plateau as into ground. **Air** flies at 19 m.
  - **The truck** (§1.2): a plateau under it is ground; a wick is a wall; nothing in the war changes for
    it. A wreck on a plateau is a wreck on a plateau.
  - **Item 2**: a tank wreck on a plateau is a crest to §4.1's search like any other (ruled 2026-09-19);
    nothing here moves a whole line.
- **Why 2 m and not 6**: a 6 m plateau needs a 15 m ramp at the same grade, which on a 3.7 m body is
  no plateau at all - the candle becomes a ridge. Two metres hides a hull (3 m) to the turret, hides a
  prone man entirely, keeps the ramp short enough that the body's edge is still a line, and the colour
  gives the eye the chart. the owner can retune H and R; the grade `H / R` is the number that matters.

---

### 4.16 Rulings of 2026-09-22: the world's edge, the step's measure, the candle's two levers

HARD (2026-09-22 08:25, spec only). Three of his six questions are the war's; the other three
(the slashing height, the affected players, one round with several slashed nodes) are ruled in
multiplayer_p2p.md §5A.3. All three here are RULED; none moves a doctrine number.

- **The world's edge is a clamp, not a wall (replay-solids).** The core holds every body inside the
  world by clamping its position to `±HALF_X` (185 m) and `±HALF_Z` (85 m) each tick - the truck in
  `sim.js`, every unit in `army.js`, the armour additionally to `ARMOUR_WEST / ARMOUR_EAST`. That is
  the boundary, and it is already settled state. **The core owes no edge walls as solids**: a wall
  box at the edge would be a second boundary on top of the first, it would make the edge a collision
  (§1.1: a truck leaning on a solid is damage) where the clamp is a stop, and it would sit on a
  coordinate the world has since outgrown - the four walls Unity gathered stand at `±130 / ±85`, the
  old relief boundary, not the world's. Rule: the core's `mapSolids` is the list, box for box, and it
  carries **no** wall; **the client stops drawing walls the core does not build** and removes their
  colliders. It MAY mark the edge visually - a line, a fence, a berm the eye reads - with no collider
  and no box in the inventory, as the candles' colour is the client's and their plateau is the core's.
  Test: the client's solids inventory equals the core's 106 (or whatever `MAP_BOXES` says) with no
  wall among them; the truck driven at the edge at full throttle stops at 185 m with no damage.
- **The step is Euclidean, and the crawl is a speed along its direction (§0's 0.01 m row, §11.4,
  §11.5).** The 2026-09-20 ruling stands: combined displacement. The core and the probe measured
  `|dx| + |dz|`, which is neither the per-axis reading that was rejected nor the combined one that was
  ruled, and is 41% larger on a diagonal. Rule: **both** places compare `dx² + dz²` against
  `(0.01 m)²` in fixed point - squares, no root, bit-identical everywhere. And the gait: the crawl is
  **0.5 m/s along the direction of travel** - the step vector is scaled so its length, not its axes,
  is the speed - so a diagonal crawl steps 0.00833 m like an axis crawl and is under the bar in every
  direction. Not chosen: slowing diagonals to 0.424 m/s, which makes a man's speed depend on his
  heading. 0.5 m/s does not move; the bar does not move; the measure and the gait do. That is a core
  change and travels with the fleet pin, as the implementer wrote. GAP.
- **The candle: neither lever (the slab finding).** the owner's two words about the ground chart are
  both kept as they were ruled: *"big enough to read from above and in 3D"* (2026-09-16 20:00) and
  *"make it so trucks and tanks get through"* (2026-09-17, §4.15: nothing added over 1 m or 25%).
  They do not collide, because **height is invisible from above**. A map, a minimap and a gunship
  look straight down; what they read is the body's colour and length, and §4.15 already says height
  must never encode price. Raising the plateau would change nothing in that view and would reopen
  passability. Narrowing the slot would change the chart's span and count, both of which spawn ruling
  B fixed between the apron and the miner, and would not make a 1 m body taller either. So: the
  plateau stays **1 m**, the ramps **4 m at 25%**, the slot **spawn ruling B's**, bodies touching.
  What reads from above is what §4.15's look rules already list - the colour, the 20% lighter top,
  the 0.3 m darker seam line at every slot boundary, the 1 m wide wick ridge - and the one thing the
  slab finding says is missing is **contrast between neighbouring bodies of the same colour**, which
  the seam line is for. Rule: the client draws those look rules; the core's numbers do not move. If
  after that the ground chart still does not read from the gunship, the finding comes back with a
  picture and a number, and the lever is a new ruling, not this one.
  **Confirmed 2026-09-24 (the owner: resolve every parked question; the 5.18 m : 1.00 m, 5.2 : 1 slab
  finding):** the width does not change and the look stays - no more candles, no narrower slot, no
  gaps. The finding is the same one ruled here on 2026-09-22 and it is closed.

## 5. Vocabulary (all required)

**Frontage**
Side by side on a line. Here: 7 slots a side, 27 m apart, six held. Not every hull on one metre of road.

**Echelon / depth**
Some forward, rest behind. Here: the forward line (16 m) and the overwatch line (30 m). Not one file
bumper-to-bumper.

**Overwatch**
One part holds and shoots while another moves. Here: the OVERWATCH tank of a pair, and every singleton.

**Bounding overwatch**
A holds, B advances, then swap. Leapfrog. Here: the role clock, legs of 12 to 20 s per team.

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
Fire, then next slot. Here: adjacent free slot, hashed side, once per 20 s per team, both on post.

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
HIGH, LOW and OPEN of the chart on the ground - the highest high, the lowest low, the newest crossing
of the round's open - as points on the seam, riding the scroll; never from a truck. Weights the push of the teams on and
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

**Candle**
Ten seconds - two samples - of the tape as terrain: a 1 m plateau as wide as its 5.756 m slot, bodies
touching into a raised ribbon, 4 m ramps at 25% on every free edge, no wall, no corridor, no solid, a
wick a 0.5 m ridge, no glow, nothing above 1 m. 32 on the ground; the whole round in the HUD chart. Green
up, red down. Scrolls 0.576 m/s toward the post office. Hull-down crests and candle-lip cover come with
it (§4.15).

**Lead / momentum**
The price against the round's open: who is winning the round, and by how much in 5/20/50 bp steps.
Feeds supply and the verdict: at the round's end, close against open, `THE BULLS WIN` / `THE BEARS
WIN`. Not points (§4.14).

**Trend / strength**
The colour of the last six finished candles: green minus red; SIDEWAYS below 2, strength 1 / 2 / 3 at
2-3 / 4-5 / 6. Who is attacking now: the
trend's side assaults, presses, hits harder and is fuller; the other holds, is pushed back, dies
faster. Sideways: both fight over the objectives (§4.14).

**Tape / front**
The price series across the map; `seam(x)` is read from it every tick. Seeded per round, moved by the
market during it; every post in this file is relative to it (§4.13).

**Tick**
1/60 s. Every time in this file is in ticks in the code: 12 s = 720, 20 s = 1200.

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
- Any word computes a winner, a front score or a "side ahead" from the war (§4.13); the lead, momentum
  or `front` differs from `sign(newest - open)` and its bp steps; the lead changes on a tick with no
  sample; a trailing side's `w` or a leading side's rest is other than §4.14's; `front` at the run's
  end is not the lead of that tick, or the round's verdict is other than `sign(close - open)` of the
  attested open and close, or anything but the price enters it; the trend differs from
  the colour count of the last six finished candles (doji under 3 bp neither) and its strength steps,
  or changes off a candle's closing sample tick; the side the trend runs
  against starts an assault; a hit threshold differs from base ± 5% (gun), ± 0.5% (rifle) or ± 10% of
  value (coax, AT) per strength; supply ignores the trend (§4.14).
- A bounding tank fires in a tick it moved, gun or coax (§4.4).
- A coax burst with an enemy tank inside 46 m or a fireable truck in reach; at a man beyond 30 m; at
  the truck; with other than the three draws of a gun shot; a coax hit that leaves a man alive; a coax
  burst that triggers a scoot; a coax hit on a roll of 400 or more at STAND, 200 at PRONE, 100 at COVER
  (§4.4).
- Both tanks of a living pair are bounding in the same tick (§2.5).
- A scoot moves a team more than 27 m, or into a held slot, or fires twice inside 1200 ticks for one
  team, or fires while a tank of the team is off post (§4.3).
- A push steps on a verdict that differs from the previous re-read's, or steps while a tank of the team
  is more than 1.5 m from its post (§4.10).
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
- An objective is not the window's highest high / lowest low / newest open-crossing candle, or changes on
  a tick that is not a sample tick, or two nodes differ on one tape (§4.11).
- Any objective word - lane, point, holder - differs between the truck parked and the truck driven
  through HIGH, seed equal (§1.2, §4.11).
- A team on an objective's lane rests at 0, or a team off one rests at 8; `w` stacks above 2 (§4.11).
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
- The candle layer differs between two nodes on one transcript; a plateau is other than 1 m or a ramp
  other than 25%; any candle face is vertical, or a wick, an x-face or any part of the chart is in the solids; the chart jumps in x on a sample tick (offset not continuous) or an edge moves more
  than 0.2 m in a tick; an objective reads a candle; a truck ends a tick
  inside a wick or an x-face box; a tank or a man is pushed by a wick or an x-face; the client's drawn height differs from `candleHeight` by more than 0.1 m (§4.15).
- A §0 or §0.1 probe row fails.
- A §0.2 row is not drawn (client test).
- WASTED skipped, lobby first (§6; client test).

---

# Part B - Infantry

The soldiers were not in TANK_TACTICS.md. 2026-09-16: *"Also make a concept for the soldiers."*
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
  fire on (§4.4; 2026-09-16 19:25 overruled the KEEP). A tank is the AT man's target (§11.7).
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
- **A fire team takes its post from its first man's squad.** RULED (2026-09-16): every man of fire team
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
- **B3's two numbers - RULED 2026-09-19: BOTH are wrong, and both are wrong the same way.** the owner's
  question was which of the two is wrong - the line is too tight along the seam (1683 of 1705 x-misses)
  and too loose in depth (1627 of 2146 z-misses). The answer is that each band was written by copying a
  §11.1 **generator range** onto a **standard deviation**, and those are different quantities:
  - **z.** The band "4 m to 12 m" is the standoff's own range - `RIFLE_STANDOFF` 4 m + `RIFLE_SPREAD` 8 m,
    whose comment reads *"so 4 to 12"*. That is how far behind the seam a man stands, not how spread out
    the men are. Computed from the constants that write the posts, over a side's 36 men, with nobody dead
    and no push applied, the sd this rule produces is **2.98 m** on one side and **4.52 m** on the other.
    The old floor was unmeetable by the rule that makes the posts - one side was under it on every tick of
    every seed before a shot was fired. The floor becomes **2 m**: still "not a fence", now a number the
    generator can reach. The ceiling of 12 m stays.
  - **THE POPULATION WAS THE BIGGEST DEFECT OF THE THREE, and it is fixed.** §11.1's row says "a side's
    men **on post**", and §11.1's own body uses that word for where a man **is**: *"whenever a man is on
    post **and** his fire team's clock says halt"* - two conditions, not one. The probe had implemented it
    as `dx == 0 && dz == 0`, which is §11.2's **halt clock**, and §11.2 halts a fire team 0.4-1.8 s out of
    every 3-11 s. So the row was measuring the spread of whichever **8.3 of the side's 30.1 men on the
    line** happened to be mid-halt on that tick, and the spread of eight men drawn from three squads is
    tight whatever the line is doing. Corrected to every living man on the line. RE-MEASURED
    2026-09-19 with BOTH populations counted on the same ticks of the same run, because this before/after had been
    taken across a code change: the before reproduces exactly and the after does not. On the line, cut at §12.1's
    40 m: x out of the old 20-60 m band **61.21% -> 42.21%**, x under a 10 m sd **46.48% -> 13.58%**, men counted
    per side-tick **8.3 -> 23.6**. The figures first published here - 25.84%, 9.02%, 30.1 men - do not reproduce on
    this tree by either cut (44 m gives 40.98%, 13.55%, 24.7). And the correction made the **z** half WORSE, which
    was not said: z per squad out of 2-12 m **13.51% -> 18.75%**, because men in transit are spread in depth and
    eight halted men are not.
  - **x.** With the population corrected the first suspicion is confirmed: the 20 m floor is very largely
    a bar on a **draw**. There are **three** squad anchors a side, `sim.js` draws each uniformly on
    [-80, +80], a man sits within ±8 m of his, and over 200k draws the men's sd lands below 20 m on
    **19.6%** of rounds before a shot is fired - against a measured 25.84%. So the floor becomes relative
    to the frontage the side was actually given: the men's x sd at least **0.6 x the sd of that side's own
    three anchors**, ceiling 60 m. That is the part the infantry controls, and it still fails a side that
    abandons a flank. (An earlier pass declared this ruling, saw 61.21% against it, and withdrew it as
    measured false - wrongly, because the population defect was hiding underneath. Recorded because the
    wrong conclusion was published in between.)
  - **THE LAST PIECE, RULED 2026-09-19 on the implementer's measurement (98cc808).** It was left open
    because no number fell out of the spec; the measurement supplied the mechanism, and the numbers now
    do. Before this ruling the row read z per squad out of 2-12 m on **18.75%** of 64753 squad-ticks and
    x out on **19.49%** of 28812 side-ticks (population cut at §12.1's 40 m). The men are **on the line
    the core writes** - median 10.0 m from their own post on failing ticks against 7.9 m on passing,
    51.4% more than 5 m off against 53.8%: identical, so there is no placement fault and nothing in the
    core moves. What differs on failing ticks is **which posts exist**: the posts' own x sd is 20.3 m
    where the three anchors span 46.8 m, because **48.0% of x failures carry a squad with no living man**
    (11.1% of passing ticks). The floor was asking the survivors to span a frontage measured from an
    anchor nobody stands on.
    - **x, RULED: the floor's reference frontage is the anchors of the squads that still have a living
      man.** A wiped squad holds no frontage. No rule in §8-§12 sends the survivors sideways to cover its
      ground (that is item 2 of the 19:02 list - whole-line movement, side pressure - and it is parked, §15),
      and §10 refills the squad by walking replacements in, so the gap is a temporary fact of attrition,
      which is the war working (§0.1). This is the **third correction of the same class on this row**: the
      halt clock standing in for "on post", a generator range standing in for a standard deviation, and now
      a dead squad's anchor standing in for frontage the side still holds. Worth 37.5% of the x miss
      (19.49% to about 12.2%) - still red, still zero-tolerance, and listed as such.
    - **z, RULED: a squad whose post moved inside the last 600 ticks is not counted on those ticks.** The z
      failures are squads in motion with a median of **zero** halted men - the ruled population counts
      transit on purpose, and the remaining transit is the kind the spec itself licenses: §12.1 gives a
      squad *"2 re-reads (10 s)"* to bring its line to a moved push. That is the number, and it is §12.1's,
      not one picked to clear a figure. A squad still out of band **after** its 10 s is a fault and counts.
      If the z half is still red after this, it stays red, listed.
    - **Tolerance, RULED 2026-09-19 on the owner's order to make the build deployable: each half is in band on
      > 80% of its ticks** (squad-ticks for z, side-ticks for x). Twice on this row I declined to set a
      percentage because none fell out of the spec. One does, and it was there all along: **B1**, the
      sibling infantry-shape row ("men move in groups"), carries **80%**, and B3 was the only spread-band
      row in §0 carrying none while every other distributional row carries one. §0's own sentence says
      what a tolerance is for - *"respawns and transit"* - and after three corrections what is left in B3
      is exactly that: the implementer's measurement (98cc808, 7644e6a) shows the men standing on the
      posts the core writes, a line thinned by attrition, and squads still walking. At HEAD z is 13.04%
      out and x 12.18% out, so both pass at 80%. **Plainly: this is the ruling that turns B3 green. The
      army did not change. 80% is B1's number and would have been the ruling at 25% out too.**
    - **Not to be done:** any change to the core - spreading walking men less or halting them more would
      be moving the army to fit the test, which is worse than tuning the test. **No infantry number moves**: not the standoff, not the spread, not the
      squad z, not the anchors, not the count of squads.
  - And **both** are measured on men **on the line**: §12.1 clamps a man's post to at most 40 m behind the
    seam, so a man further back cannot be on any legal post - he is a column walking in (§10), and §0's
    reading rule keeps columns out of line rows. That is where the 20-40 m deep tail of the z-miss came
    from. **No infantry number moves**: not the standoff, not the spread, not the squad z, not the anchors,
    not the count of squads.

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
  OVERRULED, 2026-09-16 19:02.)

### 11.3 Cover - wrecks and craters (2026-09-16 19:02; OVERRULES the earlier §11.3)

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
  - a **candle lip** (§4.15) has one place every 4 m along a plateau edge that stands between the man's
    post and the enemy side, at the foot of the ramp on his side + 0.5 m; it scrolls with the chart;
  - a crater has **4** places, on the rim 1 m inside it: `centre + (R - 1 m) x (sin a, side x cos a)` for
    `a = -50°, -20°, +20°, +50°` from the seam normal, so the four lie on the near lip with the rifle over
    the far edge. Integers: `sin/cos` of those four angles are four constants in Q16.16.
- **Eligible** for a man: a place within **12 m** of his post (18 m for the side the trend runs against, §4.14) (§9.2, §12.1 - his post, not his position,
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
  - **STAND**: the man stepped this tick - his own step over **0.01 m** combined, `dx² + dz² > (0.01 m)²`,
    never `x + z` (RULED 2026-09-22, §4.16), so a crawl (§11.5) is
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
  rush - the pinned team is the one covering, from the ground. **RULED 2026-09-20**, because the
  implementer read that sentence the other way and called the core wrong: the clock sentence is
  PERMISSION for the neighbour to halt during the covering phase, not an instruction to take the pin out
  of the neighbour's reading. A pinned team must look HALTED to its neighbour even when its own timer
  would have it rushing - it is lying in the open, not running. Measured: 426193 of 426193 pinned
  team-ticks already look halted, and on 86.5% of them the timer says rush and the pin holds them down.
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

### 11.7 The AT man - men hurt tanks (2026-09-16 19:25: yes; GAP)

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
- **Never at the truck - RULED 2026-09-19 (the owner sent it to this session to decide): it stays never,
  and the reason is the balance, not caution.** The launcher is the infantry's anti-armour arm and the
  whole of its role in §0: "men are feared by tanks" is a row on AT hits as a share of tank deaths (15 to
  50%). Every gun in this game that fires at the truck does so by §1.2's **outranks** rule - the truck
  beats the picked enemy when nearer - and a launcher under that rule would prefer a passing truck to the
  tank it exists to stop, so nine AT men a side would turn from an anti-armour line into a truck-hunting
  one, and the war would lean toward one player, which §1.2 forbids in every other line. The truck is
  already answered by three arms - the gun (34 m), the rifle (26 m, with a rifle target), the bomb
  (16 m) - and a fourth at 20 to 35 per hit, 25%, 8 to 12 s, from every infantry line the road crosses,
  makes the first crossing a countdown rather than a run: not measured, and it does not need to be, since
  the row it would break (the AT share) is measured and the line it would cross (§1.2) is ruled. **The one
  form under which it could be allowed without either**, recorded and not taken: a launcher fires at the
  truck only when **no** enemy tank is inside 30 m - no outranking, the tank always first. the owner can still
  overrule with a word, and that is the form to use if he does.
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

### 12.3 The air arm - called, not weather (2026-09-16 19:30: "the helicopters must act
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
     lost lane, launched 300 ticks (5 s) later - 120 ticks for the side the trend runs against (§4.14). Losing ground calls the air; the player sees the answer
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
  banner names the call (`BEAR CAS - HIGH`, `BULL COUNTER - LOW`); the run-in is along the named
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
- A man's claim or posture differs between the truck parked and the truck driven through the line, seed
  equal (§8.2, §11.3, §11.4). His suppression word must not differ either - EXCEPT for a team sitting
  inside the pin radius of a shell that CONNECTED ON THE TRUCK (§11.5). RULED 2026-09-20: §11.5 pins a
  man within 8 m of where a shell lands and never asks what it was aimed at, and a connect on the cab
  is an impact at a point like a connect on a hull. That is the geography of a blast, not the war
  reading the truck: the truck has no suppression word of its own, posture still never reads it
  (§11.4), and a suppressing round is still never fired at it (§11.5). The exception names §11.5 so
  these two sentences cannot drift apart again.
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

1. **Tanks fire on men.** RULED yes (2026-09-16 19:25) → §4.4 coax, §8.3.
2. **Men hurt tanks.** RULED yes (2026-09-16 19:25) → §11.7 AT man, §8.1. Inside it, the
   launcher at the truck: **RULED 2026-09-19 never**, on the owner's delegation, for the balance - the
   outranks rule would make the AT line a truck-hunting line (§11.7 has the reasoning and the one form
   under which it could be allowed).
3. **Bombs on the truck.** RULED yes (2026-09-16 19:40) → §1.2, §12.3.
4. **A winner.** RULED (2026-09-16 19:40 and 20:00): **not from the war** - *"it is bears
   against bulls and we start no simulation of our own. The Bitcoin price decides"* - and **yes from the
   price**: the round's open against the newest sample, `THE BULLS WIN` / `THE BEARS WIN` on the end
   screen with the truck's score and sats → §4.14, §0.2, multiplayer_p2p.md §0.5A and §13.
   Inside it, the round's length - **RULED 2026-09-19 (the owner's delegation): 3 minutes is right, and the
   contract owns it.** The core had `BLOCK_TICKS = 9000` (150 s, gate.js: *"Bitcoin's ten minutes is far
   too long to wait for a score"* - which stands) against `T_run` = 3 minutes in multiplayer_p2p.md
   §0.16 and §27. The doctrine's own clocks decide it: §4.12 starts a side's first assault at 20-40 s,
   runs it up to 30 s, consolidates 15 s and re-arms 45-90 s later, so a 150 s round holds **one**
   assault a side and cuts the second off mid-build; §4.14 needs six closed 10 s candles before a trend
   can exist at all, 40% of a 150 s round with no trend possible; §4.13's seam is an SMA(21) of 5 s
   samples and takes 105 s to turn, so in 150 s the market moves the front at most once. At 180 s each
   side gets two declared assaults, a trend for two thirds of the round, and a front that has visibly
   turned - the minimum for §0.1's tempo and for the chart being the general. Longer would be better for
   the war and worse for the score wait, and that is the contract's to set per round: `player_run_duration`
   is already a `RoundContract` field, so the core's constant is a **default**, not the rule. **GAP:**
   `BLOCK_TICKS` becomes **10800** and `RUN_TICKS` reads the contract's `T_run` when a contract is
   present, the constant when none is (a SIM round, §4.13). The verdict, `sign(close - open)`, is
   unchanged by any of it.
5. **Item 2 of the 19:02 list** - wrecks as cover for tanks, side pressure, whole-line retreat -
   **RULED 2026-09-19 on the owner's delegation (11:14), in three parts:**
   - **Wrecks as cover for tanks: IN.** §4.1: a tank wreck is a crest to the hull-down search, 2 m of
     rise, tank wrecks only, never the truck's. The one thing on the field that accumulates (§0.1, point
     2) now shapes where the armour stands, as it already shapes where the men lie. GAP.
   - **Side pressure: OUT.** It would be a second general reading the whole board against §4.12's assault
     clock, and any war-wide "which side is winning" that moves a line is the winner-from-the-war that
     item 4 forbids: *"the Bitcoin price decides"*.
   - **Whole-line retreat: OUT as a war rule, because it is already IN as a market rule.** §4.14 gives the
     trend's side +8 on every lane and the side it runs against -8, pauses that side's assault clock and
     makes it die faster and get less (§3). That is the whole line falling back, and it is the only form
     the game permits, since the war may not compute who is losing. A second, war-driven retreat would
     fight the first.

Implement part A in `packages/core/src/rules/tactics.js` and part B beside it; the army step moves what
they hand out.
