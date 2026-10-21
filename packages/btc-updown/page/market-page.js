// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// UP/DOWN'S PART OF THE ARENA PAGE (kanban #521: every game whole under its plugin): the markets' page code - the pick the sheet chose,
// the tab's picks and hidden moves, the market outcomes read from the seats, the orders restored from them, the lobby's market lines and
// the pick sheet itself. It was lines of the page's main script; the page loads it as a classic script just before that script, so its
// top-level names are the page's names exactly as before (it uses none of the main script's own). Its markup, the pick sheet, is put
// where it stood (after #arena-lobby); its CSS is market-page.css beside this file.
document.getElementById('arena-lobby').insertAdjacentHTML('afterend', '<div id="arena-pick" role="dialog" aria-modal="true" aria-label="pick an outcome"><div class="sheet"></div></div>');
    // ---------------------------------------------------------------- markets (§0A.7a)
    // THE PICK THE SHEET CHOSE, read by the join it starts: { round, pick, gameId, confirmed, manifestHex }
    window.ARENA_PICK_CHOSEN = null;
    function pickFor(roundIdHex) { const c = window.ARENA_PICK_CHOSEN; return c && c.round === roundIdHex ? c : null; }
    // an unpinned market the player confirmed a second time on the sheet (§0A.6): only that game, only for that join
    function confirmedMarkets() { const c = window.ARENA_PICK_CHOSEN; return c && c.confirmed ? new Set([c.gameId]) : null; }
    // A HEAD-TO-HEAD MOVE: the move a head-to-head game's client chose, read by the join it starts: { round, move }
    window.ARENA_HIDDEN_CHOSEN = null;
    function hiddenFor(roundIdHex) { const c = window.ARENA_HIDDEN_CHOSEN; return c && c.round === roundIdHex ? c : null; }
    // THE TAB'S HIDDEN MOVES, kept with the tab's seed (sessionStorage): the move and its salt until they are revealed - a
    // reload between entry and reveal must not lose the salt, or the move could never be shown and the entry forfeits
    const HIDDEN_KEY = 'arena.h2h.moves';
    function readHidden() { try { return JSON.parse(window.sessionStorage.getItem(HIDDEN_KEY) || '[]'); } catch { return []; } }
    function rememberHidden(h) {
      try { const all = readHidden().filter((x) => x.roundIdHex !== h.roundIdHex); all.push(h); window.sessionStorage.setItem(HIDDEN_KEY, JSON.stringify(all.slice(-50))); }
      catch { /* kept for this page only */ }
    }
    window.ARENA_HIDDEN_MOVES = readHidden;
    // THE TAB'S PICKS, kept with the tab's seed (sessionStorage): what the lobby's market lines are made of
    const PICKS_KEY = 'arena.market.picks';
    function readPicks() { try { return JSON.parse(window.sessionStorage.getItem(PICKS_KEY) || '[]'); } catch { return []; } }
    function rememberPick(p) {
      try {
        const c = window.ARENA_PICK_CHOSEN;
        const all = readPicks().filter((x) => (p.order ? x.entryIdHex !== p.entryIdHex : x.roundIdHex !== p.roundIdHex));
        all.push(Object.assign({}, p, c && c.manifestHex ? { manifestHex: c.manifestHex } : {}));
        window.sessionStorage.setItem(PICKS_KEY, JSON.stringify(all.slice(-50)));
      } catch { /* kept for this page only */ }
    }
    // a pick's market: the one this page pins, or the manifest the player confirmed (kept with the pick)
    function marketOfPick(p) {
      // its round as the pick kept it: a template's round asks its own question and a scalar template's names its bounds
      const round = ARENACLIENT.roundOfPick ? ARENACLIENT.roundOfPick(p) : { gameId: ARENACLIENT.fromHex(p.gameId) };
      return ARENACLIENT.marketForRound(round, p.manifestHex ? { manifestBytes: ARENACLIENT.fromHex(p.manifestHex) } : {});
    }
    // THE OUTCOMES OF THE TAB'S PICKS, read from the seats every 10 s once a pick's entries have closed, each checked by this
    // page against the attestors it pinned (ARENACLIENT.checkAttestation) - a seat's word alone is shown unverified
    const MARKET_OUTCOMES = new Map();
    window.ARENA_MARKET_OUTCOMES = MARKET_OUTCOMES;
    // THE ROUNDS WHOSE OUTCOME THIS PAGE HAS ASKED THE SEATS FOR AT LEAST ONCE
    const OUTCOMES_READ = new Set();
    async function readMarketOutcomes() {
      for (const p of readPicks()) {
        if (Date.now() < Number(p.entryCloseMs)) continue;
        const had = MARKET_OUTCOMES.get(p.roundIdHex);
        // THE PICK'S ROW IN THE TABLE (measured live 18:05Z: a seat outside the round's committee answers ATTESTED with
        // an empty table marked refunded - and the first answer was kept, so a won and a lost order both read "your pick is not in
        // the signer nodes' table" and stayed "waiting for the result"): every seat asked at once, the answer holding this pick's
        // entry kept, else the fullest; a final, verified answer is kept for good only once it holds the row
        const hasRow = (o) => !!(o && o.table && Array.isArray(o.table.rows) && o.table.rows.some((x) => x.entryId === p.entryIdHex));
        if (had && had.state === 'ATTESTED' && had.final && had.check && had.check.verified && (hasRow(had) || !p.entryIdHex)) continue;
        const market = marketOfPick(p);
        // a market this page cannot read is asked no more - and its orders are not kept out of sight for it (quietOrders)
        if (!market) { OUTCOMES_READ.add(p.roundIdHex); continue; }
        const answers = (await Promise.all((p.nodes || []).map((n) => fetch(String(n).replace(/\/+$/, '') + '/outcome?round=' + p.roundIdHex, { cache: 'no-store', signal: AbortSignal.timeout(6000) })
          .then((r) => (r.ok ? r.json() : null)).catch(() => null)))).filter(Boolean);
        OUTCOMES_READ.add(p.roundIdHex);
        const rowsOf = (o) => (o && o.table && Array.isArray(o.table.rows) ? o.table.rows.length : -1);
        const best = answers.find(hasRow) || answers.sort((a, b) => rowsOf(b) - rowsOf(a))[0];
        // NO ROW ANYWHERE, ITS ROUND CLOSED: an order that matched nobody has no row - the table holds filled positions
        // only. Its position read from the round's book: 0 shares and 0 cost is an order that matched nobody, its stake back whole
        if (best && best.state === 'ATTESTED' && !hasRow(best) && p.entryIdHex && !p.unfilled && Date.now() > Number(p.entryCloseMs) + 5000) {
          const books = (await Promise.all((p.nodes || []).map((n) => fetch(String(n).replace(/\/+$/, '') + '/book?round=' + p.roundIdHex, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
            .then((r) => (r.ok ? r.json() : null)).catch(() => null)))).filter(Boolean);
          const pos = books.map((b) => (b.positions || []).find((x) => x.entry === p.entryIdHex)).find(Boolean);
          if (pos && (pos.shares || []).every((x) => String(x) === '0') && String(pos.cost || '0') === '0') rememberPick(Object.assign({}, p, { unfilled: true }));
        }
        for (const o of best ? [best] : []) {
          try {
            // EVERY KIND CHECKED HERE: an outcome attestation, a scalar market's value attestation, or a market on a
            // game's source result - whose committee this page derives from the chain itself (clientCommittee), never the seats' list
            if (o.attestation || o.gameOutcome) o.check = ARENACLIENT.checkMarketOutcome ? await ARENACLIENT.checkMarketOutcome({ outcome: o, market,
              roundIdHex: p.roundIdHex, sourceRoundIdHex: p.sourceRoundIdHex || null, entryCloseMs: p.entryCloseMs,
              verifySchnorr: (sig, msg, key) => window.ARENA_CURVE.verify(sig, msg, key),
              // a series source round (Tick Tock's): its series' template from the seats, believed once it hashes to the series id
              sourceSeries: (sid) => ARENACLIENT.fetchSeriesTemplate({ seriesIdHex: sid, nodes: p.nodes || [], fetcher: (u, o) => fetch(u, o),
                timeout: (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined) }),
              sourceCommittee: async (sourceHex, source) => {
                const got = await ARENACLIENT.clientCommittee(sourceHex, source, p.nodes || [], { curve: window.ARENA_CURVE, compare: false, roles: ['settlement'] });
                return got && got.ok ? got.committees.settlement.map((k) => ARENACLIENT.toHex(k)) : null;
              } }) : (o.attestation ? await ARENACLIENT.checkAttestation({ attestationHex: o.attestation, market, roundIdHex: p.roundIdHex }) : undefined);
            MARKET_OUTCOMES.set(p.roundIdHex, o);
            break;
          } catch { /* the next seat */ }
        }
      }
    }
    setInterval(() => { readMarketOutcomes().catch((e) => console.warn('[arena] market outcomes: ' + e.message)); }, 10000);
    // THE FIRST READ AT ONCE, not 10 s after load: the orders closed before the load wait out of sight for it (quietOrders)
    const PAGE_LOADED_MS = Date.now();
    setTimeout(() => { readMarketOutcomes().catch((e) => console.warn('[arena] market outcomes: ' + e.message)); }, 300);
    // MY ORDERS FROM THE SEATS (2026-10-17: "When I reload the page my open orders are gone and still no closed
    // orders"; "Have the open orders from the nodes not from local storage"): the tab's picks live in sessionStorage, which a reload,
    // a new tab or another device does not have. Every 15 s, in a market game, each paid round of it the lobby lists is read from its
    // own signer seats (its book's positions and resting buys); every entry not looked at yet is fetched (GET /entry) and kept when its
    // player key is one this wallet makes for that round (playerFor, order 0..7) - it is a pick of this wallet again, as the order
    // made it, so its result, My orders and the past orders follow. Its cancel key is not on the seats: a restored order is not
    // cancelled from here. The next order in that round takes the next key.
    const ORDER_KEYS = 8;
    const ENTRIES_SEEN = new Set();
    // THE ROUNDS THAT TOOK ORDERS LATELY, from the seats (GET /market-rounds, the last 24 h): asked once a minute, each round's
    // contract fetched once by its id (fetchRound: it hashes to the id) - an order of this wallet in a round that closed while no tab
    // of it was open is read back from there
    const MARKET_ROUNDS = new Map();   // id -> contract, or null when it could not be read
    let marketRoundsAt = 0;
    async function recentMarketRounds(nodes) {
      if (Date.now() - marketRoundsAt < 60000) return;
      marketRoundsAt = Date.now();
      const since = Date.now() - 24 * 3600 * 1000;
      const said = await Promise.all(nodes.map((n) => fetch(String(n).replace(/\/+$/, '') + '/market-rounds?since=' + since, { cache: 'no-store', signal: AbortSignal.timeout(6000) })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)));
      const ids = new Set(said.flatMap((x) => (x && Array.isArray(x.rounds) ? x.rounds.map((r) => String(r.round)) : [])).filter((id) => /^[0-9a-f]{64}$/.test(id)));
      for (const id of ids) {
        if (MARKET_ROUNDS.has(id)) continue;
        try { MARKET_ROUNDS.set(id, (await ARENACLIENT.fetchRound(id, nodes)).contract || null); } catch { MARKET_ROUNDS.set(id, null); }
      }
    }
    window.ARENA_RESTORED_ORDERS = [];
    async function restoreOrdersFromSeats() {
      const G = window.ARENA_GAME;
      if (!G || !G.market || !ARENACLIENT.myOrdersFromEntries || !window.ARENA_CURVE) return;
      let seed = null;
      try { if (window.sessionStorage.getItem('arena.player.seed')) seed = ARENACLIENT.tabSeed({ storage: window.sessionStorage, random: (n) => crypto.getRandomValues(new Uint8Array(n)) }); } catch { seed = null; }
      if (!seed) return;                                  // no wallet in this tab yet: nothing is minted for this
      const known = new Set(readPicks().map((x) => x.entryIdHex));
      // the rounds the lobby lists, and those just closed that the seats still list (an order there has its result to show)
      const listed = [...(window.ARENA_LOBBY_ROWS || []), ...(window.ARENA_LOBBY_CLOSED || []).map((c) => ({ id: c.id, contract: c.contract, free: false }))];
      // the seats of this game's side (those of a round of it listed now), and the rounds that took orders on them lately
      const sideRow = listed.find((r) => r && r.contract && ARENACLIENT.toHex(r.contract.gameId) === String(G.game.id));
      const sideNodes = sideRow && window.ARENA_ROW_NODES ? window.ARENA_ROW_NODES(sideRow.id) : [];
      if (sideNodes.length) {
        try { await recentMarketRounds(sideNodes); } catch { /* the next minute */ }
        const have = new Set(listed.map((r) => r && r.id));
        for (const [id, contract] of MARKET_ROUNDS) if (contract && !have.has(id)) listed.push({ id, contract, free: false, nodes: sideNodes });
      }
      const rows = listed.filter((r) => r && !r.free && r.contract && ARENACLIENT.roundPays && ARENACLIENT.roundPays(r.contract) !== false
        && ARENACLIENT.marketForRound && ARENACLIENT.marketForRound(r.contract) && ARENACLIENT.toHex(r.contract.gameId) === String(G.game.id));
      // THE ROUNDS SIDE BY SIDE, THEIR ENTRIES TOO (measured live 2026-10-17 ~21:10Z, UI 210: a wallet's 14 orders in 9
      // rounds appeared 15-35 s after the page loaded - every round's book, then every entry in it, each player's, was read after the
      // one before, each from the first seat that answered): every round at once, and a round's entries at once, each asked first of a
      // different seat of the round's
      await Promise.all(rows.map(async (r) => {
        const round = Object.assign({}, r.contract, { id: ARENACLIENT.fromHex(r.id) });
        const keys = new Map();
        for (let i = 0; i < ORDER_KEYS; i++) { try { keys.set(ARENACLIENT.toHex(ARENACLIENT.playerFor(round, { seed, curve: window.ARENA_CURVE, order: i }).pubkey), i); } catch { /* no key */ } }
        let book = null;
        if (r.nodes) {   // a round from the seats' recent list: its book from those seats, the fullest answer
          const got = (await Promise.all(r.nodes.map((n) => fetch(String(n).replace(/\/+$/, '') + '/book?round=' + r.id, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
            .then((x) => (x.ok ? x.json() : null)).catch(() => null)))).filter(Boolean);
          const size = (b) => (b.batches || []).length + (b.positions || []).length;
          book = got.length ? got.reduce((a, b) => (size(b) > size(a) ? b : a)) : null;
        } else { try { book = await G.market.book(r.id); } catch { book = null; } }
        if (!book) return;
        const ids = [...new Set([...(book.positions || []).map((x) => x.entry), ...((book.resting && book.resting.buys) || [])])]
          .filter((id) => id && !known.has(id) && !ENTRIES_SEEN.has(r.id + id));
        if (!ids.length) return;
        const nodes = r.nodes || (window.ARENA_ROW_NODES ? window.ARENA_ROW_NODES(r.id) : []);
        const entries = [];
        await Promise.all(ids.map(async (id, k) => {
          for (let j = 0; j < nodes.length; j++) {
            const n = nodes[(k + j) % nodes.length];
            try { const res = await fetch(String(n).replace(/\/+$/, '') + '/entry?id=' + id, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
              if (res.ok) { entries.push({ idHex: id, bytes: new Uint8Array(await res.arrayBuffer()) }); break; } } catch { /* the next seat */ }
          }
          ENTRIES_SEEN.add(r.id + id);
        }));
        const mine = ARENACLIENT.myOrdersFromEntries({ entries, keys });
        for (const m of mine) {
          rememberPick(Object.assign(ARENACLIENT.pickRecord({ roundIdHex: r.id, entryIdHex: m.entryIdHex, pick: m.pick, round, nodes, confirmed: false }),
            { stakeMsat: m.stakeMsat, order: { limitPrice: m.limitPrice, orderExpiryMs: m.orderExpiryMs, sessionKeyPkcs8: null, placedMs: Date.now(), index: m.orderIndex, restored: true } }));
          window.ARENA_RESTORED_ORDERS.push({ round: r.id, entry: m.entryIdHex, pick: m.pick, index: m.orderIndex });
          try { const k = 'arena.order.next.' + r.id; if ((Number(window.sessionStorage.getItem(k)) || 0) <= m.orderIndex) window.sessionStorage.setItem(k, String(m.orderIndex + 1)); } catch { /* this tab's only */ }
        }
        if (mine.length) { console.log('[arena] restored ' + mine.length + ' order(s) of round ' + r.id.slice(0, 16) + ' from its seats'); readMarketOutcomes().catch(() => {}); }
      }));
    }
    // EVERY ORDER NAMED UNDER THE PLAYER (2026-10-17: "The leaderboard is still empty" - measured: each order of a
    // market joins under its own round key and was named under nobody, so the season listed every order as a stranger and the
    // player under none): each order of this wallet - placed here or read back from the seats - gets the signed name record of its
    // own key (nameRecordFor with its order number) at its round's seats, once a seat keeps it
    async function nameOrders() {
      if (!window.ARENA_CURVE || !ARENACLIENT.nameRecordFor || !ARENACLIENT.postName) return;
      try { if (!window.sessionStorage.getItem('arena.player.seed')) return; } catch { return; }
      for (const p of readPicks().filter((x) => x.order && !x.named && x.entryIdHex)) {
        try {
          const signed = ARENACLIENT.nameRecordFor({ id: ARENACLIENT.fromHex(p.roundIdHex) }, { storage: window.sessionStorage,
            random: (n) => crypto.getRandomValues(new Uint8Array(n)), curve: window.ARENA_CURVE, order: Number(p.order.index) || 0 });
          const said = await ARENACLIENT.postName(signed, p.nodes || [], { fetcher: (u, o) => fetch(u, Object.assign({}, o, { signal: AbortSignal.timeout(8000) })) });
          if (said.some((x) => x.status === 201 || x.status === 200)) rememberPick(Object.assign({}, p, { named: true }));
        } catch (e) { console.warn('[arena] naming an order: ' + e.message); }
      }
    }
    setInterval(() => { nameOrders().catch(() => {}); }, 30000);
    // ONE PASS AT A TIME (measured: a slow pass and the next one read the same rounds side by side)
    let restoring = null;
    const restoreOnce = () => { if (!restoring) restoring = restoreOrdersFromSeats().catch((e) => console.warn('[arena] orders from the seats: ' + e.message)).finally(() => { restoring = null; }); };
    setTimeout(restoreOnce, 4000);
    setInterval(restoreOnce, 15000);
    // the lobby's market lines (Unity draws them under the round rows, as the collect lines)
    let QUIET_ORDERS = new Set();
    function marketViewLines(onlyThisGame = false) {
      if (!ARENACLIENT.marketLines) return [];
      // THE GAME SHOWN ONLY, in a lobby (2026-10-17: "Btc orders showing up in tick tock"): Tick Tock's lobby listed
      // Up/Down's orders - every market pick of the tab, whatever game is open
      const ids = onlyThisGame ? new Set((window.ARENA_GAME_IDS || [window.ARENA_GAME_ID]).filter(Boolean).map((x) => String(x).toLowerCase())) : null;
      // AN OLD ORDER READ BACK FROM THE SEATS WAITS FOR ITS RESULT OUT OF SIGHT (2026-10-17 23:42 local, phone, UI 211:
      // "I am seeing other users orders, I don't have any open orders. They disappear after a few secs" - measured: they were this
      // wallet's own closed orders of 20:15 and 19:15, read back from the seats in seconds since UI 211 and listed under My orders as
      // "waiting for the result" until the page had asked for their outcome, then moved to History): a restored order whose window
      // closed more than 10 minutes ago is not listed as "waiting" (or as not yet in the table) while its result is being read - for
      // at most a minute after it was read back, so an order whose result cannot be read still shows
      const picks = readPicks().filter((p) => !ids || ids.has(String(p.gameId || '').toLowerCase()))
        .map((p) => Object.assign({}, p, { market: marketOfPick(p) })).filter((p) => p.market);
      // AND AN ORDER WHOSE WINDOW CLOSED BEFORE THIS PAGE LOADED, until its outcome was asked once (quietOrders, 2026-10-20)
      try {
        const all = ARENACLIENT.marketLines({ picks, outcomes: MARKET_OUTCOMES, nowMs: Date.now() });
        const held = ARENACLIENT.quietOrders({ picks, lines: all, read: OUTCOMES_READ, loadedMs: PAGE_LOADED_MS, nowMs: Date.now() });
        QUIET_ORDERS = held;        // the client's order list (market.orders) leaves them out too
        return all.filter((l) => !held.has(l.entry));
      } catch (e) { return [{ kind: 'market', text: 'markets: ' + e.message }]; }
    }
    window.ARENA_MARKET_LINES = marketViewLines;
    // THE SHEET (decision B, plan 777): one button per outcome, the stake, the 5% fee and the 0-5% donation; Cancel ends the
    // join and makes nothing. An unpinned market's manifest is read from the round's seats (GET /game-manifest), shown with
    // its developer key and manifest id, and staked on only after the second confirmation.
    async function openPickSheet(contract, id, nodes, onPick) {
      let market = ARENACLIENT.marketForRound(contract);
      let manifestHex = null;
      if (!market) {
        for (const n of nodes || []) {
          try {
            const r = await fetch(String(n).replace(/\/+$/, '') + '/game-manifest?round=' + id, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
            if (!r.ok) continue;
            const bytes = new Uint8Array(await r.arrayBuffer());
            market = ARENACLIENT.marketForRound(contract, { manifestBytes: bytes });
            if (market) { manifestHex = ARENACLIENT.toHex(bytes); break; }
          } catch { /* the next seat */ }
        }
      }
      if (!market) throw new Error('that round is not a market this page can read');
      const sheet = ARENACLIENT.pickSheet({ market, contract });
      const el = document.getElementById('arena-pick');
      const box = el.querySelector('.sheet');
      // THE REACT SHEET (kanban #564) when the page loaded the market bundle: the same pick, the same second confirmation for an unlisted
      // market (a box to tick before any outcome), the same Cancel; this page's own sheet below otherwise
      if (window.ArenaMarket && window.ArenaMarket.openSheet) {
        const shut = () => { el.classList.remove('show'); if (box._react) { box._react.unmount(); box._react = null; } box.textContent = ''; };
        window.ArenaMarket.openSheet(box, { sheet, free: !ARENACLIENT.roundPays(contract),
          onPick: (index, confirmed) => {
            if (sheet.confirm && !confirmed) return;
            shut();
            window.ARENA_PICK_CHOSEN = { round: id, pick: index, label: sheet.outcomes[index].label, gameId: market.gameId, confirmed: !!market.needsConfirm, manifestHex };
            onPick(index);
          },
          onCancel: () => { shut(); window.ARENA_PICK_CHOSEN = null; console.log('[arena] pick sheet ' + id.slice(0, 16) + ': cancelled, nothing made'); } });
        el.classList.add('show');
        window.ARENA_PICK_SHEET = { round: id, market: market.name, outcomes: sheet.outcomes.map((x) => x.label), lines: sheet.lines, confirm: sheet.confirm };
        return;
      }
      box.textContent = '';
      const h = document.createElement('h3'); h.textContent = sheet.title;
      const lines = document.createElement('div'); lines.className = 'lines';
      for (const t of ARENACLIENT.roundPays(contract) ? [sheet.lines.stake, sheet.lines.fee, sheet.lines.net, sheet.attestors] : ['free - nothing at stake', sheet.attestors]) {
        const d = document.createElement('div'); d.textContent = t; lines.append(d);
      }
      const outs = document.createElement('div'); outs.className = 'outcomes';
      const close = () => { el.classList.remove('show'); box.textContent = ''; };
      for (const o of sheet.outcomes) {
        const b = document.createElement('button'); b.className = 'outcome'; b.type = 'button'; b.dataset.outcome = String(o.index);
        b.textContent = o.label;
        b.addEventListener('click', () => {
          if (sheet.confirm && !window.confirm(sheet.confirm)) return;            // the second confirmation (§0A.6)
          close();
          window.ARENA_PICK_CHOSEN = { round: id, pick: o.index, label: o.label, gameId: market.gameId, confirmed: !!market.needsConfirm, manifestHex };
          onPick(o.index);
        });
        outs.append(b);
      }
      box.append(h, lines, outs);
      if (sheet.confirm) { const c = document.createElement('div'); c.className = 'confirm'; c.textContent = sheet.confirm; box.append(c); }
      const cancel = document.createElement('button'); cancel.className = 'cancel'; cancel.type = 'button'; cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => { close(); window.ARENA_PICK_CHOSEN = null; console.log('[arena] pick sheet ' + id.slice(0, 16) + ': cancelled, nothing made'); });
      box.append(cancel);
      el.classList.add('show');
      window.ARENA_PICK_SHEET = { round: id, market: market.name, outcomes: sheet.outcomes.map((x) => x.label), lines: sheet.lines, confirm: sheet.confirm };
      console.log('[arena] pick sheet ' + id.slice(0, 16) + ': ' + market.name + ' - ' + sheet.outcomes.map((x) => x.label).join(' / '));
    }

