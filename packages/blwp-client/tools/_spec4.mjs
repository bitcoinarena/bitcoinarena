import { WebSocket } from 'ws';
import { writeFileSync } from 'node:fs';
const PORT = 9341, DIR = process.env.DIR || '/tmp';
const PAGE = 'http://127.0.0.1:8191/index.html';
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
const drag = async (x0, y0, x1, y1, steps = 16) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0 });
  await wait(250); };
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: PAGE });
await wait(12000);
for (let i = 0; i < 40; i++) { if (await ev('!!(window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwp)') === true) break; await wait(2000); }
await wait(3000);
const g = JSON.parse(await ev(`(function(){var c=document.querySelector('canvas');var r=c.getBoundingClientRect();
  return JSON.stringify({cx:r.left+r.width/2,cy:r.top+r.height/2,spectate:[r.left+r.width*0.69,r.top+r.height*0.86]});})()`));
await shot('band2-00-lobby.png');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.spectate[0], y: g.spectate[1], button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.spectate[0], y: g.spectate[1], button: 'left', buttons: 0 });
await wait(2500);
await shot('band2-01-entered.png');
await hold('KeyE', 69, 'e', 5000);                                        // climb high
for (let i = 0; i < 5; i++) await drag(g.cx - 240, g.cy, g.cx + 240, g.cy); // yaw round to the field
await drag(g.cx, g.cy - 150, g.cx, g.cy + 150);                            // look down
await shot('band2-02-down.png');
await hold('KeyW', 87, 'w', 3500);
await shot('band2-03-band.png');
await hold('KeyW', 87, 'w', 3500);
await shot('band2-04-further.png');
ws.close();
