// THE THREE THINGS THE 18:56 / 18:59 LETTER ASKS FOR, IN A REAL PLAYER (the owner 2026-09-20).
//
//   1. the centre line still reaches the gate and still DELIVERS
//   2. driving into a gold coin stack stops the truck instead of passing through it
//   3. driving west at the Mempool stops ON the yellow line, not 14 m inside the building
//
// Each is driven in the page's own core with `window.BLWP.teleport`, and read back from
// `unityInstance.Module.blwp.st.i32` - never from PhysX, whose Rigidbody is kinematic while the core drives.
// The truck is placed, the throttle is held, and where it comes to rest is the answer.
//
//   i32[0] tick   i32[5] T_X   i32[6] T_Z   i32[19] S_ELAPSED   i32[23] S_STATE (1 = DELIVERED)
//
// The numbers to beat, all measured in node on the same core first:
//   centre line          RUN_DELIVERED
//   coin, from the north nose stops north of z 59.4 (it used to pass straight through)
//   mempool, driving west nose stops at x -114.40, the wall's east face, where `port_guard_post_*` - every
//                        part drawn in bumper_guard_yellow on that facade - spans x -114.95 .. -113.94.
//                        Before the fix it ran to x -180.22, the west map edge, out of the back of the building.
//
// MUST RUN ON A GPU BROWSER (packages/blwp-client/tools/gpu-chrome.sh).
//
//   node probe-solid-world.mjs <cdp-port> <url> <tag>
const PORT = Number(process.argv[2] || 9347);
const URL_ = process.argv[3] || 'https://btc-logistics-core.pages.dev/';
const TAG = process.argv[4] || 'solid';
const OUT = '/tmp/btc-phase0/owner-screens/';
const PLAY = [504, 690], AUTO = [306, 751], ROLLOUT = [660, 751];
const ONE = 65536;
const EAST = 16384, SOUTH = 32768, WEST = 49152;
const BODY_FRONT = 2.00, BODY_RADIUS = 1.27;              // rules/solids.js
const LINE = -114.40, POST_W = -114.95, POST_E = -113.94; // the wall face, and the yellow marks
const COIN_N = 59.4;

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
const key = (down) => call('Input.dispatchKeyEvent', { type: down ? 'keyDown' : 'keyUp', key: 'w',
  code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
const shot = async (n) => { const s = await call('Page.captureScreenshot', { format: 'png' });
  if (s && s.data) { (await import('node:fs')).writeFileSync(OUT + n, Buffer.from(s.data, 'base64')); return n; } return null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POSE = `(function(){ var m = window.unityInstance && window.unityInstance.Module;
  var st = m && m.blwp && m.blwp.st; if (!st) return null;
  var i = st.i32;
  return JSON.stringify({ tick: i[0], x: i[5]/65536, z: i[6]/65536, elapsed: i[19], state: i[23] }); })()`;
const place = (x, z, h) => `(function(){ var m = window.unityInstance && window.unityInstance.Module;
  var st = m && m.blwp && m.blwp.st, core = window.BLWP;
  if (!st || !core || !core.teleport) return 'no teleport';
  core.teleport(st, Math.round(${x} * 65536), Math.round(${z} * 65536), ${h}); return 'ok'; })()`;

console.log(`renderer: ${await ev(`(function(){var c=document.createElement('canvas');var g=c.getContext('webgl2')||c.getContext('webgl');
  if(!g) return 'none'; var e=g.getExtension('WEBGL_debug_renderer_info');
  return e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER);})()`)}`);

await call('Page.navigate', { url: URL_ });
let ready = false;
for (let i = 0; i < 45; i++) {
  await sleep(4000);
  const showing = await ev('!!(window.BLWP_UNITY_LOBBY&&window.BLWP_UNITY_LOBBY.showing)');
  const n = await ev('(function(){try{var v=window.BLWP_LOBBY_VIEW&&window.BLWP_LOBBY_VIEW();return v?(v.rows||[]).length:0;}catch(e){return 0;}})()');
  if (showing === true && n > 0) { console.log(`  lobby with ${n} round(s) at t+${i * 4}s`); ready = true; break; }
}
if (!ready) { console.log('  NO LOBBY - stopping'); process.exit(1); }
console.log(`  version on the page: ${await ev("(function(){var m=document.body.innerText.match(/0\\\\.0\\\\.1\\\\d\\\\d\\\\d/);return m?m[0]:'?';})()")}`);
await click(PLAY); await sleep(14000);
await click(AUTO); await sleep(1500); await click(ROLLOUT); await sleep(3000);
console.log(`  rolled out: ${await ev(POSE)}\n`);

/** Place, hold the throttle, and report where it comes to rest. */
async function run(label, x, z, heading, axis, seconds, name) {
  console.log(`  ${label}`);
  console.log(`     placed: ${await ev(place(x, z, heading))}`);
  await sleep(600);
  await key(true);
  let last = null, still = 0, end = null;
  for (let t = 0; t < seconds; t++) {
    await sleep(1000);
    let o; try { o = JSON.parse(await ev(POSE)); } catch { continue; }
    if (!o) continue;
    end = o;
    const v = axis === 'x' ? o.x : o.z;
    if (last !== null && Math.abs(v - last) < 0.05) { if (++still >= 3) break; } else still = 0;
    last = v;
    if (o.state !== 0) break;
  }
  await key(false);
  if (name) console.log(`     shot: ${await shot(name)}`);
  return end;
}

// THE ORDER MATTERS AND THE FIRST RUN OF THIS PROBE GOT IT WRONG: the centre line DELIVERS, which ends the
// round, and a finished run locks the truck - so the two drives after it "ended" exactly where they were
// placed, having never moved at all. The delivery goes LAST.

// 1. THE MEMPOOL FACADE
const c = await run('MEMPOOL: placed at the spawn, driven west into the facade', -100.4, 10.2, WEST, 'x', 40, `${TAG}-1-mempool.png`);
const nose = c.x - BODY_FRONT - BODY_RADIUS;
console.log(`     ended x ${c.x.toFixed(2)}  nose ${nose.toFixed(2)}`);
console.log(`     the yellow marks run ${POST_W} .. ${POST_E}, the wall face is ${LINE}`);
console.log(`     ->  ${Math.abs(nose - LINE) < 0.5 ? 'STOPPED ON THE YELLOW LINE' : (nose < -160 ? 'DROVE OUT THE BACK OF THE BUILDING' : `stopped at ${nose.toFixed(2)}, off the line`)}\n`);

// 2. THE COIN, from its open (north) face
const b = await run('COIN: placed north of the stack on x 183, driven south', 183, 72, SOUTH, 'z', 40, `${TAG}-2-coin.png`);
console.log(`     ended x ${b.x.toFixed(2)} z ${b.z.toFixed(2)}  ->  ${b.z > COIN_N ? `STOPPED north of the stack at ${COIN_N}` : 'DROVE INTO THE STACK'}\n`);

// 3. THE CENTRE LINE - last, because it ends the round
const a = await run('CENTRE LINE: placed 20 m short of the gate on z 0, driven east', 149, 0, EAST, 'x', 40, `${TAG}-3-centre.png`);
console.log(`     ended x ${a.x.toFixed(2)} z ${a.z.toFixed(2)} state ${a.state}  ->  ${a.state === 1 ? 'DELIVERED' : 'NOT DELIVERED'}\n`);

console.log(`\n  RESULT  centre ${a.state === 1 ? 'DELIVERED' : 'state ' + a.state}`
  + ` | coin stop z ${b.z.toFixed(2)} (face ${COIN_N})`
  + ` | mempool nose ${nose.toFixed(2)} (line ${LINE})`);
process.exit(a.state === 1 && b.z > COIN_N && Math.abs(nose - LINE) < 0.5 ? 0 : 2);
