// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK HEALTH PAGE'S READ (kanban #526, #564): what ./index.html read inline until 2026-10-26 - daily.json's seats, one census, each
// node's public doors, the seats' network reads - and each card handed to React (H.draw). A module now, so the same read runs in two places
// (kanban #686, 2026-10-26: "health is very very slow to load. Cache all the data in the background and if data is outdated show it instead
// that its older than 5 minutes. right now it's unusable."):
//   the page        live from the nodes (transport `live`), its answers kept (`recorder`) in the browser for the next visit
//   the explorer    src/website/explorer/worker.js asks the same doors every minute and serves what they answered at /api/health
// and a kept copy is drawn by the very same code (`replay`): one read, so a kept copy cannot draw differently from a live one.
export const ASK_MS = 10000, AT_ONCE = 6;

/** One answer from a node: { ok, status, why, ms, body } - never throws; a node that does not answer in ASK_MS is { ok: false }. */
export async function live(base, path, fetchImpl = fetch) {
  const t0 = Date.now();
  try {
    const r = await fetchImpl(base + path, { signal: AbortSignal.timeout(ASK_MS), cache: 'no-store' });
    const ms = Date.now() - t0;
    if (!r.ok) { let why = ''; try { why = (await r.json()).why || ''; } catch { /* not JSON */ } return { ok: false, status: r.status, why, ms }; }
    return { ok: true, ms, body: await r.json() };
  } catch (e) { return { ok: false, status: 0, why: e.name === 'TimeoutError' ? 'no answer in 10 s' : e.message, ms: Date.now() - t0 }; }
}

/** The name an answer is kept under: its door, without GET /served's window (from/to change with every read). */
export const keyOf = (base, path) => base + (/^\/served\?/.test(path) ? '/served' : path);

/** A transport that keeps every answer it passes on, with when it came: { transport, answers }. */
export function recorder(inner = live) {
  const answers = {};
  return { answers, transport: async (base, path) => { const a = await inner(base, path); answers[keyOf(base, path)] = { ...a, atMs: Date.now() }; return a; } };
}

/** A transport that answers from a kept copy ({ answers }), asking nobody; a door the copy has not read is not answered. */
export const replay = (snap) => async (base, path) => {
  const a = snap && snap.answers ? snap.answers[keyOf(base, path)] : null;
  return a ? { ok: !!a.ok, status: a.status, why: a.why, ms: a.ms, body: a.body } : { ok: false, status: 0, why: 'not read yet', ms: 0 };
};

// A KEPT COPY'S ANSWERS, SMALL (kanban #686): only what the cards use - a node's dashboard without its rounds, days and dev clients (40 to
// 75 kB each, measured 2026-10-26), its newest settlement only; an answer a read did not use (`spare`) kept as not used, with its time
export function keepable(answers, spare = new Set()) {
  const out = {};
  for (const [k, a] of Object.entries(answers)) {
    if (spare.has(k)) { out[k] = { ok: false, status: 0, why: 'another seat answered more', ms: a.ms, atMs: a.atMs }; continue; }
    if (a.ok && a.body && /\/dashboard\.json$/.test(k)) {
      const d = a.body, last = Math.max(0, ...(d.settlements || []).map((x) => Number(x.madeMs) || 0));
      out[k] = { ...a, body: { node: d.node, totals: d.totals, byGame: d.byGame, hosts: d.hosts, settlements: last ? [{ madeMs: last }] : [] } };
    } else if (a.ok && a.body && k.endsWith(NOW_ROUNDS)) {
      // a seat's rounds for the lobby's window (kanban #758): only the rounds that are open or start within the hour, each with whether it is
      // seated and its drawn game committee by the keys' first 16 characters (what roundSeating compares the answering nodes with)
      // (the keys once, in `keys`, each round naming them by place: 100 kB a seat measured with every key in every round, 10:59Z)
      const at = Number(a.atMs) || Number(a.body.nowMs) || Date.now(), keys = [], place = new Map();
      const ix = (x) => { const h = String(x).toLowerCase().slice(0, 16); if (!place.has(h)) { place.set(h, keys.length); keys.push(h); } return place.get(h); };
      out[k] = { ...a, body: { nowMs: a.body.nowMs, keys, rounds: (a.body.rounds || []).filter((r) => inNow(r, at)).map((r) => ({ id: String(r.id).slice(0, 16), game: { id: String(r.game && r.game.id).slice(0, 16), name: r.game && r.game.name },
        entryOpen: !!r.entryOpen, played: r.played, startTimeMs: r.startTimeMs, entryCloseMs: r.entryCloseMs, committeeTimeMs: r.committeeTimeMs, federation: String(r.federation || '').slice(0, 16),
        committee: r.committee ? { seated: r.committee.seated || null, drawnCount: r.committee.drawnCount || null,
          ...(isSeated(r.committee) ? {} : { drawnAt: drawnGame(r).map(ix) }) } : null })) } };
    } else if (a.ok && a.body && /\/rounds\?/.test(k)) {
      // a seat's rounds (kanban #692, 346 kB at ?next=1): each round's app, committee time, federation and whether its committee is drawn
      out[k] = { ...a, body: { rounds: (a.body.rounds || []).map((r) => ({ game: { id: r.game && r.game.id }, committeeTimeMs: r.committeeTimeMs, federation: r.federation,
        committee: { drawn: !!(r.committee && r.committee.drawn), why: r.committee && !r.committee.drawn ? r.committee.why || null : null } })) } };
    } else out[k] = a;
  }
  return out;
}

// THE ROUNDS THAT MATTER NOW, SEATED OR NOT (kanban #758, 2026-10-28, a tester: "The health page must be able to understand these kind of
// outages and show it in the 'App' section"). The outage (#757, measured 10:05Z): every seat listed the day's rounds, entry open on 120 Rock
// Paper Scissors, 36 Next Block and 4 Up/Down rounds, and NONE was seated - committee.seated false for both roles, only 0-4 of the 9 drawn
// answering - so the Arena page offered no round to join while this table said "posted" in green. Read from every seat's GET /rounds?next=8
// (the lobby's own ask, so a seat serves it from the listing it keeps), for the rounds whose entry is still open and that start within the
// hour (NOW_WINDOW_MS); a round counts once, by id:
//   seated     some seat says both roles are seated (committee.seated.game and .settlement) - what the lobby needs before a join
//   joinable   seated and its entry open
//   not seated listed, no seat says it is seated; with how many of its drawn game committee answer this page
// A round a seat does not play in its window (played: false, the backup rule) does not count. The cell: red "no joinable rounds" when rounds
// are listed and none can be joined (or the day's rounds are posted and no seat lists one in the hour), amber when some are not seated, green
// when the next rounds are seated.
// roundSeating({ games, lists, nowMs, answering, posted }) -> Map(app name -> cell { t, c, tip })
export const NOW_ROUNDS = '/rounds?next=8', NOW_WINDOW_MS = 3600000;
const drawnGame = (r, keys = null) => { const c = r && r.committee; if (!c) return [];
  if (keys && Array.isArray(c.drawnAt)) return c.drawnAt.map((i) => keys[i]).filter(Boolean);
  return c.drawn && Array.isArray(c.drawn.game) ? c.drawn.game : Array.isArray(c.game) ? c.game : []; };
const inNow = (r, nowMs, windowMs = NOW_WINDOW_MS) => Number(r.entryCloseMs) > nowMs && Number(r.startTimeMs) <= nowMs + windowMs;
const isSeated = (c) => !!(c && c.seated && c.seated.game && c.seated.settlement);
export function roundSeating({ games = [], lists = [], nowMs = Date.now(), answering = null, posted = () => false, windowMs = NOW_WINDOW_MS }) {
  nowMs = Number(nowMs); windowMs = Number(windowMs);
  const nameOfId = new Map((games || []).map((g) => [String(g.id).toLowerCase().slice(0, 16), g.name || g.title]));
  const live = answering ? new Set([...answering].map((k) => String(k).toLowerCase().slice(0, 16))) : null;
  const byId = new Map();
  for (const body of lists) for (const r of (body && body.rounds) || []) {
    if (!r || !r.id || r.played === false || !inNow(r, nowMs, windowMs)) continue;
    const k = String(r.id).toLowerCase().slice(0, 16), w = byId.get(k);
    const name = nameOfId.get(String(r.game && r.game.id).toLowerCase().slice(0, 16)) || (r.game && (r.game.name || r.game.title)) || '?';
    const drawn = drawnGame(r, body.keys);
    if (!w) byId.set(k, { name, startTimeMs: Number(r.startTimeMs), seated: isSeated(r.committee), open: !!r.entryOpen, drawn, drawnCount: drawn.length || Number(r.committee && r.committee.drawnCount && r.committee.drawnCount.game) || 0 });
    else { w.seated = w.seated || isSeated(r.committee); w.open = w.open || !!r.entryOpen; if (!w.drawn.length && drawn.length) { w.drawn = drawn; w.drawnCount = drawn.length; } }
  }
  const apps = new Map();
  for (const r of byId.values()) { if (!apps.has(r.name)) apps.set(r.name, []); apps.get(r.name).push(r); }
  const until = hm(nowMs + windowMs), seats = lists.filter(Boolean).length;
  const out = new Map();
  const cellOf = (name, rs) => {
    if (!rs.length) {
      // no seat's listing read (a kept copy made before kanban #758 has none): nothing known, said so - not red
      if (!seats) return { t: 'no seat answered', c: 'warn', tip: `no seat answered GET ${NOW_ROUNDS}: whether the next rounds are seated is not known` };
      if (!posted(name)) return { t: '-', c: 'muted', tip: `no round of this app is open or starts by ${until} UTC on any of the ${seats} seats that answered` };
      return { t: 'no joinable rounds - posted but none listed', c: 'bad', summary: 'No round can be joined: the day\'s rounds are posted, and no seat lists one for the next hour.',
        tip: `the day's rounds are posted, but none of the ${seats} seats that answered lists a round of this app open or starting by ${until} UTC` };
    }
    const seated = rs.filter((r) => r.seated), joinable = seated.filter((r) => r.open), unseated = rs.filter((r) => !r.seated);
    const here = (r) => (live && r.drawn.length ? r.drawn.filter((k) => live.has(String(k).toLowerCase().slice(0, 16))).length : null);
    const ups = unseated.map(here).filter((x) => x != null), of = Math.max(0, ...unseated.map((r) => r.drawnCount));
    const answer = ups.length ? `${Math.min(...ups) === Math.max(...ups) ? Math.min(...ups) : `${Math.min(...ups)}-${Math.max(...ups)}`} of ${of} drawn answer` : of ? `${of} drawn` : '';
    const soon = (xs) => xs.length ? hm(Math.min(...xs.map((r) => r.startTimeMs))) : '-';
    const lines = [`${rs.length} round(s) open or starting by ${until} UTC, from ${seats} seat(s) that answered`, `seated: ${seated.length} (both roles' committees seated)`,
      `listed but not seated: ${unseated.length}${answer ? ` (${answer})` : ''}`, `joinable now (seated, entry open): ${joinable.length}${joinable.length ? `, the soonest at ${soon(joinable)} UTC` : ''}`];
    if (!joinable.length && unseated.length) return { t: `no joinable rounds - posted but not seated${answer ? ` (${answer})` : ''}`, c: 'bad', tip: lines.join('\n'),
      summary: 'No round can be joined: the rounds are listed, but their committees are not seated - too few of the drawn nodes answer.' };
    if (!joinable.length) return { t: `${seated.length} seated · none open yet`, c: 'warn', tip: lines.join('\n'), summary: 'The next rounds are seated; none takes entries yet.' };
    if (unseated.length) return { t: `${joinable.length} joinable · ${unseated.length} of ${rs.length} not seated${answer ? ` (${answer})` : ''}`, c: 'warn', tip: lines.join('\n'),
      summary: 'Some rounds can be joined; others are listed but their committees are not seated.' };
    return { t: `${joinable.length} joinable · ${seated.length} of ${rs.length} seated`, c: 'ok', tip: lines.join('\n'), summary: 'The next rounds are seated and can be joined.' };
  };
  // the one line on what it means first in the tooltip, then the counts
  const fin = ({ summary, ...c }) => (summary ? { ...c, tip: `${summary}\n${c.tip}` } : c);
  for (const [name, rs] of apps) out.set(name, fin(cellOf(name, rs)));
  for (const g of games || []) { const name = g.name || g.title; if (!out.has(name)) out.set(name, fin(cellOf(name, []))); }
  return out;
}

/** The grids of the next hour's rounds, seated or not (kanban #758): Map(seatKey(game, committee time, federation) -> true seated | false). */
export function seatingOf({ games = [], lists = [], nowMs = Date.now(), windowMs = NOW_WINDOW_MS }) {
  nowMs = Number(nowMs);
  const nameOfId = new Map((games || []).map((g) => [String(g.id).toLowerCase().slice(0, 16), g.name || g.title]));
  const out = new Map();
  for (const body of lists) for (const r of (body && body.rounds) || []) {
    if (!r || r.played === false || !inNow(r, nowMs, windowMs) || r.committeeTimeMs == null) continue;
    const name = nameOfId.get(String(r.game && r.game.id).toLowerCase().slice(0, 16)) || (r.game && (r.game.name || r.game.title));
    const k = seatKey(name, r.committeeTimeMs, r.federation);
    out.set(k, out.get(k) === true || isSeated(r.committee));
  }
  return out;
}

// THE ROUNDS POSTED FOR EACH APP (kanban #692, 2026-10-26, on the APPS table: "Should also show the round posting status for the today and
// the next 24 hours. Status posted, delayed, failed with a tooltip why it's delayed or failed. After posted add confirmations in ()"). Only
// the NEWEST version of each app counts (the owner's rule). For each period - the rest of today (UTC) and the next 24 h - every grid of that
// version whose rounds fall in it, from the seats' GET /pending (a grid's publication and committee block, as each seat reads its chain; the
// furthest kept) with its version from GET /expected, and from one seat's GET /rounds whether its committee can be drawn:
//   posted (N)   the committee block is 6 deep and the seats can draw the committee; N = the committee block's confirmations (the least of its grids)
//   scheduled (N) mined (N confirmations), its committee block not 6 deep yet, but its first round has not started: on time
//   delayed      a round's start passed and its committee block is not there or not 6 deep - the tooltip says which and when
//   failed       part of the period no grid of the newest version covers, a publication on no chain, or a grid whose committee no seat
//                draws - the tooltip names the seat's reason
// roundPosting({ games, pending, expected, rounds, nowMs, fedNo }) -> Map(app name -> { today, next }), each a table cell { t, c, tip }
const BLOCK_MS = 600000, GAP_MS = 15 * 60000;
const hm = (ms) => new Date(Number(ms)).toISOString().slice(11, 16), dhm = (ms) => new Date(Number(ms)).toISOString().slice(5, 16).replace('T', ' ');
export function roundPosting({ games = [], pending = [], expected = [], rounds = [], nowMs = Date.now(), fedNo = () => null }) {
  const keyOf3 = (x) => `${x.publication ? x.publication.txid : ''}:${x.committeeTimeMs}:${x.federation}`;
  const versionOf = new Map(expected.map((e) => [keyOf3(e), String(e.gameId).toLowerCase()]));
  // every seat's grids, one per series (its publication, committee time and federation), the furthest reading kept
  const grids = new Map();
  for (const a of pending) for (const g of a.grids || []) {
    const k = keyOf3(g), was = grids.get(k);
    if (!was || (g.beacon.depth || 0) > (was.beacon.depth || 0) || (g.publication.confirmations || 0) > (was.publication.confirmations || 0)) grids.set(k, g);
  }
  // a grid one seat expects and none reads on its chain yet
  for (const e of expected) if (!grids.has(keyOf3(e))) grids.set(keyOf3(e), { ...e, publication: { ...e.publication, confirmations: 0, inMempool: false, unread: true }, beacon: { height: null, depth: 0, needed: 6 } });
  // each grid's rounds as one seat lists them: drawn or not, and why not
  const drawn = new Map();
  for (const r of rounds) {
    const k = `${String(r.game && r.game.id).toLowerCase()}:${r.committeeTimeMs}:${r.federation}`, d = drawn.get(k) || { yes: 0, no: 0, why: null };
    if (r.committee && r.committee.drawn) d.yes++; else { d.no++; d.why = d.why || (r.committee && r.committee.why) || null; }
    drawn.set(k, d);
  }
  const newest = new Map();
  for (const x of games) { const k = x.name || x.title; const w = newest.get(k); if (x.version != null && (!w || Number(x.version) > Number(w.version))) newest.set(k, x); }
  const endOfDay = Math.floor(nowMs / 86400000) * 86400000 + 86400000;
  const out = new Map();
  for (const [name, app] of newest) {
    const id = String(app.id).toLowerCase();
    const mine = [...grids.entries()].filter(([k]) => versionOf.get(k) === id).map(([, g]) => g);
    const cell = (a, b) => {
      if (b - a < 60000) return { t: '-', c: 'muted', tip: 'the day is over' };
      if (!pending.length && !expected.length) return { t: '-', c: 'muted', tip: 'no seat answered GET /pending or GET /expected' };
      const inside = mine.filter((g) => Number(g.firstWindowMs) < b && Number(g.lastCloseMs) > a);
      const lines = [], states = [], items = [];   // items: the reasons as short rows for the panel (kanban #692: "Wall of text")
      const span = (f, t) => { const day = (x) => new Date(x).toISOString().slice(5, 10); const same = day(f) === day(nowMs), next = day(f) === day(nowMs + 86400000);
        const midnight = t % 86400000 === 0 && t - f <= 86400000 && day(t - 1) === day(f);   // a stretch to the end of its day reads 24:00
        return `${same ? 'today' : next ? 'tomorrow' : day(f)} ${hm(f)}–${midnight ? '24:00' : `${day(t) === day(f) ? '' : day(t) + ' '}${hm(t)}`}`; };
      const plainWhy = (why) => /names census root/.test(why || '') ? 'can\'t be played: its census is from a chain branch that was left'
        : /census carries 0 game nodes/.test(why || '') ? 'can\'t be played: no node of this version was in its census' : `can't be played: ${why || 'no seat draws it'}`;
      // the stretches of the period no grid of the newest version covers
      const spans = inside.map((g) => [Math.max(a, Number(g.firstWindowMs)), Math.min(b, Number(g.lastCloseMs))]).sort((x, y) => x[0] - y[0]);
      let at = a;
      for (const [f, t] of spans) { if (f - at > GAP_MS) { states.push('failed'); lines.push(`${dhm(at)} to ${dhm(f)} UTC: no grid of version ${app.version} posted for it`); items.push({ s: 'bad', live: false, f: at, to: f, when: span(at, f), say: 'no rounds posted' }); } at = Math.max(at, t); }
      if (b - at > GAP_MS) { states.push('failed'); lines.push(`${dhm(at)} to ${dhm(b)} UTC: no grid of version ${app.version} posted for it`); items.push({ s: 'bad', live: false, f: at, to: b, when: span(at, b), say: 'no rounds posted' }); }
      const depths = [], waits = { scheduled: [], delayed: [] }, per = [];   // per: [grid, 4 posted | 3 scheduled | 2 delayed | 1 unconfirmed] - the live ones
      for (const g of inside.sort((x, y) => Number(x.firstWindowMs) - Number(y.firstWindowMs))) {
        const n = fedNo(g.federation), p = g.publication, bc = g.beacon;
        const head = `${n ? `Federation ${n}` : String(g.federation || '').slice(0, 8)}, rounds ${dhm(g.firstWindowMs)} to ${dhm(g.lastCloseMs)} UTC: `;
        const d = drawn.get(`${id}:${g.committeeTimeMs}:${g.federation}`);
        const item = (st, live, say, detail) => { const f = Math.max(a, Number(g.firstWindowMs)), to = Math.min(b, Number(g.lastCloseMs)); items.push({ s: st, live, f, to, when: span(f, to), fed: n ? `Fed ${n}` : '', say, detail }); };
        if (!p.height && !p.inMempool) { states.push('failed'); lines.push(head + (p.unread ? 'announced, but no seat reads its round table on its chain' : `its round table ${String(p.txid).slice(0, 10)} is in no block and not in the mempool`)); item('bad', false, p.unread ? 'announced, but no node finds its transaction' : 'never mined: its transaction was replaced or dropped', `round table ${String(p.txid).slice(0, 10)}`); }
        else if (!p.height) { states.push('unconfirmed'); per.push([g, 1]); lines.push(head + `its round table ${String(p.txid).slice(0, 10)} waits in the mempool to be mined`); item('warn', true, 'waiting to be mined', `round table ${String(p.txid).slice(0, 10)}`); }
        // SCHEDULED, NOT DELAYED (2026-10-26 ~15:20Z, the owner: "Why does health [say] delayed for tomorrow if the confirmations are in,
        // the committee comes at 18:00 UTC and the rounds go online as planned? I wouldn't call that delayed"): mined, and its first round
        // has not started yet - on time; delayed only once a round's start passed before its committee block was 6 deep
        else if ((bc.height == null || (bc.depth || 0) < (bc.needed || 6)) && nowMs < Number(g.firstWindowMs)) { states.push('scheduled'); per.push([g, 3]); waits.scheduled.push(Number(p.confirmations) || 0); lines.push(head + `scheduled: published in block ${p.height}; ${bc.height == null ? `its committee block comes after ${hm(g.committeeTimeMs)} UTC` : `its committee block ${bc.height} has ${bc.depth} of ${bc.needed || 6} confirmations`}, before its first round at ${dhm(g.firstWindowMs)} UTC`); item('ok', true, `on time: ${bc.height == null ? `committee block after ${hm(g.committeeTimeMs)} UTC` : `committee block ${bc.depth} of ${bc.needed || 6} confirmations`}, rounds from ${hm(g.firstWindowMs)} UTC`, `published in block ${p.height}`); }
        else if (bc.height == null) { states.push('delayed'); per.push([g, 2]); waits.delayed.push(Number(p.confirmations) || 0); lines.push(head + `published in block ${p.height}; its committee block is the first whose median time passes ${hm(g.committeeTimeMs)} UTC (the median time runs about an hour behind), then 6 confirmations`); item('warn', true, `mined; waiting for its committee block (after ${hm(g.committeeTimeMs)} UTC), then 6 confirmations`, `published in block ${p.height}`); }
        else if ((bc.depth || 0) < (bc.needed || 6)) { states.push('delayed'); per.push([g, 2]); waits.delayed.push(Number(p.confirmations) || 0); lines.push(head + `its committee block ${bc.height} has ${bc.depth} of ${bc.needed || 6} confirmations: posted in about ${((bc.needed || 6) - bc.depth) * BLOCK_MS / 60000} min`); item('warn', true, `committee block ${bc.depth} of ${bc.needed || 6} confirmations, about ${((bc.needed || 6) - bc.depth) * BLOCK_MS / 60000} min to go`, `committee block ${bc.height}`); }
        else if (d && !d.yes && d.no) { states.push('failed'); lines.push(head + `posted, but no seat can draw its committee: ${d.why || 'no reason given'}`); item('bad', false, plainWhy(d.why), d.why || ''); }
        else { states.push('posted'); per.push([g, 4]); depths.push(bc.depth); lines.push(head + `posted: its committee block ${bc.height} has ${bc.depth} confirmations (6 needed)`); item('ok', true, `playable · committee block ${bc.depth} confirmations`, `committee block ${bc.height}`); }
      }
      if (!states.length) return { t: '-', c: 'muted', tip: 'nothing to post' };
      // UNCONFIRMED, IN YELLOW (2026-10-26, the owner: "If it's the rounds are in the mempool and unconfirmed it needs to show as unconfirmed
      // and yellow"): a round table waiting in the mempool is named so, after failed and before delayed
      // EACH STRETCH BY ITS BEST LIVE GRID, THE PERIOD BY ITS WORST LIVE STRETCH (2026-10-26 11:33, the owner on his phone: "I thought they
      // were unconfirmed now?? Why failed"): the worst of all grids made today's dead day grids (a census of the branch the chain left)
      // outweigh the live ones - Rock Paper Scissors drew 7/7 and read "failed". A stretch no live grid covers marks the cell "· gap";
      // failed only when no stretch is live
      const cuts = [...new Set([a, b, ...per.flatMap(([g]) => [Number(g.firstWindowMs), Number(g.lastCloseMs)]).filter((x) => x > a && x < b)])].sort((x, y) => x - y);
      const segs = cuts.slice(1).map((e, i) => { const f = cuts[i]; return Math.max(0, ...per.filter(([g]) => Number(g.firstWindowMs) < e && Number(g.lastCloseMs) > f).map(([, r]) => r)); });
      const liveRanks = segs.filter((r) => r > 0);
      // A GAP IS LONGER THAN 15 MIN, as a failed stretch is (2026-10-26 ~15:30Z, the owner on tomorrow's "delayed (60) · gap": Up or Down's
      // day grid runs 23:45 to 23:45 and Tick Tock's 23:59 to 23:59 - the last minutes of a day are the next day's grid's, not a gap)
      const gap = segs.some((r, i) => r === 0 && cuts[i + 1] - cuts[i] > GAP_MS);
      const st = !liveRanks.length ? 'failed' : ['failed', 'unconfirmed', 'delayed', 'scheduled', 'posted'][Math.min(...liveRanks)];
      // A DELAYED GRID SAYS HOW FAR IT IS MINED (2026-10-26, the owner: "if it is confirmed and says delayed it should say delayed(1) for example
      // for 1 confirmation"): the round table's confirmations in () - the least of the grids that give the status, never another grid's
      // (2026-10-26 ~15:35Z: today's Tick Tock read "delayed (60)" from tomorrow's scheduled grid while its own had 1)
      return { t: (st === 'posted' ? `posted (${Math.max(...depths)})` : (st === 'delayed' || st === 'scheduled') && Math.min(...waits[st]) > 0 ? `${st} (${Math.min(...waits[st])})` : st) + (gap && st !== 'failed' ? ' · gap' : ''), c: (st === 'posted' || st === 'scheduled') && !gap ? 'ok' : st === 'failed' ? 'bad' : 'warn',
        // one line per reading (several series share a round table and a committee block): the same words once, with how many
        tip: (st === 'posted' ? `version ${app.version}; in () the confirmations of the committee block - the block whose hash draws each round's committee\n` : st === 'delayed' || st === 'scheduled' ? `version ${app.version}; in () the confirmations of the round table\n` : `version ${app.version}\n`)
          + [...lines.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map())].map(([l, k]) => (k > 1 ? `${l} (${k} grids)` : l)).join('\n'),
        // THE SAME, READABLE (2026-10-26 11:44, the owner on the panel: "Wall of text make it more readable and much easier to understand"):
        // one line on what it means, then one short row per grid - the live ones first, the ones that cannot be played folded below
        summary: (st === 'posted' ? 'Rounds are playable.' : st === 'scheduled' ? 'The rounds are mined and start on time.' : st === 'delayed' ? 'The rounds should have started: they still wait for their committee block.' : st === 'unconfirmed' ? 'The next rounds wait to be mined.' : 'No rounds can be played.')
          + (gap && st !== 'failed' ? ' Some hours have no rounds.' : ''),
        version: app.version,
        // WHAT WAS DONE ABOUT IT (2026-10-26, the owner: "Also post resolution what has been done to fix the problem"): each stretch that cannot
        // be played names the live grid that took its hours over, or says nothing has yet
        items: [...items.map((x) => { if (x.live) return x; const by = items.filter((l) => l.live && l.f < x.to && l.to > x.f).sort((p1, p2) => p1.f - p2.f)[0];
          return { ...x, fix: by ? `fixed: a new grid${by.fed ? ` (${by.fed})` : ''} covers ${by.when} - ${by.say}` : 'not fixed yet: no new grid covers these hours' }; }).reduce((m, x) => { const k = `${x.s}|${x.when}|${x.fed || ''}|${x.say}`; const w = m.get(k); if (w) w.n++; else m.set(k, { ...x, n: 1 }); return m; }, new Map()).values()]
          .sort((x, y) => Number(y.live) - Number(x.live)) };
    };
    // TOMORROW, NOT THE NEXT 24 H (2026-10-26 ~15:20Z, the owner on that column's panel: "Why does it show today's rounds when I click
    // tomorrow?"): the next UTC day, 00:00 to 24:00 - the day its duty note names
    out.set(name, { today: cell(nowMs, endOfDay), next: cell(endOfDay, endOfDay + 86400000) });
  }
  return out;
}

// THE CHAIN'S OWN CLOCK (kanban #758, 2026-10-28, the owner on "reaches the seats at ~14:40": "I thought the timing was much later"): no
// 10 min a block - our testnet4 branch runs ~15 min a block, its miner stamps +20 min. Measured from the tips the reads saw (`tips`: each
// height with the median time past the seats' GET /pending gave for it and when a read first saw it, kept with the copy, the explorer's every
// 2 min): the wall time a block takes (the middle half of the last 24 intervals, a range) and how far the median time moves a block.
// noteTip(tips, { h, mtpMs, atMs }) -> tips with a new height added; blockClock(tips) -> { lo, hi, step, n, seen } | null (fewer than two heights)
export const TIPS_KEPT = 48;
export function noteTip(tips, { h, mtpMs, atMs }) {
  const list = (Array.isArray(tips) ? tips : []).filter((x) => x && Number.isFinite(Number(x.h)) && Number.isFinite(Number(x.atMs)));
  if (!Number(h) || !Number.isFinite(Number(atMs)) || list.some((x) => Number(x.h) >= Number(h))) return list.slice(-TIPS_KEPT);
  return [...list, { h: Number(h), mtpMs: mtpMs == null ? null : Number(mtpMs), atMs: Number(atMs) }].slice(-TIPS_KEPT);
}
export function blockClock(tips) {
  const t = (Array.isArray(tips) ? tips : []).map((x) => ({ h: Number(x.h), atMs: Number(x.atMs), mtpMs: x.mtpMs == null ? null : Number(x.mtpMs) })).sort((a, b) => a.h - b.h);
  if (t.length < 2) return null;
  const per = [], steps = [];
  for (let i = 1; i < t.length; i++) {
    const dh = t[i].h - t[i - 1].h, dt = t[i].atMs - t[i - 1].atMs;
    if (dh > 0 && dt > 0) for (let k = 0; k < Math.min(dh, 6); k++) per.push(dt / dh);
    if (dh > 0 && t[i].mtpMs != null && t[i - 1].mtpMs != null) steps.push((t[i].mtpMs - t[i - 1].mtpMs) / dh);
  }
  const last = per.slice(-24).sort((a, b) => a - b);
  if (!last.length) return null;
  const q = (f) => last[Math.min(last.length - 1, Math.floor(f * (last.length - 1) + 0.5))];
  const st = steps.slice(-24).sort((a, b) => a - b);
  return { lo: q(0.25), hi: q(0.75), step: st.length ? st[Math.floor(st.length / 2)] : null, n: last.length, seen: t[t.length - 1] };
}
const between = (a, b) => (Math.abs(b - a) < 10 * 60000 ? `~${hm((a + b) / 2)}` : `~${hm(a)}-${hm(b)}`);

// EVERY POSTING OF THE DAY, NOT ONLY THE DUTY'S (kanban #758, 2026-10-28, the owner: "Is health showing the newly posted rounds? It needs to
// support that as well."). On 10-28 (#757) emergency grids were published for the rest of the day by an ops tool, not by the daily duty.
// Every publication of the day, one row each, from what the seats already answer:
//   GET /duty      the duty's postings, primary and backup, and every grid carrying the duty's emergency marker, with the key that signed it
//                  (height null: seen in the mempool)
//   GET /pending   every grid a seat reads on its chain: its publication's block or mempool, its beacon (committee) block - the first whose
//                  median time passes the committee time - and how deep; the tip and its median time
//   GET /expected  every grid announced to a seat, read or not
// A grid in /pending or /expected that no /duty posting names is an EXTRA POSTING (another creator key, e.g. an ops tool's emergency grid);
// the seats do not say its creator (GET /expected drops the signed series line's key).
// EACH ROW SAYS WHERE ITS PUBLICATION IS ON THE CHAIN (2026-10-28, the owner: "And show confirmations on the chain"): "in the mempool", or
// "mined in <height> · N confirmations" (from the newest tip), and "beacon <height> · k/6 deep" once its beacon block is there. Its state:
//   listed and seated / listed by the seats (not yet seated)   beacon 6 deep: the seats hold its series and list its rounds - seated or not
//                  as the seats say for its rounds of the next hour (`seating`); "listed by the seats" alone when none is in that hour
//                  ("2 on the seats" read as playable - the owner: "what do you mean by '2 on the seats'")
//   reaches the seats ~HH:MM-HH:MM   mined: the blocks to its beacon block (from the tip's median time and how far it moves a block) and
//                  to 6 deep, at the measured wall time a block takes (blockClock), a range; not said until two heights were seen
//   waiting to be mined / announced, not read on chain / not on chain
// allPostings({ games, pending, expected, duty, nowMs, tip, clock, seating }) -> Map(app name -> { today, next }), each a cell
// seating: Map(seatKey(game name, committeeTimeMs, federation) -> true seated | false listed, not seated), for the rounds of the next hour
// (the committee time to the minute: a round lists 1793102400000 where its grid says 1793102399998)
export const seatKey = (game, committeeTimeMs, federation) => `${game}:${Math.round(Number(committeeTimeMs) / 60000)}:${String(federation || '').toLowerCase().slice(0, 16)}`;
export function allPostings({ games = [], pending = [], expected = [], duty = null, nowMs = Date.now(), tip = null, clock = null, seating = null }) {
  nowMs = Number(nowMs);
  const k16 = (t) => String(t || '').toLowerCase().slice(0, 16);
  const nameOfId = new Map((games || []).map((g) => [String(g.id).toLowerCase(), g.name || g.title]));
  // the newest tip any seat read, and its median time past
  const { top, mtp } = tipOf(pending, tip);
  // every grid read or announced, by publication; the furthest reading kept
  const grids = new Map();
  const deeper = (g, w) => !w || (Number(g.beacon && g.beacon.depth) || 0) > (Number(w.beacon && w.beacon.depth) || 0) || (Number(g.publication && g.publication.confirmations) || 0) > (Number(w.publication && w.publication.confirmations) || 0)
    || (!!(g.publication && g.publication.inMempool) && !(w.publication && w.publication.inMempool) && !(w.publication && w.publication.height));
  for (const a of pending || []) for (const g of (a && a.grids) || []) { const k = k16(g.publication && g.publication.txid); if (k && deeper(g, grids.get(k))) grids.set(k, { ...g, read: true }); }
  for (const e of expected || []) { const k = k16(e.publication && e.publication.txid); if (k && !grids.has(k)) grids.set(k, { ...e, game: e.game || nameOfId.get(String(e.gameId).toLowerCase()), read: false, beacon: { height: null, depth: 0, needed: 6 } }); }
  // the duty's postings, by publication: which day, which role, emergency or not, who signed it
  const byDuty = new Map(), order = new Map();
  for (const d of (duty && duty.days) || []) {
    for (const o of d.order || []) order.set(String(o.key).toLowerCase(), o);
    for (const a of d.apps || []) for (const x of a.postings || []) {
      const k = k16(x.txid); if (!k || byDuty.has(k)) continue;
      byDuty.set(k, { app: a.name || a.app, period: d.period, role: x.role || a.role || 'primary', emergency: !!x.emergency, poster: x.poster || null, posterEndpoint: x.posterEndpoint || null, height: x.height ?? null, txid: x.txid });
    }
  }
  const endOfDay = Math.floor(nowMs / 86400000) * 86400000 + 86400000;
  // a grid's day: the one its duty posting names, else the day its middle falls on (a day grid starts minutes before its day: 23:45, 23:59)
  const periodOf = (g) => { if (Number(g.lastCloseMs) <= nowMs) return null; const mid = (Number(g.firstWindowMs) + Number(g.lastCloseMs)) / 2;
    return mid < endOfDay ? 'today' : mid < endOfDay + 86400000 ? 'next' : null; };
  const who = (key, endpoint) => (key ? nodeLabel(key, endpoint || (order.get(String(key).toLowerCase()) || {}).endpoint) : null);
  const num = (x) => Number(x).toLocaleString('en-US');
  // when a mined grid reaches the seats: the blocks to its beacon block, then to 6 deep, at the measured block time - [from, to, blocks]
  const reach = (g, bc, depth, need) => {
    if (!clock || !top) return null;
    let blocks;
    if (bc.height != null) blocks = Math.max(0, need - depth);
    else {
      if (mtp == null || !(clock.step > 0)) return null;
      const toBeacon = Number(g.committeeTimeMs) < mtp ? 1 : Math.floor((Number(g.committeeTimeMs) - mtp) / clock.step) + 1;
      blocks = toBeacon + need - 1;
    }
    // counted from when the tip was first seen, never before now
    const from = clock.seen && clock.seen.h === top ? clock.seen.atMs : nowMs;
    return [Math.max(nowMs, from + blocks * clock.lo), Math.max(nowMs, from + blocks * clock.hi), blocks];
  };
  const rows = [];
  for (const k of new Set([...grids.keys(), ...byDuty.keys()])) {
    const g = grids.get(k) || null, d = byDuty.get(k) || null;
    const app = (g && g.game) || (d && d.app);
    const period = d && (d.period === 'today' || d.period === 'next') ? d.period : g ? periodOf(g) : null;
    if (!app || !period) continue;
    const p = g ? g.publication || {} : {}, bc = g ? g.beacon || {} : {}, need = Number(bc.needed) || 6;
    const height = p.height || (d && d.height) || null;
    // where its publication is on the chain, counted from the newest tip
    const conf = height ? Math.max(Number(p.confirmations) || 1, top ? top - Number(height) + 1 : 1) : 0;
    const depth = bc.height != null ? Math.max(Number(bc.depth) || 0, top ? top - Number(bc.height) + 1 : 0) : 0;
    const chain = height ? `mined in ${num(height)} · ${conf} confirmation${conf === 1 ? '' : 's'}${bc.height != null ? ` · beacon ${num(bc.height)} · ${Math.min(depth, need)}/${need} deep` : ''}`
      : (g && p.inMempool) || (d && !(g && g.read)) ? 'in the mempool' : g && !g.read ? 'not read on any seat\'s chain' : 'in no block and no mempool';
    let st, s, eta = null, listed = false;
    if (g && bc.height != null && depth >= need) {
      listed = true;
      const se = seating ? seating.get(seatKey(app, g.committeeTimeMs, g.federation)) : undefined;
      st = se === true ? 'listed and seated' : se === false ? 'listed by the seats (not yet seated)' : 'listed by the seats';
      s = se === false ? 'warn' : 'ok';
    } else if (g && height && g.read) {
      eta = reach(g, bc, depth, need);
      st = eta ? `reaches the seats ${between(eta[0], eta[1])} UTC (${eta[2]} more block${eta[2] === 1 ? '' : 's'})` : 'reaches the seats after its beacon block is 6 deep (block times not measured yet)';
      s = 'warn';
    } else if (g && !g.read) { st = 'announced to the seats, not read on their chain yet'; s = 'warn'; }
    else if ((g && p.inMempool) || (d && d.height == null && !(g && g.read))) { st = 'waiting to be mined'; s = 'warn'; }
    else if (d && d.height != null) { st = 'mined, not read by the seats yet'; s = 'warn'; }
    else { st = 'not on chain: neither mined nor in any seat\'s mempool'; s = 'bad'; }
    const kind = d ? (d.emergency ? 'emergency grid (duty marker)' : `duty ${d.role}`) : 'extra posting';
    const by = d ? (d.poster ? who(d.poster, d.posterEndpoint) : 'a key outside the census') : 'creator not named by the seats';
    const rounds = g && Number(g.slots) ? `${num(g.slots)} rounds from ${dhm(g.firstWindowMs)} UTC` : 'its rounds not read yet';
    rows.push({ app, period, s, st, eta, conf, listed, extra: !d || d.emergency, live: s !== 'bad', item: { s, live: s !== 'bad', when: kind[0].toUpperCase() + kind.slice(1), say: `${rounds} · ${st} · ${chain}`,
      detail: `publication ${String(d ? d.txid : p.txid).slice(0, 16)} · by ${by}${g && g.federation ? ` · federation ${String(g.federation).slice(0, 8)}` : ''}` },
      line: `${kind} ${String(d ? d.txid : p.txid).slice(0, 10)} by ${by}: ${rounds}; ${st}; ${chain}` });
  }
  const out = new Map();
  const names = new Set([...(games || []).map((g) => g.name || g.title), ...rows.map((r) => r.app)]);
  const clockSays = clock ? `block times measured: ${Math.round(clock.lo / 60000)}-${Math.round(clock.hi / 60000)} min a block (${clock.n} seen)${clock.step ? `; the median time moves ${Math.round(clock.step / 60000)} min a block` : ''}`
    : 'block times not measured yet: the page has not seen two tips';
  for (const name of names) {
    const cell = (period) => {
      const rs = rows.filter((r) => r.app === name && r.period === period);
      if (!rs.length) return { t: '-', c: 'muted', tip: `no posting of this app read for ${period === 'today' ? 'the rest of today' : 'tomorrow'}` };
      const listed = rs.filter((r) => r.listed).length, coming = rs.filter((r) => !r.listed && r.live), extra = coming.filter((r) => r.extra);
      // each extra posting on its way by its state and its confirmations; of the duty's on their way, the soonest
      const way = (r) => (r.eta ? `reaches the seats ${between(r.eta[0], r.eta[1])}` : r.st) + (r.conf ? ` (${r.conf} conf.)` : '');
      const extraSays = extra.map((r) => `extra posting ${way(r)}`);
      const duty = coming.filter((r) => !r.extra), soon = duty.filter((r) => r.eta).sort((x, y) => x.eta[0] - y.eta[0])[0];
      const t = [`${rs.length} posting${rs.length === 1 ? '' : 's'} · ${listed} listed by the seats`, ...[...new Set(extraSays)].map((x) => (extraSays.filter((y) => y === x).length > 1 ? `${x} (${extraSays.filter((y) => y === x).length})` : x)),
        ...(soon ? [`next ${way(soon)}`] : duty.length ? [`${duty.length} on the way`] : [])].join(' · ');
      const c = listed && !coming.length && !rs.some((r) => r.listed && r.s === 'warn') ? 'ok' : listed || coming.length ? 'warn' : 'bad';
      return { t, c, tip: `${rs.map((r) => r.line).join('\n')}\n${clockSays}`,
        summary: `Every grid of ${period === 'today' ? 'today' : 'tomorrow'} the seats know of - the duty's, its emergency grids and any other creator's. Listed means the seats hold its rounds; whether they can be joined is the next-hour column.`,
        items: rs.sort((x, y) => Number(y.live) - Number(x.live)).map((r) => r.item), fold: 'Not on chain' };
    };
    out.set(name, { today: cell('today'), next: cell('next') });
  }
  return out;
}
/** The newest tip the seats' GET /pending answers read, with its median time past: { top, mtp }. */
export function tipOf(pending, tip = null) {
  let top = Number(tip) || 0, mtp = null;
  for (const a of pending || []) {
    if (!a || !Number(a.tip)) continue;
    const g = (a.grids || []).find((x) => x.beacon && x.beacon.medianTimeMs != null), m = g ? Number(g.beacon.medianTimeMs) : null;
    if (Number(a.tip) > top) { top = Number(a.tip); mtp = m; } else if (Number(a.tip) === top && mtp == null) mtp = m;
  }
  return { top: top || null, mtp };
}

// WHO POSTS EACH DAY'S ROUNDS, AND WHO DID (kanban #702, 2026-10-26, the owner: "In health also say who posted that round" - "Since its pre
// deterministic"). A seat's GET /duty names, for the day whose posting covers today and the one covering the next 24 h, the duty order the
// census at that day's anchor gives and, per app, every posting seen with the node whose key signed it (the series' creator). TWO GRIDS A
// DAY (the owner's ruling, 2026-10-26 ~11:4xZ): the PRIMARY from rank 1 (rank 2 an hour later if nothing is posted, then rank 3), and a
// BACKUP from rank 2 (from 02:00 UTC of the duty day, rank 3 from 03:00) - only one is played per window, the primary while its committee
// is drawn. A posting by a node ranked below the role's own (primary 1, backup 2) is a fallback, said as one. An app entry that names no
// role (a seat before the backup) is the primary. A node is named as the page names seats: the last part of its address (node-3), else its
// host, else its key's first 8 characters.
// dutyNotes(duty body) -> Map(app name -> { today, next }), each { t, tip } - the short words for the cell and the whole story for its tooltip
export const nodeLabel = (key, endpoint) => {
  if (endpoint) {
    try {
      const u = new URL(String(endpoint).replace(/^ws(s?):/, 'http$1:'));
      const last = u.pathname.split('/').filter(Boolean).pop();
      if (last) return last;
      return u.hostname.split('.')[0];
    } catch { /* not an address: the key */ }
  }
  return key ? String(key).slice(0, 8) : 'an unknown node';
};
const fullName = (key, endpoint, rank = null) => (endpoint ? `${String(endpoint).replace(/^(wss?|https?):\/\//, '')} (key ${String(key || '').slice(0, 8)}${rank ? `, rank ${rank}` : ''})`
  : `key ${String(key || '').slice(0, 16)}${rank ? ` (rank ${rank})` : ''}`);
const ROLE_RANK = Object.freeze({ primary: 1, backup: 2 });
export function dutyNotes(duty) {
  const out = new Map();
  if (!duty || !Array.isArray(duty.days)) return out;
  const hmUtc = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 16)} UTC` : '?'; };
  for (const d of duty.days) {
    const period = d.period === 'today' ? 'today' : d.period === 'next' ? 'next' : null;
    if (!period) continue;
    const order = d.order || [];
    const byKey = new Map(order.map((o) => [String(o.key).toLowerCase(), o]));
    const endpointOf = (key, given) => given || (byKey.get(String(key || '').toLowerCase()) || {}).endpoint;
    const name = (key, endpoint) => nodeLabel(key, endpointOf(key, endpoint));
    const head = [`The rounds of ${d.covers} are posted the day before by the nodes on duty${d.anchor != null ? `, drawn from the census at block ${Number(d.anchor).toLocaleString('en-US')}` : ''}:`,
      ...order.map((o) => `${o.rank}. ${fullName(o.key, o.endpoint)}: ${o.rank === 1 ? `the primary grid from ${hmUtc(o.dueFrom)}`
        : `${o.backupDueFrom ? `the backup grid from ${hmUtc(o.backupDueFrom)}${o.rank > 2 ? ' if rank 2 has not posted it' : ''}; ` : ''}the primary from ${hmUtc(o.dueFrom)} if nobody before it has posted`}`)];
    if (!order.length) head.push('no duty order yet: the day\'s anchor block is not there');
    // each app's primary and backup entries (an entry without a role is the primary)
    const apps = new Map();
    for (const a of d.apps || []) { const k = a.name || a.app; const m = apps.get(k) || {}; m[a.role === 'backup' ? 'backup' : 'primary'] = a; apps.set(k, m); }
    for (const [key, roles] of apps) {
      const lines = [...head], short = [], items = [];
      for (const role of ['primary', 'backup']) {
        const a = roles[role];
        if (!a) continue;
        const own = ROLE_RANK[role], Role = role === 'primary' ? 'Primary' : 'Backup';
        const owner = order.find((o) => o.rank === own) || null;
        const ps = a.postings || [];
        const main = ps.find((p) => !p.emergency) || ps[0] || null;
        const late = (p) => !!p.fallback || (Number(p.posterRank) > own);
        const due = owner ? (role === 'backup' && owner.backupDueFrom ? owner.backupDueFrom : owner.dueFrom) : null;
        const ownerSays = owner ? fullName(owner.key, owner.endpoint, own) : `rank ${own} (none in this census)`;
        for (const p of ps) {
          const who = p.poster ? fullName(p.poster, endpointOf(p.poster, p.posterEndpoint), p.posterRank) : 'a key outside the census';
          const where = p.height != null ? `block ${Number(p.height).toLocaleString('en-US')}` : 'the mempool';
          lines.push(`${Role}: ${p.emergency ? 'emergency grid' : 'posted'} by ${who} in ${String(p.txid).slice(0, 10)}, ${where}${late(p) ? `, a fallback: rank ${own} did not post in its hour` : ''}`);
        }
        // the same as rows for the panel: one per poster (its grids counted), or the one waiting
        const rows = new Map();
        for (const p of ps) {
          const who = p.poster ? name(p.poster, endpointOf(p.poster, p.posterEndpoint)) : 'a key outside the census';
          const k = `${who}|${p.emergency ? 1 : 0}|${p.height != null ? 1 : 0}`, w = rows.get(k);
          if (w) { w.n++; w.detail += `, ${String(p.txid).slice(0, 10)}`; continue; }
          rows.set(k, { s: p.height != null ? 'ok' : 'warn', live: true, when: Role,
            say: `${p.emergency ? 'emergency grid' : 'posted'} by ${who}${p.height != null ? ` in block ${Number(p.height).toLocaleString('en-US')}` : ', waiting to be mined'}${late(p) ? ` (fallback: rank ${own} did not post)` : ''}`,
            detail: String(p.txid).slice(0, 10), n: 1 });
        }
        items.push(...rows.values());
        if (!ps.length) items.push(owner
          ? { s: a.state === 'missed' ? 'bad' : 'warn', live: true, when: Role, say: a.state === 'missed' ? `${name(owner.key, owner.endpoint)} missed its hour; the next node on duty posts it`
            : a.state === 'due' ? `due from ${hmUtc(due)} by ${name(owner.key, owner.endpoint)}, not posted yet` : `${name(owner.key, owner.endpoint)} posts it from ${hmUtc(due)}` }
          : { s: 'bad', live: true, when: Role, say: `no node of this census holds rank ${own}` });
        if (main) {
          const who = main.poster ? name(main.poster, main.posterEndpoint) : 'a key outside the census';
          const fb = late(main) && main.posterRank ? ` (fallback, rank ${main.posterRank})` : '';
          short.push(role === 'primary' ? `${main.emergency ? 'emergency grid by' : 'by'} ${who}${fb}` : `backup ${main.emergency ? 'emergency grid ' : ''}by ${who}${fb}`);
        } else if (owner) {
          const missed = a.state === 'missed' ? ' (missed)' : '';
          short.push(role === 'primary' ? `on duty: ${name(owner.key, owner.endpoint)}${missed}` : `backup: ${name(owner.key, owner.endpoint)}${missed}`);
          lines.push(`${Role}: ${a.state === 'missed' ? `${ownerSays} did not post it in its hour: the next node on duty posts it.` : a.state === 'due' ? `due from ${hmUtc(due)} from ${ownerSays}, not posted yet.` : `${ownerSays}, from ${hmUtc(due)}: not due yet.`}`);
        } else { short.push(role === 'primary' ? 'no duty order yet' : 'backup: nobody yet'); lines.push(`${Role}: no node of this census holds rank ${own}.`); }
      }
      const was = out.get(key) || {};
      // THE PANEL IN ROWS, AS THE ROUNDS' PANEL (2026-10-26 ~15:00Z, the owner: "tomorrow is still the old format"): one line on what it
      // is, a row for the primary and the backup, the duty order folded below
      out.set(key, { ...was, [period]: { t: short.join(' · '), tip: lines.join('\n'),
        summary: `The rounds of ${d.covers} are posted the day before by the nodes on duty${d.anchor != null ? ` (census at block ${Number(d.anchor).toLocaleString('en-US')})` : ''}.`,
        items: [...items, ...order.map((o) => ({ s: '', live: false, when: `${o.rank}. ${nodeLabel(o.key, o.endpoint)}`,
          say: o.rank === 1 ? `primary from ${hmUtc(o.dueFrom)}` : `${o.backupDueFrom ? `backup from ${hmUtc(o.backupDueFrom)}, ` : ''}primary from ${hmUtc(o.dueFrom)} if nobody before it posted`,
          detail: fullName(o.key, o.endpoint) }))],
        fold: order.length ? 'Duty order' : null } });
    }
  }
  return out;
}
/** A round-posting cell (roundPosting) with who is on duty or who posted beside it, the duty's story added to its tooltip. */
export function withDuty(cell, note) {
  if (!note) return cell;
  const base = cell && typeof cell === 'object' ? cell : { t: cell == null ? '-' : String(cell) };
  const rows = note.items ? { summary: note.summary, items: note.items, fold: note.fold } : {};
  return [{ ...(base.items ? {} : rows), ...base, tip: base.tip ? `${base.tip}\n\n${note.tip}` : note.tip }, { t: note.t, c: 'muted', tip: note.tip, ...rows }];
}

/** How old a kept copy is: its oldest answer's time (a copy is as old as the oldest thing it shows). */
export const ageOf = (snap) => {
  const t = Object.values((snap && snap.answers) || {}).map((a) => Number(a.atMs) || 0).filter(Boolean);
  return t.length ? Math.min(...t) : Number((snap && snap.atMs) || 0);
};

// makeHealth({ H, $, window }): H the React views (window.ArenaHealth; a stand-in that draws nothing in the worker), $ the page's elements by
// id, window where the read leaves ARENA_HEALTH for probes
export function makeHealth({ H, $, window = {} }) {
  const sat = (v) => (v == null || v === '' ? '-' : Number(v).toLocaleString('en-US'));
  const satMsat = (v) => (v == null ? '-' : Math.floor(Number(v) / 1000).toLocaleString('en-US'));
  // A TABLE AS DATA (kanban #564): head, rows of cells - text, { t, c } (text in a class), { bar: [have, need] } or a list of those - and
  // the words for none; drawn by React's Table
  const cut = (h, n = 8) => (h ? String(h).slice(0, n) : '-');
  const fedCell = (fid) => { const n = fedNoOf(fid); return n ? [`Federation ${n}`, { t: cut(fid, 8), c: 'muted mono' }] : { t: cut(fid, 12), c: 'mono' }; };
  const drawTable = (id, head, rows, empty, foot) => H.draw($(id), 'table', { head, rows, empty, foot });
  // FEDERATIONS BY NUMBER (kanban #557, 2026-10-20: "give the federation a running number starting with 1, and in the node list say where
  // it belongs, federation 1,2,3 or more"): 1, 2, 3 ... by the oldest record first, then by id - the same number on every card of the page
  let FED_NO = new Map();
  const numberFeds = (list) => { FED_NO = new Map([...(list || [])].sort((a, b) => (Number(a.height) - Number(b.height)) || String(a.federation).localeCompare(String(b.federation))).map((f, i) => [String(f.federation).toLowerCase(), i + 1])); };
  const fedNoOf = (fid) => { const k = String(fid || '').toLowerCase(); for (const [id, n] of FED_NO) if (id === k || (k.length < 64 && id.startsWith(k))) return n; return null; };
  // A SEAT'S ADDRESS THROUGH daily.json's ROUTES, as the Arena page takes it (the longest host/path key wins): a seat that
  // advertises its tailnet name is reached at its public name
  let ROUTES = {};
  const viaAlt = (u) => {
    let x; try { x = new URL(String(u).replace(/^ws(s?):/, 'http$1:')); } catch { return String(u); }
    const path = x.pathname.replace(/\/+$/, '');
    const hit = Object.keys(ROUTES).filter((k) => k === x.host || (x.host + path).startsWith(k + '/') || (x.host + path) === k).sort((p, q) => q.length - p.length)[0];
    return (hit ? x.protocol + '//' + ROUTES[hit] + path : x.origin + path).replace(/\/+$/, '');
  };
  // AT MOST SIX REQUESTS AT ONCE, each with its own 10 s: the nodes are not to be loaded by a page anybody can open
  let running = 0; const queue = [];
  const slot = () => new Promise((r) => { if (running < AT_ONCE) { running++; r(); } else queue.push(r); });
  const free = () => { const n = queue.shift(); if (n) n(); else running--; };
  // each answer through the read's transport: the nodes themselves (live), or a kept copy of their answers (replay)
  let transport = live;
  async function ask(base, path) {
    await slot();
    try { return await transport(base, path); } finally { free(); }
  }
  let SERVED = new Map();   // node key -> rounds it signed in the last 24 h (any seat's)
  // a node is ACTIVE when it answers now or signed a round in the last 24 h; one not asked yet counts as active until it is
  const activeOf = (n) => !n.version || (n.version && n.version.ok) || (SERVED.get(n.node) || 0) > 0;
  const first = async (seats, path) => { for (const s of seats) { const a = await ask(s, path); if (a.ok) return { seat: s, ...a }; } return null; };
  // EVERY SEAT ASKED AT ONCE, THE ANSWER THAT SCORES HIGHEST KEPT (`score(body)` -> [numbers], compared in order); the others are spare -
  // a kept copy leaves them out (kanban #686: they made most of its 2.9 MB), and a replay of it keeps the same one
  let spare = new Set();
  const best = async (seats, path, score) => {
    const got = (await Promise.all(seats.map(async (s) => { const a = await ask(s, path); return a.ok && a.body ? { seat: s, ...a, sc: score(a.body) } : null; }))).filter(Boolean);
    got.sort((x, y) => { for (let i = 0; i < Math.max(x.sc.length, y.sc.length); i++) { const d = (y.sc[i] || 0) - (x.sc[i] || 0); if (d) return d; } return 0; });
    for (const g of got.slice(1)) spare.add(keyOf(g.seat, path));
    return got[0] || null;
  };

  let reading = false, TIPS = [];   // the tips seen, kept with the copy (kanban #758): the chain's measured block time
  const say = (text, bad = false) => H.draw($('read'), 'line', { text, bad });   // the reading state, drawn by React like the rest
  // read({ transport, daily, atMs }): daily() gives daily.json, transport(base, path) each answer, atMs the time the data is of (a kept
  // copy's); true when every card was drawn, null while another read runs
  async function read(how = {}) {
    if (reading) return null; reading = true; say('reading …');
    transport = how.transport || live; spare = new Set();
    if (Array.isArray(how.tips)) TIPS = how.tips.slice();
    try {
      const daily = await (how.daily ? how.daily() : (await fetch('../daily.json', { cache: 'no-store' })).json());
      const net = daily.testnet || daily;
      ROUTES = net.alt || daily.alt || {};
      const seats = [...new Set((net.node || []).map(viaAlt))];
      // EVERY NODE OF THE CENSUS (2026-10-20: "On each automatic background refresh it is loosing the protocol reserve ... Make sure the
      // data is being updated properly"): every seat is asked and the newest census kept - not the first seat's, which after a restart or by the
      // rounds it holds can be days older (measured: 156,968 / 156,813 / 156,220 on three seats at once)
      const roles = await best(seats, '/roles', (b) => [Number(b.censusHeight) || 0, (b.nodes || []).length]);
      // the federations a node guards: from the records it signed (custody), then its advertisement - the census the seat reads can be older
      // than an advertisement that added a federation (kanban #557, 10-20: the fed2 seats guard Federation 3 too, the census at 156,968 said 2 only)
      const nodes = roles ? roles.body.nodes.map((n) => ({ ...n, guardianOf: [...new Set([...(n.custody || []).map((c) => c.federation), ...(n.guardianOf || [])])], base: viaAlt(n.endpoint) })) : seats.map((s) => ({ node: null, base: s, roles: [], serving: null, guardianOf: [] }));
      // THE SEATS' OWN READS run beside the nodes' (measured: /network-games asks every seat itself and took most of the first 15 s);
      // only the tip is waited for before the nodes' rows
      // the network's answers from the seat that holds the most: the newest tip, every federation record, every reserve entry (seats hold
      // different parts of the reserve ledger - measured 112,000 / 102,000 / 10,000 msat at once), the most proposals
      const [feesP, fedsP, gamesP, reservesP, fundingP, capP] = [['/fees', (b) => [Number(b.tip) || 0]], ['/federations', (b) => [(b.federations || []).length, Math.max(0, ...(b.federations || []).map((f) => Number(f.height) || 0))]],
        ['/network-games', (b) => [(b.games || []).length, (b.seats || []).length]], ['/reserves', (b) => [Number(b.entries) || 0, Number(b.totalMsat) || 0]], ['/funding', (b) => [(b.proposals || []).length]], ['/capacity', (b) => [(b.federations || []).length]]]
        .map(([p, score]) => (score ? best(seats, p, score) : first(seats, p)));
      // ACTIVE IN THE LAST 24 HOURS (2026-10-20: "mark it as active in the last 24 hours and inactive"): the census nodes that signed a
      // round result in that window, from every seat's GET /served (each holds its own results, so they are merged)
      { const to = Date.now(), from = to - 86400000;
        const got = await Promise.all(seats.map((s) => ask(s, `/served?to=${to}&from=${from}`)));
        SERVED = new Map();
        for (const a of got) if (a.ok && a.body) for (const x of a.body.nodes || []) SERVED.set(x.key, Math.max(SERVED.get(x.key) || 0, Number(x.rounds) || 0)); }
      const fees = await feesP;
      const tip = fees ? fees.body.tip : null;
      let feds = null, reserves = null, funding = null;
      // EACH NODE'S OWN DOORS: its version first - a node that does not answer that is red and is asked nothing more (measured on
      // preview UI 246: asking every door of every node, the unreachable ones' 10 s each held the page at "reading" past 60 s)
      // painted as each one answers: a node that does not answer holds its slot for 10 s, and the rows of those that do are not held with it
      paintNodes(nodes, tip);
      await Promise.all(nodes.map(async (n) => { n.version = await ask(n.base, '/owner/version'); paintNodes(nodes, tip); }));
      paintNetwork({ tip, nodes, seats, roles, feds, reserves });
      paintNodes(nodes, tip);
      say('reading each node … (' + nodes.filter((n) => n.version.ok).length + ' of ' + nodes.length + ' answered)');
      await Promise.all(nodes.filter((n) => n.version.ok).map(async (n) => {
        // and its uptime (kanban #756, GET /uptime): 24 h, 7 days, 30 days, all time - the 24 h marked when below inclusion
        const [b, d, lc, gc, fd, up] = await Promise.all([ask(n.base, '/owner/bond'), ask(n.base, '/dashboard.json'), ask(n.base, '/liquidity-claim'), ask(n.base, '/gateway-claim'), ask(n.base, '/founding'), ask(n.base, '/uptime')]);
        Object.assign(n, { bond: b, dash: d, liq: lc, gw: gc, found: fd, uptime: up });
      }));
      [feds, reserves, funding] = await Promise.all([fedsP, reservesP, fundingP]);
      paintNetwork({ tip, nodes, seats, roles, feds, reserves, funding });
      paintNodes(nodes, tip);
      const fedList = feds ? feds.body.federations : [];
      numberFeds(fedList); paintNodes(nodes, tip);
      fedList.sort((a, b) => (fedNoOf(a.federation) || 99) - (fedNoOf(b.federation) || 99));   // the tables in number order (kanban #557)
      paintCapacity(await capP, fedList);
      paintFeds(fedList);
      paintFounding(nodes, fedList, await membersOf(nodes));
      await paintGateways(fedList, seats, nodes);
      // THE SEATS' GET /pending beside the rest (kanban #686, 2026-10-26 measurement: a node that reads its chain through a bridge takes
      // 7 s warm and past 20 s cold): its two tables come when it does, the cards below are not held for it
      pendingRead = null; postings = null; duties = null; every = null;
      const pendingP = paintPending(seats);
      // the rounds posted for each app (kanban #692): the grids' versions from the seat that expects the most, the committees from one seat's rounds
      const expectedP = best(seats, '/expected', (b) => [(b.expected || []).length]), roundsP = first(seats, '/rounds?next=1');
      // and whether the rounds of the next hour are seated (kanban #758): every seat's listing, the lobby's own ask
      nowRounds = null;
      const nowP = Promise.all(seats.map((s) => ask(s, NOW_ROUNDS)));
      // and who is on duty for each day, who posted it (kanban #702): the seat that has seen the most postings
      const dutyP = best(seats, '/duty', (b) => [(b.days || []).reduce((s, d) => s + (d.apps || []).reduce((x, y) => x + (y.postings || []).length, 0), 0), (b.days || []).length]);
      await paintLiquidity(fedList, nodes, tip);
      paintLnd(nodes);
      paintMachines(nodes);
      const games = await gamesP;
      paintApps(games, nodes);
      paintFees(fees);
      paintReferral(await best(seats, '/referral-fees', (b) => [Number(b.totalMsat) || 0, (b.programs || []).length]));
      say('read ' + new Date().toISOString().slice(11, 19) + ' UTC · ' + nodes.length + ' nodes asked');
      await pendingP;
      const [ex, rd, dt] = await Promise.all([expectedP, roundsP, dutyP]);
      duties = dutyNotes(dt ? dt.body : null);
      postings = roundPosting({ games: games ? games.body.games : [], pending: pendingRead || [], expected: ex ? ex.body.expected || [] : [],
        rounds: rd ? rd.body.rounds || [] : [], nowMs: Date.now(), fedNo: fedNoOf });
      // the tip the seats read, noted with when it was first seen: the chain's measured block time (blockClock)
      { const { top, mtp } = tipOf(pendingRead || []); TIPS = noteTip(TIPS, { h: top, mtpMs: mtp, atMs: how.atMs || Date.now() }); }
      const lists = (await nowP).map((a) => (a.ok && a.body ? a.body : null));
      nowRounds = roundSeating({ games: games ? games.body.games : [], lists, nowMs: how.atMs || Date.now(),
        answering: nodes.filter((n) => n.node && n.version && n.version.ok).map((n) => n.node),
        posted: (name) => { const p = postings && postings.get(name); return !!(p && p.today && /^(posted|scheduled)/.test(String(p.today.t))); } });
      every = allPostings({ games: games ? games.body.games : [], pending: pendingRead || [], expected: ex ? ex.body.expected || [] : [], duty: dt ? dt.body : null,
        nowMs: how.atMs || Date.now(), clock: blockClock(TIPS), seating: seatingOf({ games: games ? games.body.games : [], lists, nowMs: how.atMs || Date.now() }) });
      paintApps(games, nodes);
      window.ARENA_HEALTH = { atMs: how.atMs || Date.now(), tip, nodes: nodes.length, answered: nodes.filter((n) => n.version && n.version.ok).length };
      return true;
    } catch (e) { say('could not read the network: ' + e.message, true); return false; }
    finally { reading = false; transport = live; }
  }

  function paintNetwork({ tip, nodes, seats, roles, feds, reserves, funding }) {
    const up = nodes.filter((n) => n.version && n.version.ok).length;
    const protos = new Map(); for (const n of nodes) if (n.version && n.version.ok) { const p = Math.max(...(n.version.body.protocols || [0])); protos.set(p, (protos.get(p) || 0) + 1); }
    // every census node's bond: its own answer, else the census's (a node that does not answer still has a bond)
    const bonds = nodes.reduce((s, n) => s + (n.bond && n.bond.ok && n.bond.body.bond ? Number(n.bond.body.bond.sats) : Number(n.bondSats || 0)), 0);
    const facts = [
      ['Bitcoin tip (testnet4)', tip == null ? '-' : sat(tip), tip == null ? 'bad' : ''],
      ['Census nodes', `${nodes.filter(activeOf).length} active of ${nodes.length}` + (roles ? ' (census at ' + sat(roles.body.censusHeight) + ')' : ''), roles ? '' : 'bad'],
      ['Answering (active nodes)', up + ' of ' + nodes.filter(activeOf).length, up >= nodes.filter(activeOf).length ? 'ok' : up >= nodes.filter(activeOf).length * 0.7 ? 'warn' : 'bad'],
      ['Newest protocol run', [...protos].sort((a, b) => b[0] - a[0]).map(([p, c]) => p + ' on ' + c).join(', ') || '-', protos.size > 1 ? 'warn' : 'ok'],
      ['Bonds proven (active nodes)', sat(nodes.filter(activeOf).reduce((s, n) => s + (n.bond && n.bond.ok && n.bond.body.bond ? Number(n.bond.body.bond.sats) : Number(n.bondSats || 0)), 0)) + ' sat · all ' + sat(bonds), ''],
      ['Federations', feds ? feds.body.federations.length : '-', feds ? '' : 'bad'],
      ['Protocol reserves', reserves ? satMsat(reserves.body.totalMsat) + ' sat' : '-', ''],
      ['Seats in daily.json', seats.length, ''],
      // THE NEWEST SETTLEMENT any node's dashboard shows, and how long ago: rounds that stopped settling show here first
      ...(() => { const last = Math.max(0, ...nodes.flatMap((n) => (n.dash && n.dash.ok ? n.dash.body.settlements || [] : []).map((x) => Number(x.madeMs) || 0)));
        if (!last) return [['Last settlement', '-', 'muted']];
        const h = (Date.now() - last) / 3600000;
        return [['Last settlement (any node)', h < 1 ? Math.round(h * 60) + ' min ago' : Math.round(h) + ' h ago', h > 26 ? 'warn' : 'ok']]; })(),
      ['Funding proposals', funding ? String(funding.body.proposals.length) + (funding.body.leaderboards.length ? ' · ' + funding.body.leaderboards.length + ' leaderboard payouts' : '') : '-', ''],
    ];
    H.draw($('network'), 'facts', { items: facts });
  }

  function paintNodes(nodes, tip) {
    const served = Object.fromEntries(SERVED);
    H.draw($('nodes'), 'nodes', { rows: nodes.map((n) => H.nodeView(n, { tip, served, fedNo: fedNoOf, active: activeOf(n) })) });
  }

  // CAPACITY PRESSURE (spec §23A.3a, kanban #543): each federation's band from the seats' GET /capacity - how full it is against what its
  // bonds cover, the bond B* each guardian would need for 50 % load and who is below it, the gateways' peg-ins against P* - and the
  // network's band (the lowest-load OPEN federation's: new deposits go there) with the installer's minimum bond
  function paintCapacity(cap, feds = []) {
    if (cap && cap.body) window.ARENA_HEALTH_CAPACITY = cap.body;
    H.draw($('capacity'), 'capacity', { view: H.capacityView(cap && cap.body, feds, fedNoOf) });
  }

  function paintFeds(list) {
    const rows = list.map((f) => {
      const load = f.exposureCapSats ? Number(f.load || 0) : null;
      // the dot is the worse of its status and its load (2026-10-20: "Why is Federation 1 green when the load is 433 %?"): an OPEN
      // federation at 100 % or more takes no deposits, so it is red and says FULL, as the capacity card does; from 70 % it is yellow
      const st = String(f.status || ''), byStatus = st === 'OPEN' || st === 'ACTIVE' ? 'ok' : st ? 'warn' : 'bad';
      const byLoad = load == null ? 'ok' : load >= 1 ? 'bad' : load >= 0.7 ? 'warn' : 'ok';
      const RANK = { ok: 0, warn: 1, bad: 2 }, c = RANK[byLoad] > RANK[byStatus] ? byLoad : byStatus;
      return { key: f.federation, dot: c, cells: [fedCell(f.federation), st === 'OPEN' && load != null && load >= 1 ? [st, '·', { t: 'FULL', c: 'bad' }] : (st || '-'), sat(f.height),
        Array.isArray(f.signers) ? f.signers.length : f.signers, sat(f.reserveSats), sat(f.exposureCapSats),
        load == null ? '-' : { t: `${(load * 100).toFixed(0)} %`, c: load >= 1 ? 'bad' : load >= 0.7 ? 'warn' : 'ok' }] };
    });
    drawTable('feds', ['Federation', 'Status', 'Record height', 'Signers', 'Reserve (sat)', 'Cap (sat)', 'Load'], rows, 'no federation record read');
  }

  // WAITING FOR A FOUNDING (kanban #585, 2026-10-22: "shows the 10 nodes waiting for a founding event so we know in the future if
  // they're ready to be founded" - and "Tu das Dashboard so umbauen dass es solchen Diskrepanzen nicht geben kann ... Wenn 8 von 10 ready
  // sind müssen auch 8 da stehen"): ONE LIST, from one seat - every node the cohort can draw, each asked by that seat (GET /founding?members=1:
  // the page cannot reach nodes on private addresses) - and every number on the card is counted from those rows
  async function membersOf(nodes) {
    const fb = (n) => (n.found && n.found.ok ? n.found.body : null);
    const seats = nodes.filter((n) => fb(n) && fb(n).ready && fb(n).ready.cohort).sort((a, b) => fb(b).ready.cohort.height - fb(a).ready.cohort.height);
    for (const n of seats) { const a = await ask(n.base, '/founding?members=1'); if (a.ok && a.body && a.body.members) return a.body.members; }
    return null;
  }
  function paintFounding(nodes, feds, mem) {
    const fb = (n) => (n.found && n.found.ok ? n.found.body : null);
    // the founding most nodes name (an old draw on nodes not restarted yet may hold more codes), then the newest trigger
    const runs = nodes.map(fb).filter((b) => b && b.id);
    const byId = new Map(); for (const b of runs) { const w = byId.get(b.id); if (!w || (b.codes || []).length > (w.codes || []).length) byId.set(b.id, b); }
    const named = new Map(); for (const b of runs) named.set(b.id, (named.get(b.id) || 0) + 1);
    const th = (b) => Number((b.trigger && b.trigger.height) || 0);
    const run = [...byId.values()].sort((x, y) => (named.get(y.id) - named.get(x.id)) || (th(y) - th(x)) || ((y.codes || []).length - (x.codes || []).length))[0] || null;
    const live = run && !run.void && run.federation !== true ? run : null;
    const seated = new Map((live ? live.seated || [] : []).map((x) => [String(x.node || x).toLowerCase(), x]));
    const coded = new Set((live ? live.codes || [] : []).map((c) => String(c.node).toLowerCase()));
    // the rows: the seat's list, and any drawn node it does not list
    const byKey = new Map(((mem && mem.nodes) || []).map((m) => [String(m.node).toLowerCase(), m]));
    for (const k of seated.keys()) if (!byKey.has(k)) byKey.set(k, { node: k, endpoint: '', state: 'not listed' });
    const WORD = { setup: ['ready', 'ok'], running: ['its guardian runs a federation', 'warn'], none: ['no guardian in setup', 'bad'], off: ['founding is off on this node', 'bad'],
      'older release': ['an older release (says nothing)', 'warn'], 'no answer': ['no answer', 'bad'], 'not listed': ['not in the seat\'s list', 'warn'] };
    // ONLY THE NODES THAT CAN BE FOUNDED (kanban #599, 2026-10-23: "founding is off on this node, an older release, its guardian runs a
    // federation raus und auch in den zusammenfassungen nicht anzeigen damit es konsistent bleibt"): those three are left out of the rows, and
    // every number on the card is counted from the rows shown
    const CANNOT = new Set(['off', 'older release', 'running']);
    const rows = [...byKey.values()].filter((m) => !CANNOT.has(m.state)).map((m) => {
      const k = String(m.node).toLowerCase(), s = seated.get(k), w = WORD[m.state] || [String(m.state), 'warn'];
      const part = !live ? '' : s ? (coded.has(k) ? { t: `drawn #${s.position + 1} · code ✓`, c: 'ok' } : { t: `drawn #${s.position + 1} · no code yet`, c: 'bad' })
        : (live.alternates || []).map((x) => String(x).toLowerCase()).includes(k) ? 'alternate' : '';
      return { key: k, dot: w[1] === 'ok' ? 'ok' : w[1], ready: m.state === 'setup', drawn: s ? s.position : 99, cells: [{ t: cut(k, 12), c: 'mono' }, String(m.endpoint || '').replace(/^https?:\/\//, ''), { t: w[0], c: w[1] }, part] };
    }).sort((x, y) => (x.drawn - y.drawn) || (Number(y.ready) - Number(x.ready)));
    const nReady = rows.filter((r) => r.ready).length;
    const drawnRows = rows.filter((r) => seated.has(r.key)), drawnCoded = drawnRows.filter((r) => coded.has(r.key)).length;
    H.draw($('founding-facts'), 'facts', { items: [
      ['Can be drawn', mem ? `${rows.length} nodes (${mem.needed} operators needed)` : 'no seat answered its list yet', mem ? (rows.length >= mem.needed ? 'ok' : 'warn') : 'muted'],
      ['Ready (guardian waits in setup)', `${nReady} of ${rows.length}`, rows.length && nReady >= 10 ? 'ok' : nReady ? 'warn' : 'bad'],
      ['Founding', live ? `${cut(live.id, 8)}: ${drawnRows.length} drawn, ${drawnCoded} posted their code · until block ${sat(live.windowEnd)}` : run && run.federation ? `${cut(run.id, 8)}: the federation runs` : 'none running',
        live ? (drawnCoded >= drawnRows.length ? 'ok' : 'warn') : run && run.federation ? 'ok' : 'muted'],
    ] });
    drawTable('founding', ['Node key', 'Address', 'State', 'This founding'], rows, 'no seat answered the list of nodes that can be drawn yet',
      mem ? `as seat-counted at block ${sat(mem.height)} - each node asked by that seat` : null);
  }

  // WHAT THE NETWORK WAITS FOR (kanban #560, 2026-10-20: "Make sure that /health is also showing this table by asking the nodes"):
  // every seat's GET /pending, merged - a grid by its publication, a peg-in by its outpoint, the furthest reading of each kept
  async function paintPending(seats) {
    const answers = (await Promise.all(seats.map((s) => ask(s, '/pending')))).filter((a) => a && a.ok && a.body && a.body.ok).map((a) => a.body);
    pendingRead = answers;
    const grids = new Map(), pegs = new Map(), ads = new Map();
    for (const a of answers) {
      for (const g of a.grids || []) { const k = g.publication.txid, was = grids.get(k); if (!was || (g.beacon.depth || 0) > (was.beacon.depth || 0) || (g.publication.confirmations || 0) > (was.publication.confirmations || 0)) grids.set(k, { ...g, tip: a.tip }); }
      for (const p of a.pegIns || []) { const k = p.txid + ':' + p.vout, was = pegs.get(k); if (!was || (p.confirmations || 0) > (was.confirmations || 0)) pegs.set(k, p); }
      for (const x of a.adverts || []) if (!ads.has(x.node)) ads.set(x.node, { ...x, tip: a.tip });
    }
    const hhmm = (ms) => new Date(Number(ms)).toISOString().slice(11, 16) + ' UTC';
    // each row as table data (kanban #564): what, tx, confirmations, how far (a bar), what it waits for
    const W = [null, 'mono', null, null, 'wrap'];
    const rows = [];
    // THE CHAIN SPLIT (2026-10-20, "Mining view mismatch, what is true"): each node names its tip and the rival tips of the same
    // (or more) work it knows; nodes on different tips, or a rival of the same work, mean the next block decides - and everything below
    // is read on each node's own branch
    { const tips = new Map(), rivals = new Map();
      for (const a of answers) if (a.chain) { tips.set(a.chain.hash, a.chain.height); for (const r of a.chain.rivals || []) if (r.work !== 'less') rivals.set(r.hash, r); }
      for (const h of tips.keys()) rivals.delete(h);
      if (tips.size > 1 || rivals.size) {
        const fork = Math.min(...[...rivals.values()].map((r) => r.forkHeight + 1), Infinity);
        const on = [...tips].map(([h, n]) => `${cut(h, 10)} (${sat(n)})`).join(', ');
        const other = [...rivals.values()].map((r) => `${cut(r.hash, 10)} (${sat(r.height)}, ${r.work === 'same' ? 'the same work' : 'more work, not taken'})`).join(', ');
        rows.push({ key: 'split', dot: 'warn', cls: W, cells: [{ t: `the chain is split${Number.isFinite(fork) ? ` from block ${sat(fork)}` : ''}`, c: 'strong' }, '-', '-', '',
          `the nodes follow ${on}${other ? `; another branch: ${other}` : ''}. The next block decides which one stays - until then, confirmations below count on the nodes' own branch, and a public explorer may show the other`] });
      }
    }
    for (const g of grids.values()) {
      const pub = g.publication, b = g.beacon;
      const waits = !pub.height ? `its publication must confirm${pub.inMempool ? ' (in the mempool)' : ''}`
        : b.height === null ? `beacon: the first block whose median time passes ${hhmm(g.committeeTimeMs)} (median time now ${b.medianTimeMs ? hhmm(b.medianTimeMs) : '-'}), then 6 deep`
        : b.depth < 6 ? `beacon block ${sat(b.height)}: ${b.depth} of 6 deep, then its rounds are posted` : `beacon ${sat(b.height)} is ${b.depth} deep: its rounds are posted`;
      rows.push({ key: pub.txid, dot: b.depth >= 6 ? 'ok' : 'warn', cls: W, cells: [`${g.game} grid: ${g.slots} rounds, entry from ${new Date(Number(g.firstWindowMs)).toISOString().slice(5, 16).replace('T', ' ')} UTC`,
        cut(pub.txid, 10), sat(pub.confirmations), { bar: [b.height === null ? 0 : b.depth, 6] }, waits] });
    }
    for (const p of pegs.values()) {
      const left = p.finality && p.confirmations != null ? Math.max(0, p.finality + 1 - p.confirmations) : null;
      const waits = !p.onChain ? 'not found unspent on this node\'s chain (spent: counted, or not confirmed yet)'
        : left ? `${p.confirmations} of ${p.finality} confirmations: counts as the gateway's e-cash in about ${left >= 6 ? Math.round(left / 6) + ' h' : left * 10 + ' min'}` : 'final: counted';
      rows.push({ key: p.txid + ':' + p.vout, dot: left === 0 ? 'ok' : 'warn', cls: W, cells: [[`peg-in ${sat(p.sats)} sat to ${cut(p.node, 10)}'s gateway in`, ...[].concat(fedCell(p.federation))],
        `${cut(p.txid, 10)}:${p.vout}`, sat(p.confirmations), { bar: [p.confirmations || 0, p.finality || 0] }, waits] });
    }
    for (const x of ads.values()) {
      const left = Math.max(0, Number(x.takenByTip) - Number(x.tip));
      rows.push({ key: 'ad' + x.node, dot: 'warn', cls: W, cells: [[`advertisement of ${cut(x.node, 10)}`, { t: String(x.endpoint).replace(/^wss?:\/\//, ''), c: 'muted' }], '-', '-', '',
        `${x.changes.join('; ')} - the census takes it by block ${sat(x.takenByTip)} (${left ? `in ${left} block${left === 1 ? '' : 's'}` : 'now'})`] });
    }
    // THE ONE TRANSACTION LIST (2026-10-20: "Make sure that both show the same number of transactions at all times"): every
    // node's txs, one row per transaction, its furthest confirmation kept, and how many of the answering nodes name it
    { const all = new Map();
      for (const a of answers) for (const t of a.txs || []) {
        const was = all.get(t.txid);
        if (!was) all.set(t.txid, { ...t, seenBy: 1 });
        else { was.seenBy++; if ((t.confirmations || 0) > (was.confirmations || 0)) Object.assign(was, { ...t, seenBy: was.seenBy }); }
      }
      const fedText = (fid) => { const n = fedNoOf(fid); return n ? [`Federation ${n}`, { t: cut(fid, 8), c: 'muted mono' }] : [{ t: cut(fid, 12), c: 'mono' }]; };
      const label = (t) => t.kind === 'advert update' ? `advertisement update of ${cut(t.node, 10)}${t.protocols ? ` (protocols to ${t.protocols})` : ''}`
        : t.kind === 'bond' ? `bond of ${cut(t.node, 10)}${t.maturity ? ` (matures ${sat(t.maturity)})` : ''}`
        : t.kind === 'grid publication' ? `${t.game} grid publication, ${t.slots} rounds`
        : t.kind === 'peg-in' ? ['peg-in', ...(t.outputs || []).flatMap((o, i) => [`${i ? '; ' : ''}:${o.vout} ${sat(o.sats)} sat to ${cut(o.node, 8)} in`, ...fedText(o.federation)])]
        : t.kind === 'funding' ? `funding of ${cut(t.parentOf, 10)}` : String(t.kind);
      const list = [...all.values()].sort((x, y) => (x.confirmations || 0) - (y.confirmations || 0) || String(x.kind).localeCompare(String(y.kind)));
      H.draw($('txs-count'), 'line', { text: `(${list.length})` });
      drawTable('pending-txs', ['Tx', 'What', 'Confirmations', 'Nodes'], list.map((t) => ({ key: t.txid, cls: ['mono', 'wrap'],
        cells: [cut(t.txid, 10), label(t), t.inMempool ? 'in the mempool' : `${sat(t.confirmations)}${t.height ? ` (block ${sat(t.height)})` : ''}`, `${t.seenBy} of ${answers.length}`] })),
        answers.length ? 'no transaction on its way' : 'no node answers GET /pending yet'); }
    drawTable('pending', ['What', 'Tx', 'Confirmations', '', 'Waits for'], rows, answers.length ? 'nothing pending on ' + answers.length + ' node(s)' : 'no node answers GET /pending yet');
    return answers;
  }

  async function paintGateways(feds, seats, nodes) {
    const rows = [], pending = [];
    // PENDING GATEWAYS (kanban #552, 2026-10-20: "display the pending gateways that still have pegins confirming (along with their
    // confirmation) or are pending in some other way"): every gateway a federation's seat measured that is not seated, or holds its seat
    // below the minimums, with what it waits for; a peg-in still confirming shows its confirmations against the federation's finality
    // (as its operator's claim states them) and about when it counts, a block taken as 10 minutes
    function pendingRows(fed, b) {
      const out = [], gws = b.gateways || {};
      const pegs = (node) => ((gws[node] && gws[node].pending && gws[node].pending.pegIns) || []).flatMap((p) => {
        const fin = Number(p.finality) || 0, conf = Number(p.confirmations) || 0, left = Math.max(0, fin + 1 - conf);
        const eta = left ? (left >= 6 ? `about ${Math.round(left / 6)} h` : `about ${left * 10} min`) : 'now';
        return [`· peg-in ${sat(p.sats)} sat ·`, { t: `${conf} of ${fin || '?'}`, c: 'strong' }, `confirmations · counts in ${eta}`, { t: `${cut(p.txid, 8)}:${p.vout}`, c: 'mono muted' }, { bar: [conf, fin] }];
      });
      const row = (node, c, what) => out.push({ key: fed + node, dot: c, cls: [null, 'mono', 'wrap'], cells: [fedCell(fed), cut(node, 10), [what, ...pegs(node)]] });
      for (const n of b.belowMinimums || []) row(n, 'warn', `holds the seat below the minimums: ${((b.ineligible || []).find((x) => x.node === n) || {}).why || ''}`);
      for (const x of b.ineligible || []) if (!(b.belowMinimums || []).includes(x.node)) row(x.node, 'bad', `not eligible: ${x.why}`);
      for (const x of b.waiting || []) row(x.node, 'warn', `waits: ${x.why}`);
      return out;
    }
    const W = [null, null, null, 'mono', 'wrap'];
    for (const f of feds) {
      // A GUARDIAN SEAT RANKS ITS OWN FEDERATION ONLY (gateway-watch.js; the ?federation= is not read): the answer counts only from a
      // seat whose federationId is this one - the first seat that answers may guard the other federation
      let g = null;
      // EVERY SEAT OF THE FEDERATION ASKED, THE ONE WITH THE MOST SEATED KEPT (2026-10-20 "is this correct?": the first seat had just
      // restarted and judged with no census); a seat that has read no census yet answers 503 and is left out
      { const got = (await Promise.all(seats.map(async (s) => { const a = await ask(s, '/gateway-seats?federation=' + f.federation); return a.ok && a.body && a.body.federationId === f.federation ? { seat: s, ...a } : null; }))).filter(Boolean);
        got.sort((x, y) => ((y.body.seated || []).length - (x.body.seated || []).length) || ((x.body.ineligible || []).length - (y.body.ineligible || []).length));
        g = got[0] || null;
        for (const s of seats) if (!g || s !== g.seat) spare.add(keyOf(s, '/gateway-seats?federation=' + f.federation)); }
      if (!g) { rows.push({ key: f.federation, dot: 'bad', cls: W, cells: [fedCell(f.federation), { t: 'no guardian seat of this federation answered', c: 'bad' }, '', '', ''] }); continue; }
      const b = g.body, seated = b.seated || [], need = Number(b.seats) || 2;   // 2 seats, 1 for a draining federation (hard rule, 2026-10-20)
      pending.push(...pendingRows(f.federation, b));
      const c = seated.length >= need ? 'ok' : seated.length ? 'warn' : 'bad';
      rows.push({ key: f.federation, dot: c, cls: W, cells: [fedCell(f.federation), b.epoch, `${seated.length} of ${need}`, seated.map((x) => cut(x.node || x, 10)).join(', ') || '-', { t: b.why || '', c: 'muted' }] });
      // THE RUNNING EPOCH (kanban #552): the seats rank the last whole epoch; what this one would seat, and from which block
      if (b.next) rows.push({ key: f.federation + ':next', cls: W, cells: ['', { t: b.next.epoch, c: 'muted' }, { t: `${(b.next.seated || []).length} of ${need}`, c: 'muted' },
        { t: (b.next.seated || []).map((x) => cut(x, 10)).join(', ') || '-', c: 'muted' }, { t: `next epoch, from block ${sat(b.next.fromBlock)}: ${b.next.why || ''}`, c: 'muted' }] });
      // PEG-IN CLAIMED AND PROVED (kanban #559/#543): what each gateway's claim states, and how much of it the federation's own coins
      // show (its claimed outpoints that are federation coins); "not checked" while the seat runs code that does not read the coins
      for (const [node, x] of Object.entries(b.gateways || {})) rows.push({ key: f.federation + node, cls: W, cells: ['', '', '', { t: cut(node, 10), c: 'muted' },
        { t: `peg-in ${sat(x.pegInSats || 0)} sat claimed · ${x.provedPegInSats == null ? 'not checked' : sat(x.provedPegInSats) + ' sat proved by the federation\'s coins'}`, c: 'muted' }] });
    }
    const claims = nodes.filter((n) => n.gw && n.gw.ok).map((n) => `${cut(n.node, 10)} · LND ${cut(n.gw.body.lightningPubkey, 10)}`);
    drawTable('gateways', ['Federation', 'Epoch', 'Seated', 'Seats', 'Why'], rows, 'no federation', `Nodes that claim a gateway: ${claims.join(', ') || 'none'}`);
    drawTable('gw-pending', ['Federation', 'Node', 'Waits for'], pending, 'no gateway waiting');
  }

  async function paintLiquidity(feds, nodes, tip) {
    const providers = nodes.filter((n) => n.liq && n.liq.ok);
    const epoch = tip == null ? null : Math.floor(tip / 144);
    const weights = new Map();
    // THE NEWEST SIGNED SEATING of each federation - this epoch's, or the last one's while this one's gather has not run yet -
    // from the first of its guardians that holds one
    const used = new Map();
    if (epoch != null) for (const f of feds) {
      found: for (const e of [epoch, epoch - 1]) for (const n of nodes.filter((x) => (x.guardianOf || []).includes(f.federation))) {
        const s = await ask(n.base, `/liquidity-seating?federation=${f.federation}&epoch=${e}`);
        if (s.ok) { for (const p of s.body.providers || []) weights.set(f.federation.slice(0, 8) + ':' + p.node, p.weight); used.set(f.federation, e); break found; }
      }
    }
    const rows = providers.map((n) => {
      const c = n.liq.body, free = Number(c.freeSats || 0), given = (c.channels || []).reduce((s, x) => s + Number(x.capacitySats || 0), 0);
      const w = [...weights].filter(([k]) => k.endsWith(':' + n.node)).map(([k, v]) => k.split(':')[0] + ' ' + sat(v)).join(', ');
      const age = Math.round((Date.now() - Number(c.atMs || 0)) / 60000);
      const col = free + given >= 500000 ? 'ok' : 'warn';
      return { key: n.node, dot: col, cls: [null, 'mono', null, null, null, null, age > 20 ? 'warn' : null],
        cells: [{ t: cut(n.node, 12), c: 'mono' }, cut(c.lightningPubkey, 12), sat(free), `${(c.channels || []).length} · ${sat(given)} sat`, (c.funds || []).length,
          w || { t: 'not seated', c: 'muted' }, `${age} min ago`] };
    });
    drawTable('liquidity', ['Provider node', 'LND', 'Free (claimed, sat)', 'Channels given', 'Coins proven by signature',
      `Seating weight (epoch ${[...new Set(used.values())].join(', ') || (epoch == null ? '-' : epoch)})`, 'Claim signed'], rows, 'no node serves a liquidity claim');
  }

  function paintLnd(nodes) {
    const rows = nodes.filter((n) => n.dash && n.dash.ok && n.dash.body.hosts && n.dash.body.hosts.lnd).map((n) => {
      const l = n.dash.body.hosts.lnd;
      const c = !l.synced ? 'bad' : Number(l.activeChannels || 0) === 0 ? 'warn' : 'ok';
      return { key: n.node, dot: c, cls: [null, null, 'mono'], cells: [{ t: cut(n.node, 12), c: 'mono' }, l.alias || '-', cut(l.pubkey, 12),
        l.synced ? { t: 'yes', c: 'ok' } : { t: 'no', c: 'bad' }, l.activeChannels, satMsat(l.localMsat), satMsat(l.remoteMsat), l.forwards30d == null ? '-' : l.forwards30d] };
    });
    drawTable('lnd', ['Node', 'Alias', 'LND key', 'Synced', 'Active channels', 'Local (sat)', 'Remote / inbound (sat)', 'Forwards 30 d'], rows, 'no node shows an LND on its dashboard');
  }

  // MACHINES AND APPS (kanban #597, testnet4 only): the nodes by the machine each names, with its load and what its nodes earned; every
  // app's newest version and what the nodes earned from it (HealthViews.jsx machinesView / appsView)
  function paintMachines(nodes) { H.draw($('machines'), 'machines', { view: H.machinesView(nodes) }); }
  // ROUNDS POSTED (kanban #692): the newest version's, today and the next 24 h (roundPosting above), once the seats' grids are read
  // AND WHO IS ON DUTY FOR THEM, WHO POSTED THEM (kanban #702): beside each cell, the whole story in its tooltip
  let pendingRead = null, postings = null, duties = null, nowRounds = null, every = null;
  function paintApps(g, nodes) {
    // GAMES AND MARKETS FOLDED IN HERE (2026-10-26 ~15:25Z, the owner: "Games and Markets is also deprecated if we have apps"): the one
    // number it had that Apps did not, the seats hosting the newest version
    const AH = ['App', 'Type', 'Newest version', 'Seats hosting', 'Next hour: seated / joinable', 'Postings today', 'Rounds today', 'Tomorrow', 'Earned by nodes (sat)', 'This month (sat)'];
    const hosting = (name, v) => Math.max(0, ...(g ? g.body.games : []).filter((x) => (x.name || x.title) === name && String(x.version) === String(v)).map((x) => (x.seats || []).length || 0));
    const wait = { t: 'reading …', c: 'muted' };
    const rows = H.appsView(g ? g.body.games : [], nodes).map((a) => { const p = postings && postings.get(a.name), d = duties && duties.get(a.name);
      const at = (k) => (p ? withDuty(p[k], d && d[k]) : postings ? withDuty('-', d && d[k]) : wait);
      // THE NEXT HOUR (kanban #758): seated and joinable rounds, red when none can be joined - the row's dot with it
      const now = nowRounds ? nowRounds.get(a.name) || { t: '-', c: 'muted' } : wait;
      return { key: a.name, dot: now.c === 'bad' ? 'bad' : now.c === 'warn' ? 'warn' : a.newest != null ? 'ok' : 'warn',
        cells: [a.title, a.type, a.newest == null ? '-' : String(a.newest), a.newest == null ? '-' : hosting(a.name, a.newest), now, every ? (every.get(a.name) || {}).today || { t: '-', c: 'muted' } : wait, at('today'), at('next'), sat(a.total), sat(a.month)] }; });
    drawTable('apps', AH, rows, 'no app read', 'summed from every answering node\'s dashboard - each node counts only its own share');
  }

  function paintFees(f) {
    if (!f) return H.draw($('fees'), 'facts', { items: [['Fees in force', 'no seat answered /fees', 'bad']] });
    const i = f.body.inForce || {};
    const facts = [['Node fee (round)', (i.roundNodeBps / 100) + ' %'], ['Donation (round)', (i.roundDonationBps / 100) + ' %'], ['Reserves (round)', (i.roundReserveBps / 100) + ' %'],
      ['Market node fee', (i.marketNodeBps / 100) + ' %'], ['Market donation', (i.marketDonationBps / 100) + ' %'], ['Market reserves', (i.marketReserveBps / 100) + ' %'],
      ['Items: nodes / reserves / devs', i.itemNodesPct + ' / ' + i.itemReservesPct + ' / ' + i.itemDevsPct + ' %'], ['Website share', i.websitePct + ' %']];
    H.draw($('fees'), 'facts', { items: facts.map(([k, v]) => [k, v, '']) });
  }

  // WHICH SITE EARNED WHAT (kanban #675): every referral program by the name its key said, what its website payouts came to (the seat that
  // indexed the most), and the share in force
  function paintReferral(r) {
    const RH = ['Program', 'Key', 'Payouts', 'Earned (sat)'];
    if (!r) return drawTable('referral', RH, [], 'no seat answered /referral-fees');
    const names = new Map((r.body.programs || []).map((p) => [p.site, p.name]));
    const sites = new Map((r.body.sites || []).map((x) => [x.site, x]));
    for (const [site] of names) if (!sites.has(site)) sites.set(site, { site, msat: '0', payouts: 0 });
    const rows = [...sites.values()].sort((a, b) => Number(BigInt(b.msat) - BigInt(a.msat))).map((x) => ({ key: x.site, dot: BigInt(x.msat) > 0n ? 'ok' : 'warn',
      cells: [names.get(x.site) || x.name || 'unnamed', x.site.slice(0, 16) + '…', String(x.payouts), sat(String(BigInt(x.msat) / 1000n))] }));
    drawTable('referral', RH, rows, 'no referral program yet', 'a program earns 10 % of the nodes\' fee on what its players stake; set one up in the owner area, Referrer');
  }

  // read(how); spare(): the doors the last read asked and did not use
  return { read, spare: () => new Set(spare), tips: () => TIPS.slice() };
}
