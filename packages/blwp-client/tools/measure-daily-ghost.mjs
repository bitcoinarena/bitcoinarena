// WHAT A PLAYER'S GHOST ACTUALLY DOES ON THE DAILY, AND WHETHER THE SIGNER NODES' LEFTOVER STALLS MOVE IT
// (the owner 2026-09-17 19:15, the ghost letter's remainder: live nodes are median 14 ms and p90 21 ms, with a max of
// 552 ms and two stalls over 300 ms a minute, attributed to the close / finality path).
//
//     node tools/measure-daily-ghost.mjs [--minutes=10] [--daily=/mnt/bitcoin/blwp-2of2]
//
// THREE STREAMS AT ONCE, from outside the daemons:
//   the DRIVER   a stake-0 entry in the Daily's free round, recording a tick every 1/60 s and draining every sixth,
//                which is `BlwpNet.BatchEvery` and the drain rule the page ships. The truck is parked - the pictures
//                are what is measured, not where they are.
//   the WATCHER  a second stake-0 entry in the same round, subscribed, recording every picture of the driver: when it
//                arrived and which tick it names. A picture is never sent to the entry that made it (`interestSet`
//                drops the viewer), so watching needs its own seat - two tabs, as a player would have.
//   the PINGER   both nodes' /play sockets at 10 Hz. A text frame is answered on the event loop, so a gap in the
//                answers is the loop held, whatever held it.
// And the daemons' own log is tailed with an arrival stamp per line, so a stall can be ATTRIBUTED: close / finality
// only when a [close], [verify], [settle], [payout] or [custody] line falls inside that stall's window, and
// unattributed otherwise. Nothing here is assumed.
//
// NOTHING IN THIS FILE IS AN INPUT TO ANYBODY'S SIMULATION. It drives one truck of its own and reads pictures.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import WebSocket from 'ws';

import { Client } from '../src/client.js';
import { joinFromQuery, tabSeed, playerFor, entryFor } from '../src/join.js';
import { watchGhosts, SILENT_MS, tickClock } from '../src/ghost-field.js';
import { fetchLobby } from '../src/lobby.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const MINUTES = Number(arg('minutes', 10));
const DAILY = arg('daily', process.env.BLWP_2OF2_DIR || '/mnt/bitcoin/blwp-2of2');
const STALL_MS = 300;                      // the leftover stalls this letter is about
const RETIRE_MS = SILENT_MS;               // a truck with no picture for this long is taken away (ghost-field.js)
const FELT_MS = 600;                       // the top of what the owner reported feeling: "300-600 ms"

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const storage = () => { const held = new Map(); return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) }; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (ms) => new Date(ms).toISOString().slice(11, 23);
const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null);
const ms = (x) => (x === null || x === undefined ? '-' : `${Math.round(x)} ms`);

const daily = JSON.parse(readFileSync(`${DAILY}/daily.json`, 'utf8'));
const NODES = daily.node;
const say = (line) => console.log(line);

/** Every stall of a node's event loop, as a 10 Hz pinger on /play sees it. */
function pinger(url, until) {
  const held = { stalls: [], rtts: [], closed: false };
  (async () => {
    for (;;) {
      if (Date.now() >= until) return;
      let sock;
      try {
        sock = new WebSocket(`${url.replace(/^http/, 'ws')}/play`);
        await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });
      } catch { await wait(1000); continue; }
      let gone = null;
      const dropped = () => { gone = new Error('the socket closed'); };
      sock.once('close', dropped);
      try {
        while (Date.now() < until) {
          if (gone) throw gone;
          const at = Date.now(), t = performance.now();
          await new Promise((r, j) => { sock.once('message', r); sock.send('hello'); setTimeout(() => (gone ? j(gone) : null), 15000); });
          const took = performance.now() - t;
          held.rtts.push(took);
          if (took > STALL_MS) held.stalls.push({ at, ms: took });
          await wait(100);
        }
      } catch { held.closed = true; }
      try { sock.close(); } catch { /* gone */ }
    }
  })();
  return held;
}

/** The daemons' own log, each line stamped when it arrived here. */
function logTail(until) {
  const lines = [];
  const tail = spawn('tail', ['-f', '-n0', `${DAILY}/daily.log`]);
  let rest = '';
  tail.stdout.on('data', (b) => {
    rest += b.toString();
    const parts = rest.split('\n');
    rest = parts.pop();
    for (const l of parts) if (l.trim()) lines.push({ at: Date.now(), line: l });
  });
  setTimeout(() => { try { tail.kill(); } catch { /* gone */ } }, Math.max(0, until - Date.now()) + 2000);
  return { lines, stop: () => { try { tail.kill(); } catch { /* gone */ } } };
}

/**
 * One seat in the round: a client that has joined, connected and been told which round it plays.
 *
 * A NODE THAT HAS JUST STARTED IS ASKED AGAIN. It reads an old round's chain view before it answers for it, so the
 * first seats after a restart are refused with that in words; the lobby page retries, and so does this.
 */
async function seat(named, roundIdHex, until = Date.now() + 120000) {
  for (;;) {
    try { return await seated(named, roundIdHex); }
    catch (e) {
      if (Date.now() >= until || !/still reading its chain view|no beacon|randomness/.test(e.message)) throw e;
      await wait(5000);
    }
  }
}

async function seated(named, roundIdHex) {
  const secret = ed25519.utils.randomSecretKey();
  const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
  const built = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
  const client = await Client.at({
    headers: named.chain.headers, bonds: named.chain.bonds,
    signedAdvert: fromHex(named.advert.signedAdvert), committee: named.round.nodes,
  }, {
    core: { hash: (st) => core.hash(st) },
    sign: (id) => ed25519.sign(id, secret),
    verify, contract: named.round, roundIdGiven: fromHex(roundIdHex),
  });
  const rid = await client.openRound(named.round);
  const entry = { ...built, roundId: rid, sessionPubkey: ed25519.getPublicKey(secret) };
  const eid = await client.join(entry);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
  return { client, rid, eid };
}

/** An open free round with enough entry window left to drive in. */
async function freeRound(until) {
  // A KEEPER THAT HAS JUST CLOSED ONE HAS NOT OPENED THE NEXT YET: asked again every 5 s rather than given up on, which
  // is what the lobby page does. Only a window that ends with none is an error.
  for (;;) {
    const lobby = await fetchLobby({ nodes: NODES, verify }).catch(() => ({ rows: [] }));
    const open = (lobby.rows || []).filter((r) => r.phase === 'open' && r.free && r.joinable
      && Number(r.entryCloseMs || 0) > Date.now() + 20000);
    const pick = open.sort((a, b) => Number(b.entryCloseMs || 0) - Number(a.entryCloseMs || 0))[0];
    if (pick) return pick.id;
    if (Date.now() >= until - 20000) return null;
    await wait(5000);
  }
}

const until = Date.now() + MINUTES * 60000;
const pings = NODES.map((n) => ({ node: n, held: pinger(n, until) }));
const log = logTail(until);
// THE TWO CLOCKS A PAIR OF TABS HAS (the owner 2026-09-18 04:05: print the overlay age beside the wire lag). The driver
// stamps the tick it has just recorded, exactly as blwp.jslib does on every batch slot; the watcher reads those stamps
// back over the same channel, exactly as the overlay does. One browser, two tabs.
const driverClock = tickClock({ Channel: BroadcastChannel, name: 'blwp-daily-ghost' });
const watcherClock = tickClock({ Channel: BroadcastChannel, name: 'blwp-daily-ghost' });
const overlayAges = [];         // what the label would print
const wireLags = [];            // now, less the moment the driver recorded that very tick
// AND WHERE THE DRAWN TRUCK ACTUALLY SITS (the owner 2026-09-18 04:30). `GhostTruck` walks from the pose it is standing on
// to each new picture over one picture interval (PictureSeconds 0.1 s) and the label is re-read every 0.1 s, so the eye
// is behind the number. The drawn truck is on the PREVIOUS picture when a new one lands and reaches the new one an
// interval later: its age is the age of the pose it is standing on, which is this picture's age plus the gap it has not
// yet crossed. Measured here from the same pictures, not asserted.
// Read from the shipped C# rather than typed here, so this measures what the page does.
const csOf = (file, what, orElse) => {
  const text = readFileSync(new URL(`../../../unity-proto/Assets/Scripts/Blwp/${file}`, import.meta.url).pathname, 'utf8');
  const found = text.match(what);
  if (!found) {
    if (orElse !== undefined) return orElse;
    throw new Error(`${file} no longer says ${what}`);
  }
  return Math.round(Number(found[1]) * 1000);
};
// Zero once nothing walks: the page has no ease left to be behind by, and that is a fact about the shipped C# rather
// than a number this file decided.
const EASE_MS = csOf('GhostTruck.cs', /PictureSeconds = ([0-9.]+)f/, 0);
const LABEL_REFRESH_MS = csOf('GhostField.cs', /labelsReadAt < ([0-9.]+)f/);
const easedAges = [];
const acrossInterval = [];
// AND WHERE THE HULL IS POINTING (the owner 2026-09-18 05:45). The place binds in the landing frame; the facing was still
// walked from the pose before it over one ease, so at land the hull still pointed the way the PREVIOUS picture said -
// which is the whole-interval term the place has just lost. Measured the same way and against the same land-frame
// clock, and decided by the shipped C# rather than by a number typed here.
const facingAges = [];
// AND THE FIRST PICTURE OF A NEW ROUND, DRAWN (the owner's report: after PLAY the other truck missing, then in the wrong
// place). The wire says when it arrived; this says how old the pose the hull stands in is at that frame.
const firstDrawn = [];
const behind = [];              // how many ticks the pictured pose trails the driver's own tick, per picture
// The body of `Show(int, int, int, float?)` alone, so "the facing binds in the landing frame" is read where it would
// happen and not off `Ease`, which sets the same fields every frame.
const showBody = (cs) => {
  const at = cs.indexOf('public void Show(int x, int z, int heading, float? y)');
  return at < 0 ? '' : cs.slice(at, cs.indexOf('/// <summary>', at) < 0 ? cs.length : cs.indexOf('/// <summary>', at));
};
const ghostTruckCs = readFileSync(new URL('../../../unity-proto/Assets/Scripts/Blwp/GhostTruck.cs', import.meta.url).pathname, 'utf8');
let lastPictureAt = null, lastPictureTick = null;
let stamped = 0, guessed = 0;
const pictures = [];            // { at, tick, session } of the driver, as the watcher was shown them
const theirs = new Set();       // every driver entry this probe has had, so a picture of a round we left is counted
const sessions = [];
let session = 0;                // a round change is this probe's own, not the nodes': its gap is not a ghost's

say(`# the Daily, ${MINUTES} min: a stake-0 driver and a watcher in the free round, both nodes pinged at 10 Hz`);
while (Date.now() < until - 20000) {
  const roundIdHex = await freeRound(until);
  if (!roundIdHex) { say('the Daily listed no joinable free round for the rest of the window'); break; }
  const named = await joinFromQuery(`?round=${roundIdHex}&node=${NODES.join(',')}&bond=${daily.bond}&advert=${daily.advert}`);
  const driver = await seat(named, roundIdHex);
  const watcher = await seat(named, roundIdHex);
  const field = watchGhosts(watcher.client, { roundId: watcher.rid, entryId: watcher.eid });
  await field.watching;
  const was = watcher.client.onGhost;
  session++;
  const here = session;
  const mine = toHex(driver.eid);
  // THE SECOND ROUND, ON THE WIRE (the owner 2026-09-17 19:15: "in the second round the ghost does not appear reliably -
  // sometimes missing, then at the wrong position"). For every round after the first: when the first picture of this
  // round's driver arrived, measured from the driver's first published tick, and how far behind the driver that
  // picture was. A picture that names an entry of a round this pair has left is counted apart - that is the "wrong
  // place" a player sees when an old truck is still drawn.
  const began = { pictures: 0, firstAt: null, firstTick: null, stale: 0, wouldHaveRetired: 0 };
  lastPictureAt = null; lastPictureTick = null;   // a new round destroys every truck: nothing is walked from
  watcher.client.onGhost = (g) => {
    if (toHex(g.entryId) === mine) {
      if (began.firstAt === null) { began.firstAt = Date.now(); began.firstTick = g.tick; }
      began.pictures++;
      const now = Date.now();
      // THE LABEL'S OWN NUMBER: the driver's clock for the tick this picture names, read back through the stamps.
      const sent = watcherClock.sentMs(mine, g.tick);
      if (sent === null) guessed++; else { stamped++; overlayAges.push(now - sent); }
      // AND THE WIRE: the same picture against the moment the driver actually recorded that tick.
      if (recordedAt[g.tick] !== undefined) wireLags.push(now - recordedAt[g.tick]);
      // A SILENCE LONG ENOUGH THAT THE OLD RULE WOULD HAVE TAKEN THE TRUCK AWAY - the missing-then-wrong-place shot.
      if (lastPictureAt !== null && now - lastPictureAt > RETIRE_MS) began.wouldHaveRetired++;
      // THE POSE ON SCREEN AT THE MOMENT THIS PICTURE LANDS: still the previous one, and the label still shows what it
      // read up to a refresh ago. Its age is that older picture's own age plus the ease and the refresh it is behind.
      // AT THE LAND INSTANT: what the hull is standing on in the frame this picture arrives. It is this picture's own
      // age once the pose binds at land; it was the previous picture's while the truck walked.
      const bindsAtLand = /transform.position = _want;|transform.SetPositionAndRotation\(_want/.test(ghostTruckCs);
      const drawnAge = recordedAt[g.tick] !== undefined && (bindsAtLand || lastPictureTick === null)
        ? (now - recordedAt[g.tick]) + LABEL_REFRESH_MS
        : (lastPictureAt !== null && recordedAt[lastPictureTick] !== undefined
          ? (now - recordedAt[lastPictureTick]) + EASE_MS + LABEL_REFRESH_MS : null);
      if (drawnAge !== null) easedAges.push(drawnAge);
      // THE FACING IN THAT SAME FRAME. A truck the field has just made stands and points at its first picture at once
      // (`_placed` is false, so there is no earlier pose to walk from, and a new round destroys every truck at tick
      // -2). After that the facing either binds with the place or is still the one before it.
      const facingBinds = /_wantHeading, 0f\)\);\s*$|SetPositionAndRotation\(_want, Quaternion.Euler\(0f, _wantHeading/m
        .test(showBody(ghostTruckCs));
      if (recordedAt[g.tick] !== undefined && (facingBinds || lastPictureTick === null)) {
        facingAges.push((now - recordedAt[g.tick]) + LABEL_REFRESH_MS);
      } else if (lastPictureTick !== null && recordedAt[lastPictureTick] !== undefined) {
        facingAges.push((now - recordedAt[lastPictureTick]) + LABEL_REFRESH_MS);
      }
      // AND THE FIRST PICTURE OF THIS ROUND, DRAWN: the hull was made this frame, so the place it stands in is this
      // picture's own. Recorded apart so PLAY-again is a number on screen and not only on the wire.
      if (began.pictures === 1 && drawnAge !== null) firstDrawn.push({ session: here, age: drawnAge });
      // AND HOW FAR BEHIND THE DRIVER THE PICTURE ITSELF IS, ALL ROUND LONG (the owner 2026-09-18 10:42: "position is
      // only correct at the start; the longer the other truck drives, the more the ghost is in the wrong place").
      // The first picture of a round was already measured at 1-4 ticks; this asks whether that grows. A tick is
      // 1/60 s, so the metres are the other truck's speed times this.
      behind.push({ at: began.pictures, ticks: tick - g.tick });
      // AND ACROSS THE WHOLE INTERVAL: the pose ages until the next picture lands, so the eye's average is the age at
      // land plus half a gap.
      if (lastPictureAt !== null) acrossInterval.push((now - lastPictureAt) / 2);
      lastPictureAt = now; lastPictureTick = g.tick;
      pictures.push({ at: now, tick: g.tick, session: here });
    } else if (theirs.has(toHex(g.entryId))) began.stale++;
    was(g);
  };
  theirs.add(mine);

  const drivingFrom = Date.now();
  const recordedAt = [];
  let tick = 0, ended = null;
  // THE PAGE'S OWN CADENCE: a tick every 1/60 s on the wall clock, `drain()` on every sixth, and nothing recorded once
  // the core's run is over - `blwp.jslib`'s `net.tick`.
  while (Date.now() < until && !ended) {
    const due = Math.floor((Date.now() - drivingFrom) / (1000 / 60));
    while (tick <= due) {
      if (driver.client.runOver()) { ended = 'the run reached its last tick'; break; }
      if (!driver.client.record([0, 0, 0, 0, 0])) { ended = driver.client.endedWhy || 'the client stopped recording'; break; }
      recordedAt[tick] = Date.now();
      tick++;
      // The page's own cadence, and its stamp with it: the newest recorded tick and the clock at that moment.
      if (tick % 6 === 0) { driverClock.post(mine, tick - 1); driver.client.drain(); }
      // AND THE WATCHER'S FIELD IS DRAINED THE WAY UNITY DRAINS IT - every frame (the owner 2026-09-18 11:45). Without
      // this the field's own silence rule never ran here at all, so this probe reported "retired for silence 0"
      // whether the rule took a truck away or not, and that number said nothing about the page.
      field.drain(24);
    }
    if (driver.client.ended) ended = ended || 'the run ended';
    await wait(4);
  }
  // LEAVING CLEANLY: what is held goes out, then the sockets close - a silent truck is retired by everybody watching.
  for (let i = 0; i < 20 && driver.client.hold.length && !driver.client.ended; i++) { try { await driver.client.drain(); } catch { break; } await wait(50); }
  sessions.push({ round: roundIdHex.slice(0, 16), ticks: tick, seconds: ((Date.now() - drivingFrom) / 1000).toFixed(0),
    firstPictureMs: began.firstAt === null ? null : began.firstAt - drivingFrom,
    firstPictureBehind: began.firstTick === null ? null : Math.max(0, Math.round((began.firstAt - drivingFrom) / (1000 / 60)) - began.firstTick),
    stalePictures: began.stale,
    why: ended || 'the window closed', pictures: pictures.filter((x) => x.session === here).length,
    // WHAT THE PAGE'S OWN RULE DID: a truck silent for SILENT_MS is retired, and this counts the times it happened.
    silenced: field.silenced | 0, retired: field.retired | 0, collapsed: field.collapsed | 0,
    wouldHaveRetired: began.wouldHaveRetired });
  try { driver.client.close(); } catch { /* gone */ }
  try { watcher.client.close(); } catch { /* gone */ }
  if (Date.now() < until - 20000) await wait(1000);
}
await wait(1500);
log.stop();

// ---- what it saw ---------------------------------------------------------------------------------------------
const gaps = [];
for (let i = 1; i < pictures.length; i++) {
  if (pictures[i].session !== pictures[i - 1].session) continue;    // this probe left one round and joined the next
  gaps.push({ at: pictures[i].at, ms: pictures[i].at - pictures[i - 1].at });
}
const sortedGaps = gaps.map((g) => g.ms).sort((a, b) => a - b);
const CAUSE = /\[(close|verify|settle|payout|custody)\]/;
const all = [];
for (const p of pings) for (const s of p.held.stalls) all.push({ node: p.node, ...s });
all.sort((a, b) => a.at - b.at);
// A stall's window is the ping that was held: from when it was sent to when it was answered.
const attributed = all.map((s) => {
  const from = s.at, to = s.at + s.ms;
  const lines = log.lines.filter((l) => l.at >= from - 250 && l.at <= to + 250);
  const cause = lines.find((l) => CAUSE.test(l.line));
  const gap = gaps.find((g) => g.at - g.ms <= to && g.at >= from);
  return { ...s, cause: cause ? cause.line.match(CAUSE)[1] : null, gap: gap ? gap.ms : null };
});
const withCause = attributed.filter((s) => s.cause);
const overRetire = attributed.filter((s) => s.ms >= RETIRE_MS);
const byNode = (n) => attributed.filter((s) => s.node === n);

say('');
sessions.forEach((s, i) => say(`round ${i + 1} ${s.round}: ${s.ticks} ticks in ${s.seconds} s, ${s.pictures} pictures, `
  + `first picture ${s.firstPictureMs === null ? 'never' : `${s.firstPictureMs} ms in, ${s.firstPictureBehind} tick(s) behind the driver`}`
  + `, pictures of a round this pair had left ${s.stalePictures}, taken away for silence ${s.retired}`
  + `, silences past ${RETIRE_MS} ms that used to take it away ${s.wouldHaveRetired} - ${s.why}`));
say(`pictures of the driver: ${pictures.length} in ${MINUTES} min `
  + `(${(pictures.length / (MINUTES * 60)).toFixed(1)}/s; a driving page publishes 10/s)`);
say(`picture gaps: p50 ${ms(pct(sortedGaps, 0.5))}, p90 ${ms(pct(sortedGaps, 0.9))}, max ${ms(sortedGaps[sortedGaps.length - 1])}; `
  + `over ${FELT_MS} ms: ${sortedGaps.filter((g) => g > FELT_MS).length}; over ${RETIRE_MS} ms (a truck is retired): `
  + `${sortedGaps.filter((g) => g >= RETIRE_MS).length}`);
const sortNum = (xs) => xs.slice().sort((a, b) => a - b);
const oa = sortNum(overlayAges), wl = sortNum(wireLags);
say(`the age the overlay would print: p50 ${ms(pct(oa, 0.5))}, p90 ${ms(pct(oa, 0.9))}, max ${ms(oa[oa.length - 1])} `
  + `(${stamped} stamped, ${guessed} with no stamp - those print "~" and are time since arrival)`);
say(`the same pictures on the wire: p50 ${ms(pct(wl, 0.5))}, p90 ${ms(pct(wl, 0.9))}, max ${ms(wl[wl.length - 1])} `
  + `(the driver's own record of that tick to this watcher)`);
const ea = sortNum(easedAges);
say(`the page eases over ${EASE_MS} ms and re-reads the label every ${LABEL_REFRESH_MS} ms`);
const ai = sortNum(acrossInterval);
say(`and it ages until the next picture lands: add p50 ${ms(pct(ai, 0.5))} across an interval`);
say(`where the drawn truck sits at the moment a picture lands: p50 ${ms(pct(ea, 0.5))}, `
  + `p90 ${ms(pct(ea, 0.9))}, max ${ms(ea[ea.length - 1])}; over 300 ms ${ea.filter((x) => x > 300).length} of ${ea.length}, `
  + `over 600 ms ${ea.filter((x) => x > 600).length}`);
// DOES IT GROW? The same list, cut in three by position in the round.
if (behind.length > 30) {
  const third = Math.floor(behind.length / 3);
  const cut = (xs) => { const s = xs.map((b) => b.ticks).sort((a, b) => a - b); return `p50 ${pct(s, 0.5)}, p90 ${pct(s, 0.9)}, max ${s[s.length - 1]}`; };
  say(`how far behind the driver each picture is, in ticks (1/60 s each): first third ${cut(behind.slice(0, third))}; `
    + `middle ${cut(behind.slice(third, 2 * third))}; last third ${cut(behind.slice(2 * third))}`);
}
const fa = facingAges.slice().sort((a, b) => a - b);
say(`where the hull is POINTING at that same moment: p50 ${ms(pct(fa, 0.5))}, p90 ${ms(pct(fa, 0.9))}, `
  + `max ${ms(fa[fa.length - 1])}; over 300 ms ${fa.filter((x) => x > 300).length} of ${fa.length}, `
  + `over 600 ms ${fa.filter((x) => x > 600).length}`);
say(`the first picture of each round, drawn: ${firstDrawn.map((f) => ms(f.age)).join(', ')} `
  + `(the pose the hull stands in on the frame a new round's truck is made)`);
for (const p of pings) {
  const r = p.held.rtts.slice().sort((a, b) => a - b);
  say(`${p.node.replace('https://', '')}: ${r.length} pings, median ${ms(pct(r, 0.5))}, p90 ${ms(pct(r, 0.9))}, `
    + `max ${ms(r[r.length - 1])}, stalls over ${STALL_MS} ms: ${byNode(p.node).length}`);
}
say(`stalls over ${STALL_MS} ms: ${all.length} in ${MINUTES} min; close/finality ${withCause.length}, unattributed ${all.length - withCause.length}`);
const causes = {};
for (const s of withCause) causes[s.cause] = (causes[s.cause] || 0) + 1;
say(`  by the line in the window: ${Object.entries(causes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
say(`  longest: ${attributed.slice().sort((a, b) => b.ms - a.ms).slice(0, 6).map((s) => `${stamp(s.at)} ${Math.round(s.ms)} ms ${s.cause || 'unattributed'}`).join('; ') || 'none'}`);
say(`  over ${RETIRE_MS} ms (long enough to retire a truck): ${overRetire.length}`);
const covering = attributed.filter((s) => s.gap !== null);
say(`  with a picture gap inside them: ${covering.length}; the gaps they cover: `
  + `p50 ${ms(pct(covering.map((s) => s.gap).sort((a, b) => a - b), 0.5))}, `
  + `max ${ms(covering.length ? Math.max(...covering.map((s) => s.gap)) : null)}`);
say(`  and the picture gaps over ${FELT_MS} ms that no stall covers: `
  + `${gaps.filter((g) => g.ms > FELT_MS && !attributed.some((s) => g.at - g.ms <= s.at + s.ms && g.at >= s.at)).length}`);
process.exit(0);
