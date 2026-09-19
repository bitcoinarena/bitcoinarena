// WHAT THE PRICE HEADLINE IS ACTUALLY DRAWN AT, from the cab (2026-09-19).
// PRIORITIES: "from the cab the price headline is drawn about 80 px tall across the middle of the screen". That ~80
// was read off a photograph; this asks the page. DriveHud sizes it `min(w,h) * 0.13` and shrinks it only to fit the
// gap's width, drawing it in WHITE at HeadlineRowY(w,h,0) - so the canvas size is printed beside the pixels and the
// two can be checked against each other.
// Live Chrome is the test host (HARD 19:05), reached on the forwarded CDP port.
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const PAGE = arg('page', 'https://btc-logistics-core.pages.dev/');
const PORT = Number(arg('port', 9341));
const OUT = arg('out', '/tmp/claude-1000/-tmp-btc-phase0/3702e750-4ad9-4253-93e3-670b04a90b08/scratchpad/cab-headline');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (l) => console.log(`${new Date().toISOString().slice(11, 19)}  ${l}`);
mkdirSync(OUT, { recursive: true });

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const target = list.find((x) => x.type === 'page' && x.url.startsWith('http'));
if (!target) throw new Error(`nothing to attach to on ${PORT}`);
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Runtime.enable'); await send('Page.enable');
const ev = async (e) => { const r = await Promise.race([send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }), wait(20000).then(() => null)]); return r ? r.result?.result?.value : 'TIMED OUT'; };
const shot = async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null); if (r?.result?.data) { writeFileSync(join(OUT, f), Buffer.from(r.result.data, 'base64')); return true; } return false; };
const key = (type, code, kc, text) => send('Input.dispatchKeyEvent', { type, code, key: text, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, ...(type === 'keyDown' ? { text } : {}) });
const click = async (x, y) => { for (const t of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1, buttons: 1 }); await wait(700); };

const ST = `(function(){var m=window.unityInstance&&window.unityInstance.Module,b=m&&m.blwp;
  if(!b||!b.st) return null; return {tick:b.st.i32[0], x:b.st.i32[5], z:b.st.i32[6]};})()`;

try {
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Page.navigate', { url: PAGE });
  await wait(9000);
  let rows = 0;
  for (let i = 0; i < 60 && !rows; i++) { rows = Number(await ev('(window.BLWP_LOBBY||[]).length')) || 0; if (!rows) await wait(2000); }
  say(`lobby rows ${rows}`);
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
    return JSON.stringify({cw:w,ch:h,k:k,left:r.left,top:r.top,
      splash:[r.left+r.width/2,r.top+r.height*0.69],
      auto:[r.left+(px+inner+g/2)*k,r.top+(py+panelH-lh*1.25+lh/2)*k],
      roll:[r.left+(px+inner*2+g+g/2)*k,r.top+(py+panelH-lh*1.25+lh/2)*k]});})()`));
  say(`canvas ${geom.cw} x ${geom.ch} (css scale ${geom.k.toFixed(3)}), min = ${Math.min(geom.cw, geom.ch)}`);
  const drove = async (ms) => { const a = await ev(ST); await key('keyDown', 'KeyW', 87, 'w'); await wait(ms); await key('keyUp', 'KeyW', 87, 'w'); const b = await ev(ST); if (!a || !b) return 0; return Math.hypot((b.x - a.x) / 65536, (b.z - a.z) / 65536); };
  let out = await drove(2500) > 0.5;
  for (let i = 0; i < 6 && !out; i++) {
    await click(geom.splash[0], geom.splash[1]); await wait(1200);
    await click(geom.auto[0], geom.auto[1]); await wait(1000);
    await click(geom.roll[0], geom.roll[1]); await wait(2500);
    out = await drove(2500) > 0.5;
    say(`try ${i + 1}: the truck ${out ? 'is rolling' : 'is still in the bay'}`);
  }
  if (!out) { await shot('00-never-left-the-bay.png'); throw new Error('never left the bay'); }
  say(`drove out ${(await drove(4000)).toFixed(0)} m`);
  await wait(1500);
  for (let i = 0; i < 3; i++) { await shot(`cab-${i}.png`); await wait(1200); }
  say(`shots in ${OUT}`);
  writeFileSync(join(OUT, 'geom.json'), JSON.stringify(geom, null, 1));
} catch (e) { say(`FAILED ${e && e.message ? e.message : e}`); process.exitCode = 1; }
finally { try { ws.close(); } catch {} }
