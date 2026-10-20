// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUND TIMER MUST END THE ROUND (2026-09-20 16:21), in a real player on test host Chrome.
//
// THE RIG MATTERS AND IT IS THE REASON THE FIRST ATTEMPT MEASURED NOTHING. Headless Chrome on SwiftShader draws
// this world at about 3 frames a second; the page walks at most `MostTicksPerFrame` = 8 ticks a frame, so the
// core ran at 23 ticks a second against the 60 the round keeps (41 at 640x400). The node closed the round on its
// own clock first - "refuses this run's inputs at tick 4588: error the round is closed" - and the run died VOID
// at core tick 5004 of 10800, by the CLIENT's word, which is the path that already worked. Nothing about the
// timer was exercised. On the SAME machine with ANGLE/Vulkan on the AMD Renoir the page runs 61.4 ticks/s, so
// the core reaches its own block end and the timer is reachable. Use a GPU port.
//
// Everything is read from the page's own core - `unityInstance.Module.blwp.st.i32` - never from PhysX:
//   i32[0]   tick        i32[19]  S_ELAPSED       i32[23]  S_STATE   0 LIVE 1 DELIVERED 2 WRECKED 3 MISSED
// and the lobby from `window.ARENA_UNITY_LOBBY.showing`, the flag SplashScreen itself sets.
//
// The HUD clock is NOT read off the screen: it is `BlockClock.CoreSecondsLeft(elapsed)`, which after this letter
// is `max(0, BLOCK_TICKS - elapsed) * 1092 / 65536`. That is the point of the letter - the clock IS the core's
// count - so the probe computes the same number the HUD does and screenshots the frames around 0:00.
//
//   node timerdrive.mjs <cdp-port> <url> <tag>
const PORT = Number(process.argv[2] || 9347);
const URL_ = process.argv[3] || 'http://127.0.0.1:8191/';
const TAG = process.argv[4] || 'tdrive';
const OUT = '/tmp/btc-phase0/owner-screens/';
const PLAY = [504, 690], AUTO = [306, 751], ROLLOUT = [660, 751];
const BLOCK_TICKS = 10800;
const clockText = (elapsed) => {
  const s = Math.max(0, BLOCK_TICKS - elapsed) * 1092 / 65536;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

let id = 0; const pend = new Map();
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const said = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result ?? d.error); pend.delete(d.id); return; }
  if (d.method === 'Runtime.consoleAPICalled') { const s = (d.params.args || []).map((a) => a.value ?? '').join(' ');
    if (/ended|void|missed|lobby|outcome|refus/i.test(s)) said.push(s.slice(0, 170)); } };
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

const READ = `(function(){ var m = window.unityInstance && window.unityInstance.Module;
  var st = m && m.blwp && m.blwp.st;
  var showing = !!(window.ARENA_UNITY_LOBBY && window.ARENA_UNITY_LOBBY.showing);
  if (!st) return JSON.stringify({ core: false, showing: showing });
  var i = st.i32;
  return JSON.stringify({ core: true, tick: i[0], elapsed: i[19], state: i[23], showing: showing,
                          assault: window.ARENA_UNITY_ASSAULT || null }); })()`;

const renderer = await ev(`(function(){var c=document.createElement('canvas');var g=c.getContext('webgl2')||c.getContext('webgl');
  if(!g) return 'none'; var e=g.getExtension('WEBGL_debug_renderer_info');
  return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);})()`);
console.log(`renderer: ${renderer}`);

await call('Page.navigate', { url: URL_ });
let ready = false;
for (let i = 0; i < 45; i++) {
  await sleep(4000);
  const showing = await ev('!!(window.ARENA_UNITY_LOBBY&&window.ARENA_UNITY_LOBBY.showing)');
  const rows = await ev('(function(){try{var v=window.ARENA_LOBBY_VIEW&&window.ARENA_LOBBY_VIEW();return v?(v.rows||[]).length:0;}catch(e){return 0;}})()');
  if (showing === true && rows > 0) { console.log(`  lobby with ${rows} round(s) at t+${i * 4}s`); ready = true; break; }
}
if (!ready) { console.log('  NO LOBBY - stopping'); console.log(`  shot: ${await shot(TAG + '-nolobby.png')}`); process.exit(1); }

await click(PLAY); await sleep(14000);
await click(AUTO); await sleep(1500); await click(ROLLOUT); await sleep(3000);
console.log(`  rolled out: ${await ev(READ)}`);

// LEAVE IT ALONE. No key is pressed: the only thing that can end this run is the block running out.
let outcomeAt = null, backAt = null, lastState = 0, wasShowing = false, nearShot = false, zeroSeen = null;
let assaultLines = 0;
for (let i = 0; i < 420; i++) {
  await sleep(1000);
  let o; try { o = JSON.parse(await ev(READ)); } catch { continue; }
  if (!o.core) continue;
  if (i % 15 === 0) console.log(`    t+${i}s  elapsed ${o.elapsed}  clock ${clockText(o.elapsed)}  state ${o.state}  lobby ${o.showing}`);
  if (o.assault && (o.assault.lines || []).length > assaultLines) {
    assaultLines = o.assault.lines.length;
    console.log(`       HUD LOG: ${o.assault.lines[o.assault.lines.length - 1]}   (banner "${o.assault.banner}")`);
  }
  if (!nearShot && o.elapsed >= BLOCK_TICKS - 420) {       // seven seconds before 0:00
    nearShot = true;
    console.log(`  shot: ${await shot(TAG + '-before-zero.png')}  (clock ${clockText(o.elapsed)}, elapsed ${o.elapsed})`);
  }
  if (zeroSeen === null && o.elapsed >= BLOCK_TICKS) {
    zeroSeen = i;
    console.log(`    *** THE CLOCK READS 0:00 at t+${i}s, elapsed ${o.elapsed} of ${BLOCK_TICKS}`);
  }
  if (o.state !== lastState) {
    console.log(`    *** state ${lastState} -> ${o.state} at t+${i}s, elapsed ${o.elapsed}, clock ${clockText(o.elapsed)}`);
    lastState = o.state;
    if (o.state !== 0 && outcomeAt === null) {
      outcomeAt = i;
      console.log(`  shot: ${await shot(TAG + '-outcome.png')}`);
    }
  }
  if (o.showing && !wasShowing) {
    wasShowing = true; backAt = i;
    console.log(`    *** THE LOBBY CAME BACK BY ITSELF at t+${i}s`
      + (outcomeAt === null ? '  (NO core outcome was seen - the client ended it)' : `, ${i - outcomeAt}s after the outcome`));
    console.log(`  shot: ${await shot(TAG + '-lobby-back.png')}`);
    break;
  }
}
if (backAt === null) {
  const o = JSON.parse(await ev(READ));
  console.log(`    THE LOBBY NEVER CAME BACK - last elapsed ${o.elapsed}, clock ${clockText(o.elapsed)}, state ${o.state}`);
  console.log(`  shot: ${await shot(TAG + '-stuck.png')}`);
}
console.log(`\n  RESULT clock-zero ${zeroSeen === null ? 'never' : zeroSeen + 's'},`
  + ` outcome ${outcomeAt === null ? 'never' : outcomeAt + 's'},`
  + ` lobby-back ${backAt === null ? 'NEVER' : backAt + 's'}`);
if (said.length) { console.log('  page said:'); for (const l of said.slice(-6)) console.log('    ' + l); }
process.exit(backAt !== null && outcomeAt !== null ? 0 : 2);
