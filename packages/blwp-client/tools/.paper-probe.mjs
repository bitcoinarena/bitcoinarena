import { WebSocket } from 'ws';
const PORT = Number(process.argv[2] || 9351);
const PAGE = process.argv[3] || 'https://btc-logistics-core.pages.dev/';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
const t = list.find(x => x.type === 'page' && x.url.startsWith('http'));
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const pending = new Map(); const logs = [];
ws.on('message', raw => { const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' ')); });
const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.clearDeviceMetricsOverride');
await send('Page.navigate', { url: PAGE });
await wait(25000);
const ev = e => send('Runtime.evaluate', { expression: e, returnByValue: true }).then(r => r.result?.result?.value);
for (let i = 0; i < 40; i++) { if (await ev('!!(window.unityInstance && window.BLWP_UNITY_LOBBY)')) break; await wait(2000); }
const v = await ev('JSON.stringify(window.BLWP_UNITY_LOBBY||null)');
if (v && v !== 'null') {
  const s = JSON.parse(v);
  const g = JSON.parse(await ev(`(function(){var c=document.querySelector('canvas');var r=c.getBoundingClientRect();return JSON.stringify({k:r.width/c.width,left:r.left,top:r.top});})()`));
  const x = g.left + (s.spectate[0] + s.spectate[2] / 2) * g.k, y = g.top + (s.spectate[1] + s.spectate[3] / 2) * g.k;
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
  console.log(`pressed SPECTATE at ${Math.round(x)},${Math.round(y)}`);
}
await wait(22000);
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.SHOT || '/tmp/paper-shot.png', Buffer.from(shot.result.data, 'base64'));
  console.log('shot saved to ' + (process.env.SHOT || '/tmp/paper-shot.png'));
}
const paper = logs.filter(l => l.includes('[paper]'));
console.log(paper.length ? paper.slice(-6).join('\n') : 'no [paper] line in the console');
ws.close();
