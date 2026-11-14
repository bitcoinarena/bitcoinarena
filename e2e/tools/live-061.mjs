// #061 / #069 on a live testnet page (testnet sats only, as the coordinator allowed): header balance through wallet create, the seed
// modal, Feedback; then the footer's "Get 300 sats". Samples the header and the deposit window, screenshots each step.
import { launch } from '../lib/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const [url, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch({ dir: `${out}/c`, width: 1280, height: 900 });
const log = [];
try {
  const t = await b.tab('about:blank', { allowExternal: true, noUnity: true, viewport: { width: 1280, height: 900 } });
  const J = (e) => t.js(e, 15000).catch((x) => `js failed: ${x.message.slice(0, 60)}`);
  const hdr = () => J('(document.getElementById("arena-hdr-bal") || {}).innerText || null');
  const toast = () => J('[...document.querySelectorAll("#arena-money-alert, .arena-toast, [role=status], #arena-money-why")].filter((e) => e.offsetParent !== null).map((e) => e.innerText.trim()).filter(Boolean).join(" | ").slice(0, 200)');
  const note = async (step, shot) => { const r = { t: new Date().toISOString().slice(11, 19), step, header: await hdr(), toast: await toast() }; log.push(r); console.log(JSON.stringify(r)); if (shot) await t.shot(`${out}/${shot}.png`); };
  await t.go(url, 10000);
  await note('loaded', '01-loaded');
  await t.click('button', 'Create a new wallet');
  for (let i = 0; i < 12; i++) { await wait(1500); await note(`after create +${(i + 1) * 1.5}s`, i === 3 ? '02-seed-modal' : null); }
  await t.click('button', '^Close$');
  for (let i = 0; i < 6; i++) { await wait(1500); await note(`after seed close +${(i + 1) * 1.5}s`, i === 1 ? '03-seed-closed' : null); }
  await t.click('#arena-foot-feedback');
  for (let i = 0; i < 6; i++) { await wait(1500); await note(`feedback open +${(i + 1) * 1.5}s`, i === 1 ? '04-feedback-open' : null); }
  await t.js('(() => { const x = [...document.querySelectorAll("button")].find((e) => e.offsetParent !== null && /^(×|Close|Cancel)$/.test(e.innerText.trim())); if (x) x.click(); return !!x; })()');
  await wait(3000); await note('feedback closed', '05-feedback-closed');
  // #069
  const dep = () => J('(() => { const d = document.getElementById("arena-deposit"); if (!d || getComputedStyle(d).display === "none" || !d.innerText.trim()) return { open: false }; const q = d.querySelector("svg, img, canvas"); return { open: true, qr: !!q, text: d.innerText.replace(/\\n/g, " / ").slice(0, 220) }; })()');
  const btn = await J('(document.getElementById("arena-foot-topup") || {}).innerText || null');
  console.log('topup button:', btn);
  await t.click('#arena-foot-topup');
  for (let i = 0; i < 30; i++) { await wait(3000); const d = await dep(); const r = { t: new Date().toISOString().slice(11, 19), step: `topup +${(i + 1) * 3}s`, header: await hdr(), deposit: d, toast: await toast() }; log.push(r); console.log(JSON.stringify(r).slice(0, 400)); if ([1, 5, 12, 29].includes(i)) await t.shot(`${out}/06-topup-${(i + 1) * 3}s.png`); }
  writeFileSync(`${out}/log.json`, JSON.stringify({ log, console: t.log.console.filter((c) => /faucet|deposit|credited|balance/i.test(c.text)).map((c) => c.text.slice(0, 200)) }, null, 1));
} finally { await b.close(); process.exit(0); }
