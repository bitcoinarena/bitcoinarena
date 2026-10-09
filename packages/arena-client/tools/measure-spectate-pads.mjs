#!/usr/bin/env node
// Do the flying pads answer a MOUSE in spectate?
//
// the owner 2026-09-18 21:52 (photographed, HARD playtest): "I can press it with the mouse but it won't do anything ...
// and only on spectate". The pad was drawn HELD under his pointer and the camera stood still.
//
// This opens the deployed page, presses SPECTATE at the rectangle the splash itself publishes (window.BLWP_UNITY_LOBBY),
// then holds the forward pad with the mouse and asks whether the VIEW CHANGED - by comparing the frames, because the
// spectator camera is C# and tells JS nothing. A window with nothing held is the control: the world moves on its own
// (tanks, fire, the chart), so the question is not "did anything change" but "did far more change while the pad was
// held than while it was not".
//
// Live Chrome runs on the test host (HARD 19:05): monitoring/blwp_mac_playtest.sh start && ... tunnel, then --attach.
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PAGE = arg('page', 'https://btc-logistics-core.pages.dev/');
const PORT = Number(arg('port', 9351));
const OUT = arg('out', '/tmp/claude-1000/-tmp-btc-phase0/3702e750-4ad9-4253-93e3-670b04a90b08/scratchpad/spectate-pads');
const HOLD_MS = Number(arg('hold', 4000));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toISOString().slice(11, 19);
const say = (line) => console.log(`${clock()}  ${line}`);
mkdirSync(OUT, { recursive: true });

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const target = list.find((x) => x.type === 'page' && x.url.startsWith('http'));
if (!target) throw new Error(`nothing to attach to on ${PORT}`);
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
const frame = async (file) => {
  const r = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (!r?.result?.data) return null;
  const buf = Buffer.from(r.result.data, 'base64');
  if (file) writeFileSync(join(OUT, file), buf);
  return buf;
};
const press = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
};
const lift = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
const click = async (x, y) => { await press(x, y); await wait(120); await lift(x, y); await wait(900); };

// How different two PNGs are, as a share of their bytes. Crude on purpose: a camera that flew forward redraws the
// whole frame, and a world ticking over in place does not.
const unlike = (a, b) => {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let differ = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) differ++;
  return differ / n + Math.abs(a.length - b.length) / Math.max(a.length, b.length);
};

try {
  say(`page ${PAGE}`);
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Page.navigate', { url: PAGE });
  await wait(9000);
  for (let i = 0; i < 60; i++) {
    if (await evaluate('!!(window.unityInstance && window.BLWP_UNITY_LOBBY)') === true) break;
    await wait(2000);
  }
  const view = await evaluate('JSON.stringify(window.BLWP_UNITY_LOBBY || null)');
  if (!view || view === 'null') throw new Error('the splash published no rectangles, so SPECTATE cannot be pressed');
  const splash = JSON.parse(view);
  const geom = await evaluate(`(function(){var c=document.querySelector('canvas');var r=c.getBoundingClientRect();
    return JSON.stringify({k:r.width/c.width,left:r.left,top:r.top,w:c.width,h:c.height,cssW:r.width,cssH:r.height});})()`);
  const g = JSON.parse(geom);
  const css = (rect) => ({ x: g.left + (rect[0] + rect[2] / 2) * g.k, y: g.top + (rect[1] + rect[3] / 2) * g.k });

  say(`the splash is up at ${splash.screen?.join('x')}, canvas ${g.w}x${g.h} backing / ${Math.round(g.cssW)}x${Math.round(g.cssH)} css`);
  const spectate = css(splash.spectate);
  say(`SPECTATE is at css (${spectate.x.toFixed(0)}, ${spectate.y.toFixed(0)})`);
  await frame('01-splash.png');
  await click(spectate.x, spectate.y);
  await wait(4000);
  await frame('02-spectating.png');

  // The pads, where TouchPad.RectFor puts them, in css pixels.
  const s = Math.max(76, Math.min(g.w, g.h) * 0.20), m = Math.max(14, Math.min(g.w, g.h) * 0.035);
  const bottom = g.h - m - s;
  const pad = (x, y) => ({ x: g.left + (x + s / 2) * g.k, y: g.top + (y + s / 2) * g.k });
  const up = pad(g.w - m - s, bottom - s - m * 0.5), right = pad(m + s + m * 0.5, bottom);
  say(`the forward pad is at css (${up.x.toFixed(0)}, ${up.y.toFixed(0)})`);

  const window_ = async (what, at, file) => {
    const before = await frame(null);
    if (at) await press(at.x, at.y);
    await wait(HOLD_MS);
    const after = await frame(file);
    if (at) await lift(at.x, at.y);
    await wait(1200);
    const moved = unlike(before, after);
    say(`${what}: the frame changed by ${(moved * 100).toFixed(1)}%`);
    return moved;
  };

  const still = await window_('nothing held            ', null, '03-nothing-held.png');
  const flown = await window_('the forward pad held    ', up, '04-forward-pad-held.png');
  const sideways = await window_('the right pad held     ', right, '05-right-pad-held.png');

  say('');
  say(`nothing ${(still * 100).toFixed(1)}% | forward pad ${(flown * 100).toFixed(1)}% | right pad ${(sideways * 100).toFixed(1)}%`);
  const flies = flown > still * 1.5 && flown > 0.05;
  say(flies ? 'the mouse FLIES the spectator camera' : 'the mouse does NOT fly the spectator camera');
  say(`shots in ${OUT}`);
} catch (e) {
  say(`FAILED ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch {}
}
