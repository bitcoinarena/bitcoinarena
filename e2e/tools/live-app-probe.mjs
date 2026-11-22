// #064: open a live page, choose an app in the chooser, and record what the page says and logs (read-only; one headless Chrome).
//   node e2e/tools/live-app-probe.mjs <url> <app title regexp> <out dir>
import { launch } from '../lib/cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const [url, app, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b = await launch({ dir: `${out}/chrome` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const t = await b.tab('about:blank', { allowExternal: true, noUnity: true });
  await t.go(url, 8000);
  const tiles = await t.js(`[...document.querySelectorAll('button,a,[role=button]')].filter((e) => e.offsetParent !== null).map((e) => (e.innerText || '').trim().slice(0, 40)).filter(Boolean).slice(0, 40)`);
  console.log('tiles:', JSON.stringify(tiles));
  const clicked = await t.click('button,a,[role=button],.tile,[data-app]', app);
  console.log('clicked:', clicked);
  await wait(20000);
  const text = await t.text();
  await t.shot(`${out}/shot.png`);
  writeFileSync(`${out}/log.json`, JSON.stringify(t.log, null, 1));
  console.log('url now:', await t.js('location.href'));
  console.log('--- text\n' + text.slice(0, 1500));
  console.log('--- console (manifest/client/load/cannot)');
  for (const c of t.log.console) if (/manifest|client|cannot|hash|loaded|index\.html|version/i.test(c.text)) console.log(`[${c.type}] ${c.text.slice(0, 500)}`);
  console.log('--- errors', JSON.stringify(t.log.errors.map((e) => e.text.slice(0, 300))));
  console.log('--- manifest/app requests');
  for (const r of t.log.requests) if (/manifest|game-manifest|rock|updown|games\/|\/plugin|app-version|\/games\b/i.test(r.url)) console.log(r.status ?? '-', r.url.slice(0, 200));
} finally { await b.close(); process.exit(0); }
