// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// HOW LONG A LIVE ROUND ACTUALLY LASTS, on the Daily, from the cab.
//
// Joins the round the lobby's PLAY is armed for, takes AUTO and ROLL OUT, and then SITS: what is measured is the
// tick the run survives to, not where the truck goes. Written after the deploy of 2026-09-19, when the page drove
// to 10800 ticks and the signer nodes' keeper still wrote 9000 into every contract, so every run died at about
// 150 s with "the node refuses this run's inputs at tick 8948". A run that passes tick 9000 still LIVE is the
// proof that the two halves agree; the number to watch in the output is the tick beside `state 0`.
//
//   node packages/arena-client/tools/measure-live-round.mjs
//
// The page is driven through the the test host's playtest Chrome (HARD 2026-09-20 15:12: test host only), port 9351.
import { WebSocket } from 'ws';
import { writeFileSync } from 'node:fs';
const DIR = process.env.DIR || '/tmp';
const PAGE = 'https://testnet.bitcoin-arena.io/';
const list = await fetch('http://127.0.0.1:9351/json/list').then((r) => r.json());
const t = list.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0; const pend = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${DIR}/${n}`, Buffer.from(r.result.data, 'base64')); console.log('shot', n); };
const click = async (x, y) => { for (const k of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: k, x, y, button: 'left', clickCount: 1, buttons: 1 }); await wait(700); };
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: PAGE + '?t=' + Date.now() });
await wait(30000);
for (let i = 0; i < 60; i++) { if (await ev('!!(window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwp)') === true) break; await wait(2000); }
let play = null;
for (let i = 0; i < 40 && !play; i++) {
  const l = await ev('JSON.stringify(window.ARENA_UNITY_LOBBY||null)');
  const o = l ? JSON.parse(l) : null;
  if (o && o.playEnabled && o.play) play = o; else await wait(3000);
}
if (!play) { console.log('PLAY NEVER ARMED'); ws.close(); process.exit(1); }
const c = JSON.parse(await ev(`(function(){var c=document.querySelector('canvas');var r=c.getBoundingClientRect();
  return JSON.stringify({left:r.left,top:r.top,k:r.width/c.width});})()`));
await click(c.left + (play.play[0] + play.play[2] / 2) * c.k, c.top + (play.play[1] + play.play[3] / 2) * c.k);
await wait(14000);
// the loadout's own AUTO and ROLL OUT, at the geometry the HUD publishes
const g = JSON.parse(await ev(`(function(){var cv=document.querySelector('canvas');var r=cv.getBoundingClientRect();
  var w=cv.width,h=cv.height;var bp=Math.max(10,h*0.022);var hf=Math.round(Math.min(Math.max(Math.min(w,h)*0.034,15),26));
  var lh=hf*1.6,barW=Math.min(w*0.94,1040),panelH=lh*5.1,px=(w-barW)/2,py=h-panelH-bp,inner=bp*1.2,gg=(barW-inner*3)*0.34;var k=r.width/w;
  return JSON.stringify({auto:[r.left+(px+inner+gg/2)*k,r.top+(py+panelH-lh*1.25+lh/2)*k],
    roll:[r.left+(px+inner*2+gg+gg/2)*k,r.top+(py+panelH-lh*1.25+lh/2)*k]});})()`));
await click(g.auto[0], g.auto[1]); await wait(1500);
await click(g.roll[0], g.roll[1]); await wait(2500);
const ST = `(function(){var b=window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwp;
  if(!b||!b.st)return null;var s=b.st.i32||b.st;return {tick:s[0],x:s[5]/65536,state:s[23]};})()`;
let past9000 = false, best = null;
for (let k = 0; k < 130; k++) {
  const st = await ev(ST);
  if (st) {
    best = st;
    if (st.tick > 9000 && !past9000) { past9000 = true; console.log(`PAST 9000: tick ${st.tick} (${(st.tick/60).toFixed(0)} s) state ${st.state} x ${st.x.toFixed(1)}`); await shot('live-past-9000.png'); }
    if (st.state !== 0) { console.log(`RUN ENDED state ${st.state} at tick ${st.tick} (${(st.tick/60).toFixed(0)} s)`); break; }
    if (k % 10 === 0) console.log(`tick ${st.tick} (${(st.tick/60).toFixed(0)} s) state ${st.state}`);
  }
  await wait(2000);
}
console.log('PAST 9000:', past9000, '| last', JSON.stringify(best));
ws.close();
