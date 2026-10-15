// #326 item 16: a phone opens every guardian wss:// endpoint (A and B), from the live page's origin, and asks each for its session count
import WebSocket from 'ws'; import { spawn } from 'node:child_process'; import fs from 'node:fs';
const [shot = 'phonews.png'] = process.argv.slice(2); const port = 9454;
const dir = fs.mkdtempSync('/tmp/claude-1000/pw-');
const ch = spawn(process.env.CHROME_BIN || new URL('./blwp-browser/chrome', import.meta.url).pathname, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs; for (let i = 0; i < 50; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.find((t) => t.type === 'page')) break; } catch {} await sleep(200); }
const ws = new WebSocket(tabs.find((v) => v.type === 'page').webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
let id = 0; const wait = new Map();
ws.on('message', (m) => { const j = JSON.parse(m); if (j.id && wait.has(j.id)) { wait.get(j.id)(j); wait.delete(j.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result.result ? r.result.result.value : JSON.stringify(r.result); };
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
try {
  await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // a phone on a fast 4G line: 150 ms round trip, 9 Mbit/s down, 1.5 up
  await send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 });
  await send('Page.navigate', { url: 'https://testnet.bitcoin-arena.io/' }); await sleep(8000);
  const out = await ev(`(async () => {
    const eps = [...[1,2,3,4,5,6,7].map(i => ['A', i, 'wss://tn4.bitcoin-arena.io/guardian-' + i + '/guardian']), ...[1,2,3,4,5,6,7].map(i => ['B', i, 'wss://tn4.bitcoin-arena.io/fed2-' + i + '/guardian'])];
    const one = ([fed, i, u]) => new Promise((res) => { const t0 = performance.now(); let open = null; const w = new WebSocket(u);
      const done = (r) => { try { w.close(); } catch {} res({ fed, i, u, open, ...r }); };
      const to = setTimeout(() => done({ err: 'no answer in 20 s' }), 20000);
      w.onopen = () => { open = Math.round(performance.now() - t0); w.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session_count', params: [{ params: null, auth: null }] })); };
      w.onmessage = (m) => { clearTimeout(to); const j = JSON.parse(m.data); done({ answer: Math.round(performance.now() - t0), session: j.result, err: j.error && JSON.stringify(j.error) }); };
      w.onerror = () => { clearTimeout(to); done({ err: 'socket error' }); }; });
    const rows = await Promise.all(eps.map(one));
    document.body.innerHTML = '<div style="font:14px monospace;padding:12px;background:#fff;color:#000"><b>' + navigator.userAgent.slice(0, 60) + '</b><br>origin ' + location.origin + '<br>' + new Date().toISOString() + '<br><br>' + rows.map(r => r.fed + ' g' + r.i + ' open ' + r.open + ' ms, answer ' + (r.answer ?? '-') + ' ms, session ' + (r.session ?? '-') + (r.err ? ' ERR ' + r.err : '')).join('<br>') + '</div>';
    return JSON.stringify({ origin: location.origin, ua: navigator.userAgent, mobile: navigator.userAgentData && navigator.userAgentData.mobile, rows });
  })()`);
  await sleep(500);
  const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shot, Buffer.from(r.result.data, 'base64'));
  console.log(out);
} finally { ws.close(); ch.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
process.exit(0);
