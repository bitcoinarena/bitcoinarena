// THE NUMBER ON THE HUD AGAINST THE NUMBER IN THE CORE (2026-09-19).
// The headline draws MarketFeed.Price - a live socket price the client also submits into the core
// (CoreDrivenTruck: BlwpCore.SubmitSample(_feed.Price)). So the feed is an INPUT and the core's tape is what the
// world is built from. This asks whether the two agree: the drawn headline against the core's own last tape price,
// read through chartView's CH_LAST and CH_UNIT. A HUD showing a price the core is not running on would be the
// client holding its own outcome.
import { WebSocket } from 'ws';
const PORT = Number(process.env.PORT || 9341);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const t = list.find((x) => x.type === 'page' && x.url.startsWith('http'));
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (m, p = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
await send('Runtime.enable');
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;

// CH_LAST 4, CH_UNIT 14 (chart.js). Prices are in the tape's unit, CH_UNIT per dollar.
const CORE = `(function(){
  var m=window.unityInstance&&window.unityInstance.Module, b=m&&m.blwp;
  if(!b||!b.st||!b.core||typeof b.core.chartView!=='function') return null;
  var out=new Int32Array(4096); b.core.chartView(b.st,0,out);
  return JSON.stringify({last:out[4], unit:out[14], samples:out[23], lo:out[2], hi:out[3]});
})()`;
for (let i = 0; i < 5; i++) {
  const raw = await ev(CORE);
  if (!raw) { console.log('core not up'); await wait(2000); continue; }
  const c = JSON.parse(raw);
  const usd = c.unit ? c.last / c.unit : NaN;
  console.log(`core: CH_LAST ${c.last} at CH_UNIT ${c.unit} per dollar = $${usd.toFixed(2)}   samples ${c.samples}`
    + `   range lo ${(c.lo / c.unit).toFixed(2)} hi ${(c.hi / c.unit).toFixed(2)}`);
  await wait(2500);
}
ws.close();
