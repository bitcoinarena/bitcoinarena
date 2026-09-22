// §4.14 ON THE PAGE: what the core's trend word says against the candles the chart is drawing (the owner 12:55).
// The shot shows six green candles climbing into GATE and the HUD saying SIDEWAYS with six grey dots. chart.js
// computes CH_DOTS from the tape itself but takes CH_TREND/CH_STRENGTH from the market STATE word, so the two can
// disagree - this reads both, plus the last six candle bodies, and applies §4.14's own rule to them.
import { WebSocket } from 'ws';
const PORT = Number(process.env.PORT || 9351);
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const t = list.find((x) => x.type === 'page' && x.url.startsWith('http'));
if (!t) throw new Error('no page on CDP');
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0; const pend = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
await send('Runtime.enable');
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;

// CH_CANDLES 1, CH_LAST 4, CH_OPEN 5, CH_LEAD 6, CH_LEAD_BP 7, CH_MOMENTUM 8, CH_TREND 9, CH_STRENGTH 10,
// CH_DOTS 11, CH_UNIT 14, CH_SAMPLES 23, CH_CANDLE 55 (open, high, low, close per candle).
const READ = `(function(){
  var b = window.unityInstance && window.unityInstance.Module && window.unityInstance.Module.blwp;
  if (!b || !b.st || !b.core) return null;
  var o = new Int32Array(4096); b.core.chartView(b.st, 0, o);
  var n = o[1], unit = o[14], out = { candles: n, unit: unit, last: o[4], open: o[5], lead: o[6], leadBp: o[7],
    momentum: o[8], trend: o[9], strength: o[10], dots: o[11], samples: o[23], bodies: [] };
  for (var c = Math.max(0, n - 6); c < n; c++) {
    var at = 55 + c * 4;
    out.bodies.push({ o: o[at], c: o[at + 3] });
  }
  return JSON.stringify(out);
})()`;
const raw = await ev(READ);
if (!raw) { console.log('the page core is not up'); ws.close(); process.exit(1); }
const v = JSON.parse(raw);
const bp = (x) => (v.open ? (x / (Math.abs(v.open) / 10000)) : 0);
console.log(`page: ${await ev('location.href')}`.slice(0, 120));
console.log(`candles ${v.candles}, samples ${v.samples}, unit ${v.unit}`);
console.log(`core says: trend ${v.trend}  strength ${v.strength}  dots 0b${(v.dots >>> 0).toString(2).padStart(12, '0')}  lead ${v.lead}  leadBp ${v.leadBp}  momentum ${v.momentum}`);
let green = 0, red = 0, doji = 0;
console.log('the last six candles the chart is drawing (body in basis points of the open):');
for (const b of v.bodies) {
  const body = b.c - b.o, bpBody = bp(body);
  const kind = Math.abs(bpBody) < 3 ? 'doji' : body > 0 ? 'GREEN' : 'RED';
  if (kind === 'GREEN') green++; else if (kind === 'RED') red++; else doji++;
  console.log(`   open ${b.o}  close ${b.c}  body ${body} = ${bpBody.toFixed(2)} bp  -> ${kind}`);
}
const net = green - red;
const want = Math.abs(net) < 2 ? 'SIDEWAYS' : (net > 0 ? 'UP' : 'DOWN');
const strength = Math.abs(net) < 2 ? 0 : Math.min(3, Math.abs(net) - 1);
console.log(`§4.14 on those six: green ${green}, red ${red}, doji ${doji}, net ${net} -> ${want}` + (want === 'SIDEWAYS' ? '' : ` strength ${strength}`));
console.log(`the core's word: ${v.trend === 0 ? 'SIDEWAYS' : v.trend > 0 ? 'UP' : 'DOWN'} strength ${v.strength}`);
ws.close();
