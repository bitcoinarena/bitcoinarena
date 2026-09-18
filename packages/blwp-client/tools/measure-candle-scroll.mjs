#!/usr/bin/env node
// Do the world candles keep scrolling from the cab, or do they move once and freeze?
//
// the owner 2026-09-17 16:42 (HARD, still open): "at round start from the cab, candles move LEFT then freeze; miner-ward
// scroll is otherwise correct."
//
// The ribbon is drawn at the core's own `candleShift` (sim.js `candleView` -> CV_SHIFT), so this asks the page's core
// for that number and for its tick, twice a second, from the moment a round starts. A shift that stops while the tick
// runs on is the core's; a shift that runs on while the ribbon stands still would be the drawing's, and the drawn
// rebuild count is read beside it so the two can be told apart.
//
// Live Chrome runs on the test host (HARD 19:05): monitoring/blwp_mac_playtest.sh start, then --attach.
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PAGE = arg('page', 'https://btc-logistics-core.pages.dev/');
const PORT = Number(arg('port', 9341));
const OUT = arg('out', '/tmp/claude-1000/-tmp-btc-phase0/3702e750-4ad9-4253-93e3-670b04a90b08/scratchpad/candle-scroll');
const WATCH_MS = Number(arg('watch', 90000));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toISOString().slice(11, 19);
const say = (line) => console.log(`${clock()}  ${line}`);
const METRES = (w) => w / 65536;
mkdirSync(OUT, { recursive: true });

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const target = list.find((x) => x.type === 'page' && x.url.startsWith('http'));
if (!target) throw new Error(`nothing to attach to on ${PORT}`);
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0;
const pending = new Map();
const logs = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled')
    logs.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
});
const send = (method, params = {}) => new Promise((r) => {
  const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params }));
});
await send('Runtime.enable');
await send('Page.enable');
const evaluate = async (expression) => {
  const r = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
                                wait(20000).then(() => null)]);
  if (!r) return 'TIMED OUT';
  return r.result?.result?.value;
};
const shot = async (file) => {
  const r = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (r?.result?.data) writeFileSync(join(OUT, file), Buffer.from(r.result.data, 'base64'));
};
const click = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
  await wait(800);
};

// THE CORE'S OWN NUMBERS: the shift the ribbon is drawn at, the tick it belongs to, and how many samples the tape has
// taken - a ribbon that stops because no price arrived is a different fault from one whose shift stops moving.
const STATE = `(function () {
  var m = window.unityInstance && window.unityInstance.Module;
  var b = m && m.blwp;
  if (!b || !b.st) return null;
  var st = b.st;
  // x and z so the probe can tell a truck that is rolling from one still parked, and the tape's own sample count
  // through the core's public reader rather than a field that does not exist (the first run printed samples 0 -> 0
  // because it read st.samplesTaken, which is a FUNCTION of the state in sim.js, not a field on it).
  return { tick: st.i32[0], shift: st.candleShift | 0, candles: st.candles ? st.candles.length : 0,
           x: st.i32[5], z: st.i32[6],
           samples: (b.core && typeof b.core.samplesTaken === 'function') ? b.core.samplesTaken(st) : -1,
           apron: st.apron ? 1 : 0 };
})()`;

try {
  say(`page ${PAGE}`);
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Page.navigate', { url: PAGE });
  await wait(9000);
  let rows = 0;
  for (let i = 0; i < 60 && !rows; i++) {
    rows = Number(await evaluate('(window.BLWP_LOBBY || []).length')) || 0;
    if (!rows) await wait(2000);
  }
  say(`lobby rows ${rows}`);
  let href = '';
  for (let i = 0; i < 40 && !href; i++) {
    const got = await evaluate(`(function(){var r=(window.BLWP_LOBBY||[]).filter(function(x){return x.free&&x.join;})[0];`
      + `return r ? (location.origin + location.pathname + r.join + '&play=1') : '';})()`);
    if (got && String(got).includes('round=')) href = String(got); else await wait(3000);
  }
  if (!href) throw new Error('no joinable free round in the lobby');
  await send('Page.navigate', { url: href });
  await wait(6000);
  for (let i = 0; i < 90; i++) {
    if (await evaluate('!!(window.unityInstance && window.unityInstance.Module && window.unityInstance.Module.blwp)') === true) break;
    await wait(2000);
  }
  // through the splash and the bay, at the rectangles the page publishes
  const geom = JSON.parse(await evaluate(`(function(){var c=document.querySelector('canvas');var r=c.getBoundingClientRect();
    var w=c.width,h=c.height;var bp=Math.max(10,h*0.022),hf=Math.round(Math.min(Math.max(Math.min(w,h)*0.034,15),26));
    var lh=hf*1.6,barW=Math.min(w*0.94,1040),panelH=lh*5.1,px=(w-barW)/2,py=h-panelH-bp,inner=bp*1.2,g=(barW-inner*3)*0.34;
    var k=r.width/w;
    return JSON.stringify({splash:[r.left+r.width/2, r.top+r.height*0.69],
      auto:[r.left+(px+inner+g/2)*k, r.top+(py+panelH-lh*1.25+lh/2)*k],
      roll:[r.left+(px+inner*2+g+g/2)*k, r.top+(py+panelH-lh*1.25+lh/2)*k]});})()`));
  // OUT OF THE BAY FIRST, and proved out of it. A page parked in the depot shows no candle band at all, and the first
  // run of this measured eight identical frames of the loading screen and nearly called the ribbon frozen.
  const key = (type, code, keyCode, text) => send('Input.dispatchKeyEvent', {
    type, code, key: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    ...(type === 'keyDown' ? { text } : {}),
  });
  const drove = async (ms) => {
    const before = await evaluate(STATE);
    await key('keyDown', 'KeyW', 87, 'w');
    await wait(ms);
    await key('keyUp', 'KeyW', 87, 'w');
    const after = await evaluate(STATE);
    if (!before || !after) return 0;
    return Math.hypot(METRES(after.x - before.x), METRES(after.z - before.z));
  };
  let out = await drove(2500) > 0.5;
  for (let i = 0; i < 6 && !out; i++) {
    await click(geom.splash[0], geom.splash[1]); await wait(1500);
    await click(geom.auto[0], geom.auto[1]); await wait(1200);
    await click(geom.roll[0], geom.roll[1]); await wait(3000);
    out = await drove(2500) > 0.5;
    say(`after try ${i + 1} the truck ${out ? 'is rolling' : 'is still in the bay'}`);
  }
  if (!out) { await shot('00-never-left-the-bay.png'); throw new Error('the truck never left the bay, so no band is in view'); }
  // AND OUT ONTO THE MAP, where the ribbon is: the band is around the seam, not in the depot.
  say(`driving out to the band: ${(await drove(12000)).toFixed(0)} m`);

  const first = await evaluate(STATE);
  if (!first) throw new Error('the page core never came up');
  say(`the run is on: tick ${first.tick}, ${first.candles} candle words, shift ${METRES(first.shift).toFixed(2)} m, samples ${first.samples}`);
  await shot('01-at-the-start.png');

  const t0 = Date.now();
  const series = [];
  while (Date.now() - t0 < WATCH_MS) {
    const s = await evaluate(STATE);
    if (s) series.push({ ms: Date.now() - t0, ...s });
    await wait(500);
  }
  await shot('02-after-watching.png');

  // WHAT MOVED AND WHEN: the shift in metres against the tick, and the longest stretch where the tick ran on while
  // the shift did not.
  let frozen = 0, frozenFrom = null, worst = { ms: 0, from: 0, tickFrom: 0, tickTo: 0 };
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    if (b.shift === a.shift && b.tick > a.tick) {
      if (frozenFrom === null) frozenFrom = a;
      frozen = b.ms - frozenFrom.ms;
      if (frozen > worst.ms) worst = { ms: frozen, from: frozenFrom.ms, tickFrom: frozenFrom.tick, tickTo: b.tick };
    } else if (b.shift !== a.shift) { frozenFrom = null; frozen = 0; }
  }
  const moved = series.length ? METRES(series[series.length - 1].shift - series[0].shift) : 0;
  const ticks = series.length ? series[series.length - 1].tick - series[0].tick : 0;
  say(`over ${Math.round((Date.now() - t0) / 1000)} s: the shift moved ${moved.toFixed(2)} m across ${ticks} ticks`
      + `, samples ${series[0]?.samples} -> ${series[series.length - 1]?.samples}`);
  say(worst.ms > 1500
    ? `FROZEN: the shift stood still for ${worst.ms} ms while the tick ran ${worst.tickFrom} -> ${worst.tickTo}`
    : 'the shift never stood still for more than 1.5 s while the tick ran');
  const every = series.filter((_, i) => i % 10 === 0).map((s) => `${Math.round(s.ms / 1000)}s ${METRES(s.shift).toFixed(2)}m t${s.tick}`);
  say(`the series, every 5 s: ${every.join(' | ')}`);
  writeFileSync(join(OUT, 'series.json'), JSON.stringify(series, null, 1));
  const said = logs.filter((l) => l.includes('[candles]')).slice(-4);
  for (const l of said) say(`page said: ${l.slice(0, 200)}`);
  say(`shots and series in ${OUT}`);
} catch (e) {
  say(`FAILED ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch {}
}
