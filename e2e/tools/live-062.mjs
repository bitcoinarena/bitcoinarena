// #062/#066/#063 read-only checks on a live page (one nice'd headless Chrome at a time): footer overlap at 1280x900, how long the chooser
// says "Finding the nodes", and Next Block without WebGL. Nothing is sent, no wallet is made.
import { launch } from '../lib/cdp.mjs';
import { mkdirSync } from 'node:fs';
const [url, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const res = {};
const J = (t, e) => t.js(e, 15000).catch((x) => `js failed: ${x.message.slice(0, 80)}`);
{ // #066 + #062
  const b = await launch({ dir: `${out}/c1`, width: 1280, height: 900 });
  try {
    const t = await b.tab('about:blank', { allowExternal: true, noUnity: true, viewport: { width: 1280, height: 900 } });
    const t0 = Date.now();
    await t.call('Page.navigate', { url });
    let seen = null, first = null, last = '';
    while (Date.now() - t0 < 300000) {
      const s = await J(t, 'document.body ? document.body.innerText : ""');
      const finding = /Finding the nodes/i.test(s);
      if (finding && first === null) first = Date.now() - t0;
      if (first !== null && !finding) { seen = Date.now() - t0; last = s; break; }
      if (first === null && Date.now() - t0 > 30000) { last = s; break; }
      await wait(250);
    }
    res['066'] = { findingShownAtMs: first, changedAtMs: seen, findingForMs: first !== null && seen !== null ? seen - first : null,
      after: String(await J(t, '(document.querySelector("#arena-games") || document.body).innerText.slice(0, 300)')).replace(/\n/g, ' / '), lastPolled: String(last).slice(0, 200).replace(/\n/g, ' / ') };
    await wait(3000);
    await t.shot(`${out}/full-1280x900.png`);
    res['062'] = await J(t, `(() => { const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      const ui = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /^UI \\d+$/.test((e.innerText || '').trim()) && e.offsetParent !== null).map((e) => ({ text: e.innerText.trim(), box: r(e) }));
      const x = [...document.querySelectorAll('a,button')].filter((e) => e.offsetParent !== null && /x\\.com|twitter/i.test(e.href || e.getAttribute('aria-label') || e.title || '')).map((e) => ({ href: e.href || null, box: r(e) }));
      const hit = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      return { ui, x, overlap: ui.some((u) => x.some((k) => hit(u.box, k.box))) }; })()`);
    const f = res['062'] && res['062'].ui && res['062'].ui[0] ? res['062'].ui[0].box : null;
    if (f) await t.call('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, f.x - 300), y: Math.max(0, f.y - 30), width: 600, height: 80, scale: 2 } })
      .then((s) => import('node:fs').then((fs) => fs.writeFileSync(`${out}/footer-1280x900.png`, Buffer.from(s.data, 'base64'))));
  } finally { await b.close(); }
}
{ // #063
  const b = await launch({ dir: `${out}/c2`, extra: ['--disable-webgl', '--disable-3d-apis'] });
  try {
    const t = await b.tab('about:blank', { allowExternal: true });
    await t.go(url, 8000);
    await t.click('button,a,[role=button]', '^Tick Tock, Next Block');
    await wait(20000);
    await t.shot(`${out}/nowebgl-nextblock.png`);
    const txt = String(await J(t, 'document.body.innerText'));
    res['063'] = { webgl: await J(t, '!!document.createElement("canvas").getContext("webgl")'), says: (txt.match(/[^\n]*WebGL[^\n]*/gi) || []).slice(0, 4), bodyStart: txt.slice(0, 200).replace(/\n/g, ' / ') };
  } finally { await b.close(); }
}
console.log(JSON.stringify(res, null, 1));
process.exit(0);
