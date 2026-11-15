// Step through a page with a list of actions (kanban #2642 harness work), printing the text after each.
//   node e2e/tools/explore.mjs <url> <out dir> '<json list of [kind, arg, arg2]>'   kinds: wait ms | click sel textRe | js expr | type sel value | shot name
import { launch, servePageDir } from '../lib/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const [url, out, steps] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
if (process.env.PAGE_DIR) await servePageDir(process.env.PAGE_DIR, Number(process.env.PAGE_PORT), { faucet: process.env.FAUCET || null, anchor: process.env.ANCHOR || null });
const b = await launch({ dir: process.env.PROFILE_DIR || `${out}/chrome` });
let last = '';
try {
  const t = await b.tab(url, { noUnity: !!process.env.NOUNITY });
  for (const [k, a1, a2] of JSON.parse(steps)) {
    try {
      if (k === 'wait') await new Promise((r) => setTimeout(r, a1));
      else if (k === 'click') console.log(`click ${a1} ${a2 || ''}:`, await t.click(a1, a2));
      else if (k === 'js') console.log(`js:`, JSON.stringify(await t.js(a1)).slice(0, 3000));
      else if (k === 'type') console.log('type:', await t.js(`(() => { const e = document.querySelector(${JSON.stringify(a1)}); if (!e) return false; const set = Object.getOwnPropertyDescriptor(e.__proto__, 'value').set; set.call(e, ${JSON.stringify(a2)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`));
      else if (k === 'tap') { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await t.call('Input.dispatchMouseEvent', { type, x: a1, y: a2, button: 'left', clickCount: 1, buttons: 1 }); console.log('tap', a1, a2); }
      else if (k === 'shot') await t.shot(`${out}/${a1}.png`);
      else if (k === 'text') { const x = await t.text(); const d = x.split(last).join(''); console.log(`--- text (${x.length})\n${(a1 === 'all' ? x : x).slice(0, 2500)}`); last = x; }
    } catch (e) { console.log(`step ${k} failed: ${e.message}`); }
  }
  console.log('--- errors', JSON.stringify(t.log.errors.map((e) => e.text.slice(0, 200))).slice(0, 1200));
  console.log('--- console errors', JSON.stringify(t.log.console.filter((c) => c.type === 'error').map((c) => c.text.slice(0, 200)).slice(0, 8)).slice(0, 1600));
  writeFileSync(`${out}/log.json`, JSON.stringify(t.log, null, 1));
} finally { await b.close(); process.exit(0); }
