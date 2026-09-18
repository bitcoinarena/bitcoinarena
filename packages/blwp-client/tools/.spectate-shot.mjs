// WHAT A SPECTATOR ACTUALLY SEES ON THE SHIPPED BUILD (the owner 2026-09-18 20:00, the sky billboard).
// Attaches to the test host's browser, opens the daily page, presses SPECTATE, and photographs it.
import WebSocket from 'ws';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 9341);
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const target = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Runtime.enable'); await send('Page.enable');
const ev = async (e) => { const r = await Promise.race([send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }), wait(20000).then(() => null)]);
  return r ? (r.result?.exceptionDetails ? 'THREW ' + r.result.exceptionDetails.text : r.result?.result?.value) : 'TIMED OUT'; };
await send('Page.navigate', { url: 'https://btc-logistics-core.pages.dev/' });
for (let i = 0; i < 90; i++) { if (await ev('!!window.unityInstance') === true) break; await wait(2000); }
console.log('unity up:', await ev('!!window.unityInstance'), '| build', await ev("(document.title||'') + ' ' + (document.body.innerText.match(/0\\.0\\.1[0-9]+/)||[''])[0]"));
await wait(8000);
const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased'])
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 }); await wait(1500); };
await click(881, 690);                      // SPECTATE, beside PLAY on the splash
await wait(6000);
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.result?.data) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.argv[3] || '/tmp/spectate-now.png', Buffer.from(shot.result.data, 'base64'));
  console.log('shot written');
}
console.log('market:', await ev(`(function(){var m=window.unityInstance&&window.unityInstance.Module;return 'unity ' + (!!m);})()`));
try { ws.close(); } catch {}
process.exit(0);
