// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA'S HEADER AND FOOTER ON EVERY PAGE OF THE MENU (kanban #694, 2026-10-26: "when selecting the menu entry in the burger menu, the
// header of those pages does not match the style of the arena and games pages"; #698 "health is missing the header"; #699 "all pages are
// missing the footer"; #700 "docs missing footer"; #701 "the button to play should be renamed to Arena and styled, and positioned like on the
// arena and games header pages"; #695 "the home btn is redundant in functionality to the logo. remove it"; #697 "referral pages is missing a
// option to return to the games"; #696 "the explorer link opens in a new window. it should open in the same tab"). One file draws them for
// Proposals, Health, the Referral Program and its demo (this site), the docs (docs.bitcoinarena.io, bitcoinarena.io/docs) and the
// explorer (explorer.bitcoinarena.io), each page with one line right after <body>:
//
//     <script src="https://testnet.bitcoinarena.io/site-chrome.js"></script>          (on this site: src="/site-chrome.js")
//
// The pages on other domains load it from this site, not a copy: the menu, the look and the build line stay one, and a page of this site
// that changes them changes them everywhere at its next deploy. The header is the games screen's bar (index.html, #arena-wallet-bar): the
// logo to bitcoinarena.io at the left, "← Arena" beside it back to the games, ☰ at the right end with the same links as the Arena page's
// menu, all in the same tab; at 560 px and below the logo keeps its mark and ← its arrow, as on the games. The footer is the games
// screen's: Donate at the window's bottom right (Donate opens the Arena page's donation box, /#donate - it needs the wallet), and left of
// it, well clear of it, Bitcoin Arena on X, Discord, Telegram and GitHub (kanban #749, #753; GitHub is the docs' Repositories page), the
// only links here that open a new tab. At the left the Arena page's UI number, never the static build number (kanban #753
// 2026-10-28: "I want 'UI xxx' still there"), filled by tools/build-arena-page.mjs.
//
// A page can hand the bar one control of its own for the left end (the docs' Contents button): data-lead="<id of the element>".
(function () {
  'use strict';
  var me = document.currentScript;
  if (!me || document.getElementById('asc-bar')) return;
  // THIS SITE: where the script came from (testnet.bitcoinarena.io live; a test server's own address in a test)
  var site = new URL('/', me.src).href;
  var STAMP = 'UI {{{ UI_VERSION }}}';
  var LINKS = [['Proposals', site + 'proposals/'], ['Explorer', 'https://explorer.bitcoinarena.io/'], ['Health', site + 'health/'], ['Referral Program', site + 'referral/']];
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  // the page this is, marked in the menu: same host and the path starts with the link's (any page of the explorer is the Explorer)
  // A START-PAGE ANCHOR (bitcoinarena.io/#games) IS NEVER THE PAGE HERE, and '/' marks only the start page itself (#1457: every link to #... showed white on /security)
  var here = function (href) { var u = new URL(href); if (u.host !== location.host || u.hash) return false; return u.pathname === '/' ? location.pathname === '/' : location.pathname.indexOf(u.pathname) === 0; };

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
    '#asc-bar .asc-home img.asc-mark { flex: none; height: 26px; width: auto; display: block; }' +
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
    // the Bitcoin Arena Nostr profile, verified as bitcoinarena.io by NIP-05 (/.well-known/nostr.json names it _), on every page (kanban #1144)
    '#asc-bar .asc-nostr { display: inline-flex; flex: none; align-items: center; gap: 5px; height: 32px; margin: 0 0 0 auto; padding: 0 8px; border-radius: 6px;',
    '  background: none; color: #b98cff; font: 600 12.5px/1 system-ui, sans-serif; white-space: nowrap; }',
    '#asc-bar .asc-nostr svg { display: block; width: 16px; height: 16px; fill: currentColor; }',
    '#asc-bar .asc-nostr:hover, #asc-bar .asc-nostr:focus-visible { color: #e8eaed; }',
    '#asc-bar .asc-nostr + .asc-nav { margin-left: 4px; }',
    '@media (max-width: 560px) { #asc-bar .asc-nostr .d { display: none; } }',
    '@media (max-width: 560px) { #asc-bar .asc-home span, #asc-bar .asc-back .word { display: none; } }',
    '@media (max-width: 420px) { #asc-bar { gap: 5px; } #asc-bar .asc-back { padding: 0 7px; } #asc-bar .asc-back, #asc-bar .asc-nav-go { font-size: 12.5px; } }',
    // the foot: one 30 px row at the window's bottom, the links left of Donate (index.html, "THE FOOT IN ONE ROW")
    '#asc-foot { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin: 0;',
    '  height: calc(30px + env(safe-area-inset-bottom, 0px)); padding: 0 6px env(safe-area-inset-bottom, 0px) 8px; box-sizing: border-box; background: #0d1014;',
    '  border: 0; border-radius: 0; width: auto; max-width: none; box-shadow: none; transform: none; text-align: right; }',
    '#asc-foot-space { height: calc(30px + env(safe-area-inset-bottom, 0px)); }',
    '#asc-foot .asc-build { min-width: 0; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8b949e; font: 600 10px/30px ui-monospace, SFMono-Regular, Menlo, monospace; }',
    '#asc-foot .asc-feedback { flex: none; display: inline-flex; align-items: center; height: 24px; margin: 0 8px 0 0; padding: 0 10px; border: 1px solid #30363d; border-radius: 8px; color: #e6edf3; text-decoration: none; font-size: 13px; }',
    '#asc-foot .asc-feedback:hover, #asc-foot .asc-feedback:focus-visible { border-color: #f7931a; color: #f7931a; }',
    '#asc-foot .asc-donate { flex: none; display: inline-flex; align-items: center; height: 24px; margin: 0; padding: 0 10px; border: 1px solid #f7931a; border-radius: 8px;',
    '  background: #1b1408; color: #f7931a; font: 600 12px system-ui, sans-serif; white-space: nowrap; cursor: pointer; }',
    // X, Discord, Telegram and GitHub left of Donate (kanban #749), 16 px more than the row's gap away from it (#753: "too close to donate
    // button"): grey, amber on hover as the bar's buttons
    '#asc-foot .asc-social { flex: none; display: inline-flex; align-items: center; gap: 6px; margin: 0 16px 0 0; padding: 0; }',
    '#asc-foot .asc-social a { display: inline-grid; place-items: center; width: 24px; height: 24px; margin: 0; padding: 0; border-radius: 6px; background: none; color: #8b949e; }',
    '#asc-foot .asc-social a:hover, #asc-foot .asc-social a:focus-visible { color: #f7931a; }',
    '#asc-foot .asc-social svg { display: block; width: 14px; height: 14px; fill: currentColor; }',
  ].join('\n');
  var style = document.createElement('style');
  style.id = 'asc-style';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // THE HEADER, where this script stands (first thing in <body>), so it is drawn before the page below it
  var bar = document.createElement('header');
  bar.id = 'asc-bar';
  // THE SAME HEADER AS THE START PAGE (kanban #1457, Daniel 2026-11-11: "Alle Seiten, auch Security müssen angepasst werden. Der Header muss überall
  // gleich aussehen" - "Ein Header für alles"): bitcoinarena.io's nav.top, drawn here for every page that loads this script - the stadium and the
  // name, the start page's links (to bitcoinarena.io), the Nostr badge and App →; links fold away at the start page's widths
  var HOME = 'https://bitcoinarena.io/';
  var TOP = [['Games', HOME + '#games'], ['How it works', HOME + '#how'], ['Nostr', HOME + '#nostr'], ['Build &amp; run', HOME + '#build'], ['Download', HOME + '#download'],
    ['Proposals', 'https://testnet.bitcoinarena.io/proposals/', 1], ['Security', HOME + 'security/', 1], ['Docs', 'https://docs.bitcoinarena.io/', 1]];
  var mark = 'https://bitcoinarena.io/img/logo/';
  bar.innerHTML = '<div class="asc-wrap"><a class="asc-brand" href="' + HOME + '" aria-label="Bitcoin Arena"><img class="asc-mark" src="' + mark + 'bitcoin-arena-mark-90.webp" srcset="' + mark + 'bitcoin-arena-mark-60.webp 2x, ' + mark + 'bitcoin-arena-mark-90.webp 3x" width="58" height="30" alt=""><span>Bitcoin Arena</span></a>'
    + '<div class="asc-links">' + TOP.map(function (l) { return '<a' + (l[2] ? ' class="asc-keep"' : '') + (l[0] === 'Nostr' ? ' data-nostr="1"' : '') + ' href="' + l[1] + '"' + (here(l[1]) ? ' aria-current="page"' : '') + '>' + l[0] + '</a>'; }).join('') + '</div>'
    + '<a class="asc-nid" href="https://njump.me/npub1p8dl6aewvlszgsxlvpzznaruw3mx3wpt3699zgwnv7tk5pk790msqkqyh2" rel="me" title="Bitcoin Arena on Nostr - verified as bitcoinarena.io (NIP-05)" aria-label="Bitcoin Arena on Nostr - verified as bitcoinarena.io (NIP-05)"><svg viewBox="48 44 167 167" aria-hidden="true" focusable="false"><path d="M210.8 199.4c0 3.1-2.5 5.7-5.7 5.7h-68c-3.1 0-5.7-2.5-5.7-5.7v-15.5c.3-19 2.3-37.2 6.5-45.5 2.5-5 6.7-7.7 11.5-9.1 9.1-2.7 24.9-.9 31.7-1.2 0 0 20.4.8 20.4-10.7s-9.1-8.6-9.1-8.6c-10 .3-17.7-.4-22.6-2.4-8.3-3.3-8.6-9.2-8.6-11.2-.4-23.1-34.5-25.9-64.5-20.1-32.8 6.2.4 53.3.4 116.1v8.4c0 3.1-2.6 5.6-5.7 5.6H57.7c-3.1 0-5.7-2.5-5.7-5.7v-144c0-3.1 2.5-5.7 5.7-5.7h31.7c3.1 0 5.7 2.5 5.7 5.7 0 4.7 5.2 7.2 9 4.5 11.4-8.2 26-12.5 42.4-12.5 36.6 0 64.4 21.4 64.4 68.7v83.2ZM150 99.3c0-6.7-5.4-12.1-12.1-12.1s-12.1 5.4-12.1 12.1 5.4 12.1 12.1 12.1S150 106 150 99.3Z"/></svg></a>'
    + '<a class="asc-app" href="https://testnet.bitcoinarena.io/">App &rarr;</a></div>';
  var topCss = document.createElement('style');
  topCss.id = 'asc-top-style';
  topCss.textContent = [
    '#asc-bar { height: 56px !important; background: #0f0a10 !important; border-bottom: 1px solid #2f2229 !important; display: block !important; padding: env(safe-area-inset-top, 0px) 0 0 !important;',
    '  font: 400 15px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important; color: #f3ebe4 !important; }',
    '#asc-bar-space { height: 57px !important; }',
    '#asc-bar .asc-wrap { width: min(1080px, calc(100% - 32px)); margin: 0 auto; display: flex; align-items: center; gap: 22px; height: 56px; }',
    '#asc-bar .asc-lead { flex: none; margin-right: -8px; }',
    '#asc-bar .asc-brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; color: #f3ebe4 !important; text-decoration: none !important; white-space: nowrap; }',
    '#asc-bar .asc-brand img.asc-mark { height: 30px; width: auto; display: block; }',
    '#asc-bar .asc-links { margin-left: auto; display: flex; gap: 20px; font-size: 15px; }',
    // A PAGE'S OWN RULES NEVER REACH THE BAR (#1457: /security's a { color } and letter-spacing made its links white and tight)
    '#asc-bar, #asc-bar * { letter-spacing: normal !important; text-transform: none !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important; }',
    '#asc-bar .asc-links a { color: #9d8d84 !important; text-decoration: none !important; white-space: nowrap; font-weight: 400; }',
    '#asc-bar .asc-links a:hover, #asc-bar .asc-links a[aria-current="page"] { color: #f3ebe4 !important; }',
    '#asc-bar .asc-links a[data-nostr] { color: #b98cff !important; }',
    '#asc-bar .asc-nid { display: inline-flex; align-items: center; gap: 6px; color: #b98cff !important; text-decoration: none !important; font-size: 14px; white-space: nowrap; }',
    '#asc-bar .asc-nid svg { display: block; width: 18px; height: 18px; fill: currentColor; }',
    '#asc-bar .asc-app { padding: 7px 12px; border-radius: 4px; background: #f7931a; color: #140a00 !important; font-weight: 600; font-size: 15px; text-decoration: none !important; white-space: nowrap; }',
    '#asc-bar .asc-app:hover { background: #ffa53d; color: #140a00; }',
    '@media (max-width: 1140px) { #asc-bar .asc-links a:not(.asc-keep) { display: none; } #asc-bar .asc-links { gap: 16px; } #asc-bar .asc-wrap { gap: 16px; } }',
    '@media (max-width: 1279px) { #asc-bar .asc-nid span { display: none; } #asc-bar .asc-nid svg { width: 20px; height: 20px; } }',
    '@media (max-width: 480px) { #asc-bar .asc-links a[href*="proposals"] { display: none; } #asc-bar .asc-wrap { gap: 12px; } #asc-bar .asc-links { gap: 12px; font-size: 14px; } #asc-bar .asc-brand { font-size: 16px; } }',
    '@media (max-width: 420px) { #asc-bar .asc-brand span { display: none; } }'
  ].join('\n');
  (document.head || document.documentElement).appendChild(topCss);
  if (!document.querySelector('link[rel="me"][href="https://njump.me/npub1p8dl6aewvlszgsxlvpzznaruw3mx3wpt3699zgwnv7tk5pk790msqkqyh2"]')) { var me1144 = document.createElement('link'); me1144.rel = 'me'; me1144.href = 'https://njump.me/npub1p8dl6aewvlszgsxlvpzznaruw3mx3wpt3699zgwnv7tk5pk790msqkqyh2'; (document.head || document.documentElement).appendChild(me1144); }
  var space = document.createElement('div');
  space.id = 'asc-bar-space';
  me.parentNode.insertBefore(bar, me);
  me.parentNode.insertBefore(space, me);
  // the page's own control for the left end, styled as the bar's buttons
  var placeLead = function () {
    var id = me.getAttribute('data-lead'), el = id && document.getElementById(id);
    if (!el || bar.contains(el)) return;
    el.classList.add('asc-lead');
    var row = bar.querySelector('.asc-wrap') || bar; row.insertBefore(el, row.firstChild);
  };
  placeLead();

  // (no ☰ menu since #1457: the start page's header has none - its links fold away at narrow widths as there)

  // THE FOOTER, at the end of the page once it is read
  var foot = function () {
    placeLead();
    // a page with a footer of its own takes only the header (kanban #1457: the website's subpages, data-foot="none")
    if (document.getElementById('asc-foot') || me.getAttribute('data-foot') === 'none') return;
    var f = document.createElement('footer');
    f.id = 'asc-foot';
    f.innerHTML = '<span class="asc-build" aria-hidden="true">' + (/\{{3}/.test(STAMP) ? '' : esc(STAMP)) + '</span>'
      + '<span class="asc-social"><a href="https://x.com/bitcoinarena_io" target="_blank" rel="noopener noreferrer" aria-label="Bitcoin Arena on X" title="X"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg></a><a href="https://discord.gg/9zZbASZyue" target="_blank" rel="noopener noreferrer" aria-label="Bitcoin Arena on Discord" title="Discord"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.445.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.028C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.873-1.295 1.226-1.994a.076.076 0 0 0-.042-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.007.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03ZM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z"/></svg></a><a href="https://t.me/+KihHE8JhcVM3NDVi" target="_blank" rel="noopener noreferrer" aria-label="Bitcoin Arena on Telegram" title="Telegram"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0Zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635Z"/></svg></a><a href="https://github.com/bitcoinarena" target="_blank" rel="noopener noreferrer" aria-label="Bitcoin Arena on GitHub" title="GitHub"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg></a><a href="https://njump.me/npub1p8dl6aewvlszgsxlvpzznaruw3mx3wpt3699zgwnv7tk5pk790msqkqyh2" target="_blank" rel="me noopener noreferrer" aria-label="Bitcoin Arena on Nostr - verified as bitcoinarena.io (NIP-05)" title="Nostr: bitcoinarena.io &#10003;"><svg viewBox="48 44 167 167" aria-hidden="true" focusable="false"><path d="M210.8 199.4c0 3.1-2.5 5.7-5.7 5.7h-68c-3.1 0-5.7-2.5-5.7-5.7v-15.5c.3-19 2.3-37.2 6.5-45.5 2.5-5 6.7-7.7 11.5-9.1 9.1-2.7 24.9-.9 31.7-1.2 0 0 20.4.8 20.4-10.7s-9.1-8.6-9.1-8.6c-10 .3-17.7-.4-22.6-2.4-8.3-3.3-8.6-9.2-8.6-11.2-.4-23.1-34.5-25.9-64.5-20.1-32.8 6.2.4 53.3.4 116.1v8.4c0 3.1-2.6 5.6-5.7 5.6H57.7c-3.1 0-5.7-2.5-5.7-5.7v-144c0-3.1 2.5-5.7 5.7-5.7h31.7c3.1 0 5.7 2.5 5.7 5.7 0 4.7 5.2 7.2 9 4.5 11.4-8.2 26-12.5 42.4-12.5 36.6 0 64.4 21.4 64.4 68.7v83.2ZM150 99.3c0-6.7-5.4-12.1-12.1-12.1s-12.1 5.4-12.1 12.1 5.4 12.1 12.1 12.1S150 106 150 99.3Z"/></svg></a></span>'
      // FEEDBACK FROM EVERY PAGE (kanban #1342, Daniel 2026-11-07: "add it on the footer properly"): the game page opens its dialog at ?feedback=1
      + '<a class="asc-feedback" href="' + esc(site) + '?feedback=1">Feedback</a>'
      + '<a class="asc-donate" href="' + esc(site) + '#donate">&hearts; Donate</a>';
    var s = document.createElement('div');
    s.id = 'asc-foot-space';
    document.body.appendChild(s);
    document.body.appendChild(f);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', foot); else foot();
})();
