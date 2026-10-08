import { WebSocket } from 'ws';
const port = process.argv[2] || 9351;
const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
const t = list.find(x => x.type === 'page' && x.url.startsWith('http'));
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r));
let id = 0; const pending = new Map();
ws.on('message', m => { const j = JSON.parse(m); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
const ev = (e) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } })); });
const out = await ev(`(function(){
  var c=document.querySelector('canvas'); if(!c) return 'no canvas';
  var r=c.getBoundingClientRect();
  var w=c.width,h=c.height,s=Math.max(76,Math.min(w,h)*0.20),m=Math.max(14,Math.min(w,h)*0.035);
  var k=r.width/w;
  var pts={ upPad:[(w-m-s/2)*k+r.left,(h-m-s-m*0.5-s/2)*k+r.top],
            leftPad:[(m+s/2)*k+r.left,(h-m-s/2)*k+r.top],
            soundIcon:[(w-m-s*0.7+s*0.17)*k+r.left,(m+s*0.80+s*0.17)*k+r.top],
            middle:[r.left+r.width/2,r.top+r.height/2] };
  var o={ url: location.href, canvas: w+'x'+h+' backing, '+Math.round(r.width)+'x'+Math.round(r.height)+' css at '+Math.round(r.left)+','+Math.round(r.top), dpr: devicePixelRatio, inner: innerWidth+'x'+innerHeight };
  Object.keys(pts).forEach(function(n){
    var e=document.elementFromPoint(pts[n][0],pts[n][1]);
    o[n]=pts[n].map(Math.round).join(',')+' -> '+(e?e.tagName+(e.id?'#'+e.id:'')+(e.className?'.'+String(e.className).slice(0,40):''):'NOTHING');
  });
  o.touch='maxTouchPoints='+navigator.maxTouchPoints+' ontouchstart='+('ontouchstart' in window)+' TouchEvent='+(typeof TouchEvent)+' ua='+navigator.userAgent.slice(0,60);
  var rf=document.getElementById('blwp-refund');
  if(rf){var b=rf.getBoundingClientRect(),st=getComputedStyle(rf);
    o.refund='rect '+Math.round(b.width)+'x'+Math.round(b.height)+'@'+Math.round(b.left)+','+Math.round(b.top)
      +' opacity='+st.opacity+' bg='+st.backgroundColor+' pe='+st.pointerEvents+' vis='+st.visibility
      +' children='+rf.children.length+' text="'+(rf.textContent||'').trim().slice(0,80)+'"'
      +' hitAtTopMiddle='+(function(){var e=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return e?e.tagName+(e.id?'#'+e.id:''):'none';})();}
  o.bodyChildren=Array.from(document.body.children).map(function(e){var b=e.getBoundingClientRect();var st=getComputedStyle(e);
    return e.tagName+(e.id?'#'+e.id:'')+' '+Math.round(b.width)+'x'+Math.round(b.height)+'@'+Math.round(b.left)+','+Math.round(b.top)+' z='+st.zIndex+' pe='+st.pointerEvents+' '+st.display;});
  return JSON.stringify(o,null,1);
})()`);
console.log(out.result?.result?.value ?? JSON.stringify(out.result));
ws.close();
