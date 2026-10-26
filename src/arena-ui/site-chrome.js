// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA'S HEADER AND FOOTER ON EVERY PAGE OF THE MENU (kanban #694, 2026-10-26: "when selecting the menu entry in the burger menu, the
// header of those pages does not match the style of the arena and games pages"; #698 "health is missing the header"; #699 "all pages are
// missing the footer"; #700 "docs missing footer"; #701 "the button to play should be renamed to Arena and styled, and positioned like on the
// arena and games header pages"; #695 "the home btn is redundant in functionality to the logo. remove it"; #697 "referral pages is missing a
// option to return to the games"; #696 "the explorer link opens in a new window. it should open in the same tab"). One file draws them for
// Proposals, Health, the Referral Program and its demo (this site), the docs (docs.bitcoin-arena.io, bitcoin-arena.io/docs) and the
// explorer (explorer.bitcoin-arena.io), each page with one line right after <body>:
//
//     <script src="https://testnet.bitcoin-arena.io/site-chrome.js"></script>          (on this site: src="/site-chrome.js")
//
// The pages on other domains load it from this site, not a copy: the menu, the look and the build line stay one, and a page of this site
// that changes them changes them everywhere at its next deploy. The header is the games screen's bar (index.html, #arena-wallet-bar): the
// logo to bitcoin-arena.io at the left, "← Arena" beside it back to the games, ☰ at the right end with the same links as the Arena page's
// menu, all in the same tab; at 560 px and below the logo keeps its mark and ← its arrow, as on the games. The footer is the games
// screen's: the build line and Donate at the window's bottom right (Donate opens the Arena page's donation box, /#donate - it needs the
// wallet). The build line is filled by tools/build-arena-page.mjs with the Arena page's own numbers.
//
// A page can hand the bar one control of its own for the left end (the docs' Contents button): data-lead="<id of the element>".
(function () {
  'use strict';
  var me = document.currentScript;
  if (!me || document.getElementById('asc-bar')) return;
  // THIS SITE: where the script came from (testnet.bitcoin-arena.io live; a test server's own address in a test)
  var site = new URL('/', me.src).href;
  var STAMP = 'build {{{ PRODUCT_VERSION }}} · UI {{{ UI_VERSION }}}';
  var LINKS = [['Proposals', site + 'proposals/'], ['Explorer', 'https://explorer.bitcoin-arena.io/'], ['Health', site + 'health/'], ['Referral Program', site + 'referral/']];
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  // the page this is, marked in the menu: same host and the path starts with the link's (any page of the explorer is the Explorer)
  var here = function (href) { var u = new URL(href); return u.host === location.host && location.pathname.indexOf(u.pathname) === 0; };

  // THE LOOK: index.html's bar, button and menu rules, under names of their own (asc-) so no page's rules reach them and theirs reach no page;
  // every property the pages set on a bare a, button or nav is set here
  var css = [
    '#asc-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 60; display: flex; align-items: center; gap: 6px; height: 40px; margin: 0;',
    '  padding: env(safe-area-inset-top, 0px) max(8px, env(safe-area-inset-right, 0px)) 0 max(8px, env(safe-area-inset-left, 0px)); box-sizing: content-box;',
    '  background: #0d1014; border: 0; border-bottom: 1px solid #30363d; border-radius: 0; font: 13px/1.2 system-ui, sans-serif; color: #e8eaed; text-align: left;',
    '  width: auto; max-width: none; min-height: 0; box-shadow: none; backdrop-filter: none; transform: none; }',
    '#asc-bar-space { height: calc(41px + env(safe-area-inset-top, 0px)); }',
    '#asc-bar *, #asc-foot * { box-sizing: border-box; }',
    '#asc-bar a, #asc-bar a:hover, #asc-foot a, #asc-foot a:hover { text-decoration: none; }',
    '#asc-bar .asc-home { display: inline-flex; flex: 0 1 auto; min-width: 26px; overflow: hidden; align-items: center; gap: 8px; margin: 0 6px 0 0; padding: 0;',
    '  color: #e8eaed; font: 700 16px/1 system-ui, sans-serif; letter-spacing: -0.01em; white-space: nowrap; background: none; }',
    '#asc-bar .asc-home i { flex: none; width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; font-style: normal; font-weight: 800;',
    '  color: #1a0f00; background: conic-gradient(from 210deg, #f7931a, #ffd166, #f7931a); }',
    '#asc-bar .asc-home span { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: inherit; }',
    '#asc-bar .asc-home:hover span { color: #f7931a; }',
    '#asc-bar .asc-back, #asc-bar .asc-nav-go, #asc-bar .asc-lead { display: inline-flex; flex: none; align-items: center; justify-content: center; gap: 4px; height: 32px;',
    '  margin: 0; padding: 0 10px; border-radius: 6px; border: 1px solid #3a4452; background: rgba(22,27,34,0.94); color: #e8eaed;',
    '  font: 600 13px/1 system-ui, sans-serif; white-space: nowrap; cursor: pointer; box-shadow: none; text-transform: none; letter-spacing: normal; }',
    '#asc-bar .asc-back:hover, #asc-bar .asc-back:focus-visible { color: #f7931a; }',
    '#asc-bar .asc-lead { width: 38px; padding: 0; } #asc-bar .asc-lead svg { width: 18px; height: 18px; }',
    '#asc-bar .asc-lead:hover, #asc-bar .asc-lead[aria-expanded="true"] { color: #f7931a; border-color: #f7931a; }',
    '#asc-bar .asc-nav { position: relative; flex: none; display: flex; margin-left: auto; }',
    '#asc-bar .asc-nav-go { width: 38px; padding: 0; }',   // 13 px as the Arena's: its bar's button rule outweighs .arena-nav-go's 18 px
    '#asc-bar .asc-nav-go:hover, #asc-bar .asc-nav.open .asc-nav-go { color: #f7931a; border-color: #f7931a; }',
    '#asc-bar .asc-nav-menu { display: none; position: absolute; top: 38px; right: 0; flex-direction: column; gap: 0; min-width: 190px; margin: 0; padding: 6px;',
    '  background: rgba(13,16,20,0.98); border: 1px solid #3a4452; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.5); z-index: 70; }',
    '#asc-bar .asc-nav.open .asc-nav-menu { display: flex; }',
    '#asc-bar .asc-nav-menu a { height: 40px; display: flex; align-items: center; padding: 0 12px; border-radius: 6px; background: none;',
    '  color: #e8eaed; font: 600 15px/1 system-ui, sans-serif; white-space: nowrap; }',
    '#asc-bar .asc-nav-menu a:hover, #asc-bar .asc-nav-menu a[aria-current="page"] { color: #f7931a; background: rgba(247,147,26,0.08); }',
    '@media (max-width: 560px) { #asc-bar .asc-home span, #asc-bar .asc-back .word { display: none; } }',
    '@media (max-width: 420px) { #asc-bar { gap: 5px; } #asc-bar .asc-back { padding: 0 7px; } #asc-bar .asc-back, #asc-bar .asc-nav-go { font-size: 12.5px; } }',
    // the foot: one 30 px row at the window's bottom, the build line left of Donate (index.html, "THE FOOT IN ONE ROW")
    '#asc-foot { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin: 0;',
    '  height: calc(30px + env(safe-area-inset-bottom, 0px)); padding: 0 6px env(safe-area-inset-bottom, 0px) 8px; box-sizing: border-box; background: #0d1014;',
    '  border: 0; border-radius: 0; width: auto; max-width: none; box-shadow: none; transform: none; text-align: right; }',
    '#asc-foot-space { height: calc(30px + env(safe-area-inset-bottom, 0px)); }',
    '#asc-foot .asc-build { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8b949e; font: 600 10px/30px ui-monospace, SFMono-Regular, Menlo, monospace; }',
    '#asc-foot .asc-donate { flex: none; display: inline-flex; align-items: center; height: 24px; margin: 0; padding: 0 10px; border: 1px solid #f7931a; border-radius: 8px;',
    '  background: #1b1408; color: #f7931a; font: 600 12px system-ui, sans-serif; white-space: nowrap; cursor: pointer; }',
  ].join('\n');
  var style = document.createElement('style');
  style.id = 'asc-style';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // THE HEADER, where this script stands (first thing in <body>), so it is drawn before the page below it
  var bar = document.createElement('header');
  bar.id = 'asc-bar';
  bar.innerHTML = '<a class="asc-home" href="https://bitcoin-arena.io/" title="bitcoin-arena.io" aria-label="Bitcoin Arena - bitcoin-arena.io"><i aria-hidden="true">&#8383;</i><span>Bitcoin Arena</span></a>'
    + '<a class="asc-back" href="' + esc(site) + '" title="Back to Bitcoin Arena" aria-label="Back to Bitcoin Arena"><span aria-hidden="true">&larr;</span><span class="word">Arena</span></a>'
    + '<div class="asc-nav"><button class="asc-nav-go" type="button" aria-label="Menu" aria-expanded="false" aria-controls="asc-nav-menu">&#9776;</button>'
    + '<div id="asc-nav-menu" class="asc-nav-menu" role="navigation" aria-label="Bitcoin Arena">'
    + LINKS.map(function (l) { return '<a href="' + esc(l[1]) + '"' + (here(l[1]) ? ' aria-current="page"' : '') + '>' + esc(l[0]) + '</a>'; }).join('')
    + '</div></div>';
  var space = document.createElement('div');
  space.id = 'asc-bar-space';
  me.parentNode.insertBefore(bar, me);
  me.parentNode.insertBefore(space, me);
  // the page's own control for the left end, styled as the bar's buttons
  var placeLead = function () {
    var id = me.getAttribute('data-lead'), el = id && document.getElementById(id);
    if (!el || bar.contains(el)) return;
    el.classList.add('asc-lead');
    bar.insertBefore(el, bar.firstChild);
  };
  placeLead();

  // THE ☰ MENU, as the Arena page's: opens and closes on its button, closes on a click anywhere else or on Escape
  var nav = bar.querySelector('.asc-nav'), go = bar.querySelector('.asc-nav-go');
  var set = function (open) { nav.classList.toggle('open', open); go.setAttribute('aria-expanded', String(open)); };
  go.addEventListener('click', function (e) { e.stopPropagation(); set(!nav.classList.contains('open')); });
  document.addEventListener('click', function (e) { if (!nav.contains(e.target)) set(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });

  // THE FOOTER, at the end of the page once it is read
  var foot = function () {
    if (document.getElementById('asc-foot')) return;
    placeLead();
    var f = document.createElement('footer');
    f.id = 'asc-foot';
    f.innerHTML = '<span class="asc-build" aria-hidden="true">' + (/\{{3}/.test(STAMP) ? '' : esc(STAMP)) + '</span>'
      + '<a class="asc-donate" href="' + esc(site) + '#donate">&hearts; Donate</a>';
    var s = document.createElement('div');
    s.id = 'asc-foot-space';
    document.body.appendChild(s);
    document.body.appendChild(f);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', foot); else foot();
})();
