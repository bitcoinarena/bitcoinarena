// #064: Next Block from the chooser on a live page: does Unity boot from the pinned client (read-only)
import { launch } from '../lib/cdp.mjs';
import { mkdirSync } from 'node:fs';
const [url, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b = await launch({ dir: `${out}/chrome` });
try {
  const t = await b.tab('about:blank', { allowExternal: true });
  await t.go(url, 8000);
  await t.click('button,a,[role=button]', '^Tick Tock, Next Block');
  let up = false; for (let i = 0; i < 60 && !up; i++) { up = await t.js('!!window.unityInstance'); if (!up) await new Promise((r) => setTimeout(r, 1000)); }
  console.log(JSON.stringify({ unity: up, pinnedRefused: t.log.console.some((c) => /not the pinned client/.test(c.text)), arenaLines: t.log.console.filter((c) => /\[arena\].*(client|pinned|loaded)/i.test(c.text)).map((c) => c.text.slice(0, 160)).slice(0, 5), errors: t.log.console.filter((c) => c.type === 'error').map((c) => c.text.slice(0, 120)) }));
} finally { await b.close(); process.exit(0); }
