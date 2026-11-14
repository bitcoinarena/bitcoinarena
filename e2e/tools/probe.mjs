// A look at one page in the real headless Chrome (kanban #2642 harness work): its text, errors, failed requests and a screenshot.
//   node e2e/tools/probe.mjs <url> <out dir> [wait ms] [js to run after]
import { launch } from '../lib/cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const [url, out, ms = '8000', after] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b = await launch({ dir: `${out}/chrome` });
try {
  const t = await b.tab(url);
  await new Promise((r) => setTimeout(r, Number(ms)));
  if (after) console.log('after:', JSON.stringify(await t.js(after)).slice(0, 4000));
  await t.shot(`${out}/shot.png`);
  const text = await t.text();
  writeFileSync(`${out}/text.txt`, text);
  writeFileSync(`${out}/log.json`, JSON.stringify(t.log, null, 1));
  console.log(text.slice(0, 3000));
  console.log('--- errors', JSON.stringify(t.log.errors).slice(0, 1500));
  console.log('--- failed', JSON.stringify(t.log.failed.slice(0, 15)).slice(0, 1500));
  console.log('--- console errors', JSON.stringify(t.log.console.filter((c) => c.type === 'error').slice(0, 10)).slice(0, 1500));
} finally { await b.close(); }
