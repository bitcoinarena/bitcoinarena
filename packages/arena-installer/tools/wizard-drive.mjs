// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #471: drive the wizard page in a headless Chrome over CDP (port 9361) and screenshot every step, full page:
//     node tools/wizard-drive.mjs <link file> <out dir> <ws module path>
import { writeFileSync, readFileSync } from 'node:fs';
const [linkFile, outDir, wsMod] = process.argv.slice(2);
const { default: WebSocket } = await import(wsMod);
const link = readFileSync(linkFile, 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs; for (let i = 0; i < 40; i++) { try { tabs = await (await fetch('http://127.0.0.1:9361/json')).json(); if (tabs.length) break; } catch {} await sleep(250); }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
let n = 0; const p = new Map(); ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); } });
const call = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.result.value;
const shot = async (name) => {
  await call('Emulation.setDeviceMetricsOverride', { width: 860, height: 900, deviceScaleFactor: 1, mobile: false });
  const h = await js('Math.max(document.body.scrollHeight, 900)');
  await call('Emulation.setDeviceMetricsOverride', { width: 860, height: h, deviceScaleFactor: 1, mobile: false });
  const s = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(s.result.data, 'base64'));
  console.log('shot', name, h);
};
const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click(), true`);
await call('Page.navigate', { url: link }); await sleep(2500);
await shot('01-bitcoin');
await js(`document.getElementById('c-url').value='http://127.0.0.1:48332/'; document.getElementById('c-cookie').value='/mnt/bitcoin/tn4/testnet4/.cookie'; true`);
await click('chain-test'); await sleep(7000); await shot('02-bitcoin-tested');
await click('chain-save'); await sleep(9000); await shot('03-roles');
await js(`document.querySelector('#roles input[value=custody]').checked = true; true`); await shot('03b-roles-custody');
await click('roles-save'); await sleep(1500); await shot('04-seed');
await click('seed-show'); await sleep(1500); await shot('05-seed-words');
await js(`window.__w = [...document.querySelectorAll('#words span')].map((s) => s.textContent.replace(/^\\d+/, '')); true`);
await click('seed-written'); await sleep(800);
await js(`(() => { for (const i of document.querySelectorAll('#confirm-inputs input')) i.value = window.__w[Number(i.dataset.p) - 1]; return true; })()`);
await shot('06-seed-asked-back');
await click('seed-confirm'); await sleep(1500); await shot('07-owner');
await click('owner-save'); await sleep(1500); await shot('08-reach');
await click('r-test'); await sleep(16000); await shot('09-reach-tested');
await js(`document.getElementById('rm-quick').checked = true; true`);
await click('r-save'); await sleep(1500); await shot('10-install');
await click('svc'); await sleep(25000); await shot('11-lightning');
await click('ln-own'); await sleep(4000); await shot('11b-lightning-starting');
for (let i = 0; i < 120 && !(await js(`/runs on/.test(document.getElementById('ln-msg').textContent)`)); i++) await sleep(500);
await shot('11c-lightning-done');
await click('gw-setup');
for (let i = 0; i < 240 && !(await js(`/gateway runs/.test(document.getElementById('gw-msg').textContent)`)); i++) await sleep(500);
await shot('11e-gateway-running');
await click('gw-next'); await sleep(2500); await shot('11f-bond-custody');
await click('b-check'); await sleep(2000); await shot('12-bond-nothing-yet');
await click('b-check'); await sleep(2000); await shot('13-bond-deposit-found');
await click('b-post'); await sleep(4000); await shot('14-done');
ws.close(); process.exit(0);
