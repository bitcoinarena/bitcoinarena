// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER KEY HANDED TO THE SITE'S OWNER PAGE OUTSIDE THE INSTALLER (the owner's playtest 2026-10-26 on 2026.1.9.8, a node installed on
// 1.9.7 and updated: the site's owner page asked for the 24 words - "The update process should make sure the secret token is in the browser
// session so this works"). Only the installer's last button ever handed the key over (FinishSteps, #668); a node set up before that never
// had it. `bitcoinarena open` does it now: a one-time page on 127.0.0.1 opens the site's owner page and, when it asks, posts it the key -
// window to window, never in a URL - as the installer does. The page's address carries a random token; the key is answered once, to that
// page alone, and the server ends after it or after 3 minutes.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const HANDOFF_FILE = 'owner-handoff.json';
const hex64 = /^[0-9a-f]{64}$/;

/** The owner key of the node at `home` as the site's page takes it: { kind: 'seed', seed } | { kind: 'nsec', secret } | null. */
export function ownerKeyOf(home) {
  let s = {};
  try { s = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')); } catch { return null; }
  if (s.control === 'nostr') {
    try {
      const db = new DatabaseSync(join(home, 'node.db'), { readOnly: true });
      try { const r = db.prepare('SELECT secret FROM identity WHERE one = 0').get(); return r ? { kind: 'nsec', secret: Buffer.from(r.secret).toString('hex') } : null; } finally { db.close(); }
    } catch { return null; }
  }
  if ((s.owner || {}).mode === 'seed' && existsSync(join(home, 'seed.hex'))) {
    const seed = readFileSync(join(home, 'seed.hex'), 'utf8').trim();
    return hex64.test(seed) ? { kind: 'seed', seed } : null;
  }
  return null;
}

/**
 * EVERY NODE'S OWNER KEY AT ONCE (kanban #713, 2026-10-26: "You need to store credentials for *all* owner pages where its needed and provide
 * links"): the nodes here (machine-nodes.js nodesHere) with a key the site's page takes - { keys: [{ node, kind, seed | secret }], links:
 * [{ node, label, url }], homes } - one hand-over stores them all, each under its node.
 */
export function allOwnerKeys(nodes, ownerSite) {
  const keys = [], links = [], homes = [];
  for (const n of nodes) {
    const k = n.key && ownerKeyOf(n.home);
    if (!k) continue;
    keys.push({ node: n.key, ...k }); homes.push(n.home);
    links.push({ node: n.key, label: n.instance ? `Node ${n.instance}` : 'Node 1', url: `${ownerSite}#node=${n.key}${n.port ? `&local=${encodeURIComponent(`http://127.0.0.1:${n.port}`)}` : ''}` });
  }
  return { keys, links, homes };
}

/** When the key was last handed over from this node's home, or null. */
export function handedAt(home) {
  try { const j = JSON.parse(readFileSync(join(home, HANDOFF_FILE), 'utf8')); return Number(j.atMs) || null; } catch { return null; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** The one-time page: it opens `target` (the site's owner page with owner-handoff) and posts the key when that page asks. */
export function handoffPage({ target, token, links = [] }) {
  const origin = new URL(target).origin;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bitcoin Arena · Owner sign-in</title>
<style>:root{color-scheme:dark}body{margin:0;background:#0d1117;color:#e8edf3;font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:560px;margin:12vh auto;padding:0 16px}h1{font-size:22px}p{color:#9aa7b4}
button{font:inherit;font-weight:600;background:#f2a93b;color:#111;border:0;border-radius:10px;padding:12px 20px;cursor:pointer}
.ok{color:#5cc96b}.bad{color:#ef6b6b}</style></head><body><main>
<h1>Sign in on your owner page</h1>
<p>This hands your owner key from this computer to your owner page on ${esc(origin.replace(/^https:\/\//, ''))}, browser window to browser window. It stays in this browser only.</p>
<p><button id="go" type="button">Open my owner page</button></p>
<p id="say"></p>
<ul id="links" style="line-height:2"></ul>
<script>
const TARGET = ${JSON.stringify(target)}, ORIGIN = ${JSON.stringify(origin)}, BASE = '/' + ${JSON.stringify(token)}, LINKS = ${JSON.stringify(links).replace(/</g, '\\u003c')};
const say = (t, c) => { const e = document.getElementById('say'); e.textContent = t; e.className = c || ''; };
let w = null;
addEventListener('message', async (e) => {
  if (!w || e.source !== w || e.origin !== ORIGIN || !e.data || e.data.type !== 'arena-owner-ready') return;
  try {
    const k = await (await fetch(BASE + '/key', { cache: 'no-store' })).json();
    if (!k.ok) return say('Not handed over: ' + k.why, 'bad');
    w.postMessage(k.keys ? { type: 'arena-owner-key', keys: k.keys } : { type: 'arena-owner-key', kind: k.kind, seed: k.seed, secret: k.secret }, ORIGIN);
    fetch(BASE + '/done', { method: 'POST' }).catch(() => {});
    say(LINKS.length > 1 ? 'Done: all ' + LINKS.length + ' owner pages are signed in in this browser.' : 'Done: your owner page is signed in. You can close this tab.', 'ok');
    document.getElementById('go').hidden = true;
    const ul = document.getElementById('links');
    for (const l of LINKS) { const li = document.createElement('li'); const a = document.createElement('a'); a.href = l.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = l.label + ' · ' + l.node.slice(0, 8) + '…'; li.appendChild(a); ul.appendChild(li); }
  } catch (err) { say('Not handed over: ' + err.message, 'bad'); }
});
const go = () => { w = window.open(TARGET, '_blank'); if (w) say('Your owner page opened in a new tab …'); else say('Your browser blocked the new tab: press the button.', 'bad'); return w; };
document.getElementById('go').onclick = go;
go();
</script></main></body></html>`;
}

/**
 * Serves the one-time page on 127.0.0.1. Answers { url, done } - done resolves with true once the key was handed over (recorded in
 * <home>/owner-handoff.json), false after `ttlMs`; the server is closed either way.
 */
export function serveHandoff({ home, key, target, links = [], homes = null, ttlMs = 180000, port = 0, now = () => Date.now() }) {
  const token = randomBytes(24).toString('base64url');
  let taken = false, finish = null;
  const done = new Promise((ok) => { finish = ok; });
  const server = createServer((req, res) => {
    const host = String(req.headers.host || '');
    const path = String(req.url || '').split('?')[0];
    // this page's own address only (a site that points a name at 127.0.0.1 gets nothing), and no other site's request
    const own = host === `127.0.0.1:${server.address().port}` && !(req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']));
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(body); };
    if (!own) return send(404, 'text/plain', 'not here');
    if (req.method === 'GET' && path === `/${token}`) return send(200, 'text/html; charset=utf-8', handoffPage({ target, token, links }));
    if (req.method === 'GET' && path === `/${token}/key`) {
      if (taken) return send(410, 'application/json', JSON.stringify({ ok: false, why: 'the key was handed over already; run the command again' }));
      taken = true;
      return send(200, 'application/json', JSON.stringify({ ok: true, ...key }));
    }
    if (req.method === 'POST' && path === `/${token}/done` && taken) {
      for (const h of homes || [home]) { try { writeFileSync(join(h, HANDOFF_FILE), JSON.stringify({ atMs: now() }) + '\n', { mode: 0o600 }); } catch { /* asked again next time */ } }
      send(200, 'application/json', '{"ok":true}');
      setTimeout(() => { server.close(); finish(true); }, 500);
      return;
    }
    return send(404, 'text/plain', 'not here');
  });
  const timer = setTimeout(() => { server.close(); finish(false); }, ttlMs);
  timer.unref();
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}/${token}`, done: done.finally(() => clearTimeout(timer)) }));
  });
}
