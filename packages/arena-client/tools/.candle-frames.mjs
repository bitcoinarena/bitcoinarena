import { WebSocket } from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT='/tmp/claude-1000/-tmp-btc-phase0/3702e750-4ad9-4253-93e3-670b04a90b08/scratchpad/candle-frames';
mkdirSync(OUT,{recursive:true});
const list = await fetch('http://127.0.0.1:9351/json/list').then(r=>r.json());
const t = list.find(x=>x.type==='page'&&x.url.startsWith('http'));
const ws = new WebSocket(t.webSocketDebuggerUrl,{maxPayload:64*1024*1024});
await new Promise(r=>ws.on('open',r));
let id=0; const p=new Map();
ws.on('message',m=>{const j=JSON.parse(m); if(j.id&&p.has(j.id)){p.get(j.id)(j);p.delete(j.id);}});
const send=(method,params={})=>new Promise(r=>{const n=++id;p.set(n,r);ws.send(JSON.stringify({id:n,method,params}));});
const ev=e=>send('Runtime.evaluate',{expression:e,returnByValue:true}).then(r=>r.result?.result?.value);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
for (let i=0;i<8;i++){
  const st = await ev(`(function(){var b=window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwp;
    return b&&b.st?JSON.stringify({tick:b.st.i32[0],shift:b.st.candleShift|0}):'none';})()`);
  const r = await send('Page.captureScreenshot',{format:'png'});
  if (r.result?.data) writeFileSync(`${OUT}/f${i}.png`, Buffer.from(r.result.data,'base64'));
  console.log(`frame ${i}: ${st}`);
  await wait(1000);
}
ws.close();
