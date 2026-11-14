// #062/#066 follow-up: where "UI nnn" and "Finding the nodes" sit on the live page, 30 s after load, at 1280x900 (read-only)
import { launch } from '../lib/cdp.mjs';
const [url, out] = process.argv.slice(2);
const b = await launch({ dir: `${out}/c3`, width: 1280, height: 900 });
try {
  const t = await b.tab('about:blank', { allowExternal: true, noUnity: true, viewport: { width: 1280, height: 900 } });
  await t.go(url, 30000);
  console.log(await t.js(`JSON.stringify((() => { const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    const vis = (e) => { const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && e.getClientRects().length > 0; };
    const find = (re) => [...document.querySelectorAll('body *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && re.test(n.textContent))).map((e) => ({ tag: e.tagName, id: e.id, cls: String(e.className).slice(0, 40), vis: vis(e), box: r(e), parent: e.parentElement && (e.parentElement.id || e.parentElement.className) }));
    const icons = [...document.querySelectorAll('footer a, .site-foot a, a[href*="x.com"]')].filter(vis).map((e) => ({ href: (e.href || '').slice(0, 40), box: r(e) }));
    return { ui: find(/UI \\d+/), finding: find(/Finding the nodes/), icons };
  })())`, 20000));
  const s = await t.call('Page.captureScreenshot', { format: 'png', clip: { x: 880, y: 860, width: 400, height: 40, scale: 2 } });
  (await import('node:fs')).writeFileSync(`${out}/footer-right-1280x900.png`, Buffer.from(s.data, 'base64'));
} finally { await b.close(); process.exit(0); }
