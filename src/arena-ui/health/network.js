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
    } else out[k] = a;
  }
  return out;
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

  let reading = false;
  const say = (text, bad = false) => H.draw($('read'), 'line', { text, bad });   // the reading state, drawn by React like the rest
  // read({ transport, daily, atMs }): daily() gives daily.json, transport(base, path) each answer, atMs the time the data is of (a kept
  // copy's); true when every card was drawn, null while another read runs
  async function read(how = {}) {
    if (reading) return null; reading = true; say('reading …');
    transport = how.transport || live; spare = new Set();
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
        ['/network-games', null], ['/reserves', (b) => [Number(b.entries) || 0, Number(b.totalMsat) || 0]], ['/funding', (b) => [(b.proposals || []).length]], ['/capacity', (b) => [(b.federations || []).length]]]
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
        const [b, d, lc, gc, fd] = await Promise.all([ask(n.base, '/owner/bond'), ask(n.base, '/dashboard.json'), ask(n.base, '/liquidity-claim'), ask(n.base, '/gateway-claim'), ask(n.base, '/founding')]);
        Object.assign(n, { bond: b, dash: d, liq: lc, gw: gc, found: fd });
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
      const pendingP = paintPending(seats);
      await paintLiquidity(fedList, nodes, tip);
      paintLnd(nodes);
      paintMachines(nodes);
      const games = await gamesP;
      paintGames(games);
      paintApps(games, nodes);
      paintFees(fees);
      paintReferral(await best(seats, '/referral-fees', (b) => [Number(b.totalMsat) || 0, (b.programs || []).length]));
      say('read ' + new Date().toISOString().slice(11, 19) + ' UTC · ' + nodes.length + ' nodes asked');
      await pendingP;
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
  function paintApps(g, nodes) {
    const AH = ['App', 'Type', 'Newest version', 'Earned by nodes (sat)', 'This month (sat)'];
    const rows = H.appsView(g ? g.body.games : [], nodes).map((a) => ({ key: a.name, dot: a.newest != null ? 'ok' : 'warn',
      cells: [a.title, a.type, a.newest == null ? '-' : String(a.newest), sat(a.total), sat(a.month)] }));
    drawTable('apps', AH, rows, 'no app read', 'summed from every answering node\'s dashboard - each node counts only its own share');
  }

  function paintGames(g) {
    const GH = ['Game or market', 'Type', 'Versions', 'Seats hosting (most of any version)'];
    if (!g) return drawTable('games', GH, [], 'no seat answered /network-games');
    const byName = new Map();
    for (const x of g.body.games) { const k = x.name || x.title; const a = byName.get(k) || { title: x.title || k, type: x.type, versions: [], seats: 0 }; a.versions.push(x.version); a.seats = Math.max(a.seats, (x.seats || []).length || 0); byName.set(k, a); }
    const rows = [...byName].map(([k, a]) => ({ key: k, dot: a.seats >= 3 ? 'ok' : a.seats ? 'warn' : 'bad',
      cells: [a.title, a.type || '-', a.versions.filter((v) => v != null).sort((p, q) => Number(p) - Number(q)).join(', ') || '-', a.seats] }));
    const answered = (g.body.seats || []).filter((s) => s.answered).length;
    drawTable('games', GH, rows, 'no game read', `${answered} of ${(g.body.seats || []).length} seats answered the games read`);
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
  return { read, spare: () => new Set(spare) };
}
