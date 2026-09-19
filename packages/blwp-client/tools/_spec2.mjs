import { WebSocket } from 'ws';
import { writeFileSync } from 'node:fs';
const PORT = Number(process.env.PORT || 9341), DIR = process.env.DIR || '/tmp';
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
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
const hold = async (code, kc, text, ms) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: text, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, text });
  await wait(ms);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: text, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc }); };
const drag = async (x0, y0, x1, y1, steps = 12) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0 });
  await wait(300); };
await send('Page.enable'); await send('Runtime.enable');
const g = JSON.parse(await ev(`(function(){var c=document.querySelector('canvas');var r=c.getBoundingClientRect();
  return JSON.stringify({cx:r.left+r.width/2,cy:r.top+r.height/2,w:r.width,h:r.height,left:r.left,top:r.top,
    spectate:[r.left+r.width*0.69,r.top+r.height*0.86]});})()`));
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.spectate[0], y: g.spectate[1], button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.spectate[0], y: g.spectate[1], button: 'left', buttons: 0 });
await wait(1600);
await hold('KeyE', 69, 'e', 3500);                 // climb
for (let i = 0; i < 4; i++) await drag(g.cx - 200, g.cy, g.cx + 200, g.cy);   // yaw around to face east
await drag(g.cx, g.cy - 120, g.cx, g.cy + 120);    // pitch down
await shot('band-top-1.png');
await hold('KeyW', 87, 'w', 2500);
await drag(g.cx, g.cy - 80, g.cx, g.cy + 80);
await shot('band-top-2.png');
ws.close();
