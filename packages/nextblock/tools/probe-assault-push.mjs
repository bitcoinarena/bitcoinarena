// CAN A PLAYER SEE THE TANKS PUSH THE LANE? (the owner 2026-09-20, the second half of the 16:22 letter.)
//
// The core half is already measured and is not re-measured here: over eight seeds, 21 declared assaults, the
// attacking side's armour on the target lane advanced 14.56 m toward the enemy against 0.29 m for the same
// side's tanks off it (`measure-assault.mjs`, `measure-assault-clock.mjs`). What that cannot say is whether any
// of it reaches a player, which is the whole complaint: "assaults are not perceptible. the owner cannot see them."
//
// So this watches ONE live assault in a real GPU-Chrome player and asks three things, in the order that decides
// what - if anything - is still wrong:
//   1. do the attacking side's tanks move on the target lane, in metres, while the banner is up?
//   2. where is that lane relative to the truck the camera is following - ahead of it, behind it, how far?
//   3. what does the screen actually show - captures at the banner and through the push.
//
// NO NEW PAGE API. Everything is read from the buffer the page's own core already holds, the same way the other
// probes read i32[19] and i32[23]. The offsets come from packages/nextblock/src (state.js, rules/tactics.js):
//
//   O_TACTICS 2246   TAC_OBJ 61   TAC_ASSAULT 76      objective lane slot = s[O_TACTICS + TAC_OBJ + o] & 255
//   O_UNITS   26     U_WORDS  8   UNITS 96            unit i at O_UNITS + i * U_WORDS
//   ARMOUR_MASK 3                                     a tank is (i & 3) === 0; the other three are men
//   U_X 0  U_Z 1  U_SIDE 2  U_HP 3                    Q16.16 metres
//   slotX(slot) = -5308416 + slot * 1769472           so slot 3 is x 0 m and the pitch is 27 m
//   assault word  = s[O_TACTICS + TAC_ASSAULT + 3*si] target = w & 15, phase = (w >> 4) & 15 (0 idle 1 push 2 consolidate)
//
// MUST RUN ON A GPU BROWSER (packages/blwp-client/tools/gpu-chrome.sh). On SwiftShader the page runs the core at
// 23 ticks/s against the 60 a round keeps and the round closes under it before much happens.
//
//   node probe-assault-push.mjs <cdp-port> <url> <tag>
const PORT = Number(process.argv[2] || 9347);
const URL_ = process.argv[3] || 'https://btc-logistics-core.pages.dev/';
const TAG = process.argv[4] || 'push';
const OUT = '/tmp/btc-phase0/owner-screens/';
const PLAY = [504, 690], AUTO = [306, 751], ROLLOUT = [660, 751];
const LANE_HALF = 6;                       // the same window the core measurement used

let id = 0; const pend = new Map();
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result ?? d.error); pend.delete(d.id); } };
await new Promise((r) => { ws.onopen = r; });
await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await call('Network.clearBrowserCache');
const ev = (e) => call('Runtime.evaluate', { returnByValue: true, expression: e }).then((r) => r?.result?.value);
const click = async ([x, y]) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
  await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? 1 : 0 }); };
const shot = async (name) => { const s = await call('Page.captureScreenshot', { format: 'png' });
  if (s && s.data) { (await import('node:fs')).writeFileSync(OUT + name, Buffer.from(s.data, 'base64')); return name; } return null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE = `(function(){
  var m = window.unityInstance && window.unityInstance.Module;
  var st = m && m.blwp && m.blwp.st;
  if (!st) return JSON.stringify({ core: false });
  var s = st.i32, ONE = 65536;
  var O_TACTICS = 2246, TAC_OBJ = 61, TAC_ASSAULT = 76;
  var O_UNITS = 26, U_WORDS = 8, UNITS = 96, ARMOUR_MASK = 3;
  var sides = [];
  for (var si = 0; si < 2; si++) {
    var w = s[O_TACTICS + TAC_ASSAULT + 3 * si];
    var target = w & 15, phase = (w >> 4) & 15;
    var o = Math.min(target, 2);
    var slot = s[O_TACTICS + TAC_OBJ + o] & 255;
    sides.push({ si: si, phase: phase, target: o, laneX: (-5308416 + slot * 1769472) / ONE });
  }
  var tanks = [];
  for (var i = 0; i < UNITS; i++) {
    if ((i & ARMOUR_MASK) !== 0) continue;
    var b = O_UNITS + i * U_WORDS;
    if (s[b + 3] <= 0) continue;
    tanks.push({ i: i, x: s[b] / ONE, z: s[b + 1] / ONE, side: s[b + 2] < 0 ? -1 : 1 });
  }
  return JSON.stringify({ core: true, tick: s[0], elapsed: s[19], state: s[23],
    truck: { x: s[5] / ONE, z: s[6] / ONE, heading: (s[7] / ONE) * 360 },
    sides: sides, tanks: tanks,
    assault: window.BLWP_UNITY_ASSAULT || null }); })()`;

console.log(`renderer: ${await ev(`(function(){var c=document.createElement('canvas');var g=c.getContext('webgl2')||c.getContext('webgl');
  if(!g) return 'none'; var e=g.getExtension('WEBGL_debug_renderer_info');
  return e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER);})()`)}`);

await call('Page.navigate', { url: URL_ });
let ready = false;
for (let i = 0; i < 45; i++) {
  await sleep(4000);
  const showing = await ev('!!(window.BLWP_UNITY_LOBBY&&window.BLWP_UNITY_LOBBY.showing)');
  const rows = await ev('(function(){try{var v=window.BLWP_LOBBY_VIEW&&window.BLWP_LOBBY_VIEW();return v?(v.rows||[]).length:0;}catch(e){return 0;}})()');
  if (showing === true && rows > 0) { console.log(`  lobby with ${rows} round(s) at t+${i * 4}s`); ready = true; break; }
}
if (!ready) { console.log('  NO LOBBY - stopping'); process.exit(1); }
await click(PLAY); await sleep(14000);
await click(AUTO); await sleep(1500); await click(ROLLOUT); await sleep(3000);
console.log('  rolled out; watching for a declared assault\n');

const onLane = (o, side, laneX) => o.tanks.filter((t) => t.side === side && Math.abs(t.x - laneX) <= LANE_HALF);
const depth = (ts, side) => (ts.length ? ts.reduce((a, t) => a + t.z * side, 0) / ts.length : NaN);

let open = null, done = 0;
for (let i = 0; i < 300 && done < 1; i++) {
  await sleep(1000);
  let o; try { o = JSON.parse(await ev(STATE)); } catch { continue; }
  if (!o.core) continue;

  for (const sd of o.sides) {
    const side = sd.si === 0 ? -1 : 1, name = sd.si === 0 ? 'BULLS' : 'BEARS';
    if (sd.phase === 1 && (!open || open.si !== sd.si)) {
      const mine = onLane(o, side, sd.laneX);
      open = { si: sd.si, side, name, laneX: sd.laneX, t: i, target: sd.target,
               ids: new Set(mine.map((t) => t.i)), startDepth: depth(mine, side), startOn: mine.length,
               peakOn: mine.length, all: o.tanks.filter((t) => t.side === side).length };
      const banner = o.assault ? o.assault.banner : '(none)';
      console.log(`  t+${i}s  ASSAULT DECLARED: ${name} on ${['HIGH','LOW','OPEN'][sd.target]}, lane x ${sd.laneX.toFixed(1)} m`);
      console.log(`         banner on screen: "${banner}"`);
      console.log(`         truck at x ${o.truck.x.toFixed(1)} z ${o.truck.z.toFixed(1)}, heading ${o.truck.heading.toFixed(0)} deg`
        + `  -> the lane is ${Math.abs(o.truck.x - sd.laneX).toFixed(1)} m ${sd.laneX > o.truck.x ? 'east' : 'west'} of the truck`);
      console.log(`         ${mine.length} of ${open.all} ${name} tanks are on that lane at the start`);
      console.log(`  shot: ${await shot(`${TAG}-01-declared.png`)}`);
    } else if (open && open.si === sd.si && sd.phase === 1) {
      const mine = onLane(o, side, open.laneX);
      if (mine.length > open.peakOn) open.peakOn = mine.length;
      if ((i - open.t) === 8 || (i - open.t) === 20) {
        const same = o.tanks.filter((t) => open.ids.has(t.i) && t.side === side);
        const moved = Number.isFinite(open.startDepth) ? open.startDepth - depth(same, side) : NaN;
        console.log(`  t+${i}s  ${i - open.t}s into the push: ${mine.length} on the lane (peak ${open.peakOn}),`
          + ` the starters have advanced ${Number.isFinite(moved) ? moved.toFixed(1) + ' m' : 'n/a (none started on it)'}`);
        console.log(`  shot: ${await shot(`${TAG}-${(i - open.t) === 8 ? '02' : '03'}-pushing.png`)}`);
      }
    } else if (open && open.si === sd.si && sd.phase !== 1) {
      const mine = onLane(o, side, open.laneX);
      const same = o.tanks.filter((t) => open.ids.has(t.i) && t.side === side);
      const moved = Number.isFinite(open.startDepth) ? open.startDepth - depth(same, side) : NaN;
      const other = o.tanks.filter((t) => t.side === side && Math.abs(t.x - open.laneX) > LANE_HALF);
      console.log(`\n  t+${i}s  the push ended after ${i - open.t}s (${sd.phase === 2 ? 'TAKEN' : 'FAILED'})`);
      console.log(`         on-lane tanks: ${open.startOn} at the start, peak ${open.peakOn}, ${mine.length} at the end`);
      console.log(`         those starters advanced ${Number.isFinite(moved) ? moved.toFixed(1) + ' m' : 'n/a'} toward the enemy`);
      console.log(`         the side's other ${other.length} tanks sit at mean depth ${depth(other, side).toFixed(1)} m`);
      console.log(`  shot: ${await shot(`${TAG}-04-ended.png`)}`);
      // A PUSH THAT LASTED A SECOND IS NOT A MEASUREMENT. Joining a round mid-assault catches one already
      // ending, and an advance read over one second is noise, not tank movement. Keep watching for one long
      // enough to have checkpoints in it.
      if ((i - open.t) >= 6) done++;
      else console.log(`         (too short to measure - still watching for a full push)`);
      open = null;
    }
  }
  if (i % 30 === 0 && !open) console.log(`    t+${i}s  elapsed ${o.elapsed}, no assault declared yet`);
}
if (!done) console.log('\n  NO ASSAULT ran to an end inside the window');
process.exit(done ? 0 : 2);
