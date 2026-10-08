// The squad geometry, core beside Army.Spawn.
//
// Written for item (l). (k) gave the infantry C#'s squads - three anchors a
// side, drawn and drifting - and the air envelope closed at 17/17. What did
// not close is the line's own work: the core's riflemen kill 8-18 a round
// against the C#'s 16-37, and the core's air kills a third more of them.
//
// The air was ruled OUT of that by measurement, not by argument: with the core
// loaded from the pre-air worktree the rifle kills land ON the recording
// (27-45 against 28-51). So (l) is not a gun fault, and the standing
// hypothesis - denser men under the blast, more bomb dead, more replacement
// churn, less time in contact, half the rifle kills - is a hypothesis about
// GEOMETRY. This tool measures the geometry rather than arguing it.
//
// Five quantities, per squad and per side:
//
//   anchor      where the knot stands, and where it has drifted to
//   men         how many men are on it - Maenner pro Knoten
//   width       how wide the knot stands: sd of its men's x about the anchor
//   pairs       how close a bull anchor comes to a bear anchor, which is the
//               only way the two lines can meet at all
//   front       what a bomb thrown at a random x would find: how much of the
//               160 m front is within a blast of somebody (cover), of nobody
//               (dud), and of BOTH sides at once (both - the friendly fire)
//
// ---------------------------------------------------------------------------
// WHERE THE C# NUMBERS COME FROM, AND WHY THEY ARE MEASURED AND NOT GUESSED
//
// csharp-infantry.json records z, spread, contact and kills. It does not
// record an anchor, a squad or an offset, and Unity is not run from here.
//
// So the C# half is replayed: `System.Random` is the seeded .NET generator,
// which is a fully specified subtractive sequence, and `Army.Populate` draws
// from it in a fixed order. Replaying both reproduces the spawn exactly - and
// the recording's t=0 row is taken BEFORE the first Update, so it is a pure
// function of that spawn. The replay is checked against it on every seed
// before a single geometry number is printed: bull and bear n, mean z and
// spread, nearestPair, meanNearest, inRifleRange, all to the stored digit,
// including the 24/72 pass with its six squads. If a seed does not reproduce,
// this tool prints REPLAY FAILED for it and reports no C# geometry.
//
// What that buys and what it does not:
//
//   t=0        EXACT for both engines. Both armies stand ON their posts the
//              moment they spawn - `unit.x = clamp(squads[squad] + offsetX)`
//              is the last line of Spawn, and the core does the same - so the
//              whole x geometry is formed up at t=0 and is measured, not
//              modelled.
//   anchors    EXACT for both engines at every t. DriftSquads is a closed
//              form in Time alone, clamped; nothing else touches an anchor.
//   over time  CORE ONLY is measured. The C# column after t=0 is marked PROJ
//              and is the drifted anchors carrying the spawn membership - it
//              says where the C# knots WOULD be with nobody dying, which is
//              the thing to compare the core's drift against, and it is not a
//              recording. Deaths and replacements are exactly what it cannot
//              see, and that is the hypothesis under test, so it is never
//              quoted as the C#'s answer.
//
// ---------------------------------------------------------------------------
// AND THE ONE COMPARISON THAT HAS TO BE GUARDED: THE DEPTH
//
// The recording carries mean z and a z spread at EVERY sample, so the line's
// depth is the one shape number that can be laid engine to engine after t=0.
// It is also the one that is easiest to quote wrongly, and was: this tool
// printed `z spread core 1.1-31.1  REC 3.5-25.7` with the core under air ON,
// against a recording whose own `setup.air` is "none". Half that core's
// riflemen are killed by bombs and replaced from the edge over the round; the
// C# line in that column was never bombed at all. The two columns are two
// different battles and the spread of a line is exactly the quantity the
// difference moves, so the pair said nothing and read as if it did.
//
// So the pairing is now CONDITIONED, from the recording's own setup block:
// `setup.air` must be "none" and `setup.seam` must be the pinned z=0 seam, or
// the REC column is withheld and the reason is printed in its place. To get
// the comparison, hold the core's air down with --sorties=off, which is what
// ArmyReferenceTests does by simply never calling LaunchSorties.
//
//     node tools/measure-squads.js [seed ...] [--seam0] [--quiet] [--core=DIR]
//                                    [--sorties=on|off|grounded]
//
// --seam0 pins the frontline at z=0, the recording's condition. --core=DIR
// loads the core from elsewhere - a worktree from before a change is the
// before half of a before-and-after. --quiet drops the per-sample rows.
//
// --sorties= holds the air down from OUT HERE, on whatever core is loaded, by
// the same mechanism measure-infantry.js uses and for the same reason - no
// rule is edited and nothing but the air's own state words is written:
//
//   off        the two sortie clocks are pinned high after every tick, so
//              launchSorties never fires and the air draws NOTHING from the
//              stream. This is the recording's own condition.
//   grounded   the clocks run and their draws land on the stream as usual, but
//              every gunship and bomb slot is cleared the tick it is filled.
//              The sortie's draws are paid for; the bombs are not. The two
//              hold modes say whether an answer is an artefact of WHICH draws
//              were withheld.
//
// No hold makes one SEED comparable across conditions - every draw the air
// makes comes off the same stream the ground fight uses, so air-off seed
// 20260901 and air-on seed 20260901 are two battles, not one battle with the
// bombs removed. Only the envelope over the four seeds is a comparison, which
// is the rule the recording is read under too.
//
// Prints; asserts nothing, except that a held run really did stay on the
// ground: in --sorties=off the gunships and bombs cleared must both be zero.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const SEAM0 = args.includes('--seam0');
const QUIET = args.includes('--quiet');
const CORE = (args.find((a) => a.startsWith('--core=')) || '--core=../src').slice(7);
const SORTIES = (args.find((a) => a.startsWith('--sorties=')) || '--sorties=on').slice(10);
if (!['on', 'off', 'grounded'].includes(SORTIES))
  throw new Error('--sorties= takes on, off or grounded');
const SEEDS = args.filter((a) => !a.startsWith('--')).map(Number);
if (SEEDS.length === 0) SEEDS.push(20260901, 20260902, 20260903, 20260904);

const base = new URL(CORE + '/', import.meta.url);
const { init, step, UNITS } = await import(new URL('sim.js', base).pathname);
const L = await import(new URL('state.js', base).pathname);
const HAS_AIR = typeof L.O_HELIS === 'number';
const { riflePost } = await import(new URL('rules/army.js', base).pathname);
const rifleStand = (anchor, i) => Math.max(Math.imul(-88, Q), Math.min(Math.imul(88, Q), riflePost(anchor, i)));
const air = HAS_AIR ? await import(new URL('rules/air.js', base).pathname) : null;
// A core from before rules/air.js has no sortie clock and no gunship slots, so
// there is nothing to hold down and the words the hold would write are not in
// its layout. That core is air-off already; asking for the flag on it is a
// mistake about which core is loaded, caught here rather than written to
// state[NaN].
if (SORTIES !== 'on' && !HAS_AIR)
  throw new Error(`--sorties=${SORTIES} wants a core with an air arm; ${CORE} has none (it is air-off already)`);

/** Which condition this run is under. Every line the tool prints carries it. */
const MODE = SORTIES;
const AIR_OFF = MODE === 'off' || MODE === 'grounded' || !HAS_AIR;
const cond = () => (MODE === 'on' ? `air=${HAS_AIR ? 'on' : 'off'}` : `air=held(${MODE})`);

/**
 * Long enough that the clock never runs out: 2^30 in Q16.16 is 16384 seconds
 * against a round of ninety, and launchSorties takes one tick off it per tick.
 */
const CLOCK_HIGH = 1 << 30;

/**
 * Holds the air down, from outside the rules. Called on the fresh state and
 * again after every tick. In 'off' nothing should ever be live here at all and
 * the counts are the evidence that the pin held; in 'grounded' the clearing IS
 * the suppression. The units, the squads, the tape and the stream are left
 * exactly as the core left them.
 */
function hold(st, tally) {
  if (MODE === 'on') return st;
  const s = st.i32;
  if (MODE === 'off') {
    s[L.O_AIR + L.AIR_BULL] = CLOCK_HIGH;
    s[L.O_AIR + L.AIR_BEAR] = CLOCK_HIGH;
  }
  for (let i = 0; i < L.MAX_HELIS; i++) {
    const o = L.heliBase(i);
    if (s[o + L.H_STATE] === 0) continue;
    s[o + L.H_STATE] = 0;
    tally.helis++;
  }
  for (let i = 0; i < L.MAX_BOMBS; i++) {
    const o = L.bombBase(i);
    if (s[o + L.B_STATE] === 0) continue;
    s[o + L.B_STATE] = 0;
    tally.bombs++;
  }
  return st;
}

const Q = 65536;
const q = (v) => v / Q;
const isArmour = (i) => (i & 3) === 0;
const BLAST = HAS_AIR ? q(air.BOMB_RADIUS) : 16;
const RIFLE_RANGE = 26;

// The battlefield a post can stand on. C# clamps to -FrontX+4 = 88 and the
// core clamps to the same number; the front swept below is that width.
const EDGE = 88;
const STEP = 0.25;

const ref = JSON.parse(readFileSync(new URL('../test/vectors/csharp-infantry.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// Is the core being run under the recording's own condition?
//
// Read off the recording's setup block rather than remembered here, so that a
// re-record that turns the air on cannot leave this tool quoting a pair that
// has stopped being a pair. Two things have to match, and only the depth
// comparison needs them: the air, and the seam. (The t=0 x geometry does not -
// it is formed at spawn, before either can have done anything.)
const REC_AIR_OFF = ref.setup.air === 'none';
const REC_SEAM0 = /z\s*=\s*0/.test(String(ref.setup.seam));
const mismatch = [];
if (REC_AIR_OFF !== AIR_OFF)
  mismatch.push(AIR_OFF
    ? `the recording is air-ON (setup.air=${JSON.stringify(ref.setup.air)}) and this core is air-off`
    : `this core is air-ON and the recording is air-off (setup.air=${JSON.stringify(ref.setup.air)})`);
if (REC_SEAM0 && !SEAM0) mismatch.push('the recording pins the seam at z=0 and this run does not (--seam0)');
const COMPARABLE = mismatch.length === 0;
const REC_TAG = COMPARABLE ? 'REC ' : 'REC*';

const refPass = (seed) => ref.passes[seed === 20260901 ? 'line' : `line-${seed}`];
const refRow = (seed, t) => {
  const p = refPass(seed);
  return p ? p.rows.find((r) => Math.abs(r.t - t) < 0.01) : null;
};

const dt = 1 / 60;
const TICKS = 90 * 60;
const SAMPLE = 5 * 60;

// ---------------------------------------------------------------------------
// System.Random, the seeded implementation Unity runs.
//
// Unity's Mono and .NET's Net5CompatSeedImpl are the same subtractive
// generator, kept bit-compatible across runtimes precisely so a seeded stream
// does not move. Reproduced here rather than trusted: see the replay check.
const MBIG = 2147483647, MSEED = 161803398;
function dotNetRandom(seed) {
  const S = new Int32Array(56);
  const subtraction = seed === -2147483648 ? 2147483647 : Math.abs(seed);
  let mj = (MSEED - subtraction) | 0, mk = 1;
  S[55] = mj;
  for (let i = 1; i < 55; i++) {
    const ii = (21 * i) % 55;
    S[ii] = mk;
    mk = (mj - mk) | 0;
    if (mk < 0) mk += MBIG;
    mj = S[ii];
  }
  for (let k = 1; k < 5; k++)
    for (let i = 1; i < 56; i++) {
      S[i] = (S[i] - S[1 + ((i + 30) % 55)]) | 0;
      if (S[i] < 0) S[i] += MBIG;
    }
  let inext = 0, inextp = 21;
  const sample = () => {
    let a = inext + 1, b = inextp + 1;
    if (a >= 56) a = 1;
    if (b >= 56) b = 1;
    let r = (S[a] - S[b]) | 0;
    if (r === MBIG) r--;
    if (r < 0) r += MBIG;
    S[a] = r; inext = a; inextp = b;
    return r * (1.0 / MBIG);
  };
  return { nextDouble: sample, next: (max) => Math.trunc(sample() * max) };
}

// ---------------------------------------------------------------------------
// Army.Populate, replayed. Float arithmetic throughout, because C#'s is float
// and the check below is to the printed digit.
const f = Math.fround;
const FRONT_X = 92, HALF_DEPTH = 79;
const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function populate(seed, armourPerSide, infantryPerSide) {
  const rng = dotNetRandom(seed);
  const Rand = (a, b) => f(f(a) + f(f(rng.nextDouble()) * f(f(b) - f(a))));
  const squads = { bull: [], bear: [] };
  const infantry = [];

  const ensureSquads = (key, strength) => {
    const want = Math.max(3, Math.trunc(strength / 12));
    while (squads[key].length < want) squads[key].push(Rand(-FRONT_X + 12, FRONT_X - 12));
  };

  const spawn = (key, vehicle) => {
    const x = Rand(-FRONT_X + 8, FRONT_X - 8);          // drawn, then thrown away for a man
    const dir = key === 'bull' ? 1 : -1;
    const z = f(-dir * f(HALF_DEPTH - Rand(0, 3)));
    const u = { side: key, x, z: cl(z, -HALF_DEPTH, HALF_DEPTH) };
    u.hp = vehicle ? Rand(6, 10) : 1;
    u.reload = Rand(0, 3);
    u.phase = Rand(0, 6.283);
    u.standoff = Rand(4, 12);
    if (!vehicle) {
      ensureSquads(key, infantryPerSide);
      u.squad = rng.next(squads[key].length);
      u.offX = Rand(-9, 9);
      u.offZ = Rand(-5, 5);
      u.height = Rand(0.92, 1.08);
      u.pace = Rand(0.82, 1.18);
      u.nextRest = Rand(2, 9);
      u.drift = Rand(-1, 1);
      u.x = cl(f(squads[key][u.squad] + u.offX), -FRONT_X + 4, FRONT_X - 4);
      infantry.push(u);
    }
    return u;
  };

  for (const key of ['bull', 'bear']) {
    for (let i = 0; i < armourPerSide; i++) spawn(key, true);
    for (let i = 0; i < infantryPerSide; i++) spawn(key, false);
  }
  return { squads, infantry };
}

/** Army.DriftSquads, run forward n ticks. Closed in Time alone, and clamped. */
function driftedAnchors(squads, ticks) {
  const out = { bull: squads.bull.slice(), bear: squads.bear.slice() };
  for (let n = 1; n <= ticks; n++) {
    const time = f(n * f(1 / 60));
    for (const key of ['bull', 'bear'])
      for (let i = 0; i < out[key].length; i++) {
        const drift = f(f(Math.sin(f(f(time * 0.12) + f(i * 2.4)))) * f(3.6 * f(1 / 60)));
        out[key][i] = cl(f(out[key][i] + drift), -FRONT_X + 12, FRONT_X - 12);
      }
  }
  return out;
}

/** The recording's t=0 row, which the replay has to reproduce to be usable. */
function replayCheck(seed) {
  const pass = refPass(seed);
  if (!pass) return { ok: false, why: `no pass for seed ${seed}` };
  const w = populate(seed, pass.armourPerSide, pass.infantryPerSide);
  const stats = (key) => {
    const g = w.infantry.filter((u) => u.side === key);
    let sum = 0; for (const u of g) sum = f(sum + u.z);
    const mean = f(sum / g.length);
    let v = 0; for (const u of g) v = f(v + f(f(u.z - mean) * f(u.z - mean)));
    return { n: g.length, z: mean, spread: f(Math.sqrt(f(v / g.length))) };
  };
  let nearest = Infinity, sum = 0, n = 0, inRange = 0;
  for (const a of w.infantry) {
    let best = Infinity;
    for (const b of w.infantry) {
      if (b.side === a.side) continue;
      const dx = f(b.x - a.x), dz = f(b.z - a.z);
      const d2 = f(f(dx * dx) + f(dz * dz));
      if (d2 < best) best = d2;
    }
    best = f(Math.sqrt(best));
    if (best < nearest) nearest = best;
    if (best < RIFLE_RANGE) inRange++;
    sum = f(sum + best); n++;
  }
  const bull = stats('bull'), bear = stats('bear'), r = pass.rows[0];
  const got = [bull.n, bull.z.toFixed(2), bull.spread.toFixed(2), bear.n, bear.z.toFixed(2),
               bear.spread.toFixed(2), f(nearest).toFixed(2), f(sum / n).toFixed(2), inRange].join(' ');
  const want = [r.bullInf.n, r.bullInf.z.toFixed(2), r.bullInf.spread.toFixed(2), r.bearInf.n,
                r.bearInf.z.toFixed(2), r.bearInf.spread.toFixed(2), r.nearestPair.toFixed(2),
                r.meanNearest.toFixed(2), r.inRifleRange].join(' ');
  return { ok: got === want, got, want, world: w };
}

// ---------------------------------------------------------------------------
// The five quantities, off a list of {side, x} posts and a list of anchors.
const sd = (xs, about) => {
  if (xs.length === 0) return 0;
  const m = about ?? xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
};

/**
 * Per squad: where it stands, how many are on it, how wide it stands, and how
 * far behind its anchor it is.
 *
 * Width is taken about the knot's OWN mean and not about the anchor, because
 * those are two different faults and one of them hides the other. An anchor
 * drifts at up to 3.6 m/s and a rifleman holds station at 2.6 (C#: 2.4 * pace,
 * 1.97 to 2.83), so a knot under a fast-moving anchor travels as a body some
 * metres behind it. Measured about the anchor that trail reads as width and a
 * ten-man knot standing five metres wide eight metres behind its mark scores
 * thirteen. `trail` is that displacement, kept separate.
 */
function knots(men, anchors, side) {
  return anchors.map((a, k) => {
    const xs = men.filter((u) => u.side === side && u.squad === k).map((u) => u.x);
    const mean = xs.length ? xs.reduce((p2, v) => p2 + v, 0) / xs.length : NaN;
    return { k, anchor: a, men: xs.length, width: sd(xs), trail: xs.length ? mean - a : 0,
             lo: xs.length ? Math.min(...xs) : NaN, hi: xs.length ? Math.max(...xs) : NaN };
  });
}

/** How close the two sides' knots come. Anchors only: this is the line's shape. */
function anchorPairs(bull, bear) {
  let min = Infinity, nBlast = 0, nRifle = 0;
  for (const a of bull) for (const b of bear) {
    const d = Math.abs(a - b);
    if (d < min) min = d;
    if (d <= BLAST) nBlast++;
    if (d <= RIFLE_RANGE) nRifle++;
  }
  return { min, nBlast, nRifle, pairs: bull.length * bear.length };
}

/**
 * What a bomb thrown at a random x would find.
 *
 * Along x only, and deliberately: x is the axis the squads set and the axis
 * (k) changed, and it is the one axis both engines can be read on at once.
 * A bomb catches nobody at all if it misses in x, so a dud in x is a dud; a
 * bomb that covers x on both sides still has to meet them in z, so `both` is
 * an upper bound on friendly fire and not a count of it.
 */
function front(men) {
  let cover = 0, both = 0, dud = 0, under = 0, samples = 0, rifleBoth = 0;
  const bull = men.filter((u) => u.side === 'bull').map((u) => u.x).sort((a, b) => a - b);
  const bear = men.filter((u) => u.side === 'bear').map((u) => u.x).sort((a, b) => a - b);
  const near = (xs, x, r) => xs.some((v) => Math.abs(v - x) <= r);
  const count = (xs, x, r) => xs.reduce((n, v) => n + (Math.abs(v - x) <= r ? 1 : 0), 0);
  for (let x = -EDGE; x <= EDGE + 1e-9; x += STEP) {
    const b1 = near(bull, x, BLAST), b2 = near(bear, x, BLAST);
    if (b1 || b2) cover++;
    if (b1 && b2) both++;
    if (!b1 && !b2) dud++;
    if (near(bull, x, RIFLE_RANGE) && near(bear, x, RIFLE_RANGE)) rifleBoth++;
    under += count(bull, x, BLAST) + count(bear, x, BLAST);
    samples++;
  }
  return { cover: cover / samples, both: both / samples, dud: dud / samples,
           rifleBoth: rifleBoth / samples, under: under / samples };
}

/** Spread of a side's riflemen in z - the one line-shape number the recording
 *  carries at EVERY sample, so the only over-time shape that can be compared
 *  engine to engine rather than projected. */
function zSpread(men) {
  const per = (key) => {
    const zs = men.filter((u) => u.side === key).map((u) => u.z);
    return { n: zs.length, z: zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : 0,
             spread: sd(zs) };
  };
  return { bull: per('bull'), bear: per('bear') };
}

const fmtKnots = (ks) => ks.map((k) => `${k.anchor.toFixed(1)}x${k.men}w${k.width.toFixed(1)}t${k.trail.toFixed(0)}`).join(' ');
const fmtFront = (fr) => `cover=${fr.cover.toFixed(2)} dud=${fr.dud.toFixed(2)} ` +
                         `both=${fr.both.toFixed(2)} rifleBoth=${fr.rifleBoth.toFixed(2)} ` +
                         `under=${fr.under.toFixed(1)}`;

// ---------------------------------------------------------------------------
// The core.
function pinSeam(st) { st.tape.fill(st.tape[0]); return st; }
const start = (seed, tally) => hold(SEAM0 ? pinSeam(init(seed)) : init(seed), tally);

function coreGeometry(st) {
  const s = st.i32;
  const anchors = { bull: [], bear: [] };
  for (let k = 0; k < L.SQUADS_PER_SIDE; k++) {
    anchors.bull.push(q(s[L.O_SQUADS + k]));
    anchors.bear.push(q(s[L.O_SQUADS + L.SQUADS_PER_SIDE + k]));
  }
  const men = [];
  for (let i = 0; i < UNITS; i++) {
    if (isArmour(i)) continue;
    const o = L.unitBase(i);
    if (s[o + L.U_STATE] === 0 || s[o + L.U_HP] <= 0) continue;
    const k = s[o + L.U_TARGET];
    const anchorK = s[o + L.U_SIDE] < 0 ? s[L.O_SQUADS + k] : s[L.O_SQUADS + L.SQUADS_PER_SIDE + k];
    men.push({ side: s[o + L.U_SIDE] < 0 ? 'bull' : 'bear', squad: k,
               x: q(s[o + L.U_X]), z: q(s[o + L.U_Z]),
               post: q(rifleStand(anchorK, i)) });
  }
  return { anchors, men };
}

/** Bull-bear pairs actually within a radius, in two dimensions. Core only. */
function realPairs(men, r) {
  const bull = men.filter((u) => u.side === 'bull'), bear = men.filter((u) => u.side === 'bear');
  let n = 0, min = Infinity;
  for (const a of bull) for (const b of bear) {
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < min) min = d;
    if (d <= r) n++;
  }
  return { n, min };
}

// ---------------------------------------------------------------------------
function measure(seed) {
  const chk = replayCheck(seed);
  console.log('');
  console.log(`SQUAD BEGIN seed=${seed}${SEAM0 ? ' seam0' : ''} ${cond()} ` +
              `blast=${BLAST} squads/side core=${L.SQUADS_PER_SIDE} ` +
              `rec=${chk.ok ? chk.world.squads.bull.length : '?'}`);
  if (!chk.ok) {
    console.log(`SQUAD REPLAY FAILED seed=${seed} - no C# geometry for this seed`);
    console.log(`SQUAD   replay ${chk.got}`);
    console.log(`SQUAD   record ${chk.want}`);
  } else {
    console.log(`SQUAD replay ok seed=${seed} (t=0 row reproduced to the digit: ${chk.want})`);
  }

  const tally = { helis: 0, bombs: 0 };
  const st = start(seed, tally);
  const rows = [];
  const recRows = [];

  const sample = (t, ticks) => {
    const g = coreGeometry(st);
    const kb = knots(g.men, g.anchors.bull, 'bull');
    const kr = knots(g.men, g.anchors.bear, 'bear');
    const ap = anchorPairs(g.anchors.bull, g.anchors.bear);
    const fr = front(g.men);
    const rp = realPairs(g.men, RIFLE_RANGE);
    const zs = zSpread(g.men);
    const lag = g.men.length
      ? g.men.reduce((a, u) => a + Math.abs(u.x - u.post), 0) / g.men.length : 0;
    const row = { t, kb, kr, ap, fr, rifle2d: rp.n, nearest2d: rp.min, lag,
                  zBull: zs.bull, zBear: zs.bear, men: g.men.length };
    rows.push(row);

    let rec = null;
    if (chk.ok) {
      const a = driftedAnchors(chk.world.squads, ticks);
      const men = chk.world.infantry.map((u) => ({
        side: u.side, squad: u.squad,
        x: cl(f(a[u.side][u.squad] + u.offX), -FRONT_X + 4, FRONT_X - 4),
      }));
      rec = { t, kb: knots(men, a.bull, 'bull'), kr: knots(men, a.bear, 'bear'),
              ap: anchorPairs(a.bull, a.bear), fr: front(men) };
      recRows.push(rec);
    }

    if (QUIET) return;
    const tag = t === 0 ? 'REC ' : 'PROJ';
    console.log(`SQUAD t=${t.toFixed(0).padStart(2)} core bull ${fmtKnots(kb)} | bear ${fmtKnots(kr)}`);
    if (rec)
      console.log(`SQUAD t=${t.toFixed(0).padStart(2)} ${tag} bull ${fmtKnots(rec.kb)} | bear ${fmtKnots(rec.kr)}`);
    console.log(`SQUAD t=${t.toFixed(0).padStart(2)} core pairs min=${ap.min.toFixed(1)} ` +
                `blast=${ap.nBlast}/${ap.pairs} rifle=${ap.nRifle}/${ap.pairs}  ${fmtFront(fr)}  ` +
                `2d rifle=${rp.n} nearest=${rp.min.toFixed(1)} men=${g.men.length}`);
    if (rec)
      console.log(`SQUAD t=${t.toFixed(0).padStart(2)} ${tag} pairs min=${rec.ap.min.toFixed(1)} ` +
                  `blast=${rec.ap.nBlast}/${rec.ap.pairs} rifle=${rec.ap.nRifle}/${rec.ap.pairs}  ${fmtFront(rec.fr)}`);
    const rr = refRow(seed, t);
    console.log(`SQUAD t=${t.toFixed(0).padStart(2)} zspread core bull ${zs.bull.n}@${zs.bull.z.toFixed(1)}sd${zs.bull.spread.toFixed(1)} ` +
                `bear ${zs.bear.n}@${zs.bear.z.toFixed(1)}sd${zs.bear.spread.toFixed(1)} lag=${lag.toFixed(1)}` +
                (rr ? `  | ${REC_TAG} bull ${rr.bullInf.n}@${rr.bullInf.z.toFixed(1)}sd${rr.bullInf.spread.toFixed(1)} ` +
                      `bear ${rr.bearInf.n}@${rr.bearInf.z.toFixed(1)}sd${rr.bearInf.spread.toFixed(1)}` : ''));
  };

  sample(0, 0);
  for (let n = 1; n <= TICKS; n++) {
    step(st, 0, 0, 0, 0, 0);
    // Between the tick and the sample, so nothing this tool reads ever sees an
    // aircraft the hold means to have taken away.
    hold(st, tally);
    if (n % SAMPLE === 0) sample(n * dt, n);
  }

  const held = rows.filter((r) => r.t >= 25);
  const recHeld = recRows.filter((r) => r.t >= 25);
  const span = (list, fn) => [Math.min(...list.map(fn)), Math.max(...list.map(fn))];
  const menPer = (r) => [...r.kb, ...r.kr].map((k) => k.men);
  const widths = (r) => [...r.kb, ...r.kr].map((k) => k.width);
  const flat = (list, fn) => [Math.min(...list.flatMap(fn)), Math.max(...list.flatMap(fn))];

  const shape = (r) => ({
    men: [Math.min(...menPer(r)), Math.max(...menPer(r))],
    width: [Math.min(...widths(r)), Math.max(...widths(r))],
    trail: Math.max(...[...r.kb, ...r.kr].map((k) => Math.abs(k.trail))),
    anchorMin: r.ap.min, cover: r.fr.cover, dud: r.fr.dud, both: r.fr.both,
    rifleBoth: r.fr.rifleBoth, under: r.fr.under,
  });

  const sum = {
    seed, ok: chk.ok,
    t0core: shape(rows[0]),
    t0rec: chk.ok ? shape(recRows[0]) : null,
    core: {
      men: flat(held, menPer), width: flat(held, widths),
      trail: span(held, (r) => Math.max(...[...r.kb, ...r.kr].map((k) => Math.abs(k.trail)))),
      anchorMin: span(held, (r) => r.ap.min), cover: span(held, (r) => r.fr.cover),
      dud: span(held, (r) => r.fr.dud), both: span(held, (r) => r.fr.both),
      rifleBoth: span(held, (r) => r.fr.rifleBoth), under: span(held, (r) => r.fr.under),
      rifle2d: span(held, (r) => r.rifle2d), nearest2d: span(held, (r) => r.nearest2d),
      lag: span(held, (r) => r.lag),
      zSpread: flat(held, (r) => [r.zBull.spread, r.zBear.spread]),
      zBull: span(held, (r) => r.zBull.z), zBear: span(held, (r) => r.zBear.z),
      standoff: flat(held, (r) => [Math.abs(r.zBull.z), Math.abs(r.zBear.z)]),
    },
    // The recording's own depth over the same window. Its rows carry mean z
    // and spread at every sample, which is the whole reason depth is a
    // comparison at all - but see COMPARABLE: it is air-off, and quoting it
    // beside an air-on core is what this tool got wrong before.
    recZ: (() => {
      const pass = refPass(seed);
      if (!pass) return null;
      const rs = pass.rows.filter((r) => r.t >= 25);
      const sp = rs.flatMap((r) => [r.bullInf.spread, r.bearInf.spread]);
      const bu = rs.map((r) => r.bullInf.z), be = rs.map((r) => r.bearInf.z);
      const so = rs.flatMap((r) => [Math.abs(r.bullInf.z), Math.abs(r.bearInf.z)]);
      return { spread: [Math.min(...sp), Math.max(...sp)],
               bull: [Math.min(...bu), Math.max(...bu)],
               bear: [Math.min(...be), Math.max(...be)],
               standoff: [Math.min(...so), Math.max(...so)] };
    })(),
    proj: chk.ok ? {
      men: flat(recHeld, menPer), width: flat(recHeld, widths),
      anchorMin: span(recHeld, (r) => r.ap.min), cover: span(recHeld, (r) => r.fr.cover),
      dud: span(recHeld, (r) => r.fr.dud), both: span(recHeld, (r) => r.fr.both),
      rifleBoth: span(recHeld, (r) => r.fr.rifleBoth), under: span(recHeld, (r) => r.fr.under),
    } : null,
  };

  const line = (tag, sh) =>
    `menPerKnot ${sh.men[0]}-${sh.men[1]} width ${sh.width[0].toFixed(1)}-${sh.width[1].toFixed(1)} ` +
    `trail<=${sh.trail.toFixed(1)} ` +
    `anchorMin=${sh.anchorMin.toFixed(1)} cover=${sh.cover.toFixed(2)} dud=${sh.dud.toFixed(2)} ` +
    `both=${sh.both.toFixed(2)} rifleBoth=${sh.rifleBoth.toFixed(2)} under=${sh.under.toFixed(1)}`;
  console.log(`SQUAD t0   core ${line('core', sum.t0core)}`);
  if (chk.ok) console.log(`SQUAD t0   REC  ${line('rec', sum.t0rec)}`);
  const c = sum.core;
  console.log(`SQUAD summary seed=${seed} core menPerKnot=${c.men[0]}-${c.men[1]} ` +
              `width=${c.width[0].toFixed(1)}-${c.width[1].toFixed(1)} ` +
              `trail=${c.trail[0].toFixed(1)}-${c.trail[1].toFixed(1)} ` +
              `anchorMin=${c.anchorMin[0].toFixed(1)}-${c.anchorMin[1].toFixed(1)} ` +
              `cover=${c.cover[0].toFixed(2)}-${c.cover[1].toFixed(2)} ` +
              `dud=${c.dud[0].toFixed(2)}-${c.dud[1].toFixed(2)} ` +
              `both=${c.both[0].toFixed(2)}-${c.both[1].toFixed(2)} ` +
              `under=${c.under[0].toFixed(1)}-${c.under[1].toFixed(1)} ` +
              `rifle2d=${c.rifle2d[0]}-${c.rifle2d[1]} ` +
              `nearest2d=${c.nearest2d[0].toFixed(1)}-${c.nearest2d[1].toFixed(1)} ` +
              `zSpread=${c.zSpread[0].toFixed(1)}-${c.zSpread[1].toFixed(1)} ` +
              `standoff=${c.standoff[0].toFixed(1)}-${c.standoff[1].toFixed(1)} ` +
              `lag=${c.lag[0].toFixed(1)}-${c.lag[1].toFixed(1)}` +
              (sum.recZ ? `   ${REC_TAG} zSpread=${sum.recZ.spread[0].toFixed(1)}-${sum.recZ.spread[1].toFixed(1)}` +
                          ` standoff=${sum.recZ.standoff[0].toFixed(1)}-${sum.recZ.standoff[1].toFixed(1)}` : ''));
  if (MODE !== 'on')
    console.log(`SQUAD summary seed=${seed} held gunships=${tally.helis} bombs=${tally.bombs}` +
                (MODE === 'off'
                  ? (tally.helis === 0 && tally.bombs === 0
                      ? '   (both zero: the clock pin held and nothing ever launched)'
                      : '   *** NOT ZERO: the clock pin did NOT hold - this run is not air-off ***')
                  : '   (cleared the tick they were filled; a bomb here would be a fault)'));
  if (chk.ok) {
    const p = sum.proj;
    console.log(`SQUAD summary seed=${seed} PROJ menPerKnot=${p.men[0]}-${p.men[1]} ` +
                `width=${p.width[0].toFixed(1)}-${p.width[1].toFixed(1)} ` +
                `anchorMin=${p.anchorMin[0].toFixed(1)}-${p.anchorMin[1].toFixed(1)} ` +
                `cover=${p.cover[0].toFixed(2)}-${p.cover[1].toFixed(2)} ` +
                `dud=${p.dud[0].toFixed(2)}-${p.dud[1].toFixed(2)} ` +
                `both=${p.both[0].toFixed(2)}-${p.both[1].toFixed(2)} ` +
                `under=${p.under[0].toFixed(1)}-${p.under[1].toFixed(1)}`);
  }
  return sum;
}

const all = SEEDS.map(measure);
const ok = all.filter((a) => a.ok);

const W = 18;
/** A range. Joined with `to` when an endpoint is negative, because `-54.9--10.1` is not a number anybody can read. */
const rng = (v, d) => (v[0] < 0 || v[1] < 0
  ? `${v[0].toFixed(d)} to ${v[1].toFixed(d)}`
  : `${v[0].toFixed(d)}-${v[1].toFixed(d)}`);
const pair = (name, core, other, label, d = 1) => {
  const left = `SQUAD ${name.padEnd(W)} core ${rng(core, d)}`;
  console.log(other ? left.padEnd(46) + `  ${label} ${rng(other, d)}` : left);
};
const merge = (list, pick) => [Math.min(...list.map((a) => pick(a)[0])), Math.max(...list.map((a) => pick(a)[1]))];
const one = (list, pick) => [Math.min(...list.map(pick)), Math.max(...list.map(pick))];

console.log('');
console.log(`SQUAD ENVELOPE seeds ${SEEDS.join(',')}  replayed ${ok.length}/${all.length}` +
            `  ${cond()}${SEAM0 ? ' seam0' : ''}`);
console.log('SQUAD');
console.log('SQUAD -- t=0: BOTH ENGINES MEASURED. Every man is on his post the tick he');
console.log('SQUAD    spawns, in both, so the whole x geometry is formed up and exact.');
pair('t0 menPerKnot', merge(all, (a) => a.t0core.men), ok.length ? merge(ok, (a) => a.t0rec.men) : null, 'REC ', 0);
pair('t0 knot width', merge(all, (a) => a.t0core.width), ok.length ? merge(ok, (a) => a.t0rec.width) : null, 'REC ');
pair('t0 knot trail', one(all, (a) => a.t0core.trail), ok.length ? one(ok, (a) => a.t0rec.trail) : null, 'REC ');
pair('t0 anchor min gap', one(all, (a) => a.t0core.anchorMin), ok.length ? one(ok, (a) => a.t0rec.anchorMin) : null, 'REC ');
pair('t0 front cover', one(all, (a) => a.t0core.cover), ok.length ? one(ok, (a) => a.t0rec.cover) : null, 'REC ', 2);
pair('t0 front dud', one(all, (a) => a.t0core.dud), ok.length ? one(ok, (a) => a.t0rec.dud) : null, 'REC ', 2);
pair('t0 front both', one(all, (a) => a.t0core.both), ok.length ? one(ok, (a) => a.t0rec.both) : null, 'REC ', 2);
pair('t0 rifleBoth', one(all, (a) => a.t0core.rifleBoth), ok.length ? one(ok, (a) => a.t0rec.rifleBoth) : null, 'REC ', 2);
pair('t0 men under blast', one(all, (a) => a.t0core.under), ok.length ? one(ok, (a) => a.t0rec.under) : null, 'REC ');
console.log('SQUAD');
console.log('SQUAD -- t>=25: the core is MEASURED. The other column is PROJ - the C#');
console.log('SQUAD    anchors drifted forward with the spawn membership frozen, so it');
console.log('SQUAD    is what the C# knots would be with nobody dying. Not a recording.');
pair('menPerKnot', merge(all, (a) => a.core.men), ok.length ? merge(ok, (a) => a.proj.men) : null, 'PROJ', 0);
pair('knot width', merge(all, (a) => a.core.width), ok.length ? merge(ok, (a) => a.proj.width) : null, 'PROJ');
pair('knot trail', merge(all, (a) => a.core.trail), null, '');
pair('anchor min gap', merge(all, (a) => a.core.anchorMin), ok.length ? merge(ok, (a) => a.proj.anchorMin) : null, 'PROJ');
pair('front cover', merge(all, (a) => a.core.cover), ok.length ? merge(ok, (a) => a.proj.cover) : null, 'PROJ', 2);
pair('front dud', merge(all, (a) => a.core.dud), ok.length ? merge(ok, (a) => a.proj.dud) : null, 'PROJ', 2);
pair('front both', merge(all, (a) => a.core.both), ok.length ? merge(ok, (a) => a.proj.both) : null, 'PROJ', 2);
pair('rifleBoth', merge(all, (a) => a.core.rifleBoth), ok.length ? merge(ok, (a) => a.proj.rifleBoth) : null, 'PROJ', 2);
pair('men under blast', merge(all, (a) => a.core.under), ok.length ? merge(ok, (a) => a.proj.under) : null, 'PROJ');
console.log('SQUAD');
console.log('SQUAD -- over the round: the line\'s DEPTH. The recording carries mean z and');
console.log('SQUAD    a z spread at every sample, so depth is the one shape number that can');
console.log('SQUAD    be laid engine to engine after t=0 - and the ONLY one whose comparison');
console.log('SQUAD    is conditional, because the air moves it.');
const withZ = all.filter((a) => a.recZ);
const recPick = (f) => (withZ.length ? merge(withZ, f) : null);
if (COMPARABLE) {
  console.log(`SQUAD    recording: air=${JSON.stringify(ref.setup.air)} seam=${JSON.stringify(ref.setup.seam)}`);
  console.log(`SQUAD    this run:  ${cond()}${SEAM0 ? ' seam0' : ''}  -> LIKE FOR LIKE, quote these two together.`);
  pair('z spread', merge(all, (a) => a.core.zSpread), recPick((a) => a.recZ.spread), 'REC ');
  pair('mean z bull', merge(all, (a) => a.core.zBull), recPick((a) => a.recZ.bull), 'REC ');
  pair('mean z bear', merge(all, (a) => a.core.zBear), recPick((a) => a.recZ.bear), 'REC ');
  pair('standoff |mean z|', merge(all, (a) => a.core.standoff), recPick((a) => a.recZ.standoff), 'REC ');
} else {
  console.log(`SQUAD    recording: air=${JSON.stringify(ref.setup.air)} seam=${JSON.stringify(ref.setup.seam)}`);
  console.log(`SQUAD    this run:  ${cond()}${SEAM0 ? ' seam0' : ''}`);
  for (const m of mismatch) console.log(`SQUAD    *** NOT COMPARABLE: ${m}.`);
  console.log('SQUAD    The REC depth column is WITHHELD. Half the core\'s riflemen are');
  console.log('SQUAD    killed by bombs and replaced from the edge over the round, and the');
  console.log('SQUAD    spread of a line is exactly what that moves. Run --sorties=off');
  console.log('SQUAD    --seam0 for the pair. (The t=0 x geometry above is unaffected: it');
  console.log('SQUAD    is formed at spawn, before the air or the seam can do anything.)');
  pair('z spread', merge(all, (a) => a.core.zSpread), null, '');
  pair('mean z bull', merge(all, (a) => a.core.zBull), null, '');
  pair('mean z bear', merge(all, (a) => a.core.zBear), null, '');
  pair('standoff |mean z|', merge(all, (a) => a.core.standoff), null, '');
  const w = recPick((a) => a.recZ.spread), t = recPick((a) => a.recZ.standoff);
  if (w) console.log(`SQUAD    (the recording's own, air-off, NOT to be paired with the above: ` +
                     `z spread ${w[0].toFixed(1)}-${w[1].toFixed(1)}, standoff ${t[0].toFixed(1)}-${t[1].toFixed(1)})`);
}
if (!COMPARABLE) console.log('SQUAD    * a REC* row above is the recording under a condition this run is not.');
console.log('SQUAD');
console.log('SQUAD -- core only: the recording has no positions after t=0.');
pair('post lag', merge(all, (a) => a.core.lag), null, '');
pair('rifle pairs 2d', merge(all, (a) => a.core.rifle2d), null, '', 0);
pair('nearest pair 2d', merge(all, (a) => a.core.nearest2d), null, '');
