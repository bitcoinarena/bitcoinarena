// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE EMBED KIT (kanban #678). A website puts a game of Bitcoin Arena into its own page with the same snippet as before:
//
//     <div id="arena-game"></div>
//     <script src="https://testnet.bitcoinarena.io/arena-embed.js" data-game="rock-paper-scissors" data-ref="<program key>"
//             data-target="#arena-game"></script>
//
// THE WALLET STAYS ON THE ARENA'S ORIGIN (kanban #3531, feedback #392, high): the kit of #678 ran the whole engine - wallet included - as
// scripts in the host page, so the player's seed sat in plain hex in the host site's storage (sessionStorage arena.player.seed, after a
// restore localStorage arena.seeds) and any script of that page (the operator's, a third-party tag, an XSS) read it; measured with the
// production kit: a host-page script read a restored seed byte for byte. Now the engine runs in a frame on the Arena site (this file's own
// origin), the page at this file's address with ?game=<game>&ref=<key>&embed=1, as the site serves it now (never an older copy). Its
// storage, its 24 words, its restore and its backup are the Arena origin's: the host page cannot read them, and nothing of them crosses.
//
// THE BRIDGE, NARROW AND ORIGIN-CHECKED BOTH WAYS: at each load of the frame the kit hands it one end of a MessageChannel, posted to the
// Arena origin only (a frame navigated anywhere else never gets it); the frame takes it only from its own parent window. Over it the frame
// says, and only says: { type: 'ready', game } and { type: 'balance', sats, pending } - numbers, never a key, a seed or a word. Nothing
// the host sends is acted on besides the hello. The host reads them as window.ARENA_EMBED.on('ready' | 'balance', fn), .balance, .ready.
//
// WHAT THE HOST TAKES ON: a host page with a Content Security Policy allows the Arena site as a frame source (frame-src). One Arena per page.
// A wallet the old kit kept in this site's own storage is not moved into the frame (a host could plant a seed it knows): the player restores
// it with its 24 words in the game's Settings, inside the Arena's frame.
(function () {
  'use strict';
  const me = document.currentScript;
  if (!me) { console.error('[arena-embed] load this file with a plain <script src>, not as a module'); return; }
  if (window.ARENA_EMBED) { console.error('[arena-embed] one Arena per page: this page already holds one'); return; }
  const BASE = new URL('.', me.src).href;                      // the Arena site this file came from, e.g. https://testnet.bitcoinarena.io/
  const SITE = new URL(BASE).origin;
  const GAME = (me.dataset.game || 'rock-paper-scissors').trim();
  const REF = /^0[23][0-9a-f]{64}$/i.test(me.dataset.ref || '') ? me.dataset.ref.toLowerCase() : null;
  if (me.dataset.ref && !REF) console.warn('[arena-embed] data-ref is not a 33-byte key in hex (66 characters, 02 or 03 first): no referral program');
  const say = (...a) => console.log('[arena-embed]', ...a);

  // THE BOX: the target (data-target, else a div put where this script stands), and the Arena's frame filling it
  let target = me.dataset.target ? document.querySelector(me.dataset.target) : null;
  if (!target) { target = document.createElement('div'); me.after(target); }
  const host = document.createElement('div');
  host.className = 'arena-embed';
  host.style.cssText = 'display:block;position:relative;width:100%;height:100%;min-height:' + (me.dataset.height || '560px');
  target.append(host);
  if (target.getBoundingClientRect().height < 200 && !target.style.height) target.style.height = me.dataset.height || '720px';
  const src = BASE + '?game=' + encodeURIComponent(GAME) + (REF ? '&ref=' + REF : '') + '&embed=1';
  const frame = document.createElement('iframe');
  frame.title = 'Bitcoin Arena';
  frame.allow = 'fullscreen; autoplay; gamepad; clipboard-write';
  frame.setAttribute('allowfullscreen', '');
  frame.style.cssText = 'display:block;border:0;width:100%;height:100%;min-height:inherit;background:transparent';

  // WHAT THE FRAME SAYS, as numbers and names only (a message of another shape, or from anything but the port handed to the Arena origin,
  // is not heard)
  const fns = { ready: new Set(), balance: new Set() };
  let readyDone = null;
  const api = {
    base: BASE, game: GAME, ref: REF, host, frame, balance: null,
    on(type, fn) { if (fns[type] && typeof fn === 'function') fns[type].add(fn); return api; },
    off(type, fn) { if (fns[type]) fns[type].delete(fn); return api; },
    ready: new Promise((ok) => { readyDone = ok; }),
  };
  const tell = (type, v) => { for (const fn of fns[type]) { try { fn(v); } catch (e) { console.error(e); } } };
  function heard(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'ready' && typeof d.game === 'string') { const v = { game: d.game.slice(0, 64) }; readyDone(v); tell('ready', v); say('the Arena runs in its frame: ' + v.game + (REF ? ', referral program ' + REF.slice(0, 16) : '')); }
    else if (d.type === 'balance' && Number.isFinite(d.sats)) { const v = { sats: Math.max(0, Math.floor(d.sats)), pending: Number.isFinite(d.pending) ? Math.max(0, Math.floor(d.pending)) : 0 }; api.balance = v; tell('balance', v); }
  }
  // each load of the frame (a restore reloads it) gets a channel of its own; the old one is closed
  let port = null;
  frame.addEventListener('load', () => {
    if (port) { try { port.close(); } catch (e) { /* gone */ } }
    const ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = (e) => heard(e.data);
    try { frame.contentWindow.postMessage({ type: 'arena-embed-hello', v: 1 }, SITE, [ch.port2]); } catch (e) { console.error('[arena-embed] ' + e.message); }
  });
  frame.src = src;
  host.append(frame);
  window.ARENA_EMBED = api;
})();
