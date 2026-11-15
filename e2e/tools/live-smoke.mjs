// #064 smoke of a live page against the live seats (read-only, one nice'd headless Chrome): each app from the chooser, the wallet, Feedback.
//   node e2e/tools/live-smoke.mjs <url> <out dir>
import { launch } from '../lib/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const [url, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch({ dir: `${out}/chrome` });
const res = { url, games: {} };
let allErrors = [];
try {
  for (const [name, tile, unity] of [['rock-paper-scissors', '^Rock Paper Scissors', false], ['btc-updown', '^Bitcoin Up or Down', false], ['nextblock', '^Tick Tock, Next Block', true]]) {
    const t = await b.tab('about:blank', { allowExternal: true, noUnity: !unity });
    await t.go(url, 8000);
    res.ui = res.ui || (await t.js('(document.body.innerText.match(/UI \\d+/) || [""])[0]'));
    const clicked = await t.click('button,a,[role=button]', tile);
    await wait(unity ? 40000 : 25000);
    const lines = t.log.console.map((c) => c.text);
    const loaded = lines.find((l) => /loaded by its manifest hash/.test(l)) || null;
    const cannot = /cannot be loaded/.test(await t.text());
    const errs = t.log.console.filter((c) => c.type === 'error').map((c) => c.text.slice(0, 200)).concat(t.log.errors.map((e) => 'EXC ' + e.text.slice(0, 200)));
    allErrors = allErrors.concat(errs.map((e) => `${name}: ${e}`));
    res.games[name] = { clicked, loaded: loaded ? loaded.slice(0, 200) : null, cannot, errors: errs.length };
    await t.shot(`${out}/${name}.png`);
    if (name === 'rock-paper-scissors') {
      // the wallet start and the Feedback form, in the same page
      res.wallet = await t.js('document.body.innerText.includes("Create a new wallet") || !!document.getElementById("arena-hdr-bal")');
      const fb = await t.click('#arena-foot-feedback');
      await wait(3000);
      res.feedback = { clicked: fb, form: await t.js('!!document.querySelector("#arena-feedback-send, textarea") && /feedback/i.test(document.body.innerText)') };
      await t.shot(`${out}/feedback.png`);
    }
    await t.close();
  }
  res.consoleErrors = allErrors.length;
  writeFileSync(`${out}/errors.txt`, allErrors.join('\n'));
  console.log(JSON.stringify(res, null, 1));
  console.log('--- errors\n' + allErrors.join('\n'));
} finally { await b.close(); process.exit(0); }
