// THE CAB, on a locally served build: does the truck still deliver now the gate is at 169 m, and is anything of the
// world still under the drawn miner? Prints the core's own numbers, not an impression.
import { WebSocket } from 'ws';
import { writeFileSync } from 'node:fs';
const PORT = Number(process.env.PORT || 9341), DIR = process.env.DIR || '/tmp';
const PAGE = process.env.PAGE || 'http://127.0.0.1:8191/index.html';
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
const key = (ty, code, kc, tx) => send('Input.dispatchKeyEvent', { type: ty, code, key: tx, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, ...(ty === 'keyDown' ? { text: tx } : {}) });
const click = async (x, y) => { for (const k of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: k, x, y, button: 'left', clickCount: 1, buttons: 1 }); await wait(700); };
await send('Page.enable'); await send('Runtime.enable');
// the core's own words: truck x/z, run state, tick, and the gate the core holds
const ST = `(function(){var b=window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwp;
  if(!b||!b.st)return null;var s=b.st.i32||b.st;var o={};
  try{o.x=s[5]/65536;o.z=s[6]/65536;o.hp=s[11]/65536;}catch(e){}
  try{o.build=(window.BLWP_BUILD||'');}catch(e){}
  return o;})()`;
await send('Page.navigate', { url: PAGE });
await wait(9000);
console.log('page title:', await ev("document.title"));
let rows = 0;
for (let i = 0; i < 40 && !rows; i++) { rows = Number(await ev('(window.BLWP_LOBBY||[]).length')) || 0; if (!rows) await wait(2000); }
console.log('lobby rows', rows);
let href = '';
for (let i = 0; i < 25 && !href; i++) {
  const got = await ev(`(function(){var r=(window.BLWP_LOBBY||[]).filter(function(x){return x.free&&x.join;})[0];return r?(location.origin+location.pathname+r.join+'&play=1'):'';})()`);
  if (got && String(got).includes('round=')) href = String(got); else await wait(3000);
}
if (!href) { console.log('NO JOINABLE FREE ROUND'); await shot('cab-b-lobby.png'); ws.close(); process.exit(1); }
await send('Page.navigate', { url: href });
await wait(8000);
for (let i = 0; i < 60; i++) { if (await ev('!!(window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwp)') === true) break; await wait(2000); }
const geom = JSON.parse(await ev(`(function(){var c=document.querySelector('canvas');var r=c.getBoundingClientRect();
  var w=c.width,h=c.height;var bp=Math.max(10,h*0.022);var hf=Math.round(Math.min(Math.max(Math.min(w,h)*0.034,15),26));
  var lh=hf*1.6,barW=Math.min(w*0.94,1040),panelH=lh*5.1,px=(w-barW)/2,py=h-panelH-bp,inner=bp*1.2,g=(barW-inner*3)*0.34;var k=r.width/w;
  return JSON.stringify({splash:[r.left+r.width/2,r.top+r.height*0.69],
    auto:[r.left+(px+inner+g/2)*k,r.top+(py+panelH-lh*1.25+lh/2)*k],
    roll:[r.left+(px+inner*2+g+g/2)*k,r.top+(py+panelH-lh*1.25+lh/2)*k]});})()`));
await click(geom.splash[0], geom.splash[1]); await wait(1500);
await click(geom.auto[0], geom.auto[1]); await wait(1200);
await click(geom.roll[0], geom.roll[1]); await wait(2500);
let best = null;
for (let k = 0; k < 22; k++) {
  await key('keyDown', 'KeyW', 87, 'w'); await wait(2200); await key('keyUp', 'KeyW', 87, 'w'); await wait(200);
  const st = await ev(ST);
  if (st) { best = st; console.log(`leg ${k + 1}: truck x ${st.x?.toFixed(1)} z ${st.z?.toFixed(1)} hp ${st.hp?.toFixed(0)}`); }
  if (st && st.x > -80 && st.x < 95) await shot(`band-${Math.round(st.x)}.png`);
  // the core's own run word: 0 live, 1 delivered, 2 wrecked, 3 missed - and the tick it happened on
  const run = await ev(`(function(){var b=window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwp;
    if(!b||!b.st)return null;var s=b.st.i32||b.st;return {state:s[23],tick:s[0]};})()`);
  if (run && run.state && run.state !== 0) { console.log(`RUN ENDED state ${run.state} at tick ${run.tick}, truck x ${st?.x?.toFixed(2)}`); break; }
}
await shot('cab-b-end.png');
console.log('final', JSON.stringify(best));
console.log('ending word:', await ev("window.BLWP_ENDING || '(none)'"));
ws.close();
