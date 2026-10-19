// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TICK TOCK'S LOADING SCREEN (kanban #521: every game whole under its plugin): Unity's canvas, the gold panel Unity's lobby is
// drawn in, the title and its build line, the how-to, the percent with its 91 ... 99 % steps, the download line and the note. The page
// runs this while it is parsed, from inside #boot right after #stage - before the first paint - and it puts each where it stood in
// index.html; another game's screen hides them (html.other-game). The build number is the template's, from #boot's data-build. Then
// the panel is measured as before (bootPanel). Its CSS is unity-page.css.
(function () {
  const boot = document.getElementById('boot'), track = document.getElementById('track'), stage = document.getElementById('stage');
  const build = boot.getAttribute('data-build') || '';
  document.body.insertAdjacentHTML('afterbegin', '<canvas id="canvas" tabindex="-1"></canvas>');
  boot.insertAdjacentHTML('afterbegin', '<div id="boot-panel"><div class="head"></div></div>');
  track.insertAdjacentHTML('beforebegin', '<div id="title"><img id="logo" src="nextblock-icon.svg" alt="">Tick Tock, <span>Next Block</span></div>' + '<div id="sub">build ' + build + '</div>');
  track.insertAdjacentHTML('beforebegin', '<div id="howto"><img src="howto-1.png" alt="How to play, 1 of 4"><img src="howto-2.png" alt="How to play, 2 of 4"><img src="howto-3.png" alt="How to play, 3 of 4"><img src="howto-4.png" alt="How to play, 4 of 4"></div>');
  track.insertAdjacentHTML('beforebegin', '<div id="pctwrap"><div id="pct">0%</div><div id="pct-steps" aria-hidden="true"><span style="animation-delay:0.0s">91 %</span><span style="animation-delay:0.3s">92 %</span><span style="animation-delay:0.6s">93 %</span><span style="animation-delay:0.9s">94 %</span><span style="animation-delay:1.2s">95 %</span><span style="animation-delay:1.5s">96 %</span><span style="animation-delay:1.8s">97 %</span><span style="animation-delay:2.1s">98 %</span><span style="animation-delay:2.4s">99 %</span></div></div>');
  track.insertAdjacentHTML('afterend', '<div id="dl" aria-live="off"></div>');
  stage.insertAdjacentHTML('afterend', '<div id="note"><span id="total">…</span> to load. The first time is the slowest — after that most of it is in the browser cache.</div>');
})();
// UNITY'S LOBBY PANEL, MEASURED THE SAME WAY: SplashScreen.Measure and Styles in CSS pixels - the panel, its gold
// head, the title fitted on one line with the mark beside it (x 0.92 until it fits, as Unity does), the build row under the head.
(function () {
  const boot = document.getElementById('boot'), title = document.getElementById('title');
  const ctx = document.createElement('canvas').getContext('2d');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function bootPanel() {
    if (!boot || !title || document.documentElement.classList.contains('other-game')) return;
    const w = window.innerWidth, h = window.innerHeight, min = Math.min(w, h);
    const pw = Math.min(w * 0.86, 900), ph = Math.min(h * 0.88, 760), px = (w - pw) / 2, py = (h - ph) / 2;
    const hh = clamp(ph * 0.13, 44, 96), pad = pw * 0.07, padV = Math.min(pad, ph * 0.07);
    const sub = Math.round(clamp(min * 0.028, 14, 24));
    let tf = Math.round(clamp(min * 0.070, 30, 68)), mark = 0, gap = 0;
    for (let i = 0; i < 24; i++) {
      ctx.font = `700 ${tf}px system-ui, sans-serif`;
      const nx = ctx.measureText('TICK TOCK, NEXT BLOCK').width, ny = tf * 1.15;
      mark = Math.min(hh * 0.78, ny * 1.15); gap = Math.max(6, mark * 0.25);
      if ((nx + mark + gap + 24 <= pw && ny <= hh) || tf <= 12) break;
      tf = Math.max(12, Math.round(tf * 0.92));
    }
    const by = py + hh + ph * 0.008, bh = Math.max(12, sub * 1.3);
    // THE PICTURES SIZED TO THE ROOM LEFT IN THE FRAME (2026-10-17: "Ui version overlapping border"): on a tall
    // phone the 2x2 pictures, the percent, the bar and the words were taller than the panel and ran over its edges; the rest of the
    // column is ~290 px, the pictures take what is left (two rows ~0.9 of their width, one row 1/6.25)
    const restH = 290, roomH = Math.max(80, (py + ph - padV) - (by + bh + ph * 0.02) - restH);
    const portrait = h > w, howtoW = Math.max(120, Math.min(pw - pad * 2, portrait ? roomH / 0.9 : roomH * 6.25));
    const set = { '--hw': howtoW, '--gap': roomH < 260 ? 8 : 14, '--px': px, '--py': py, '--pw': pw, '--ph': ph, '--hh': hh, '--tf': tf, '--tm': mark, '--tg': gap, '--ix': px + pad, '--iw': pw - pad * 2,
      '--ir': w - (px + pw - pad), '--by': by, '--bh': bh, '--bf': Math.max(10, Math.round(sub * 0.8)), '--ct': by + bh + ph * 0.02,
      '--cb': h - (py + ph) + padV };
    for (const k in set) boot.style.setProperty(k, set[k].toFixed(1) + 'px');
    boot.classList.add('paneled');
  }
  bootPanel(); window.addEventListener('resize', bootPanel); window.ARENA_BOOT_PANEL = bootPanel;
})();
