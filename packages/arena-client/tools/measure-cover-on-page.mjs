// WHAT THE BUILT CORE SAYS ABOUT COVER, read from the page's own state through CDP: how many rifle slots hold a
// §11.3 claim right now. This exists because the cab CANNOT answer the question by looking: the renderer does not
// read the cover word at all - §11.4's posture bits are what it will read - so a man lying behind a candle lip is
// drawn exactly like a man standing in the open, and a screenshot can only show that men are on the field. What
// can be checked from the cab is that the BUILT wasm behaves like the core that was measured in node, and this is
// that check.
//
//   node packages/arena-client/tools/measure-cover-on-page.mjs
import { WebSocket } from 'ws';
const list = await fetch('http://127.0.0.1:9351/json/list').then((r) => r.json());
const t = list.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0; const pend = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Runtime.enable');
const READ = `(function(){
  var b = window.unityInstance && window.unityInstance.Module && window.unityInstance.Module.blwp;
  if (!b || !b.st) return null;
  var s = b.st.i32 || b.st;
  var O_UNITS = ${2246 - 96 * 8}, U_WORDS = 8;      // filled below from the page's own layout if it exposes one
  var COVER0 = 2386, NONE = 65535, UNITS = 96;
  var men = 0, held = 0;
  for (var i = 0; i < UNITS; i++) {
    if ((i & 3) === 0) continue;                      // armour takes no cover
    var slot = COVER0 + (i - ((i / 4) | 0) - 1);
    var w = s[slot] & 0xffff;
    men++;
    if (w !== NONE && w !== 0) held++;
  }
  return { men: men, held: held, tick: s[0] };
})()`;
for (let k = 0; k < 6; k++) {
  const r = await ev(READ);
  console.log(r ? `tick ${r.tick}: ${r.held} of ${r.men} rifle slots hold a claim (${(100 * r.held / r.men).toFixed(0)}%)` : 'no core on the page');
  await wait(3000);
}
ws.close();
