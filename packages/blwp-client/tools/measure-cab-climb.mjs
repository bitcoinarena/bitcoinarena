// THE HEADLINE AGAINST RISING GROUND (2026-09-19).
// The flat frames said the price covers world but no driving surface. The truck never climbed in those runs - it sat
// in the bay lane the whole horizon pass, because that page's round had ended and the roll-out was never re-done. So
// this joins a round properly, rolls out, then STEERS TOWARD RISING GROUND, asking the page's own core for the
// height under the truck (b.core.groundAt) rather than assuming a slope, and captures frames at the highest ground
// it reaches. Chrome is hidden only at capture time, after the driving is finished.
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const PORT = Number(process.env.PORT || 9351);
const PAGE = 'https://btc-logistics-core.pages.dev/';
const OUT = '/tmp/claude-1000/-tmp-btc-phase0/3702e750-4ad9-4253-93e3-670b04a90b08/scratchpad/cab-headline/climb';
const ONE = 65536;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (l) => console.log(`${new Date().toISOString().slice(11, 19)}  ${l}`);
mkdirSync(OUT, { recursive: true });
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const t = list.find((x) => x.type === 'page' && x.url.startsWith('http'));
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0; const pend = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, q = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: q })); });
await send('Runtime.enable'); await send('Page.enable');
const ev = async (e) => { const r = await Promise.race([send('Runtime.evaluate', { expression: e, returnByValue: true }), wait(20000).then(() => null)]); return r ? r.result?.result?.value : null; };
const key = (ty, code, kc, tx) => send('Input.dispatchKeyEvent', { type: ty, code, key: tx, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, ...(ty === 'keyDown' ? { text: tx } : {}) });
const click = async (x, y) => { for (const k of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: k, x, y, button: 'left', clickCount: 1, buttons: 1 }); await wait(700); };
const shot = async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null); if (r?.result?.data) writeFileSync(join(OUT, f), Buffer.from(r.result.data, 'base64')); };

// pose plus the ground under the truck and the core's tape price, all from the page's own core
const POSE = `(function(){var b=window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwp;
  if(!b||!b.st||!b.core) return null;
  var x=b.st.i32[5], z=b.st.i32[6];
  var g=b.core.groundAt(b.st,x,z);
  var o=new Int32Array(4096); b.core.chartView(b.st,0,o);
  return JSON.stringify({x:x/65536,z:z/65536,ground:g/65536,last:o[4],unit:o[14],samples:o[23]});})()`;

try {
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Page.navigate', { url: PAGE });
  await wait(9000);
  let href = '';
  for (let i = 0; i < 40 && !href; i++) {
    const got = await ev(`(function(){var r=(window.BLWP_LOBBY||[]).filter(function(x){return x.free&&x.join;})[0];return r?(location.origin+location.pathname+r.join+'&play=1'):'';})()`);
    if (got && String(got).includes('round=')) href = String(got); else await wait(3000);
  }
  if (!href) throw new Error('no joinable free round');
  await send('Page.navigate', { url: href });
  await wait(6000);
  for (let i = 0; i < 90; i++) { if (await ev('!!(window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwp)') === true) break; await wait(2000); }
  const geom = JSON.parse(await ev(`(function(){var c=document.querySelector('canvas');var r=c.getBoundingClientRect();
    var w=c.width,h=c.height;var bp=Math.max(10,h*0.022),hf=Math.round(Math.min(Math.max(Math.min(w,h)*0.034,15),26));
    var lh=hf*1.6,barW=Math.min(w*0.94,1040),panelH=lh*5.1,px=(w-barW)/2,py=h-panelH-bp,inner=bp*1.2,g=(barW-inner*3)*0.34;var k=r.width/w;
    return JSON.stringify({cw:w,ch:h,splash:[r.left+r.width/2,r.top+r.height*0.69],
      auto:[r.left+(px+inner+g/2)*k,r.top+(py+panelH-lh*1.25+lh/2)*k],
      roll:[r.left+(px+inner*2+g+g/2)*k,r.top+(py+panelH-lh*1.25+lh/2)*k]});})()`));
  say(`canvas ${geom.cw} x ${geom.ch}`);
  const pose = async () => { const v = await ev(POSE); return v ? JSON.parse(v) : null; };
  const drove = async (ms, turn) => {
    const a = await pose();
    await key('keyDown', 'KeyW', 87, 'w');
    if (turn) await key('keyDown', turn === 'L' ? 'KeyA' : 'KeyD', turn === 'L' ? 65 : 68, turn === 'L' ? 'a' : 'd');
    await wait(ms);
    if (turn) await key('keyUp', turn === 'L' ? 'KeyA' : 'KeyD', turn === 'L' ? 65 : 68, turn === 'L' ? 'a' : 'd');
    await key('keyUp', 'KeyW', 87, 'w');
    await wait(250);
    const b = await pose();
    return { a, b, moved: a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0 };
  };
  let out = (await drove(2500)).moved > 0.5;
  for (let i = 0; i < 6 && !out; i++) {
    await click(geom.splash[0], geom.splash[1]); await wait(1200);
    await click(geom.auto[0], geom.auto[1]); await wait(1000);
    await click(geom.roll[0], geom.roll[1]); await wait(2500);
    const d = await drove(2500);
    out = d.moved > 0.5;
    say(`roll-out try ${i + 1}: moved ${d.moved.toFixed(1)} m, pose ${d.b ? `x ${d.b.x.toFixed(0)} z ${d.b.z.toFixed(0)} ground ${d.b.ground.toFixed(1)} m` : '-'}`);
  }
  const start = await pose();
  if (!out || !start) { await shot('00-never-left-the-bay.png'); throw new Error(`never left the bay (pose ${start ? `x ${start.x.toFixed(0)} z ${start.z.toFixed(0)}` : 'unknown'})`); }
  say(`rolling: x ${start.x.toFixed(0)} z ${start.z.toFixed(0)}, ground under the truck ${start.ground.toFixed(2)} m`);

  // CLIMB: drive in bursts, turning when the ground stops rising, and keep the best height reached.
  let best = start, turn = null;
  for (let i = 0; i < 14; i++) {
    const d = await drove(2200, turn);
    if (!d.b) break;
    const rose = d.a ? d.b.ground - d.a.ground : 0;
    if (d.b.ground > best.ground) best = d.b;
    say(`burst ${i}: x ${d.b.x.toFixed(0)} z ${d.b.z.toFixed(0)} ground ${d.b.ground.toFixed(2)} m (${rose >= 0 ? '+' : ''}${rose.toFixed(2)}), moved ${d.moved.toFixed(0)} m`);
    turn = rose < 0.05 ? (turn === 'L' ? 'R' : 'L') : null;      // not climbing: try another way
    if (d.b.ground - start.ground > 2.0) { say('climbed over 2 m above the start'); break; }
  }
  const end = await pose();
  say(`ended at x ${end.x.toFixed(0)} z ${end.z.toFixed(0)}, ground ${end.ground.toFixed(2)} m; best reached ${best.ground.toFixed(2)} m (start ${start.ground.toFixed(2)} m)`);

  await ev(`(function(){var c=document.querySelector('canvas');document.querySelectorAll('body *').forEach(function(el){
    if(el===c||el.contains(c))return; el.style.setProperty('visibility','hidden','important');});})()`);
  await wait(700);
  for (let i = 0; i < 3; i++) {
    const p = await pose();
    if (p) say(`shot ${i}: ground ${p.ground.toFixed(2)} m, core tape $${(p.last / p.unit).toFixed(2)} (samples ${p.samples})`);
    await shot(`climb-${i}.png`);
    await wait(1300);
  }
  writeFileSync(join(OUT, 'pose.json'), JSON.stringify({ start, best, end }, null, 1));
  say(`shots in ${OUT}`);
} catch (e) { say(`FAILED ${e && e.message ? e.message : e}`); process.exitCode = 1; }
finally { try { ws.close(); } catch {} }
