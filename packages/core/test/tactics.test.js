// WAR_TACTICS.md §7 (the owner 2026-09-16 18:20): the tests that must fail if the doctrine is wrong.
//
// Touch truck-tank = WRECKED is pinned in rules.test.js ("a truck that touches a tank is written off"), and WASTED
// before the lobby in Unity's RunEndsAtDeliveredTests.AWreckShowsWastedBeforeTheLobby.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step, teleport, groundAt } from '../src/sim.js';
import { frontlineZ } from '../src/rules/frontline.js';
import * as L from '../src/state.js';
import * as T from '../src/rules/tactics.js';
import { stepUnit } from '../src/rules/army.js';
import { seed as seedRng } from '../src/rng.js';

const ONE = 65536;
const base = (i) => L.O_UNITS + i * L.U_WORDS;
const ARMOUR = Array.from({ length: 24 }, (_, k) => k * 4);
const alive = (s, i) => s[base(i) + L.U_STATE] !== 0;
const teamWord = (i) => { const { side, team } = T.teamOf(i); return (side < 0 ? 0 : T.TEAMS_PER_SIDE) + team; };

test('no two living tanks of a side share a slot, and no two teams hold one - over five seeds and a minute each', () => {
  for (const seedWord of [1, 2, 3, 4, 5]) {
    const st = init(seedWord), s = st.i32;
    for (let t = 0; t < 3600; t++) {
      step(st, 0, 0, 0, ONE, 0);
      for (const side of [-1, 1]) {
        const slots = new Set();
        for (let team = 0; team < T.TEAMS_PER_SIDE; team++) {
          const slot = s[L.O_TACTICS + T.TAC_SLOT + (side < 0 ? 0 : T.TEAMS_PER_SIDE) + team];
          assert.ok(!slots.has(slot), `seed ${seedWord} tick ${t}: two ${side < 0 ? 'bull' : 'bear'} teams hold slot ${slot}`);
          slots.add(slot);
        }
        const xs = new Map();
        for (const i of ARMOUR) {
          if (T.teamOf(i).side !== side || !alive(s, i)) continue;
          const x = T.postOf(s, L.O_TACTICS, i, s[L.O_TICK]).x;
          assert.ok(!xs.has(x), `seed ${seedWord} tick ${t}: tanks ${xs.get(x)} and ${i} were sent to the same metre`);
          xs.set(x, i);
        }
      }
    }
  }
});

test('tank to tank, never inside 12 m - to within one tick of movement', () => {
  // The separation resolves every pair before anything moves; a tank's own step (at most 0.113 m) can take it that
  // much closer before the next tick resolves it again. Measured over 4.4 million pair samples: closest 11.83 m.
  let closest = Infinity;
  for (const seedWord of [1, 2, 3]) {
    const st = init(seedWord), s = st.i32;
    for (let t = 0; t < 3600; t++) {
      step(st, 0, 0, 0, ONE, 0);
      const live = ARMOUR.filter((i) => alive(s, i));
      for (let p = 0; p < live.length; p++) for (let q = p + 1; q < live.length; q++) {
        const d = Math.hypot(s[base(live[p])] - s[base(live[q])], s[base(live[p]) + 1] - s[base(live[q]) + 1]) / ONE;
        if (d < closest) closest = d;
      }
    }
  }
  assert.ok(closest > 11.5, `two tanks came within ${closest.toFixed(2)} m of each other`);
});

test('a widow does not rush: its partner dead, it holds overwatch on the team\'s slot', () => {
  const st = init(7), s = st.i32;
  for (let t = 0; t < 600; t++) step(st, 0, 0, 0, ONE, 0);
  // Find a pair with both alive and one of them bounding, and kill the one holding.
  const bounder = ARMOUR.find((i) => alive(s, i) && alive(s, T.partnerOf(i)) && T.isBounding(s, L.O_TACTICS, i, s[L.O_TICK]));
  assert.ok(bounder !== undefined, 'no pair with a bounding tank to widow');
  const partner = T.partnerOf(bounder);
  s[base(partner) + L.U_HP] = 0; s[base(partner) + L.U_STATE] = 0;
  const post = T.postOf(s, L.O_TACTICS, bounder, s[L.O_TICK]);
  assert.equal(post.bounding, false, 'the widow was still sent forward on the bound');
  assert.equal(post.depth, T.OVERWATCH_LINE - post.push, 'the widow was not given its team\'s (pushed) overwatch line');
  assert.equal(post.x, T.slotX(s[L.O_TACTICS + T.TAC_SLOT + teamWord(bounder)]) + (T.teamOf(bounder).member === 0 ? -T.PAIR_HALF : T.PAIR_HALF),
    'the widow left its team\'s slot');
  for (let t = 0; t < 900 && alive(s, bounder) && !alive(s, partner); t++) {
    step(st, 0, 0, 0, ONE, 0);
    if (!alive(s, partner)) assert.equal(T.isBounding(s, L.O_TACTICS, bounder, s[L.O_TICK]), false, `tick ${s[L.O_TICK]}: the widow bounded`);
  }
});

test('a respawned tank rejoins its own pair as BOUNDING and takes no other team\'s partner', () => {
  const st = init(11), s = st.i32;
  for (let t = 0; t < 300; t++) step(st, 0, 0, 0, ONE, 0);
  const victim = ARMOUR.find((i) => alive(s, i) && alive(s, T.partnerOf(i)));
  const partner = T.partnerOf(victim);
  s[base(victim) + L.U_HP] = 0; s[base(victim) + L.U_STATE] = 0;
  const othersBefore = ARMOUR.filter((i) => i !== victim && i !== partner).map((i) => [i, T.partnerOf(i), s[L.O_TACTICS + T.TAC_SLOT + teamWord(i)]]);
  let back = -1;
  for (let t = 0; t < 3600 && back < 0; t++) {
    step(st, 0, 0, 0, ONE, 0);
    if (alive(s, victim)) back = s[L.O_TICK];
  }
  assert.ok(back >= 0, 'the tank was never replaced');
  assert.equal(T.partnerOf(victim), partner, 'the respawn was paired with somebody else');
  if (alive(s, partner)) {
    assert.equal(T.isBounding(s, L.O_TACTICS, victim, back), true, 'the respawn did not come back as the bounding tank');
    assert.equal(T.isBounding(s, L.O_TACTICS, partner, back), false, 'its partner was not left holding overwatch');
  }
  for (const [i, p] of othersBefore) assert.equal(T.partnerOf(i), p, `tank ${i}'s partner changed when ${victim} came back`);
  // a tank enters in its own lane
  const lane = T.postOf(s, L.O_TACTICS, victim, back).x;
  assert.ok(Math.abs(s[base(victim) + L.U_X] - lane) <= 0.12 * ONE, 'the respawn entered outside its team\'s lane');
});

test('a tank does not steer by the truck: the same tank with the truck anywhere steps the same', () => {
  const unit = () => ({ x: Math.imul(12, ONE), z: Math.imul(-30, ONE), hp: 80 * ONE, heading: 0, cooldown: 0, armour: true,
    side: -1, crowded: false, engaged: true, foeX: Math.imul(20, ONE), anchor: 0,
    tac: true, tacX: Math.imul(15, ONE), tacDepth: T.FORWARD_LINE, tacBounding: true, tacSeam: 0 });
  const rng = () => { const r = new Int32Array(4); seedRng(r, 5); return r; };
  const ground = () => 0;
  const at = (tx, tz, th) => { const u = unit(); stepUnit(u, rng(), 0, tx, tz, th, 0, 130 * ONE, 85 * ONE, 1092, 0, 1000, null, ground); return u; };
  const far = at(Math.imul(-100, ONE), 0, 16384);
  for (const [tx, tz, th] of [[Math.imul(14, ONE), Math.imul(-26, ONE), 0], [Math.imul(12, ONE), Math.imul(-31, ONE), 32768], [Math.imul(40, ONE), Math.imul(-30, ONE), 16384]])
    assert.deepEqual(at(tx, tz, th), far, `the tank stepped differently with the truck at ${tx / ONE}, ${tz / ONE}`);
});

// ---- §4.10 pressure and §4.11 objectives --------------------------------------------------------------------------

const lanesOf = (s) => [0, 1, 2].map((o) => T.objectiveLane(s, L.O_TACTICS, o));

test('three objectives on distinct inner lanes, the spec\'s table on seeds 1-5, apart where the front allows it', () => {
  // WAR_TACTICS.md §4.11, measured table: RIDGE, HOLLOW, GAP by slot.
  const table = { 1: [3, 1, 5], 2: [2, 4, 1], 3: [4, 1, 5], 4: [5, 1, 3], 5: [2, 4, 3] };
  const seen = new Set();
  for (let seedWord = 1; seedWord <= 20; seedWord++) {
    const lanes = lanesOf(init(seedWord).i32);
    if (table[seedWord]) {
      assert.deepEqual(lanes, table[seedWord], `seed ${seedWord}: objectives on other lanes than §4.11's table`);
      assert.ok(!seen.has(lanes.join()), `seed ${seedWord}: two of seeds 1-5 give the same three objectives`);
      seen.add(lanes.join());
    }
    assert.deepEqual(lanesOf(init(seedWord).i32), lanes, `seed ${seedWord}: two inits disagree on the objectives`);
    assert.equal(new Set(lanes).size, 3, `seed ${seedWord}: two objectives share a lane`);
    for (const lane of lanes) assert.ok(lane >= 1 && lane <= 5, `seed ${seedWord}: an objective on outer lane ${lane}`);
    for (let o = 1; o < 3; o++) {
      const taken = lanes.slice(0, o);
      if (!taken.some((t) => Math.abs(t - lanes[o]) === 1)) continue;
      const apart = [1, 2, 3, 4, 5].filter((l) => taken.every((t) => Math.abs(t - l) >= 2));
      assert.equal(apart.length, 0, `seed ${seedWord}: objective ${o} beside a taken lane while lane ${apart[0]} was free`);
    }
    // no holder at init
    for (let o = 0; o < 3; o++) assert.equal(T.objectiveHolder(init(seedWord).i32, L.O_TACTICS, o), T.HOLDER_NONE);
  }
});

test('a team\'s objective weight is 2 on an objective\'s lane, 1 beside one, 0 elsewhere', () => {
  for (let seedWord = 1; seedWord <= 10; seedWord++) {
    const s = init(seedWord).i32, lanes = lanesOf(s);
    for (let slot = 0; slot < T.SLOTS_PER_SIDE; slot++) {
      const want = lanes.includes(slot) ? 2 : lanes.some((l) => Math.abs(l - slot) === 1) ? 1 : 0;
      assert.equal(T.objectiveWeight(s, L.O_TACTICS, slot), want, `seed ${seedWord} slot ${slot}`);
    }
  }
});

test('push moves one 8 m step on its re-read only, on a confirmed verdict with the team on post, stays in [-8, 24], at most 16 on RIDGE; holders flip only on their re-read', () => {
  const pushTick = (s, w, tick) => ((tick + ((T.mix(s[L.O_TACTICS + T.TAC_SEED], 300 + w) >>> 1) % 300)) % 300) === 0;
  const holdTick = (s, o, tick) => ((tick + ((T.mix(s[L.O_TACTICS + T.TAC_SEED], 400 + o) >>> 1) % 300)) % 300) === 0;
  // Seeds 1-10: the hold cadence steps a push rarely (measured 0-10 steps a seed, 50 in all; seeds 1, 2 and 8 none).
  let steps = 0, flips = 0;
  for (const seedWord of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const st = init(seedWord), s = st.i32, lanes = lanesOf(s);
    const seamAt = (x) => frontlineZ(st.tape, x, 130 * ONE, 85 * ONE), ground = (x, z) => groundAt(st, x, z);
    for (let t = 0; t < 3600; t++) {
      const before = Array.from({ length: 12 }, (_, w) => s[L.O_TACTICS + T.TAC_PUSH + w]);
      const verdictBefore = Array.from({ length: 12 }, (_, w) => s[L.O_TACTICS + T.TAC_VERDICT + w]);
      // on post as the re-read sees it: this tick's posts, the positions at its start
      const onPostAtRead = Array.from({ length: 12 }, (_, w) => { const side = w < 6 ? -1 : 1, k0 = (w % 6) * 2;
        return [k0, k0 + 1].every((k) => { const i = (k << 3) | (side < 0 ? 0 : 4);
          return s[base(i) + L.U_STATE] === 0 || T.onPost(s, L.O_TACTICS, i, s[L.O_TICK] + 1, seamAt, ground); }); });
      const holders = [0, 1, 2].map((o) => T.objectiveHolder(s, L.O_TACTICS, o));
      step(st, 0, 0, 0, ONE, 0);
      const tick = s[L.O_TICK];
      for (let w = 0; w < 12; w++) {
        const now = s[L.O_TACTICS + T.TAC_PUSH + w], d = now - before[w];
        assert.ok(now >= -8 * ONE && now <= 24 * ONE, `seed ${seedWord} tick ${tick}: team ${w} push ${now / ONE} m`);
        if (s[L.O_TACTICS + T.TAC_SLOT + w] === lanes[T.OBJ_RIDGE]) assert.ok(now <= 16 * ONE, `seed ${seedWord} tick ${tick}: team ${w} on RIDGE pushed ${now / ONE} m`);
        if (d === 0) continue;
        // a scoot onto RIDGE may cut a push to the crest's 16 m on the shooter's tick
        const ontoRidge = s[L.O_TACTICS + T.TAC_SLOT + w] === lanes[T.OBJ_RIDGE] && now === 16 * ONE && d < 0;
        if (!ontoRidge) {
          assert.ok(pushTick(s, w, tick), `seed ${seedWord} tick ${tick}: team ${w} push moved off its re-read tick`);
          assert.equal(Math.abs(d), 8 * ONE, `seed ${seedWord} tick ${tick}: team ${w} push moved ${d / ONE} m`);
          assert.ok(onPostAtRead[w], `seed ${seedWord} tick ${tick}: team ${w} pushed with a tank off post`);
          assert.equal(s[L.O_TACTICS + T.TAC_VERDICT + w], verdictBefore[w], `seed ${seedWord} tick ${tick}: team ${w} stepped on an unconfirmed verdict`);
          steps++;
        }
      }
      for (let o = 0; o < 3; o++) {
        const h = T.objectiveHolder(s, L.O_TACTICS, o);
        if (h === holders[o]) continue;
        assert.ok(holdTick(s, o, tick), `seed ${seedWord} tick ${tick}: objective ${o} changed hands off its re-read tick`);
        assert.notEqual(h, T.HOLDER_NONE, 'a held objective went back to nobody');
        flips++;
      }
    }
  }
  assert.ok(steps >= 40 && flips > 0, `nothing moved to check: ${steps} push steps, ${flips} holder changes`);
});

test('with nobody fighting, a team rests at +8 m on an objective\'s lane and at 0 anywhere else', () => {
  for (const seedWord of [1, 2, 3, 4, 5]) {
    const s = init(seedWord).i32, lanes = lanesOf(s);
    for (let i = 0; i < 96; i += 4) s[base(i) + L.U_STATE] = 0;           // no tank alive: own 0, foe 0 everywhere
    for (let w = 0; w < 12; w++) s[L.O_TACTICS + T.TAC_PUSH + w] = (w % 2 ? 24 : -8) * ONE;
    for (let tick = 1; tick <= 3000; tick++) T.pressure(s, L.O_TACTICS, tick, () => 0);
    for (let w = 0; w < 12; w++) {
      const slot = s[L.O_TACTICS + T.TAC_SLOT + w];
      assert.equal(s[L.O_TACTICS + T.TAC_PUSH + w], lanes.includes(slot) ? 8 * ONE : 0,
        `seed ${seedWord}: team ${w} on slot ${slot} rests at ${s[L.O_TACTICS + T.TAC_PUSH + w] / ONE} m`);
    }
  }
});

test('the objective words are the same with the truck parked and driven through RIDGE, until the fight itself differs', () => {
  // Seeds 9 and 10: the fight stays identical long enough (352 and 361 ticks, columns off the budget) for holders to be
  // written inside the compared stretch (223 and 211 holder-ticks). Seeds 1-8 split at 263-327 ticks, and 1, 2 and 4
  // with no holder written yet, so they would compare lanes only.
  for (const seedWord of [9, 10]) {
    const a = init(seedWord), b = init(seedWord);
    const ridgeX = T.slotX(T.objectiveLane(a.i32, L.O_TACTICS, T.OBJ_RIDGE));
    let compared = 0, written = 0;
    for (let t = 0; t < 1800; t++) {
      step(a, 0, 0, 0, ONE, ONE);
      teleport(b, ridgeX + Math.round((-40 + 80 * t / 1800) * ONE), Math.round((20 - 40 * t / 1800) * ONE), 0);
      step(b, 0, 0, 0, ONE, ONE);
      for (let o = 0; o < 3; o++) assert.equal(T.objectiveLane(b.i32, L.O_TACTICS, o), T.objectiveLane(a.i32, L.O_TACTICS, o));
      let same = true;
      for (let k = 0; k < L.RNG_WORDS; k++) if (a.i32[L.O_RNG + k] !== b.i32[L.O_RNG + k]) same = false;
      for (let i = 0; i < 96 && same; i++) for (const w of [L.U_X, L.U_Z, L.U_HP, L.U_STATE]) if (a.i32[base(i) + w] !== b.i32[base(i) + w]) same = false;
      if (!same) break;
      for (let o = 0; o < 3; o++) {
        assert.equal(b.i32[L.O_TACTICS + T.TAC_OBJ + o], a.i32[L.O_TACTICS + T.TAC_OBJ + o], `seed ${seedWord} tick ${t}: objective ${o} read the truck`);
        if (T.objectiveHolder(a.i32, L.O_TACTICS, o) !== T.HOLDER_NONE) written++;
      }
      compared++;
    }
    assert.ok(compared > 300 && written > 0, `seed ${seedWord}: the worlds split after ${compared} ticks with ${written} holder ticks - nothing compared`);
  }
});

test('a bounding tank pushed onto the seam (depth 0) holds the seam, not the old standoff', () => {
  // depth 0 used to read as "no tactics": the tank was sent to the pre-doctrine standoff.
  const u = { x: Math.imul(15, ONE), z: 0, hp: 80 * ONE, heading: 0, cooldown: 0, armour: true, side: -1, crowded: false,
    crowdedLoose: false, engaged: false, foeX: 0, anchor: 0,
    tac: true, tacX: Math.imul(15, ONE), tacDepth: 0, tacBounding: true, tacSeam: 0, tacPush: 16 * ONE, tacForward: 0, tacWait: false };
  const r = new Int32Array(4); seedRng(r, 5);
  stepUnit(u, r, 0, -100 * ONE, 0, 0, 0, 130 * ONE, 85 * ONE, 1092, 0, 1000, null, () => 0);
  assert.equal(u.z, 0, `a tank standing on its depth-0 post moved to z ${u.z / ONE}`);
  assert.equal(u.x, 15 * ONE);
});

test('a team scoots at most once in 1200 ticks and only with both living tanks on post (§4.3, re-ruled 20:30)', () => {
  // On post is read from the positions at the start of the tick, against the slot the team scooted FROM; the scoot is
  // taken mid-loop, after lower indices stepped, so one tick of a tank's travel (0.12 m) is allowed on top of 1.5 m.
  let scoots = 0;
  for (const seedWord of [1, 2, 3, 4, 5]) {
    const st = init(seedWord), s = st.i32;
    const seamAt = (x) => frontlineZ(st.tape, x, 130 * ONE, 85 * ONE), ground = (x, z) => groundAt(st, x, z);
    const lastScoot = new Map();
    for (let t = 0; t < 3600; t++) {
      const slots = Array.from({ length: 12 }, (_, w) => s[L.O_TACTICS + T.TAC_SLOT + w]);
      const nearPost = Array.from({ length: 12 }, (_, w) => { const side = w < 6 ? -1 : 1, k0 = (w % 6) * 2;
        return [k0, k0 + 1].every((k) => { const i = (k << 3) | (side < 0 ? 0 : 4);
          if (s[base(i) + L.U_STATE] === 0) return true;
          const p = T.postOf(s, L.O_TACTICS, i, s[L.O_TICK] + 1), line = seamAt(p.x) + side * p.depth;
          let hold = line;
          if (!p.bounding) { let br = -Infinity; for (let c = -2; c <= 2; c++) { const z = line + c * 2 * ONE; const r = ground(p.x, z - side * 6 * ONE) - ground(p.x, z); if (r > br) { br = r; hold = z; } } }
          return Math.hypot(s[base(i)] - p.x, s[base(i) + 1] - hold) <= 1.62 * ONE; }); });
      step(st, 0, 0, 0, ONE, 0);
      const tick = s[L.O_TICK];
      for (let w = 0; w < 12; w++) {
        if (s[L.O_TACTICS + T.TAC_SLOT + w] === slots[w]) continue;
        scoots++;
        assert.ok(nearPost[w], `seed ${seedWord} tick ${tick}: team ${w} scooted with a tank off post`);
        if (lastScoot.has(w)) assert.ok(tick - lastScoot.get(w) >= T.SCOOT_TICKS, `seed ${seedWord} tick ${tick}: team ${w} scooted ${tick - lastScoot.get(w)} ticks after its last`);
        lastScoot.set(w, tick);
      }
    }
  }
  assert.ok(scoots > 0, 'no team scooted - nothing checked');
});

test('a pair swaps roles only with both tanks on post: the post is held until the bound arrives (§2.6, §0 hold)', () => {
  // On post under the roles of the leg that is ending, read from the positions at the start of the swap tick, with one
  // tick of travel (0.12 m) on top of 1.5 m.
  let swaps = 0;
  for (const seedWord of [1, 2, 3, 4, 5]) {
    const st = init(seedWord), s = st.i32;
    const seamAt = (x) => frontlineZ(st.tape, x, 130 * ONE, 85 * ONE), ground = (x, z) => groundAt(st, x, z);
    const near = (i, tick) => { const side = T.teamOf(i).side, p = T.postOf(s, L.O_TACTICS, i, tick), line = seamAt(p.x) + side * p.depth;
      let hold = line;
      if (!p.bounding) { let br = -Infinity; for (let c = -2; c <= 2; c++) { const z = line + c * 2 * ONE; const r = ground(p.x, z - side * 6 * ONE) - ground(p.x, z); if (r > br) { br = r; hold = z; } } }
      return Math.hypot(s[base(i)] - p.x, s[base(i) + 1] - hold) <= 1.62 * ONE; };
    for (let t = 0; t < 3600; t++) {
      const tickBefore = s[L.O_TICK];
      const pairs = ARMOUR.filter((i) => T.partnerOf(i) > i && alive(s, i) && alive(s, T.partnerOf(i)))
        .map((i) => [i, T.isBounding(s, L.O_TACTICS, i, tickBefore), near(i, tickBefore) && near(T.partnerOf(i), tickBefore)]);
      step(st, 0, 0, 0, ONE, 0);
      for (const [i, was, onPost] of pairs) {
        if (!alive(s, i) || !alive(s, T.partnerOf(i))) continue;
        if (T.isBounding(s, L.O_TACTICS, i, s[L.O_TICK]) === was) continue;
        // a tank of the pair died and came back inside this tick: §3 restarts the clock on the respawn (measured: seed 4
        // tick 900, tank 48 at 10 hp replaced by a fresh hull) - that is not a leg swap
        const { side, team } = T.teamOf(i);
        if (s[L.O_TACTICS + T.TAC_ROLE_START + (side < 0 ? 0 : 6) + team] === s[L.O_TICK]) continue;
        swaps++;
        assert.ok(onPost, `seed ${seedWord} tick ${s[L.O_TICK]}: pair of tank ${i} swapped roles with a tank off post`);
      }
    }
  }
  assert.ok(swaps > 20, `only ${swaps} swaps - nothing checked`);
});
