// DOES THE GROUND EVER REACH THE HEADLINE? (2026-09-19)
// The headline sits at a FIXED place on the screen - the top eighth - while the horizon moves with the camera's
// pitch and the ground under the truck. One flat frame is not evidence that the road is clear, so this drives a
// while, turning, and captures frames with the page's own chrome hidden. Each frame is then asked where the
// highest non-sky pixel in the CENTRE column is, against the headline's own band.
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const PORT = Number(process.env.PORT || 9341);
const OUT = '/tmp/claude-1000/-tmp-btc-phase0/3702e750-4ad9-4253-93e3-670b04a90b08/scratchpad/cab-headline/horizon';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const t = list.find((x) => x.type === 'page' && x.url.startsWith('http'));
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (m, p = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
await send('Runtime.enable');
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
const key = (type, code, kc, text) => send('Input.dispatchKeyEvent', { type, code, key: text, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, ...(type === 'keyDown' ? { text } : {}) });
const shot = async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null); if (r?.result?.data) writeFileSync(join(OUT, f), Buffer.from(r.result.data, 'base64')); };
await ev(`(function(){var c=document.querySelector('canvas');document.querySelectorAll('body *').forEach(function(el){
  if(el===c||el.contains(c))return; el.style.setProperty('visibility','hidden','important');});})()`);
const st = async () => { const v = await ev(`(function(){var b=window.unityInstance.Module.blwp;return JSON.stringify({x:b.st.i32[5],z:b.st.i32[6]});})()`); return v ? JSON.parse(v) : null; };
for (let i = 0; i < 8; i++) {
  await key('keyDown', 'KeyW', 87, 'w');
  if (i % 2) { await key('keyDown', 'KeyA', 65, 'a'); } else { await key('keyDown', 'KeyD', 68, 'd'); }
  await wait(2600);
  await key('keyUp', 'KeyA', 65, 'a'); await key('keyUp', 'KeyD', 68, 'd');
  await wait(400);
  await key('keyUp', 'KeyW', 87, 'w');
  await wait(500);
  const p = await st();
  await shot(`h${i}.png`);
  console.log(`frame ${i}: truck at x ${p ? (p.x / 65536).toFixed(0) : '-'} z ${p ? (p.z / 65536).toFixed(0) : '-'}`);
}
ws.close();
