import { WebSocket } from 'ws';
const wait = ms => new Promise(r => setTimeout(r, ms));
const list = await fetch('http://127.0.0.1:9351/json/list').then(r => r.json());
const t = list.find(x => x.type === 'page' && x.url.startsWith('http'));
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const p = new Map();
ws.on('message', m => { const j = JSON.parse(m); if (j.id && p.has(j.id)) { p.get(j.id)(j); p.delete(j.id); } });
const send = (method, params = {}) => new Promise(r => { const n = ++id; p.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Runtime.enable');
const ev = e => send('Runtime.evaluate', { expression: e, returnByValue: true }).then(r => r.result?.result?.value);
const line = String(await ev(`(window.__blwpChartLines||[]).slice(-1)[0]||''`));
for (const f of ['objBox=', 'objNames=', 'objUnplaced=']) {
  const m = line.match(new RegExp(f + '[^ ]*'));
  console.log(m ? m[0] : `${f} MISSING`);
}
const r = await send('Page.captureScreenshot', { format: 'png' });
if (r.result?.data) { const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/claude-1000/-tmp-btc-phase0/3702e750-4ad9-4253-93e3-670b04a90b08/scratchpad/o4-markers.png', Buffer.from(r.result.data, 'base64'));
  console.log('shot saved'); }
ws.close();
