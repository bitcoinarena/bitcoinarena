// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TICK TOCK'S PART OF THE ARENA PAGE (kanban #521: every game whole under its plugin): the bridge to its client, Unity - the
// graphics and the benchmark, the run's end (result summary, replay link, the next round and its box), the run's link to the
// signer nodes, and Unity's loader. It was lines of the page's main script; the page loads it as a classic script just before
// that script, so its top-level names are the page's names exactly as before. While it loads it uses none of the main script's
// own names (those it calls later - fail, show, canvas, config, boot, stage, ... - are the page's by then). The loader's file
// name is the build's, which only the page's template is filled with: index.html hands it over as window.ARENA_UNITY_LOADER.
// Its markup - the next round's box and the link's warning - is put where it stood; its CSS is unity-page.css beside this file.
document.getElementById('arena-bal-split').insertAdjacentHTML('afterend', '<div id="arena-next" role="status"><span id="arena-next-say"></span><button id="arena-next-addons" type="button" style="display:none">Buy add-ons</button><button id="arena-next-donate" type="button">&hearts; Donate</button><button id="arena-next-exit" type="button">exit game</button></div>');
document.getElementById('arena-lobby').insertAdjacentHTML('beforebegin', '<div id="arena-link-warn" role="alert" style="display:none;position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;max-width:min(92vw,720px);padding:8px 14px;border-radius:8px;background:#b3261e;color:#fff;font:600 14px/1.35 system-ui,sans-serif;text-align:center;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4)"></div>');
document.getElementById('arena-fps-host').insertAdjacentHTML('beforebegin', '<select id="arena-gfx-select" aria-label="Graphics"><option value="auto" selected>Auto (by device)</option><option value="high">High</option><option value="low">Low</option></select><div class="muted" id="arena-gfx-now"></div>');   // Settings' graphics line
document.getElementById('arena-set-logs').insertAdjacentHTML('afterend', '<section class="settings-card" id="arena-set-bench"><h3>Benchmark</h3><label class="muted"><input type="checkbox" id="arena-bench-on"> On - off by default</label><div class="muted">Spectates the round and measures this device\'s frame rate with each graphics cost switched off in turn; the result shows under the FPS line. While it is on, a tap on the FPS line runs it too.</div><button id="arena-bench-go" type="button" disabled>Run the benchmark</button></section>');   // the benchmark's card

    // ---------------------------------------------------------------- Unity graphics: the benchmark switch, quality by device, the frame-rate test
    // THE BENCHMARK SWITCH (2026-10-16: "Benchmark is disabled by default"): Settings turns it on, this browser keeps it
    window.ARENA_BENCH_ON = () => { try { return window.ARENA_BROWSER_STORE().getItem('arena.bench.on') === '1'; } catch { return false; } };
    // THE FRAME-RATE TEST (2026-10-08: "measure it alone and display the data you need in the fps line"): what
    // costs the frames on THIS phone. Eleven modes, 1.5 s to settle and 3 s measured each - as built, 1x pixels, no post-processing,
    // no shadows, no HDR, the shadow map's parts (cascades, size, reach), all of them off - then back as built. The result stays under the frame rate with the drawing buffer
    // of each pixel mode: if 1x pixels and "all off" barely move it, the frame is the CPU's, else the GPU's. The lobby's BENCHMARK
    // runs it over spectate (2026-10-08); a tap on the readout runs it again. window.ARENA_BENCH keeps it for a probe.
    // QUALITY BY DEVICE (2026-10-08, comment 1011): a weaker device drops render quality so the frame rate
    // holds, and each kind of device drops what its own BENCHMARK lines said costs it (card, 21:11): an iPhone gained most
    // without shadows (26 -> 56 fps) and lost with HDR off (23); an Android gained most with HDR off (48 -> 63) and a 1024 map
    // (55). The device type picks the start; if 10 s of play still average under 30 fps, Auto steps down once and remembers it
    // for the device. Settings "Graphics": Auto / High (as built) / Low (all off). `?gfx=auto|high|low` sets it for one visit.
    // Everything is a run-time switch (GfxSwitches, Unity's devicePixelRatio): nothing of the game, its ground or its HUD changes.
    (function arenaGraphics() {
      const ua = navigator.userAgent || '';
      const device = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iphone'
        : /Android/i.test(ua) ? 'android' : 'desktop';
      // "½ scale" IS URP's render scale 0.5: the 3D at a quarter of the pixels (as 1x pixels), the HUD at full resolution - the
      // page's devicePixelRatio would shrink the HUD's screen too, and the chart grew to twice its share (measured, iPhone)
      const AS_BUILT = ['as built', {}], ALL_OFF = ['all off', { scale: 0.5, post: 0, shadows: 0, hdr: 0 }];
      const LADDER = {
        iphone: [['shadows off', { shadows: 0 }], ['shadows off · ½ scale', { shadows: 0, scale: 0.5 }], ALL_OFF],
        android: [['map 1024 · HDR off', { shadowres: 1024, hdr: 0 }], ['shadows off · HDR off', { shadows: 0, hdr: 0 }],
          ['shadows off · HDR off · ½ scale', { shadows: 0, hdr: 0, scale: 0.5 }]],
        desktop: [AS_BUILT],
      }[device];
      const store = { get: (k) => { try { return window.ARENA_BROWSER_STORE().getItem(k); } catch { return null; } },
                      set: (k, v) => { try { window.ARENA_BROWSER_STORE().setItem(k, v); } catch { /* this visit only */ } } };
      const stepKey = 'arena.gfx.step.' + device;
      const urlMode = new URLSearchParams(location.search).get('gfx');
      let mode = ['auto', 'high', 'low'].includes(urlMode) ? urlMode : (['auto', 'high', 'low'].includes(store.get('arena.gfx.mode')) ? store.get('arena.gfx.mode') : 'auto');
      let step = Math.min(LADDER.length - 1, Math.max(0, parseInt(store.get(stepKey) || '0', 10) || 0));
      const current = () => mode === 'high' ? AS_BUILT : mode === 'low' ? ALL_OFF : LADDER[step];
      let baseDpr = null;
      function apply(sw) {
        const u = window.unityInstance, mod = u && u.Module;
        if (!u) return false;
        if (mod) { if (baseDpr === null) baseDpr = mod.devicePixelRatio || Math.min(window.devicePixelRatio || 1, 2); mod.devicePixelRatio = sw.dpr || baseDpr; }
        try { u.SendMessage('GfxSwitches', 'Set', 'post=' + (sw.post === 0 ? 0 : 1) + ';shadows=' + (sw.shadows === 0 ? 0 : 1) + ';hdr=' + (sw.hdr === 0 ? 0 : 1)
          + ';cascades=' + (sw.cascades || 0) + ';shadowres=' + (sw.shadowres || 0) + ';shadowdist=' + (sw.shadowdist || 0) + ';scale=' + (sw.scale || 0)); } catch { return false; }
        return true;
      }
      const label = () => (mode === 'auto' ? 'Auto' : mode === 'high' ? 'High' : 'Low') + ' · ' + { iphone: 'iPhone', android: 'Android', desktop: 'desktop' }[device] + ': ' + current()[0];
      function applyCurrent(why) {
        const ok = apply(current()[1]);
        window.ARENA_GFX_STATE = { device, mode, step, preset: current()[0], applied: ok, why };
        console.log('[gfx] ' + label() + ' (' + why + ')');
        const said = document.getElementById('arena-gfx-now'); if (said) said.textContent = 'Now: ' + label();
        return ok;
      }
      window.ARENA_GFX = { device, current, apply, applyCurrent, label };
      // ON: once Unity is up, and again a moment later (the switches' receiver is made after the first scene loads)
      (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 1200 && !window.unityInstance; i++) await sleep(250);
        if (!window.unityInstance) return;
        await sleep(1500); applyCurrent('start');
        await sleep(4000); applyCurrent('start, again');
        // THE GUARD: Auto only, a phone only, once a visit - 10 s of play under 30 fps on average take one step down
        if (mode !== 'auto' || device === 'desktop') return;
        let frames = 0, since = 0, last = 0;
        const playing = () => window.ARENA_UNITY_LOBBY && window.ARENA_UNITY_LOBBY.showing === false && !window.ARENA_BENCH_RUNNING && !document.hidden;
        await new Promise((done) => {
          const tick = (t) => {
            if (!playing()) { frames = 0; since = 0; last = 0; requestAnimationFrame(tick); return; }
            if (!since) { since = t; last = t; requestAnimationFrame(tick); return; }
            frames++; last = t;
            if (t - since >= 10000) { done(frames * 1000 / (t - since)); return; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }).then((avg) => {
          window.ARENA_GFX_GUARD = { avg: Math.round(avg), step, at: new Date().toISOString() };
          if (avg >= 30 || step >= LADDER.length - 1) { console.log('[gfx] guard: ' + Math.round(avg) + ' fps over 10 s of play, ' + current()[0] + ' stays'); return; }
          step++; store.set(stepKey, String(step));
          applyCurrent('guard: ' + Math.round(avg) + ' fps over 10 s of play, one step down');
        });
      })();
      // THE SETTINGS LINE
      const sel = document.getElementById('arena-gfx-select');
      if (sel) {
        sel.value = mode;
        sel.addEventListener('change', () => { mode = sel.value; store.set('arena.gfx.mode', mode); applyCurrent('settings'); });
        const said = document.getElementById('arena-gfx-now'); if (said) said.textContent = 'Now: ' + label();
      }
    })();
    (function arenaBench() {
      const box = document.getElementById('arena-fps'), out = document.getElementById('arena-fps-bench');
      if (!box || !out) return;
      // THE SHADOW MAP'S PARTS (the owner's iPhone 16 Pro, 2026-10-08: as built 31 fps, no shadows 60): cascades, map size, reach
      const MODES = [['as built', {}], ['1x px', { dpr: 1 }], ['no post', { post: 0 }], ['no shadows', { shadows: 0 }], ['no HDR', { hdr: 0 }],
        ['1 cascade', { cascades: 1 }], ['2 cascades', { cascades: 2 }], ['map 1024', { shadowres: 1024 }], ['reach 120 m', { shadowdist: 120 }],
        ['1 casc · 1024 · 120 m', { cascades: 1, shadowres: 1024, shadowdist: 120 }],
        ['all off', { dpr: 1, post: 0, shadows: 0, hdr: 0 }]];
      // THE PRESET NEXT TO AS BUILT: the line this device starts with, right after "as built"
      const modes = () => { const g = window.ARENA_GFX; if (!g) return MODES; const [n, sw] = g.current();
        return n === 'as built' ? MODES : [MODES[0], ['preset (' + n + ')', sw], ...MODES.slice(1)]; };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const measure = (ms) => new Promise((r) => {
        let n = 0, worst = 0, best = Infinity, last = 0; const t0 = performance.now();
        const f = (t) => { if (last) { n++; worst = Math.max(worst, t - last); best = Math.min(best, t - last); } last = t;
          if (t - t0 < ms) requestAnimationFrame(f); else r({ ...fpsOf(Math.max(n, 1), t - t0, worst, best), worstMs: Math.round(worst) }); };
        requestAnimationFrame(f);
      });
      const buffer = () => { const c = document.getElementById('canvas'); return c ? c.width + '×' + c.height : '?'; };
      let running = false, baseDpr = null;
      function set(m) {
        if (window.ARENA_GFX) { window.ARENA_GFX.apply(m); return; }
        const u = window.unityInstance, mod = u && u.Module;
        if (mod) { if (baseDpr === null) baseDpr = mod.devicePixelRatio || Math.min(window.devicePixelRatio || 1, 2); mod.devicePixelRatio = m.dpr || baseDpr; }
        try { u.SendMessage('GfxSwitches', 'Set', 'post=' + (m.post === 0 ? 0 : 1) + ';shadows=' + (m.shadows === 0 ? 0 : 1) + ';hdr=' + (m.hdr === 0 ? 0 : 1)
          + ';cascades=' + (m.cascades || 0) + ';shadowres=' + (m.shadowres || 0) + ';shadowdist=' + (m.shadowdist || 0)); } catch { /* no receiver: pixels only */ }
      }
      async function run() {
        if (running || !window.unityInstance || document.body.classList.contains('arena-clean')) return;
        running = true; window.ARENA_BENCH_RUNNING = true;
        const res = [], list = modes();
        try {
          for (const [name, m] of list) {
            out.textContent = 'testing ' + name + ' (' + (res.length + 1) + '/' + list.length + ')…';
            set(m); await sleep(1500);
            const r = await measure(3000);
            res.push({ name, ...r, buffer: m.dpr || name === 'as built' || name.startsWith('preset') ? buffer() : null });
          }
        } finally { if (window.ARENA_GFX) window.ARENA_GFX.applyCurrent('after the benchmark'); else set({}); running = false; window.ARENA_BENCH_RUNNING = false; }
        // ONE LINE A MODE: avg / min / max fps, and the drawing buffer of each pixel mode
        const line = res.map((r) => r.name + ': avg ' + r.avg + ' · min ' + r.min + ' · max ' + r.max + (r.buffer ? ' · ' + r.buffer : '')).join('\n')
          + '\ntap to rerun';
        out.textContent = line;
        window.ARENA_BENCH = { res, dpr: baseDpr, deviceDpr: window.devicePixelRatio, ua: navigator.userAgent, at: new Date().toISOString() };
        console.log('[bench] ' + line);
      }
      window.arenaBench = run;
      // OFF BY DEFAULT (2026-10-16: "Benchmark is disabled by default"): a tap on the readout runs the test only
      // while the Settings switch is on; ?bench=1 asks for it by address and runs as before
      box.addEventListener('click', (e) => { e.stopPropagation(); if (window.ARENA_BENCH_ON()) run(); });
      // `?bench=1`: BENCHMARK opens by itself once the lobby is up - the Benchmark the Settings card runs - and the
      // finished lines go to bitcoin-arena.io/__bench (fps, buffer, the browser's user agent; nothing else), so a phone's result
      // reaches the card without a screenshot. Only on that address.
      if (new URLSearchParams(location.search).get('bench') === '1') (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 1200 && !(window.ARENA_UNITY_LOBBY && window.ARENA_UNITY_LOBBY.showing); i++) await sleep(250);
        await sleep(6000);
        try { window.unityInstance.SendMessage('Bootstrap', 'Benchmark'); } catch { return; }
        for (let i = 0; i < 600 && !window.ARENA_BENCH; i++) await sleep(500);
        if (!window.ARENA_BENCH) return;
        try { await fetch('https://bitcoin-arena.io/__bench', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ ...window.ARENA_BENCH, gfx: window.ARENA_GFX_STATE || null, build: (document.querySelector('#build-stamp') || {}).textContent || null }) }); } catch { /* the lines stay on the screen */ }
      })();
    })();

    // ---------------------------------------------------------------- the benchmark from Settings
    // THE BENCHMARK FROM SETTINGS: Settings closes, and Unity spectates and runs the page's frame-rate test (Benchmark,
    // as the lobby's button did); a game without Unity runs the test over its own client
    {
      const on = document.getElementById('arena-bench-on'), go = document.getElementById('arena-bench-go');
      on.checked = window.ARENA_BENCH_ON(); go.disabled = !on.checked;
      on.addEventListener('change', () => { try { window.ARENA_BROWSER_STORE().setItem('arena.bench.on', on.checked ? '1' : '0'); } catch { /* this page only */ } go.disabled = !on.checked; });
    }
    document.getElementById('arena-bench-go').addEventListener('click', () => {
      if (!window.ARENA_BENCH_ON()) return;   // off by default
      settingsPanel().style.display = 'none';
      if (window.unityInstance && window.ARENA_UNITY !== false) { try { window.unityInstance.SendMessage('Bootstrap', 'Benchmark'); return; } catch { /* the test alone */ } }
      if (typeof window.arenaBench === 'function') window.arenaBench();
    });

    // ---------------------------------------------------------------- the run's end: the round let go, the replay link, the result summary, the run made safe, the next round and its box
    // THE RUN IS OVER, SO THE PAGE LETS GO OF ITS ROUND (2026-09-15 16:14, hole 2). Measured
    // before: after the run ended the address still read `?round=...&play=1`, so a reload joined the
    // finished round again. Called by the bridge at the core's word and when the run ends; twice is
    // the same as once. The chain and the advert go - they are what tells Unity there is a session to
    // open - and the address is the lobby's own again: the bare root, or the lobby link PLAY left.
    // The round and the entry stay for whatever reads the finished run; the next join replaces them.
    //
    // A RUN THAT STARTED FROM A ROUND'S OWN LINK HAS A LOBBY TOO (2026-09-16 14:24: "RUN STOPPED, cannot
    // pick the next round"). PLAY leaves the address as the round's link with `&play=1`; opened again - a
    // reload, a restored tab, a phone bringing the tab back - that address joins the round with no lobby
    // behind it. Measured on 0.0.1386: DELIVERED, the banner, and no lobby, ever. So a page that has no
    // lobby goes back to the lobby its link names - the same query without the round and `play` - and
    // starts it here, without a reload.
    // NO WINNINGS ADDRESS IS ASKED FOR (2026-09-29 21:58, SPECTATE-2158: "Remove 'Where should your winnings be
    // sent? Lightning address'. Winnings go to the federation wallet and are paid out to the user there"). Free or paying.
    // COPY GAME REPLAY (2026-09-25 18:39): the result card's control hands this page the run (the bridge's
    // BlwpCopyReplay); the page copies ONE https link - a random committee node of the round, from its advertisement
    // endpoints (a node's /replay/nodes), ws made https - to /replay?round=<hex>&entry=<hex>. The endpoints are fetched
    // when the run ends, so the click itself only builds the link and writes it: the clipboard wants the click's
    // activation, and a fetch between the two could outlive it.
    const replayNodes = new Map();
    const prefetchReplayNodes = (roundHex, nodes) => {
      if (!roundHex || replayNodes.has(roundHex)) return replayNodes.get(roundHex);
      const asked = (async () => {
        for (const n of nodes || []) {
          // THE STABLE NAMES FIRST (2026-09-26 13:28): a quick tunnel's name dies on its next start, so the copied link
          // names the nodes' stable https bases when they answer any, and the round's advertised endpoints only when not
          try { const r = await fetch(`${String(n).replace(/\/+$/, '')}/replay/nodes?round=${roundHex}`); if (r.ok) { const j = await r.json(); return (j.stable && j.stable.length ? j.stable : j.endpoints) || []; } }
          catch (e) { /* the next node */ }
        }
        return [];
      })();
      replayNodes.set(roundHex, asked);
      return asked;
    };
    window.ARENA_COPY_REPLAY = async (roundHex, entryHex, nodes) => {
      // "copied!" on the card only once the clipboard holds the link (2026-09-26 07:12): the bridge reads this
      window.ARENA_REPLAY_COPIED = '';
      const endpoints = await prefetchReplayNodes(roundHex, nodes);
      const link = ARENACLIENT.replayLinkFor({ endpoints, roundHex, entryHex });
      if (!link.ok) { console.error('[arena] copy game replay: ' + link.why); return link; }
      window.ARENA_REPLAY_URL = link.url;
      try { await navigator.clipboard.writeText(link.url); window.ARENA_REPLAY_COPIED = link.url; console.log('[arena] copy game replay: copied ' + link.url); }
      catch (e) { console.error('[arena] copy game replay: the clipboard refused (' + e.message + '); the link is ' + link.url); }
      return link;
    };
    // THE RESULT SUMMARY ON THE END CARD (2026-10-04): the round's own /api/round-result, read from its signer nodes
    // about 1 s after the end and every 2 s while the card is up, handed to Unity as it came (BlwpResultSummary). The
    // page decides nothing: each player's outcome, score, signers, result and netMsat are the seats' own (playerBalance);
    // it only names the fields Unity reads and writes a missing number as empty.
    let resultTimer = null;
    const readResultSummary = async (run, nodes) => {
      const kept = window.ARENA_RESULT;
      if (!kept || kept.roundHex !== run.roundHex || !window.ARENA_CARD_UP) { clearInterval(resultTimer); resultTimer = null; return; }
      for (const n of nodes) {
        try {
          const r = await fetch(`${String(n).replace(/\/+$/, '')}/api/round-result?round=${run.roundHex}`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
          if (!r.ok) continue;
          const j = await r.json();
          if (window.ARENA_RESULT !== kept) return;
          // the seat's own player object first (its stake among it, forwarded as the seat wrote it), then the fields Unity
          // reads named and their nulls written empty
          kept.players = (j.players || []).map((p) => ({ ...p,
            entry: p.entry || '', key: p.player || '', name: p.name || '', outcome: p.outcome || '',
            score: p.score === null || p.score === undefined ? -1 : Number(p.score), signedBy: p.signedBy | 0,
            result: p.result || '', net: p.netMsat === null || p.netMsat === undefined ? '' : String(p.netMsat) }));
          writeResultSummary(kept);
          kept.reads = (kept.reads | 0) + 1;
          kept.from = String(n);
          return;
        } catch (e) { /* the next node */ }
      }
    };
    // THE CARD WAITS FOR THIS RUN'S SIGNED RESULT (2026-10-04, option 1): the seats sign a run when its ROUND closes -
    // measured 90.5 s after a delivery - so with continue off the card, and the lobby behind it, hold until the round's
    // close + 20 s (+10 s let go 0.35 s before the 7th signer on round 555342f8 - the seats sign 9.3-11.3 s after the close).
    // NO EARLY RELEASE ON THE SIGNERS (round 52650809: the first signed read already had five, the hold let go on that read
    // and the lobby was up 0.25 s later - the signed lines were logged, never seen): the close + 20 s clock alone lets go,
    // so the signed names, high score and count stand on the card until then. `hold` rides with the summary to Unity
    // (DriveHud.ArrivalHoldNow); this timer keeps it true to the clock even when no seat answers.
    const RESULT_HOLD_PAST_CLOSE_MS = 20000;
    const writeResultSummary = (kept) => {
      kept.hold = Date.now() < kept.holdUntil;
      kept.text = JSON.stringify({ mine: kept.entryHex, hold: kept.hold, players: kept.players || [] })
        // ASCII ON THE BRIDGE: a name's other letters go as \u escapes, which Unity's JSON reader turns back
        .replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    };
    let holdTimer = null;
    const startResultSummary = (run) => {
      if (!run || !run.roundHex || !run.entryHex) return;
      if (window.ARENA_RESULT && window.ARENA_RESULT.roundHex === run.roundHex && resultTimer) return;
      const nodes = (run.nodes && run.nodes.length ? run.nodes : window.ARENA_NODES) || [];
      let closeMs = NaN;
      try { if (window.ARENA_ROUND && ARENACLIENT.toHex(ARENACLIENT.roundId(window.ARENA_ROUND)) === run.roundHex) closeMs = Number(ARENACLIENT.roundEndMs(window.ARENA_ROUND)); } catch { /* no close: no hold */ }
      const kept = window.ARENA_RESULT = { roundHex: run.roundHex, entryHex: run.entryHex, text: '', reads: 0, players: [],
        holdUntil: isFinite(closeMs) ? closeMs + RESULT_HOLD_PAST_CLOSE_MS : 0 };
      writeResultSummary(kept);
      clearInterval(holdTimer);
      holdTimer = setInterval(() => {
        if (window.ARENA_RESULT !== kept || !window.ARENA_CARD_UP) { clearInterval(holdTimer); holdTimer = null; return; }
        const was = kept.hold;
        if (was && !(Date.now() < kept.holdUntil)) { writeResultSummary(kept); console.log('[arena] result summary: the card lets go (the round closed + 20 s)'); }
      }, 500);
      console.log('[arena] result summary: the card holds until ' + (kept.holdUntil ? new Date(kept.holdUntil).toISOString().slice(11, 19) + 'Z (the round closed + 20 s)' : 'no close known: no hold'));
      clearInterval(resultTimer);
      setTimeout(() => readResultSummary(run, nodes), 1000);
      resultTimer = setInterval(() => readResultSummary(run, nodes), 2000);
    };
    // THE RUN IS SAFE BEFORE IT IS CELEBRATED (§13A "Client duty"): "on delivery, the reference client uploads its
    // complete transcript to at least two committee nodes ... before showing the victory screen. This is what makes the veto work for
    // a player who closes the browser immediately afterwards." The batches stream live, so this asks the nodes what they hold
    // (secureTranscript) and, until two hold the whole run, holds a line over the result card: "keep this tab open".
    // THE CHAIN CHECKED OUTSIDE THE NETWORK (§5A.4): a paid join's census and tip are spot-checked against a block explorer -
    // mempool.space for testnet4 rounds by default; `arena.explorer` in this browser's storage names another Esplora base, or `off`
    window.ARENA_EXPLORER_FOR = (round) => {
      let said = null; try { said = window.ARENA_BROWSER_STORE().getItem('arena.explorer'); } catch { /* no storage: the default */ }
      if (said === 'off') return null;
      if (said && /^https:\/\//.test(said)) return said;
      return round && round.networkId && ARENACLIENT.toHex(round.networkId) === '1060078b1d4458b32c47aa68279f2260ad8e731ae365ce3f22260dbdc92d7a15' ? 'https://mempool.space/testnet4/api' : null;
    };
    window.ARENA_SECURE_RUN = async (word, run, { tries = 30, everyMs = 3000 } = {}) => {
      if (!run || !/DELIVERED/.test(String(word || '')) || !ARENACLIENT.secureTranscript) return null;
      const M = window.unityInstance && window.unityInstance.Module;
      const n = M && (M.arenaRunNet || M.blwpRunNet || M.arenaNet || M.blwpNet);
      const finalTick = n && n.client && Number.isInteger(n.client.nextTick) ? n.client.nextTick : null;
      if (!finalTick || !run.roundHex || !run.entryHex) return null;
      let el = document.getElementById('arena-securing');
      if (!el) { el = document.createElement('div'); el.id = 'arena-securing';
        el.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:60;padding:8px 14px;border-radius:8px;background:rgba(10,14,20,.92);color:#ffd27a;font:600 14px system-ui;max-width:92vw;text-align:center';
        document.body.appendChild(el); }
      el.style.display = ''; el.textContent = 'Securing your run with the signer nodes … keep this tab open';
      let got = null;
      for (let i = 0; i < tries; i++) {
        got = await ARENACLIENT.secureTranscript({ roundId: ARENACLIENT.fromHex(run.roundHex), entryId: ARENACLIENT.fromHex(run.entryHex), nodes: run.nodes || [], finalTick });
        if (got.safe) { el.style.color = '#7ee08a'; el.textContent = 'Your run is safe: ' + got.holders.length + ' signer nodes hold all of it'; setTimeout(() => { el.style.display = 'none'; }, 4000); break; }
        el.textContent = 'Securing your run: ' + got.holders.length + ' of 2 signer nodes hold all of it … keep this tab open';
        await new Promise((r) => setTimeout(r, everyMs));
      }
      window.ARENA_RUN_SAFE = got;
      if (got && !got.safe) { el.style.color = '#ff8a7a'; el.textContent = 'Your run is not yet held by two signer nodes - keep this tab open (' + got.why + ')'; }
      return got;
    };
    window.ARENA_RUN_OVER = (word, run) => {
      if (run) prefetchReplayNodes(run.roundHex, run.nodes);
      window.ARENA_CHAIN = undefined;
      window.ARENA_ADVERT = undefined;
      const noLobby = !window.ARENA_LOBBY_ACT;
      let back = typeof window.ARENA_LOBBY_BACK === 'string' ? window.ARENA_LOBBY_BACK : '';
      if (noLobby && typeof window.ARENA_LOBBY_BACK !== 'string') {
        const q = new URLSearchParams(location.search.replace(/^\?/, ''));
        q.delete('round'); q.delete('play');
        const s = q.toString();
        back = s ? '?' + s : '';
      }
      // A NEWER JOIN KEEPS ITS ADDRESS (2026-10-03, the chained paid join): this runs twice at a run's end, and its
      // second call put the lobby's address back after the next round's join had set its round= - a reload in that round
      // then found no round to take its kept lock, key and entry back for (measured 13:43:36.667 -> 13:43:37.357Z).
      const going = window.ARENA_JOIN;
      const newerJoin = !!(going && !going.cancelled && going.state === 'joining' && going.round
        && (!run || !run.roundHex || String(going.round) !== String(run.roundHex)));
      // AND A RESUMED RUN KEEPS ITS ADDRESS UNTIL IT ENDS ITSELF (2026-10-03): while it catches up, nothing else's end
      // puts the lobby's address over its round=; it may only when that run ends, or once its round has closed.
      const resume = window.ARENA_RESUME;
      const resumedEnds = !!(resume && run && String(run.roundHex) === String(resume.roundIdHex) && resume.caughtUp);
      const resuming = !!(resume && !resumedEnds && Date.now() < Number(resume.closeMs));
      if (resumedEnds) window.ARENA_RESUME = null;
      if (!newerJoin && !resuming && location.search !== back) history.replaceState(null, '', location.pathname + back);
      window.ARENA_RUN_ENDED = String(word || '');
      // THE RESULT CARD IS UP FROM HERE UNTIL THE LOBBY (PRIORITIES item 3, "nothing overlaps"; measured 2026-09-26 at
      // 1280x720: this panel's top edge crossed the card's bottom border). It steps aside until Unity reports the lobby.
      window.ARENA_CARD_UP = true;
      // and the result summary on it, read from the round's signer nodes while it stands
      startResultSummary(run);
      // and the run made safe on two signer nodes before it is celebrated
      if (window.ARENA_SECURE_RUN && (!window.ARENA_SECURING || window.ARENA_SECURING !== (run && run.entryHex))) { window.ARENA_SECURING = run && run.entryHex; window.ARENA_SECURE_RUN(word, run).catch(() => {}); }
      { const pl = document.getElementById('arena-players'); if (pl) pl.style.display = 'none'; }
      if (noLobby && !window.ARENA_LOBBY_STARTING) {
        window.ARENA_LOBBY_STARTING = true;
        showTheLobbyIfOneWasNamed()
          .then((shown) => console.log('[arena] the run is over: ' + (shown ? 'the lobby is up' : 'this page names no lobby')))
          .catch((e) => console.error('[arena] the run is over, and that lobby cannot be read: ' + e.message));
      }
      // CONTINUING IS THE DEFAULT (2026-09-28, option 1 of A; spec "Timing - every network, every round"): the
      // page enters the next round of the same kind for the player now - its entry is open until its start - and holds
      // it until that start, so the next run starts with everybody at start_time(i+1). "exit game" stops it.
      if (!noLobby && window.ARENA_CONTINUE !== false && window.ARENA_ROUND) continueToTheNextRound(window.ARENA_ROUND);
    };
    function continueToTheNextRound(played) {
      // ONCE PER RUN: the run's end is said more than once (the core's word, then the session's close), and the first
      // call has already entered the next round - which is ARENA_ROUND by the second. Measured: the second call looked for
      // the round after THAT one, found none listed, and the box said "joining next round" with no number while the page
      // was in fact joining 459d734a.
      const was = window.ARENA_NEXT;
      if (was && (was.state === 'looking' || was.state === 'joining') && Date.now() - was.runOverAt < 120000) return;
      // THE COUNTDOWN STANDS FROM THE CARD'S END, LISTED ROUND OR NOT (2026-09-29 17:45, SEE-AND-COPIED-1745: he
      // saw no countdown - the box waited for the nodes to list the next round, up to a minute on the Daily). Until the
      // next round is listed it counts to the played round's start + 90 s, or the next 90 s step after it that has not
      // come yet; once listed, to that round's own start.
      // ONE CLOCK (2026-09-29 21:58, SPECTATE-2158: the bar said 84 s while the row said "closes 0:54"): no invented
      // 90 s slot. Until the next round is listed the box says it is joining it, with no number; once listed, it counts to
      // that round's own start - the number its lobby row shows.
      const runOverAt = Date.now();
      const next = window.ARENA_NEXT = { state: 'looking', runOverAt, startMs: NaN };
      // LOOKED FOR UNTIL IT IS LISTED: a series lists round i+1 long before; a launcher that opens its next round later
      // (the Daily: about a minute before the current round's entry closes) lists it later - measured 65 s after a run.
      // Given up only when the player joins something else from the lobby, or after 10 minutes.
      const joinAtRunOver = window.ARENA_JOIN;
      const look = () => {
        if (window.ARENA_NEXT !== next || next.state !== 'looking' || window.ARENA_CONTINUE === false) return;
        if (window.ARENA_JOIN !== joinAtRunOver || Date.now() - next.runOverAt > 600000) { next.state = 'none'; return; }
        const r = ARENACLIENT.nextRoundAfter(played, window.ARENA_LOBBY_ROWS, Date.now());
        if (!r) { setTimeout(look, 1000); return; }
        // A NEXT PAID ROUND ONLY WITH ITS STAKE IN THE PLAYER WALLET (comment 592: measured on 0.0.2832, round
        // dcd6cbb6 - the page entered the next paid round with 73 sat for a 100 sat stake, its join waited on a deposit
        // nobody asked for, and the result card held the screen past 420 s). Nobody pressed PLAY on it, so no deposit is
        // asked: the card lets go at its hold and the lobby comes back, where PLAY asks it.
        const bal = window.ARENA_WALLET_BALANCE; const stakeSats = r.free ? 0 : ARENACLIENT.lobbyStakeSats(r);
        if (stakeSats > 0 && bal && Number.isFinite(Number(bal.sats)) && Number(bal.sats) < stakeSats) {
          next.state = 'none';
          console.log(`[arena] next round ${r.id.slice(0, 16)}: not entered - its stake is ${stakeSats} sat and the player wallet holds ${bal.sats} sat`);
          return;
        }
        Object.assign(next, { state: 'joining', round: r.id, startMs: Number(r.startTimeMs) });
        const act = window.ARENA_LOBBY_ACT;
        const took = act && act.join(r.id, { holdUntilMs: Number(r.startTimeMs), next: true });
        console.log(`[arena] next round ${r.id.slice(0, 16)}: ${took ? 'entering it now, joined at its start' : 'not joinable'} `
          + `(starts ${new Date(Number(r.startTimeMs)).toISOString()})`);
        if (!took) next.state = 'none';
      };
      look();
    }
    // "joining next round in N seconds" BESIDE "exit game", after the result card and until the next start - the words
    // and the timing are ARENACLIENT.nextRoundView's
    (function paintNext() {
      const box = document.getElementById('arena-next');
      const n = window.ARENA_NEXT; const j = window.ARENA_JOIN;
      let v = { show: 'lobby' };
      const waiting = n && window.ARENA_CONTINUE !== false && (n.state === 'looking'
        || (n.state === 'joining' && j && j.round === n.round && j.state === 'joining'));
      if (waiting) {
        v = ARENACLIENT.nextRoundView({ runOverMs: n.runOverAt, nextStartMs: n.startMs, nowMs: Date.now() });
        // not listed yet: the words without a number, beside exit game - never a number that is not the round's start
        if (n.state === 'looking' && v.show === 'lobby') v = { show: 'countdown', line: 'joining next round', exit: ARENACLIENT.EXIT_GAME };
        // AT ONCE, beside the ending Unity keeps up (COUNTDOWN-NOW-2209): no waiting for the card
      }
      if (n && n.state === 'joining' && Date.now() >= n.startMs) n.state = 'started';
      if (box) {
        box.style.display = v.show === 'countdown' ? 'flex' : 'none';
        if (v.show === 'countdown') {
          document.getElementById('arena-next-say').textContent = v.line;
          document.getElementById('arena-next-exit').textContent = v.exit;
          // AND BUY ADD-ONS while the countdown runs: Unity's add-ons panel, when this game sells something
          const ad = document.getElementById('arena-next-addons');
          if (ad) ad.style.display = window.ARENA_ADDONS_VIEW && window.ARENA_ADDONS_VIEW().shop && window.unityInstance ? '' : 'none';
        }
      }
      window.ARENA_NEXT_VIEW = v;
      setTimeout(paintNext, 250);
    })();
    // WHERE THE NEXT ROUND'S BOX STARTS: its top edge as a fraction of the game canvas from the canvas's top while
    // it is up, else 0 - Unity ends the result card, its fold control and a wreck's summary above it
    window.ARENA_NEXT_BOX_TOP = () => {
      const b = document.getElementById('arena-next'); const c = document.getElementById('canvas');
      if (!b || !c || b.style.display === 'none') return 0;
      const br = b.getBoundingClientRect(); const cr = c.getBoundingClientRect();
      if (!(cr.height > 0) || !(br.height > 0)) return 0;
      return Math.round(((br.top - cr.top) / cr.height) * 1000) / 1000;
    };
    // THE NEXT ROUND'S JOIN DROPPED (exit game, or: a continuing join that would need a deposit). A join still
    // being made, or held for its start, is dropped; a stake a paying round already locked refunds by the lock's own expiry
    // (§23.1) - nothing new is sent.
    function cancelNextJoin(state) {
      const n = window.ARENA_NEXT; const j = window.ARENA_JOIN;
      if (n) n.state = state;
      if (j && n && n.round && j.round === n.round && j.state === 'joining') {
        // "refused" with no reason: Unity, which took this join as its own, stops waiting and shows the plain lobby
        j.cancelled = true; j.state = 'refused'; j.why = ''; j.stage = ''; j.held = false;
        window.ARENA_ROUND = undefined; window.ARENA_ENTRY = undefined;
        history.replaceState(null, '', location.pathname + (typeof window.ARENA_LOBBY_BACK === 'string' ? window.ARENA_LOBBY_BACK : ''));
      }
    }
    // A DEPOSIT IS ASKED ONLY FOR A ROUND THE PLAYER PRESSED PLAY ON: the next round the page entered by
    // itself is dropped instead - Unity shows the lobby, and PLAY there asks the deposit.
    window.ARENA_ASK_JOIN_DEPOSIT = (offer, show) => {
      const j = window.ARENA_JOIN;
      if (j && j.next) {
        cancelNextJoin('none');
        console.log('[arena] next round: not entered - it needs a deposit into the player wallet, and nobody pressed PLAY on it');
        return Promise.reject(new Error('the next round needs a deposit; it is not entered'));
      }
      return show(offer);
    };
    document.getElementById('arena-next-donate').addEventListener('click', () => { if (window.ARENA_DONATE_OPEN) window.ARENA_DONATE_OPEN(window.ARENA_GAME_NAME || 'nextblock'); });
    document.getElementById('arena-next-addons').addEventListener('click', () => {
      try { window.unityInstance.SendMessage('Bootstrap', 'OpenAddons'); } catch (e) { console.error('[arena] add-ons: ' + e.message); }
    });
    document.getElementById('arena-next-exit').addEventListener('click', () => {
      // EXIT GAME: no next round. A join still being made, or held for its start, is dropped; a stake a paying round
      // already locked refunds by the lock's own expiry (§23.1) - nothing new is sent. PLAY from the lobby continues again.
      window.ARENA_CONTINUE = false;
      cancelNextJoin('exited');
      console.log('[arena] exit game: no next round');
      document.getElementById('arena-next').style.display = 'none';
    });

    // ---------------------------------------------------------------- the run's link to the signer nodes, said while it is driven
    // A RUN THAT DOES NOT REACH THE SIGNER NODES IS SAID WHILE IT IS DRIVEN (2026-10-02, playtest: his Firefox run
    // delivered on his screen, and the seats held its first 2067 ticks - 34 s - and nothing after: FAILED, no pending,
    // and nothing on the page had said so). Each second: the ticks the game handed over (`offered`) against the tick the
    // signer nodes are owed next (`nextTick`); more than 3 s apart, a red bar says how far behind and why (the session's
    // state and last error); a run that ends with ticks never sent says how much of it counts. Each change is logged, so
    // the client logs carry it.
    const TICK_HZ = 60;
    let linkSaid = '', linkLoggedAt = 0, linkEndedSaidFor = null, linkEndedUntil = 0, linkLive = null, linkLiveGoneAt = 0;
    const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    function watchTheLink() {
      const bar = document.getElementById('arena-link-warn');
      if (!bar) return;
      const M = window.unityInstance && window.unityInstance.Module;
      const n = M && (M.arenaRunNet || M.blwpRunNet || M.arenaNet || M.blwpNet);
      const c = n && n.client;
      let say = '';
      // THE RUN THAT ENDED, judged on the session that carried it: the page hands the next round a new session at once
      // (measured: the old one was replaced before its `ended` could be read), so the last live one is kept until it has
      // ended or been replaced, and then said if ticks of it never reached the signer nodes.
      // A REPLACED ONE IS GIVEN 15 s to finish its own last flush, unless it has ended already.
      if (c && typeof c.offered === 'number' && !c.ended && c.offered > 0 && linkLive !== c) { linkLive = c; linkLiveGoneAt = 0; }
      if (linkLive && linkLive !== c && !linkLiveGoneAt) linkLiveGoneAt = Date.now();
      // THE SESSION THE RUN IS ON - the live one, or the replaced one still finishing - and how far the nodes are behind it
      // (a live session is the run: ARENA_STARTED, which drivingNow reads, is set by nothing)
      const on = linkLive && !linkLive.ended ? linkLive : null;
      if (on && typeof on.nextTick === 'number') {
        const behindS = Math.max(0, on.offered - on.nextTick) / TICK_HZ;
        const why = [on.state, on.refusedWhy || on.error].filter(Boolean).join(': ');
        if (behindS > 3)
          say = `Your run is not reaching the signer nodes: the last ${Math.round(behindS)} s are not sent yet${why ? ' (' + why + ')' : ''}. Only what reaches them counts.`;
      }
      const done = linkLive && (linkLive.ended || (linkLiveGoneAt && Date.now() - linkLiveGoneAt > 15000)) ? linkLive : null;
      if (done) {
        linkLive = null; linkLiveGoneAt = 0;
        const unsentS = Math.max(0, done.offered - done.nextTick) / TICK_HZ;
        if (unsentS > 1 && linkEndedSaidFor !== done) {
          const why = [done.state, done.refusedWhy || done.error].filter(Boolean).join(': ');
          linkEndedSaidFor = done; linkEndedUntil = Date.now() + 30000;
          bar.dataset.ended = `The signer nodes got ${mmss(done.nextTick / TICK_HZ)} of your run; the last ${Math.round(unsentS)} s never reached them, so the run counts only up to there${why ? ' (' + why + ')' : ''}.`;
        }
      }
      if (!say && Date.now() < linkEndedUntil) say = bar.dataset.ended || '';
      // logged when it appears, when it changes kind, every 10 s while it stays, and when it clears - not every second
      const kind = !say ? '' : say === bar.dataset.ended ? 'ended' : 'behind';
      if (kind !== linkSaid || (kind && Date.now() - linkLoggedAt > 10000)) {
        if (say) console.warn('[arena] ' + say); else if (linkSaid) console.log('[arena] the run reaches the signer nodes again');
        linkSaid = kind; linkLoggedAt = Date.now();
      }
      bar.textContent = say;
      bar.style.display = say ? '' : 'none';
    }
    setInterval(watchTheLink, 1000);

    // ---------------------------------------------------------------- Unity's loader: the download, the GPU's textures, the instance
    const script = document.createElement('script');
    script.src = window.ARENA_UNITY_LOADER;   // 'Build/<the build's loader>', from index.html's template
    script.onerror = () => fail('The loader could not be loaded.');
    // UNITY STARTS LOADING AS SOON AS IT IS THE GAME (2026-10-16: "it takes too long to load a game, it's at 0%
    // for 10-15 seconds ... It's only showing connecting"). Measured on live UI 175, phone profile: the pick at 0 s, "0% ·
    // Connecting …" until 14.5 s - the loader was only fetched once the lobby's first read had heard from every seat, and the
    // federation B seats behind the tunnel answered /rounds in 10.4-13.1 s. The download now starts when the game is chosen and
    // runs beside the lobby's reads; once, whichever asks first.
    window.ARENA_START_UNITY = () => {
      if (window.ARENA_LOADER_AT) return;
      window.ARENA_LOADER_AT = Date.now();
      stage.textContent = 'Loading the program …';
      document.body.appendChild(script);
    };
    // THE TEXTURES THIS GPU HAS (measured 2026-10-08): the build's textures were DXT only, which most Android
    // GPUs and iPhones lack - Unity then decompressed 33 of them on the CPU, 20 before 100 %. A deploy may carry the same
    // build's ASTC data beside it (Build/<data>-astc..., StreamingAssets-astc/ with its catalog; the code files are byte-
    // identical): a GPU with ASTC and no S3TC (a phone) loads that. Anything else, or a deploy without it, loads DXT.
    function astcWanted() {
      try {
        const g = document.createElement('canvas').getContext('webgl2');
        if (!g) return false;
        const ex = g.getSupportedExtensions() || [];
        const lose = g.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
        return ex.includes('WEBGL_compressed_texture_astc') && !ex.some((e) => /s3tc/i.test(e));
      } catch (e) { return false; }
    }
    // textures.json is written by a deploy that carries the ASTC data ({ "astc": { "data": "Build/...", "streamingAssets":
    // "StreamingAssets-astc" } }). A host without it answers with the page itself (Pages' fallback - measured: a missing
    // Build/ file answered 200, application/octet-stream from _headers), which is not JSON: DXT.
    async function texturesForThisGpu() {
      if (!astcWanted()) { window.ARENA_TEXTURES = 'dxt'; return; }
      let t = null;
      try { t = await (await fetch('textures.json', { cache: 'no-store' })).json(); } catch (e) { t = null; }
      const a = t && t.astc;
      if (!a || typeof a.data !== 'string' || !/^Build\/[\w.-]+\.data\.unityweb$/.test(a.data) || !/^[\w-]+$/.test(String(a.streamingAssets || ''))) {
        window.ARENA_TEXTURES = 'dxt (no astc data here)'; return;
      }
      config.dataUrl = a.data;
      config.streamingAssetsUrl = a.streamingAssets;
      window.ARENA_TEXTURES = 'astc';
    }
    script.onload = async () => {
      await texturesForThisGpu();
      console.log('[arena] textures: ' + window.ARENA_TEXTURES);
      createUnityInstance(canvas, config, show)
        .then((instance) => {
          window.ARENA_UNITY_UP_AT = Date.now();
          window.unityInstance = instance;
          show(1);
          // the deposit box outlives the loading screen: a signer node taken later asks there
          const deposit = document.getElementById('arena-deposit');
          if (deposit) document.body.appendChild(deposit);
          boot.classList.add('done');
          setTimeout(() => boot.remove(), 600);
          canvas.focus();
        })
        .catch(fail);
    };

    // ---------------------------------------------------------------- the lobby as Unity draws it: the lobby (showTheLobbyIfOneWasNamed) hands it its own state at each read
    // THE LOBBY, AS UNITY DRAWS IT (2026-09-12 22:11-22:16): the title
    // screen is the lobby - no HTML over the game. What it shows is this, and
    // what it presses comes back here.
    function unityLobbyView({ me, lobbyNow, closedRounds, lobbyViewRow, refused, unanswered, askedNodes, failedNodes, named }) {
      return ({ mode: 'lobby', from: window.ARENA_LOBBY_FROM,
        you: me ? { name: me.name, custom: !!me.custom, generated: me.generated || '', fingerprint: me.fingerprint || '' }
          : { name: 'no identity', custom: false, generated: '', fingerprint: '' },
        // THE LINE IS MADE WHEN IT IS READ (2026-09-16 15:36: "lobby list should refresh every second"):
        // made at paint time, "closes in" stood still between paints and moved in paint-sized steps.
        // A ROUND WHOSE ENTRY HAS CLOSED IS NOT JOINABLE, whatever the last paint said (measured before: "closes 0:00" with PLAY
        // enabled for 237 s behind a silent signer node, and 11.7 s at every rollover) - lobbyViewRow says leftS 0 then.
        rows: lobbyNow().filter((r) => !closedRounds.has(r.id)).map((r) => lobbyViewRow(r, Date.now())),
        refused: refused.map(String), nodes: named.nodes.length,
        // THE SIGNER NODES THAT DID NOT ANSWER the last read within the limit, by address, for the lobby to say so on screen.
        // SILENT SEATS ARE SAID ONLY WHEN THEY STOP PLAY (2026-10-17 screenshot: "Signer nodes ... fed2-1 ... fed2-7 did not
        // answer in 10 s" in red over the PLAY line while the round said "5 agree (5 needed)"): with a round joinable, slow seats are
        // no error - the box is kept for when no listed round can be joined
        unanswered: ((window.ARENA_LOBBY || []).some((x) => x && x.joinable) ? [] : unanswered).map(String), answerS: Math.round((ARENACLIENT.SIGNER_ANSWER_MS || 10000) / 1000),
        // HOW MANY SEATS WERE ASKED, AND HOW MANY FAILED OUTRIGHT: none reached is not "no round open"
        asked: askedNodes, failed: failedNodes,
        // WHICH ROUND the join was for, by id and kind, so a refusal names the round rather than "the round"
        join: window.ARENA_JOIN ? { state: window.ARENA_JOIN.state, why: String(window.ARENA_JOIN.why || ''), stage: String(window.ARENA_JOIN.stage || ''),
          round: String(window.ARENA_JOIN.round || ''), kindKnown: !!window.ARENA_JOIN.kindKnown, free: !!window.ARENA_JOIN.free,
          stakeSats: Number(window.ARENA_JOIN.stakeSats) || 0, next: !!window.ARENA_JOIN.next }
          : { state: '', why: '', stage: '', round: '', kindKnown: false, free: false, stakeSats: 0 },
        // THE PAGE IS TAKING THE PLAYER TO THE NEXT ROUND (2026-09-29 21:58, SPECTATE-2158): from the run's end until
        // "exit game" or that round's start. Unity shows no lobby meanwhile - the result card, or WASTED, stays.
        continuing: (() => { const n = window.ARENA_NEXT;
          return !!n && window.ARENA_CONTINUE !== false && (n.state === 'looking' || n.state === 'joining'); })(),
        // AND WHERE ITS BOX STARTS, for the result card to end above it
        nextBoxTop: typeof window.ARENA_NEXT_BOX_TOP === 'function' ? window.ARENA_NEXT_BOX_TOP() : 0,
        // A WITHDRAWAL AVAILABLE (2026-09-14), for the lobby to say so.
        withdraw: withdrawAvailable(),
        // THE COLLECT'S LINES: another kept seed's records, a failed collect, an uncollectable record - the
        // page's words; Unity draws them under the round rows
        // AND THE TAB'S MARKET LINES after them: its picks, then their outcomes as this page checked them
        collect: ARENACLIENT.collectLines ? ARENACLIENT.collectLines(window.ARENA_RECORDS || [], { failed: window.ARENA_COLLECT_FAILED || new Map(), held: window.ARENA_COLLECT_HELD || new Set() }).concat(marketViewLines(true)) : marketViewLines(true) });
    }

    // ---------------------------------------------------------------- the run's line in the console: the two nodes' health, the play socket, the players
    const nodeHealth = {};
    // A NODE'S NAME ON THE STRIP IS ITS PLACE IN THIS PAGE'S NODE LIST - A, B, then 3, 4 ... (2026-09-26 14:02:
    // "A ...", "B ...", "silly-rocket-..." - do not cut a name with three dots). It was read off a /blwp-a path, which a
    // quick tunnel's name never has, so both nodes read "..." for as long as the page ran.
    const nodeLetter = (i) => (i === 0 ? 'A' : i === 1 ? 'B' : String(i + 1));
    const pageNodes = () => (new URLSearchParams(location.search).get('node') || '').split(',').map((s) => s.trim()).filter(Boolean);
    // ONLY THE TWO THE STRIP SHOWS, EVERY 30 S, ONE PROBE AT A TIME (2026-10-16: "Lower the amount of concurrent
    // connections and network load"; measured on preview UI 156 during one run: 1036 of 1050 GET /identity came from here -
    // every node= of the page's address, 14 seats in a round, every 2 s, for a line that names A and B only)
    async function probeNodes() {
      if (probeNodes.busy) return;
      probeNodes.busy = true;
      const nodes = (new URLSearchParams(location.search).get('node') || '')
        .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2);
      try { await Promise.all(nodes.map(async (u, i) => {
        const name = nodeLetter(i);
        try {
          const r = await fetch(u.replace(/\/+$/, '') + '/identity');
          nodeHealth[name] = r.ok ? 'ok' : 'http ' + r.status;
        } catch (e) {
          nodeHealth[name] = 'down';
        }
      })); } finally { probeNodes.busy = false; }
    }
    function playLine(net) {
      if (!net) return 'play · not started';
      if (net.error) return 'play · ' + net.error;
      const c = net.client;
      if (!c) return 'play · ' + (net.state || 'opening');
      const where = c.base || '';
      // A NODE LETTER, or a short host - never the whole tunnel URL (13:05: it was 46 characters of it across
      // the price). The letter is what a reader needs; the host, cut to its first label and 14 characters, is
      // enough to tell two tunnels apart.
      // the node's letter from this page's list; a host not in it by its whole first label, never cut
      const hostOf = (u) => { try { return new URL(u).host + new URL(u).pathname.replace(/\/+$/, ''); } catch (e) { return String(u || ''); } };
      const at = pageNodes().findIndex((n) => hostOf(n) === hostOf(String(where).replace(/^ws/, 'http')));
      const which = at >= 0 ? nodeLetter(at) : (() => { try { return new URL(where).hostname.split('.')[0]; } catch (e) { return String(where || 'node'); } })();
      const sock = c.sock && c.sock.readyState === 1 ? 'up' : (c.state || 'no socket');
      return 'play · ' + which + ' ' + sock;
    }
    function paintPlayers() {
      const el = document.getElementById('arena-players');
      if (!el) return;
      if (window.ARENA_CARD_UP && window.ARENA_UNITY_LOBBY && window.ARENA_UNITY_LOBBY.showing) window.ARENA_CARD_UP = false;
      // hidden while the cargo panel is open (2026-09-26 14:02) - the pads and TRUCK FULL stay; this line does not
      if (!window.ARENA_ROUND || window.ARENA_CARD_UP || window.ARENA_LOADOUT_OPEN) { el.style.display = 'none'; consoleHas('players', false); return; }
      consoleHas('players', true);
      el.style.display = consoleOpen() ? 'block' : 'none';
      const inst = window.unityInstance;
      const mod = (inst && inst.Module) || (typeof Module !== 'undefined' ? Module : window.Module);
      const net = mod && (mod.arenaNet || mod.blwpNet);
      const joined = !!(window.ARENA_ENTRY);
      const others = (net && net.ghosts && typeof net.ghosts.others === 'number') ? net.ghosts.others : 0;
      // WHETHER ANYBODY IS DRAWING THEM. A field filling with pictures nobody
      // takes reads the same as an empty round unless the line says so.
      const stalled = !!(net && net.ghosts && net.ghosts.stalled);
      // AND WHERE THE NEWEST OF THEM IS. Each player parks at their own bay -
      // 24 doors, 6.8 m apart - so two tabs start up to 156 m apart on one
      // apron, and a truck drawn correctly at the far end is off screen. Read
      // this against the other tab's own position readout: the same numbers
      // mean the picture is right and the camera is pointed elsewhere.
      const at = (typeof ARENACLIENT !== 'undefined' && ARENACLIENT.newestPose && net)
        ? ARENACLIENT.newestPose(net.ghosts) : null;
      const ab = ['A', 'B'].map((n) => n + ' ' + (nodeHealth[n] || 'checking')).join(' · ');
      // AND WHETHER THIS TAB'S OWN INPUTS ARE LANDING. A tab whose batches the
      // node refuses keeps its socket, its player count and its driving, and
      // loses only every watcher's picture of it - frozen at the last tick that
      // landed. It is the one fault none of the numbers above can show.
      const refused = (net && net.client && net.client.refusedWhy) || null;
      // WHY THERE IS NO SIGNER NODE, AND WHAT THE SIGNER NODE COST. Both went to the console
      // only, so a refused signer node read exactly like a round nobody was sent to
      // and a free round read exactly like a funded one. The hold state is the
      // NODE's word, kept by `Client.join` from the answer it already gives.
      const joinRefused = window.ARENA_JOIN_REFUSED || null;
      // THE COUNT RUNS FROM THE SIGNER NODE, not only from this page's own payment: a
      // payment that lands after payStake gave up would otherwise never be
      // counted. Started once; stopped at N >= T, at the run's end, or on close.
      const c = net && net.client;
      // AND THE DONATION, ONCE THE SIGNER NODES HOLD THE STAKE (M3.2 6e, §24A.2, §22A):
      // measured before, it went as soon as the signer nodes took the entry - before
      // "Pay the stake" - so a joined player who never paid the stake donated.
      // `c.stakeCommitted` is the signer nodes' count; the Client refuses before it too.
      // the player's wallet pays each recipient of the checked set its share,
      // through the player's own Client (\`payDonation\`) - an entry and a set,
      // never an invoice. A failed
      // share is reported and not redirected; the entry stands either way. It
      // waits for a connected wallet, and runs once per page - and ONCE PER
      // PLAYER PER ROUND ACROSS A RELOAD: handed the tab's sessionStorage, the
      // Client notes each share before its wallet is asked and never asks a
      // noted one again, so a reload over a kept lock reports and sends nothing.
      // A LOOPBACK RECIPIENT GOES OVER ITS LISTED ROUTE (2026-10-03, option A): the paid rounds of 10-02..10-04 name
      // testnet4's test donation set, http://127.0.0.1:18777/lnurlp/blwp-test-a and -b - a player's browser reached nothing
      // there, every share was UNPAID and nothing was deducted. daily.json's testnet.alt names a route for 127.0.0.1:18777
      // (the testnet4 donation service, the same two recipients); only a loopback recipient that has one is sent there.
      const donationFetch = (u) => {
        try {
          const x = new URL(String(u)), alt = (window.ARENA_ALT_ROUTES || {})[x.host];
          if (alt && (x.hostname === '127.0.0.1' || x.hostname === 'localhost')) return fetch('https://' + alt + x.pathname + x.search);
        } catch { /* as named */ }
        return fetch(u);
      };
      if (c && c.joinedEntry && window.ARENA_DONATION_SET && typeof c.joinedEntry.donationMsat === 'bigint'
          && c.joinedEntry.donationMsat > 0n && c.stakeCommitted === true && !donationPaying && (wallet || window.ARENA_PLAYER_PAYER)) {
        const heldWallet = wallet ? wallet.current() : { ok: false };
        // NO OUTSIDE WALLET CONNECTED: the player wallet pays it (2026-10-01: "donation is paid by the player as well")
        if (!heldWallet.ok && window.ARENA_PLAYER_PAYER) {
          donationPaying = true;
          window.ARENA_DONATION_PAID = { state: 'paying' };
          c.payDonation(c.joinedEntry, window.ARENA_DONATION_SET, {
            round: window.ARENA_ROUND, payWith: window.ARENA_PLAYER_PAYER, log: spent, storage: window.sessionStorage, fetcher: donationFetch,
          }).then((said) => {
            window.ARENA_DONATION_PAID = ARENACLIENT.donationPaidState(window.ARENA_DONATION_SET, said);
            paintWallet(); paintHistory(); if (window.ARENA_READ_BALANCE) window.ARENA_READ_BALANCE();
          }).catch((e) => { window.ARENA_DONATION_PAID = { state: 'error', why: e.message }; paintWallet(); });
        } else if (heldWallet.ok) {
          donationPaying = true;
          window.ARENA_DONATION_PAID = { state: 'paying' };
          c.payDonation(c.joinedEntry, window.ARENA_DONATION_SET, {
            round: window.ARENA_ROUND, connection: heldWallet, curve: window.ARENA_CURVE, log: spent, storage: window.sessionStorage,
            random: (n) => crypto.getRandomValues(new Uint8Array(n)), fetcher: donationFetch,
          }).then((said) => {
            window.ARENA_DONATION_PAID = ARENACLIENT.donationPaidState(window.ARENA_DONATION_SET, said);
            paintWallet();
          }).catch((e) => { window.ARENA_DONATION_PAID = { state: 'error', why: e.message }; paintWallet(); });
        }
      }
      if (c && c.watchStake && c.joinedEntry && window.ARENA_STAKE && window.ARENA_STAKE.signerNodeKeys
          && !c.stakeWatch && !c.stakeCommitted && !c.ended && !c.stakeWatchStopped) {
        net.client.watchStake({
          signerNodes: window.ARENA_STAKE.signerNodeKeys, nodes: window.ARENA_STAKE.nodes, contract: window.ARENA_ROUND,
        }).catch((e) => console.error('[arena] stake count: ' + e.message));
      }
      const stake = window.ARENA_STAKE
        ? Object.assign({}, window.ARENA_STAKE, {
          seen: (net && net.client && net.client.stakeCount) || null,
        })
        : null;
      const who = (typeof ARENACLIENT !== 'undefined' && ARENACLIENT.playersLine)
        ? ARENACLIENT.playersLine({ joined, others, stalled, at, refused, joinRefused, stake, names: window.ARENA_OTHER_NAMES || [] })
        : (joined ? (others ? (1 + others) + ' players in this round' : '1 player · waiting') : 'round named · not joined');
      el.textContent = ab + '\n' + playLine(net) + '\n' + who;
    }
    // WHO THE OTHER PLAYERS ARE (M3.3-34): this tab hands the round's signer nodes its
    // name, signed with the round key it is joined under, and asks them for the
    // others' - every record checked against its player's key before its name
    // is drawn. A signer node that has not joined this player yet refuses it (409), so
    // it is handed again until every signer node has kept it. The name decides nothing.
    // Each ask is given 8 s, and one exchange runs at a time: a signer node that does
    // not answer must not hold the others' names back. When no signer node answers,
    // `namesOf` says so and the names already drawn stay drawn.
    const namesKept = new Set();
    let namesBusy = false;
    const namesFetch = (u, o) => fetch(u, Object.assign({}, o, { signal: AbortSignal.timeout(8000) }));
    async function exchangeNames() {
      if (namesBusy || typeof ARENACLIENT === 'undefined' || !ARENACLIENT.namesOf) return;
      if (!window.ARENA_ROUND || !window.ARENA_ENTRY || !window.ARENA_CURVE) return;
      namesBusy = true;
      const said = { posted: [], error: null };
      try {
        const nodes = window.ARENA_NODES || [];
        const left = nodes.filter((n) => !namesKept.has(n));
        if (left.length) {
          try {
            const signed = ARENACLIENT.nameRecordFor(window.ARENA_ROUND, { storage: window.sessionStorage,
              random: (n) => crypto.getRandomValues(new Uint8Array(n)), curve: window.ARENA_CURVE });
            for (const s of await ARENACLIENT.postName(signed, left, { fetcher: namesFetch })) {
              said.posted.push(s.node + ' ' + s.status);
              if (s.status === 201 || s.status === 200) namesKept.add(s.node);
            }
          } catch (e) { said.error = 'name: ' + e.message; console.error('[arena] name: ' + e.message); }
        }
        try {
          const mine = window.ARENA_ENTRY.playerPubkey ? ARENACLIENT.toHex(window.ARENA_ENTRY.playerPubkey) : null;
          const all = await ARENACLIENT.namesOf({ roundId: ARENACLIENT.roundId(window.ARENA_ROUND), nodes, fetcher: namesFetch,
            verify: (s, m, k) => !!window.ARENA_CURVE.verify(s, m, k) });
          window.ARENA_OTHER_NAMES = all.filter((x) => x.player !== mine).map((x) => x.name);
          // AND WHOSE NAME IS WHOSE, for the debug label over each ghost (2026-09-17 19:15).
          window.ARENA_NAMES_BY_PLAYER = Object.fromEntries(all.map((x) => [x.player, x.name]));
        } catch (e) { said.error = 'names: ' + e.message; console.error('[arena] names: ' + e.message); }
      } finally {
        // WHAT THE LAST EXCHANGE DID, for a harness or a player's console.
        window.ARENA_NAMES_SAID = { posted: said.posted, kept: [...namesKept], shown: window.ARENA_OTHER_NAMES || [],
          error: said.error, atMs: Date.now() };
        namesBusy = false;
      }
    }
    setInterval(exchangeNames, 3000);
    setInterval(paintPlayers, 500);
    probeNodes();
    setInterval(probeNodes, 30000);
    // the first paint of the line once the page's own script is in (it asks the console, consoleHas, which that script declares)
    document.addEventListener('DOMContentLoaded', () => paintPlayers());

    // ---------------------------------------------------------------- the add-ons panel Unity draws
    // ADD-ONS INSIDE UNITY (2026-10-16: "The buy feature must also be inside unity on the loading screen as 'buy
    // addons' where you load the packages, and when the round has closed and the countdown is showing there is also the option to buy
    // items. There is a visual confirmation in unity when the game is active and an item has been purchased."). Unity draws the panel
    // from ARENA_ADDONS_VIEW and buys through ARENA_ADDONS_BUY - the same purchase as the shop sheet (buyShopItem). A purchase counts
    // from the next entry this page builds: an entry already made (the run going, or the next round's join held to its start) keeps
    // what it named, since every node replays the run from it - `from` says which.
    const addons = { owned: null, ownedFor: '', busy: '', said: '', bad: false, seq: 0, bought: null };
    const addonsShop = () => { const chosen = window.ARENA_GAME_CHOSEN; return chosen && ARENACLIENT.shopOf ? ARENACLIENT.shopOf(window.ARENA_GAMES_FULL || [], chosen.name) : null; };
    // 'after-next' when the round this page is joining - not started yet - already has its entry, else 'next': the next entry it builds
    window.ARENA_ADDONS_FROM = (join, entryRound) => (join && join.state === 'joining' && join.round && entryRound === join.round ? 'after-next' : 'next');
    async function addonsRead() {
      const shop = addonsShop(); if (!shop) return;
      try { addons.owned = await itemsOwnedNow(shop.game.name, shop.game.nodes || [], { fresh: true }); addons.ownedFor = shop.game.name; if (!addons.busy) { addons.said = ''; addons.bad = false; } }
      catch (e) { addons.said = 'What you own could not be read: ' + e.message; addons.bad = true; }
    }
    window.ARENA_ADDONS_OPEN = () => { addonsRead(); return 1; };
    window.ARENA_ADDONS_VIEW = () => {
      const shop = addonsShop();
      if (!shop) return { shop: false };
      const use = itemsUse(shop.game.name);
      const owned = addons.ownedFor === shop.game.name ? (addons.owned || []) : [];
      return { shop: true, game: shop.game.name, read: addons.owned !== null, busy: addons.busy, said: addons.said, bad: addons.bad, seq: addons.seq,
        bought: addons.bought, devsPct: window.ARENA_ITEMS_SHARE(), items: shop.items.map((it) => ({ id: it.id, name: it.name, what: ITEM_WHAT[it.id] || '', priceSat: Number(window.ARENA_ITEM_PRICE(it.priceSat)), listSat: Number(it.priceSat),
          owned: owned.some((o) => o.itemId === it.id), use: !use || use.includes(it.id) })) };
    };
    window.ARENA_ADDONS_BUY = (itemId) => {
      const shop = addonsShop(); const it = shop && shop.items.find((x) => x.id === itemId);
      if (!it || addons.busy) return 0;
      addons.busy = itemId; addons.said = 'Paying ' + String(window.ARENA_ITEM_PRICE(it.priceSat)) + ' sat …'; addons.bad = false;
      (async () => {
        const got = await buyShopItem(shop, it).catch((e) => ({ ok: false, step: 'page', why: e.message }));
        if (got.ok) {
          const from = window.ARENA_ADDONS_FROM(window.ARENA_JOIN, window.ARENA_ENTRY_ROUND);
          addons.seq += 1; addons.bought = { seq: addons.seq, id: it.id, name: it.name, txid: String(got.txid || ''), from };
          addons.said = it.name + ' is yours (transaction ' + String(got.txid).slice(0, 12) + '…).'; addons.bad = false;
          console.log('[arena] add-on bought in Unity: ' + it.id + ', tx ' + String(got.txid).slice(0, 16) + ', plays from ' + from);
          await addonsRead();
          if (window.ARENA_READ_BALANCE) window.ARENA_READ_BALANCE().catch(() => {});
        } else { addons.said = 'Not bought (' + got.step + '): ' + got.why; addons.bad = true; }
        addons.busy = '';
      })();
      return 1;
    };
    window.ARENA_ADDONS_USE = (itemId, on) => {
      const shop = addonsShop(); if (!shop) return 0;
      const now = new Set(itemsUse(shop.game.name) || (addons.owned || []).map((x) => x.itemId));
      if (on) now.add(itemId); else now.delete(itemId);
      setItemsUse(shop.game.name, [...now]); return 1;
    };
