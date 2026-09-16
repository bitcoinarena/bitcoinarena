# Tank tactics

HARD (the owner 2026-09-16). Source of truth for armour in the **core**.
Deterministic. Same integers on every signer node. No live LLM. No `Math.random`.

Truck rules and tank-vs-tank rules are **not the same**.

---

## 1. Two relations

### 1.1 Tank vs tank (keep)

- Never inside **12 m** hull to hull.
- No clip, no ram **between tanks**.
- Flank / spacing / clip-ram rules that exist for armour vs armour **stay**.
- They do **not** apply to the truck.

### 1.2 Tank vs truck (exception)

- Do **not** dodge, flee, get pushed, or keep 12 m from the truck.
- **Shoot** the truck (especially a dangerous load).
- Otherwise **ignore** the truck.
- **Touch either way = truck dies immediately** (WRECKED). That used to work.
- After a shot, relocate to the **next hashed slot** (shoot-and-scoot). That is not fleeing the truck.

---

## 2. Assignment (bit-identical on every node)

- Mix **round seed** + **roster slot id** with integer hash only. No draw that shifts the stream.
- **Stable pairs:** sorted roster ids `(0,1), (2,3), …`.
- Do **not** re-pair from whoever is alive (that reshuffles the line).
- Odd tank = **singleton OVERWATCH** on its own hashed slot.
- In a pair: one **OVERWATCH**, one **BOUNDING**. Swap on a seeded tick period.
- **Frontage slots:** permutation hashed from `(seed, side)`. A team holds one slot. No two teams of a side hold the same metre.
- Two sides’ orders independent → **crossfire**.

---

## 3. Death and respawn

- Teams stay on **roster id**, not the living set.
- One of a pair **dies:** survivor stays **OVERWATCH** on that team’s slots. No suicide rush.
- That **id respawns:** rejoins the **same** pair as **BOUNDING** (partner already holding).
- A new hull **never** steals another team’s partner.

---

## 4. When which tactic

**Default hold**
Hull-down / overwatch covering a **kill zone** on the seam / road.

**Group relocates**
Staggered column, then bounding overwatch.

**After a shot**
Shoot-and-scoot to the **next hashed slot**, not away from the truck.

**Two sides of the road / seam**
Crossfire.

**Moving between slots**
Staggered column, not bumper-to-bumper.

**Singleton (odd / widow)**
Overwatch on own slot until the partner respawns.

**Forbidden in this game**
Sidescrape. Smoke. Kiting away from the truck.

---

## 5. Vocabulary (all required)

**Frontage**
Side by side on a line. Not every hull on one metre of road.

**Echelon / depth**
Some forward, rest behind. Not one file bumper-to-bumper.

**Overwatch**
One part holds and shoots while another moves.

**Bounding overwatch**
A holds, B advances, then swap. Leapfrog.

**Hull-down**
Turret over crest / cover, hull hidden.

**Reverse slope**
Sit behind the crest, gun just over.

**Kill zone**
Several hulls cover the same stretch from different angles.

**Crossfire**
Both sides of the road / seam.

**Shoot-and-scoot**
Fire, then next slot.

**2-tank fire team**
The stable pair.

**Staggered column**
Offset on the road when moving.

**Stop**
Seam parking lot. Wiggle-to-death because hulls almost touch.

---

## 6. WASTED

When the truck dies (touch or otherwise): **WASTED screen first**, then lobby.
Not lobby immediately.

---

## 7. Tests that must fail if this is wrong

- Two living tanks of a side share a slot.
- A widow rushes.
- A respawn steals a partner.
- A tank steers away from the truck.
- Touch truck-tank does not WRECK the truck.
- WASTED skipped, lobby first.

Implement in `packages/core/src/rules/tactics.js` and the army step.
