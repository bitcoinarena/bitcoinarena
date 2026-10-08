// The same cab frame with the PAGE'S OWN chrome hidden: the dev banner ("play · <url> up / 1 player · waiting")
// is an HTML overlay sitting on top of the canvas, and it covered the top of the price glyphs, which is why three
// frames of the same draw measured 39, 115 and 39 px. Hiding everything that is not the canvas leaves the HUD alone.
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const PORT = Number(process.env.PORT || 9351);
const OUT = '/tmp/claude-1000/-tmp-btc-phase0/3702e750-4ad9-4253-93e3-670b04a90b08/scratchpad/cab-headline';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const t = list.find((x) => x.type === 'page' && x.url.startsWith('http'));
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (m, p = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
await send('Runtime.enable'); await send('Page.enable');
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
console.log('url:', await ev('location.href'));
console.log('hidden:', await ev(`(function(){var c=document.querySelector('canvas');var n=0;
  document.querySelectorAll('body *').forEach(function(el){ if(el===c||el.contains(c)) return;
    var s=getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden') return;
    el.style.setProperty('visibility','hidden','important'); n++; });
  document.body.style.background='#000'; return n;})()`));
await wait(900);
const r = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(OUT, 'clean.png'), Buffer.from(r.result.data, 'base64'));
console.log('canvas:', await ev(`(function(){var c=document.querySelector('canvas');return c.width+'x'+c.height;})()`));
ws.close();
