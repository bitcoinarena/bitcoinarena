#!/bin/bash
# A CHROME THAT CAN KEEP THE ROUND'S CLOCK (2026-09-20).
#
# WHY THIS EXISTS. Every headless browser in `tools/` asks for `--use-gl=swiftshader`, which is right for a
# screenshot and wrong for anything the CORE decides. SwiftShader draws this world at about 3 frames a second;
# `CoreDrivenTruck` walks at most `MostTicksPerFrame` = 8 ticks a frame, so the page runs the core at 23 ticks
# a second against the 60 a round keeps. Measured 2026-09-20:
#
#   SwiftShader  1280x800     23.0 ticks/s
#   SwiftShader   640x400     41.1 ticks/s
#   ANGLE/Vulkan 1280x800     61.4 ticks/s      <- keeps the round's time
#
# A run measured on SwiftShader therefore never reaches the end of its own block: the node closes the round
# first and the client ends it VOID. That is how the first drive for the owner's 16:21 timer letter "measured"
# a fix it had not exercised at all - the lobby came back by the CLIENT's word at core tick 5004 of 10800,
# which is the path that already worked.
#
# The test host has an AMD Renoir (`/dev/dri/renderD128`) that headless Chrome will use through ANGLE/Vulkan.
# ANYTHING THAT MEASURES CORE TIMING - the round timer, an assault clock, a delivery, a tick count - must
# attach to this browser, not to a SwiftShader one.
#
#   packages/blwp-client/tools/gpu-chrome.sh [port] [width] [height]
#   node packages/core/tools/probe-timer-lobby.mjs <port> http://127.0.0.1:8191/ tag
set -u
PORT="${1:-9347}"
W="${2:-1280}"
H="${3:-800}"
CHROME="${CHROME:-/home/arena/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome}"
PROFILE="/tmp/blwp-gpu-profile-$PORT"

if [ ! -x "$CHROME" ]; then echo "no chrome at $CHROME (set CHROME=)"; exit 1; fi
if [ ! -e /dev/dri/renderD128 ]; then echo "no /dev/dri/renderD128 - there is no GPU to use here"; exit 1; fi

if curl -s --max-time 3 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then
  echo "a browser already answers on $PORT"
else
  nohup "$CHROME" --headless=new --remote-debugging-port="$PORT" \
    --window-size="$W,$H" --ozone-platform=headless --ozone-override-screen-size="$W,$H" \
    --use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist \
    --no-first-run --no-default-browser-check --disable-extensions --hide-scrollbars \
    --autoplay-policy=no-user-gesture-required --noerrdialogs \
    --user-data-dir="$PROFILE" about:blank > "/tmp/blwp-gpu-chrome-$PORT.log" 2>&1 &
  for _ in $(seq 1 20); do
    sleep 1
    curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1 && break
  done
fi

# SAY WHICH RENDERER IT GOT. A browser that silently fell back to SwiftShader looks identical from outside and
# would quietly mismeasure everything, which is the whole failure this script exists to prevent.
node -e "
const port=$PORT;
(async()=>{
 const list=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 const page=list.find(t=>t.type==='page'); if(!page){console.log('no page on '+port);process.exit(1);}
 const ws=new WebSocket(page.webSocketDebuggerUrl);
 let id=0; const pend=new Map();
 const call=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
 ws.onmessage=m=>{const d=JSON.parse(m.data); if(d.id&&pend.has(d.id)){pend.get(d.id)(d.result??d.error);pend.delete(d.id);}};
 await new Promise(r=>{ws.onopen=r;});
 await call('Runtime.enable');
 const r=await call('Runtime.evaluate',{returnByValue:true,expression:\`(function(){
   var c=document.createElement('canvas');var g=c.getContext('webgl2')||c.getContext('webgl');
   if(!g) return 'no webgl';
   var e=g.getExtension('WEBGL_debug_renderer_info');
   return e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER);})()\`});
 const name=String(r?.result?.value||'');
 console.log('port '+port+' renderer: '+name);
 if(/swiftshader|software/i.test(name)){console.log('THIS IS NOT THE GPU - do not measure core timing on it');process.exit(2);}
 process.exit(0);
})();"
