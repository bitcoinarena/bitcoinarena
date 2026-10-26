// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE EMBED KIT (kanban #678, 2026-10-26: "It shouldn't be just an iframe that is basically stealing a game. The demo site should take rps
// and take it as its own, embedding the code. Not an iframe."). A website puts a game of Bitcoin Arena into its own page:
//
//     <div id="arena-game"></div>
//     <script src="https://testnet.bitcoin-arena.io/arena-embed.js" data-game="rock-paper-scissors" data-ref="<program key>"
//             data-target="#arena-game"></script>
//
// This file brings the Arena's engine - the page at this script's own address, its lobby, wallet (create, restore, deposit, withdraw)
// and join - into the host page, and the game's client into the engine, both in the host page's own DOM: no frame anywhere. What runs is
// what the Arena site serves at that moment (its index.html, its bundles, the game's client checked against its manifest's hash, as on the
// site), so an embedded game is never an older copy of the site.
//
// HOW (the engine is a whole page and assumes it is one): its markup and its styles go into a shadow root on the target - the host page's
// CSS stays out, the engine's stays in; a <html> and a <body> element are made inside it, so the engine's own `html`, `body` and `body.x`
// rules match unchanged. The box is a size container: the engine's fixed screens are laid out in the box, its width rules (@media) and
// viewport units (vh, vw) are read as the box's (@container, cqh, cqw). The engine's scripts run in this window, in their order, each run of
// them seeing a `document` that is the shadow root's (getElementById, querySelector, body, documentElement, head), a `location` and a
// `history` of the Arena page they were written for (?game=<game>&ref=<key>; the host's address never changes) and a `fetch` that reads the
// engine's own files from the Arena site. The game's client - a page of its own on the site - is mounted the same way into a shadow root
// of its own, its `window.parent` the engine (window.ARENA_EMBED.clientElement, the one place the engine knows of the kit).
//
// WHAT THE HOST TAKES ON: the wallet is kept in the host site's own browser storage (localStorage and sessionStorage are per site), not
// in testnet.bitcoin-arena.io's - a player's seed made here is this site's, and the 24 words restore it anywhere. The engine's globals
// (window.ARENA_*, ARENACLIENT, BLWP) are the host page's globals; one engine per page. A host page with a Content Security Policy must
// allow scripts from the Arena site with 'unsafe-eval' (the engine's own scripts are evaluated here), and the connections to the nodes.
(function () {
  'use strict';
  const me = document.currentScript;
  if (!me) { console.error('[arena-embed] load this file with a plain <script src>, not as a module'); return; }
  if (window.ARENA_EMBED) { console.error('[arena-embed] one Arena per page: this page already holds one'); return; }
  // READ AS THE ARENA SITE'S OWN SCRIPT (measured 2026-10-26: "Failed to resolve module specifier './blwp_lock_client.js'. The base URL is
  // about:blank because import() is called from a CORS-cross-origin script" - no deposit): a script from another site loaded without
  // crossorigin has no address of its own for import(), and the wallet's lock client is imported by its address. This file loads itself
  // once more with crossorigin="anonymous" (the site answers any origin), so the host's snippet needs no attribute.
  if (new URL(me.src, location.href).origin !== location.origin && me.crossOrigin === null) {
    const again = document.createElement('script');
    for (const a of me.attributes) if (a.name !== 'src') again.setAttribute(a.name, a.value);
    again.crossOrigin = 'anonymous';
    again.src = me.src;
    me.after(again);
    return;
  }
  const BASE = new URL('.', me.src).href;                      // the Arena site this file came from, e.g. https://testnet.bitcoin-arena.io/
  const SITE = new URL(BASE).origin;
  const GAME = (me.dataset.game || 'rock-paper-scissors').trim();
  const REF = /^0[23][0-9a-f]{64}$/i.test(me.dataset.ref || '') ? me.dataset.ref.toLowerCase() : null;
  if (me.dataset.ref && !REF) console.warn('[arena-embed] data-ref is not a 33-byte key in hex (66 characters, 02 or 03 first): no referral program');
  // THE ENGINE'S FILES THAT NEED NO DOCUMENT OF THEIR OWN: the bundles and the cores read no `document`, `location` or relative address,
  // so they are plain scripts from the Arena site (and run at full speed); everything else runs in the engine's scope below
  const PLAIN = /^(?:blwp-core(?:-[0-9a-f]+)?|core-[0-9a-f]+|arena-client|arena-curve|arena-react|arena-nostr)\.js$/;
  const abs = (u, base) => { try { return new URL(u, base || BASE).href; } catch (e) { return u; } };
  const relative = (u) => typeof u === 'string' && u !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);
  const say = (...a) => console.log('[arena-embed]', ...a);

  // THE BOX: the target (data-target, else a div put where this script stands), a host of our own in it, its shadow root
  let target = me.dataset.target ? document.querySelector(me.dataset.target) : null;
  if (!target) { target = document.createElement('div'); me.after(target); }
  const host = document.createElement('div');
  host.className = 'arena-embed';
  host.style.cssText = 'display:block;position:relative;width:100%;height:100%;min-height:' + (me.dataset.height || '560px');
  target.append(host);
  if (target.getBoundingClientRect().height < 200 && !target.style.height) target.style.height = me.dataset.height || '720px';
  const root = host.attachShadow({ mode: 'open' });

  // CSS AS THE BOX'S: :root is the <html> made here, a viewport width or height is the box's, a relative url() the Arena site's
  const SIZE_FEATURE = /^\(\s*(?:(?:min|max)-(?:width|height)\s*:\s*[\d.]+px|orientation\s*:\s*(?:portrait|landscape))\s*\)$/i;
  function sizeOnly(prelude) {
    const items = prelude.split(',').map((s) => s.trim().replace(/^(?:only\s+)?(?:screen|all)\s+and\s+/i, ''));
    if (!items.every((it) => it.split(/\s+and\s+/i).every((f) => SIZE_FEATURE.test(f.trim())))) return null;
    return items.length === 1 ? items[0] : items.map((it) => '(' + it + ')').join(' or ');
  }
  function boxCss(css, base) {
    return String(css)
      .replace(/:root\b/g, 'html')
      .replace(/@media([^{;]+)\{/g, (m, p) => { const c = sizeOnly(p.trim()); return c ? '@container arena-box ' + c + ' {' : m; })
      .replace(/(\d*\.?\d+)(?:d|s|l)?v(h|w|min|max)\b/g, '$1cq$2')
      .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => (relative(u.trim()) ? 'url(' + q + abs(u.trim(), base) + q + ')' : m));
  }
  // a media query the engine asks in code (matchMedia) about width or height is the box's too
  function boxMedia(box, q) {
    const c = sizeOnly(String(q));
    if (c === null) return window.matchMedia(q);
    const test = () => c.split(/\s+or\s+/i).some((alt) => alt.split(/\s+and\s+/i).every((f) => {
      const m = /(min|max)-(width|height)\s*:\s*([\d.]+)px/i.exec(f);
      const w = box.clientWidth, h = box.clientHeight;
      if (m) { const v = m[2].toLowerCase() === 'width' ? w : h, n = Number(m[3]); return m[1].toLowerCase() === 'min' ? v >= n : v <= n; }
      return /portrait/i.test(f) ? h >= w : w > h;
    }));
    const fns = new Set();
    let was = test();
    const mql = { media: String(q), onchange: null, get matches() { return test(); },
      addEventListener: (t, f) => { if (t === 'change') fns.add(f); }, removeEventListener: (t, f) => fns.delete(f),
      addListener: (f) => fns.add(f), removeListener: (f) => fns.delete(f) };
    new ResizeObserver(() => { const now = test(); if (now === was) return; was = now;
      const ev = { matches: now, media: mql.media }; for (const f of [...fns, mql.onchange].filter(Boolean)) { try { f.call(mql, ev); } catch (e) { console.error(e); } } }).observe(box);
    return mql;
  }

  // A RELATIVE ADDRESS IN THE ENGINE'S MARKUP IS THE ARENA SITE'S, and a link leaves the box for a tab of its own (the host page stays)
  function fixUrls(el, base) {
    const one = (n) => {
      if (n.nodeType !== 1) return;
      for (const a of ['src', 'href', 'poster']) {
        const v = n.getAttribute(a);
        if (v !== null && relative(v)) n.setAttribute(a, abs(v, base));
      }
      if (n.tagName === 'A' && /^https?:/i.test(n.getAttribute('href') || '') && !n.hasAttribute('target')) { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener'); }
    };
    one(el);
    if (el.querySelectorAll) for (const n of el.querySelectorAll('[src],[href],[poster]')) one(n);
  }
  function watchUrls(shadow, base) {
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'attributes') fixUrls(m.target, base);
        else for (const n of m.addedNodes) fixUrls(n, base);
      }
    }).observe(shadow, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'poster'] });
  }

  // A PAGE IN A BOX: <div box> <html> <head/> <body/> </html>, as a page's own elements, so its CSS matches them unchanged
  function pageBox(shadow, srcDoc, base) {
    const box = document.createElement('div');
    box.className = 'arena-box';
    const html = document.createElement('html');
    for (const a of srcDoc.documentElement.attributes) html.setAttribute(a.name, a.value);
    const head = document.createElement('head');
    const body = document.createElement('body');
    for (const a of srcDoc.body.attributes) body.setAttribute(a.name, a.value);
    html.append(head, body);
    box.append(html);
    const base0 = document.createElement('style');
    // the host page's inherited font, colour and spacing end here; the box is the page's viewport
    base0.textContent = ':host{display:block;width:100%;height:100%}'
      + '.arena-box{all:initial;display:block;position:relative;width:100%;height:100%;overflow:hidden;container:arena-box/size;contain:strict;transform:translateZ(0);isolation:isolate}'
      + 'html{display:block;width:100%;height:100%;overflow:auto}';
    shadow.append(base0, box);
    return { box, html, head, body };
  }
  // the head the engine appends to: a script goes to the host's real head (where it runs), from the Arena site; the rest stays in the box
  function headDoor(head, base) {
    const put = (n) => {
      fixUrls(n, base);
      if (n && n.tagName === 'SCRIPT') { document.head.appendChild(n); return true; }
      return false;
    };
    const append = head.append.bind(head), appendChild = head.appendChild.bind(head), insertBefore = head.insertBefore.bind(head);
    head.appendChild = (n) => (put(n) ? n : appendChild(n));
    head.append = (...ns) => { for (const n of ns) if (typeof n === 'string' || !put(n)) append(n); };
    head.insertBefore = (n, ref) => (put(n) ? n : insertBefore(n, ref));
    return head;
  }

  // AN EVENT HEARD ON THE WINDOW OR THE DOCUMENT names the element it happened on inside the box (the browser names the box itself)
  const deep = new WeakMap();
  function deepened(fn) {
    if (typeof fn !== 'function') return fn;
    let w = deep.get(fn);
    if (!w) {
      w = function (e) {
        const t = e && e.composedPath ? e.composedPath()[0] : null;
        if (!t || t === e.target) return fn.call(this, e);
        const ev = new Proxy(e, { get: (o, k) => (k === 'target' ? t : (typeof o[k] === 'function' ? o[k].bind(o) : o[k])) });
        return fn.call(this, ev);
      };
      deep.set(fn, w);
    }
    return w;
  }

  // THE SCOPE A PAGE'S SCRIPTS RUN IN: `document`, `window`, `location`, `history`, `fetch` of the page they were written for
  function scopeFor({ shadow, parts, base, href, parent, onNavigate }) {
    let url = new URL(href);
    let title = '';
    let ready = 'loading';
    const loaded = { DOMContentLoaded: [], load: [], readystatechange: [] };
    const L = {
      get href() { return url.href; }, set href(v) { onNavigate(new URL(v, url)); },
      get search() { return url.search; }, set search(v) { const u = new URL(url); u.search = v; onNavigate(u); },
      get hash() { return url.hash; }, set hash(v) { url.hash = v; },
      get pathname() { return url.pathname; }, get origin() { return url.origin; }, get host() { return url.host; },
      get hostname() { return url.hostname; }, get protocol() { return url.protocol; }, get port() { return url.port; },
      assign: (v) => onNavigate(new URL(v, url)), replace: (v) => onNavigate(new URL(v, url)), reload: () => window.location.reload(),
      toString: () => url.href,
    };
    const H = {
      get length() { return 1; }, state: null,
      replaceState(s, t, u) { H.state = s; if (u !== undefined && u !== null) url = new URL(u, url); },
      pushState(s, t, u) { H.replaceState(s, t, u); },
      back() {}, forward() {}, go() {},
    };
    // a bare fetch() of the page's is read against the Arena page's address and goes through the window's fetch as it is now (the
    // engine puts its routes and guards there); `window.fetch` itself stays the window's, so a guard the engine wraps around it does
    // not wrap itself
    const F = (input, init) => window.fetch(typeof input === 'string' ? new URL(input, url).href : input, init);
    const bound = new Map();
    const native = (f) => { try { return /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(f)); } catch (e) { return false; } };
    const listen = (on, t, fn, o) => {
      if (t in loaded && ready !== 'complete') { loaded[t].push(fn); return; }
      on.addEventListener(t, deepened(fn), o);
    };
    const own = {
      document: null, location: L, history: H,
      innerWidth: () => parts.box.clientWidth, innerHeight: () => parts.box.clientHeight,
      matchMedia: (q) => boxMedia(parts.box, q),
      open: (u, ...a) => window.open(u ? new URL(u, url).href : u, ...a),
      addEventListener: (t, fn, o) => listen(window, t, fn, o),
      removeEventListener: (t, fn, o) => window.removeEventListener(t, deep.get(fn) || fn, o),
      scrollTo: (...a) => parts.body.scrollTo(...a), scroll: (...a) => parts.body.scrollTo(...a), scrollBy: (...a) => parts.body.scrollBy(...a),
      scrollY: () => parts.body.scrollTop, pageYOffset: () => parts.body.scrollTop, scrollX: () => 0, pageXOffset: () => 0,
    };
    const GETTERS = new Set(['innerWidth', 'innerHeight', 'scrollY', 'pageYOffset', 'scrollX', 'pageXOffset']);
    let W = null;
    const D = new Proxy(document, {
      get(o, k) {
        switch (k) {
          case 'getElementById': return (id) => shadow.getElementById(id);
          case 'querySelector': return (s) => shadow.querySelector(String(s).replace(/:root\b/g, 'html'));
          case 'querySelectorAll': return (s) => shadow.querySelectorAll(String(s).replace(/:root\b/g, 'html'));
          case 'getElementsByClassName': return (c) => parts.html.getElementsByClassName(c);
          case 'getElementsByTagName': return (t) => parts.html.getElementsByTagName(t);
          case 'getElementsByName': return (n) => shadow.querySelectorAll('[name="' + String(n).replace(/"/g, '\\"') + '"]');
          case 'elementFromPoint': return (x, y) => shadow.elementFromPoint(x, y);
          case 'elementsFromPoint': return (x, y) => shadow.elementsFromPoint(x, y);
          case 'body': return parts.body;
          case 'documentElement': case 'scrollingElement': return parts.html;
          case 'head': return parts.head;
          case 'styleSheets': return shadow.styleSheets;
          case 'activeElement': return shadow.activeElement || document.activeElement;
          case 'location': return L;
          case 'URL': case 'documentURI': case 'baseURI': return url.href;
          case 'defaultView': return W;
          case 'title': return title;
          case 'readyState': return ready;
          case 'currentScript': return null;
          case 'addEventListener': return (t, fn, op) => listen(document, t, fn, op);
          case 'removeEventListener': return (t, fn, op) => document.removeEventListener(t, deep.get(fn) || fn, op);
          default: { const v = Reflect.get(o, k, o); return typeof v === 'function' ? v.bind(o) : v; }
        }
      },
      set(o, k, v) { if (k === 'title') { title = String(v); return true; } o[k] = v; return true; },
    });
    own.document = D;
    W = new Proxy(window, {
      get(o, k) {
        if (k === 'window' || k === 'self' || k === 'top' || k === 'frames') return W;
        if (k === 'parent') return parent || W;
        if (Object.prototype.hasOwnProperty.call(own, k)) return GETTERS.has(k) ? own[k]() : own[k];
        const v = Reflect.get(o, k, o);
        // the window's own methods are called on the window; a constructor (Uint8Array, Promise) or a page's function stays itself
        if (typeof v === 'function' && /^[a-z]/.test(String(k)) && native(v)) { let b = bound.get(v); if (!b) { b = v.bind(o); bound.set(v, b); } return b; }
        return v;
      },
      set(o, k, v) { o[k] = v; return true; },
      has(o, k) { return k in own || k in o; },
    });
    const scope = Object.create(null);
    for (const k of Object.keys(own)) {
      if (GETTERS.has(k)) Object.defineProperty(scope, k, { get: own[k], enumerable: true });
      else scope[k] = own[k];
    }
    Object.assign(scope, { window: W, self: W, top: W, parent: parent || W, fetch: F });
    const done = () => {
      ready = 'complete';
      for (const t of ['readystatechange', 'DOMContentLoaded', 'load']) for (const fn of loaded[t].splice(0)) {
        try { fn.call(t === 'load' ? W : D, new Event(t)); } catch (e) { console.error(e); }
      }
    };
    return { scope, W, D, L, done };
  }

  // A RUN OF SCRIPTS IN A SCOPE: one evaluation, so a script's top-level names reach the next one's, as on a page; `var` and function
  // declarations stay the window's globals. Called from here, so a relative import() in them is read against this file's address
  // (the Arena site's), as on the site.
  let runs = 0;
  function runIn(holder, code, name) {
    const src = 'with (window.ARENA_EMBED.' + holder + ') {\n' + code + '\n}\n//# sourceURL=' + BASE + 'arena-embed/' + (++runs) + '-' + name;
    try { (0, eval)(src); } catch (e) { console.error('[arena-embed] ' + name + ': ' + (e && e.stack ? e.stack : e)); }
  }
  const plainScript = (src) => new Promise((ok) => {
    const s = document.createElement('script');
    s.src = src; s.async = false;
    s.onload = () => ok(true);
    s.onerror = () => { console.error('[arena-embed] ' + src + ' did not load'); ok(false); };
    document.head.appendChild(s);
  });
  const text = async (u) => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(u + ' answered ' + r.status); return r.text(); };

  // THE GAME'S CLIENT IN A BOX OF ITS OWN (the engine's loadTheGameClient asks for it in place of a frame): an element that is handed
  // the client's checked bytes as a blob address (`src`), mounts its page and runs its scripts with `window.parent` the engine's window,
  // then says 'load' - so the engine adds its style to `contentDocument.head` as it did to the frame's
  function clientElement(engineWindow) {
    const el = document.createElement('div');
    const shadow = el.attachShadow({ mode: 'open' });
    let mounted = null, src = '';
    Object.defineProperty(el, 'src', { get: () => src, set: (u) => { src = String(u); mount(src); } });
    Object.defineProperty(el, 'contentDocument', { get: () => (mounted ? mounted.D : null) });
    Object.defineProperty(el, 'contentWindow', { get: () => (mounted ? mounted.W : null) });
    async function mount(u) {
      const page = new DOMParser().parseFromString(await (await fetch(u)).text(), 'text/html');
      const parts = pageBox(shadow, page, BASE);
      headDoor(parts.head, BASE);
      const scripts = [...page.querySelectorAll('script')];
      for (const s of scripts) s.remove();
      for (const n of page.head.children) if (n.tagName === 'STYLE') { const st = document.createElement('style'); st.textContent = boxCss(n.textContent, BASE); parts.head.append(st); }
      for (const n of [...page.body.childNodes]) parts.body.append(document.importNode(n, true));
      fixUrls(parts.html, BASE); watchUrls(shadow, BASE);
      const sc = scopeFor({ shadow, parts, base: BASE, href: engineWindow.location.href, parent: engineWindow,
        onNavigate: (x) => window.open(x.href, '_blank', 'noopener') });
      mounted = sc;
      window.ARENA_EMBED.clientScope = sc.scope;
      // its scripts in one function of their own: the client's names are not the host page's globals
      const code = '(function () {\n' + scripts.filter((s) => !s.src && (!s.type || /javascript/i.test(s.type))).map((s) => s.textContent).join('\n;\n') + '\n}).call(window);';
      runIn('clientScope', code, 'client.js');
      sc.done();
      el.dispatchEvent(new Event('load'));
      say('the game\'s client is mounted in the page');
    }
    return el;
  }

  // THE ENGINE: the Arena page at this file's address, as the site serves it now
  async function start() {
    // (the folder's own address: the site answers /index.html with a redirect to it)
    const page = new DOMParser().parseFromString(await text(BASE), 'text/html');
    const parts = pageBox(root, page, BASE);
    headDoor(parts.head, BASE);
    // the page's scripts in their order, head first; none of them is left in the markup
    const scripts = [...page.querySelectorAll('script')].map((s) => ({ src: s.getAttribute('src'), type: s.getAttribute('type'), code: s.textContent }));
    for (const s of page.querySelectorAll('script')) s.remove();
    // the head's styles and named metas; its icons, manifest and preloads are the host's business
    for (const n of [...page.head.children]) {
      if (n.tagName === 'STYLE') { const st = document.createElement('style'); st.textContent = boxCss(n.textContent, BASE); parts.head.append(st); }
      else if (n.tagName === 'LINK' && /stylesheet/i.test(n.rel)) {
        const href = abs(n.getAttribute('href'));
        try { const st = document.createElement('style'); st.textContent = boxCss(await text(href), href); parts.head.append(st); } catch (e) { console.error('[arena-embed] ' + e.message); }
      } else if (n.tagName === 'META' && n.getAttribute('name')) parts.head.append(document.importNode(n, true));
    }
    // THIS SITE'S GAME AND ITS REFERRAL PROGRAM, as a link to the Arena would name them
    const meta = parts.head.querySelector('meta[name="arena-site-game"]');
    if (meta) meta.setAttribute('content', GAME);
    for (const n of [...page.body.childNodes]) parts.body.append(document.importNode(n, true));
    fixUrls(parts.html, BASE); watchUrls(root, BASE);
    const href = BASE + '?game=' + encodeURIComponent(GAME) + (REF ? '&ref=' + REF : '');
    const sc = scopeFor({ shadow: root, parts, base: BASE, href, parent: null,
      // a way out of the game (← Arena, another game) opens the Arena in a tab of its own; the same game again is this page again
      onNavigate: (x) => {
        if (x.origin === SITE && x.searchParams.get('game') === GAME && x.pathname === new URL(BASE).pathname) window.location.reload();
        else window.open(x.href, '_blank', 'noopener');
      } });
    window.ARENA_EMBED.scope = sc.scope;
    window.ARENA_EMBED.window = sc.W;
    window.ARENA_EMBED.document = sc.D;
    // the way back to the Arena's games is a link to the site; in the box it would leave the host page
    const own = document.createElement('style');
    own.textContent = '#arena-wb-back,#arena-games-back{display:none!important}';
    parts.head.append(own);
    let group = [], n = 0;
    const flush = () => { if (group.length) runIn('scope', group.join('\n;\n'), 'engine-' + (++n) + '.js'); group = []; };
    for (const s of scripts) {
      if (s.type && !/javascript/i.test(s.type)) continue;
      if (s.src && PLAIN.test(s.src.split('?')[0])) { flush(); await plainScript(abs(s.src)); continue; }
      if (s.src) { try { group.push(await text(abs(s.src))); } catch (e) { console.error('[arena-embed] ' + e.message); } continue; }
      group.push(s.code);
    }
    flush();
    sc.done();
    say('the Arena engine runs in this page: ' + GAME + (REF ? ', referral program ' + REF.slice(0, 16) : ''));
  }

  window.ARENA_EMBED = { base: BASE, game: GAME, ref: REF, host, root, clientElement: () => clientElement(window.ARENA_EMBED.window) };
  window.ARENA_EMBED.ready = start().catch((e) => {
    console.error('[arena-embed] the Arena did not start: ' + (e && e.message ? e.message : e));
    root.textContent = 'Bitcoin Arena could not be reached right now - try again in a moment.';
    throw e;
  });
})();
