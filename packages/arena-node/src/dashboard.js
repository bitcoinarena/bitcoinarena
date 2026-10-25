// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// /Dashboard: WHAT THIS NODE EARNED, SPENT AND DID (2026-10-01 15:44/15:45, open list item 2 of 21:16).
//
// "Every node serves /Dashboard. An interactive page with charts. A node earns from the 5% node fee ... Each category has
// its own earnings, and totals for the day, the month, and the year. Categories: game/verify fee, settlement fee,
// guardian/custody fee, other earnings if any, Lightning costs, gateway costs, and absolute profit. Also: since when the
// node has been active, which rounds it checked and what it earned on each, which settlements it made, and which
// federations it is in."
//
// EVERY FIGURE IS READ FROM THIS NODE'S OWN STORE (and its census, through `poolsFor`) - nothing asked of a peer, nothing estimated:
//   - a round it checked: one in which it signed at least one player's result;
//   - its fee share in that round: §22A's table (`nodeFeeTable`) over the entries it signed a result for, its two pools
//     the round's signer nodes - the table the settlement claims the fee locks by; EARNED once this node's settlement of
//     the round is ACCEPTED (the fee locks were claimed), OWED before;
//   - the guardian/custody third, Lightning and gateway costs: the fee table pays two pools and this node holds no
//     Lightning channel and pays no gateway, so they are 0 - and said so, not hidden;
//   - A NODE THAT HOSTS AN LND AND A GATEWAY (2026-10-03 22:50: node 1 gateway A + LND 1, node 2 gateway B + LND 2;
//     plan accepted 2026-10-04) shows them in `hosts`, read by hosts.js on this machine: the LND's own figures, the fees its
//     own payments paid as the Lightning costs of the day / month / year, and the gateway's figures. Gateway costs stay 0
//     with the reason: the gateway is what charges; the node pays it nothing. `hosts` is null on a node that hosts neither.
import { decodeRoundContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { nodeFeeTable } from '../../arena-protocol/src/fee.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const DAY = 86400000;
const hex = (b) => toHex(new Uint8Array(b));

/** The dashboard's figures, from `round` (a Round over this node's store) at `nowMs`. */
// `matchFor(roundIdBytes)`: a head-to-head round's match record (match.js) - its score shown with the round
export function dashboardData(round, { nowMs = Date.now(), roundsShown = 200, poolsFor = null, hosts = null, apps = null, matchFor = null, devClient = null, devClients = null, reserveKeys = [], marketRows = [] } = {}) {
  const db = round.db;
  // WHAT EACH ROUND PAID THE PROTOCOL RESERVES: its rows under a federation's reserve key, as kept here
  const reserveKeyHexes = (reserveKeys || []).map((k) => String(k).toLowerCase());
  const reserveRowsOf = reserveKeyHexes.length ? db.prepare(`SELECT amount_msat FROM donation_outputs WHERE round_id = ? AND recipient_pk IN (${reserveKeyHexes.map(() => '?').join(', ')})`) : null;
  const me = hex(round.pubkey);
  const first = db.prepare('SELECT MIN(opened_ms) AS t FROM rounds').get();
  // THE ROUNDS WITH ENTRIES, newest first: the only rounds a fee can come from
  const rows = db.prepare(`SELECT r.round_id, r.contract, r.opened_ms, COUNT(e.entry_id) AS n, MAX(e.joined_ms) AS lastJoin
    FROM rounds r JOIN entries e ON e.round_id = r.round_id GROUP BY r.round_id ORDER BY lastJoin DESC`).all();
  const resultsOf = db.prepare('SELECT entry_id, bytes FROM results WHERE round_id = ? AND node_pubkey = ?');
  const entryOf = db.prepare('SELECT contract FROM entries WHERE entry_id = ?');
  const settlementOf = db.prepare('SELECT state, why, made_ms FROM lock_settlements WHERE round_id = ?');
  const rounds = [];
  const federations = new Map();
  for (const r of rows) {
    let contract;
    try { contract = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
    const fed = contract.federationId ? hex(contract.federationId) : null;
    if (fed && contract.stakeMsat > 0n) {
      const f = federations.get(fed) || { federation: fed, firstMs: Number(contract.startTimeMs), lastMs: 0, rounds: 0 };
      f.firstMs = Math.min(f.firstMs, Number(contract.startTimeMs)); f.lastMs = Math.max(f.lastMs, Number(contract.startTimeMs)); f.rounds++;
      federations.set(fed, f);
    }
    const mine = resultsOf.all(r.round_id, Buffer.from(round.pubkey));
    const entries = [];
    for (const x of mine) {
      try {
        const res = decodePlayerResult(splitSignedResult(new Uint8Array(x.bytes)).body);
        const e = decodeEntryContract(new Uint8Array(entryOf.get(x.entry_id).contract));
        entries.push({ pubkey: e.playerPubkey, stakeMsat: e.stakeMsat, outcome: res.outcome });
      } catch { /* an unreadable row earns nothing */ }
    }
    let gameVerify = 0n; let settlement = 0n; let guardian = 0n;
    if (entries.length && contract.stakeMsat > 0n && Array.isArray(contract.nodes)) {
      try {
        // THE SAME POOLS THE SETTLEMENT PAYS BY (server: the census committees and the federation's guardians)
        let pools = { gameVerify: contract.nodes, settlement: contract.nodes, guardian: [] };
        try { if (poolsFor) pools = poolsFor(new Uint8Array(r.round_id), contract) || pools; } catch { /* the contract's own nodes */ }
        const all = [...pools.gameVerify, ...pools.settlement, ...(pools.guardian || [])];
        const table = nodeFeeTable({ contract, entries, pools, eligible: new Set(all.map(hex)) });
        for (const [k, msat] of table.signerNodes) {
          if (!k.endsWith(me)) continue;
          if (k.startsWith('gameVerify')) gameVerify += msat; else if (k.startsWith('guardian')) guardian += msat; else settlement += msat;
        }
      } catch { /* a round the table refuses earns nothing here */ }
    }
    const s = settlementOf.get(r.round_id);
    // THE ROUND'S GAME: its id, and the name this node hosts it under (none for a game it no longer hosts)
    const gameId = contract.gameId instanceof Uint8Array ? hex(contract.gameId) : null;
    const hostedAs = gameId && apps instanceof Map && apps.get(gameId);
    // ITS KIND ("which kind of game was played, and the score if that game supports it"): the manifest's result
    // type - a replayed game, a market (attested), a head-to-head game - and a head-to-head round's match score
    const rt = hostedAs && hostedAs.manifest ? hostedAs.manifest.resultType : null;
    const kind = rt === 1 ? 'game' : rt === 2 ? 'market' : rt === 3 ? 'head-to-head' : null;
    let score = null;
    if (rt === 3 && matchFor) { try { const m = matchFor(new Uint8Array(r.round_id)); if (m) score = { score: m.score, identities: m.identities.map((k) => k.slice(0, 8)), continued: !!m.previousRound }; } catch { score = null; } }
    rounds.push({ id: hex(r.round_id), game: gameId, gameName: hostedAs ? hostedAs.name : null, kind, score, startMs: Number(contract.startTimeMs), free: contract.stakeMsat === 0n,
      stakeMsat: String(contract.stakeMsat), entries: r.n, checked: mine.length,
      settlement: s ? { state: s.state, madeMs: Number(s.made_ms), why: String(s.why || '').slice(0, 160) } : null,
      earned: s && s.state === 'ACCEPTED', gameVerifyMsat: String(gameVerify), settlementMsat: String(settlement), guardianMsat: String(guardian),
      reservesMsat: reserveRowsOf ? String(reserveRowsOf.all(r.round_id, ...reserveKeyHexes).reduce((t, x) => t + BigInt(x.amount_msat), 0n)) : null });
  }
  const checked = rounds.filter((r) => r.checked > 0);
  // TOTALS FOR THE DAY, THE MONTH, THE YEAR (UTC), earned only
  const zero = () => ({ gameVerifyMsat: 0n, settlementMsat: 0n, guardianMsat: 0n, otherMsat: 0n, lightningCostMsat: 0n, gatewayCostMsat: 0n });
  const now = new Date(nowMs);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const yearStart = Date.UTC(now.getUTCFullYear(), 0, 1);
  // total: every earned round this seat holds, of any year (kanban #597: the health page's "total sats earned")
  const totals = { day: zero(), month: zero(), year: zero(), total: zero(), owed: zero() };
  const daily = new Map();
  for (const r of checked) {
    const add = (t) => { t.gameVerifyMsat += BigInt(r.gameVerifyMsat); t.settlementMsat += BigInt(r.settlementMsat); t.guardianMsat += BigInt(r.guardianMsat); };
    if (!r.earned) { add(totals.owed); continue; }
    const at = r.settlement.madeMs;
    if (at >= dayStart) add(totals.day);
    if (at >= monthStart) add(totals.month);
    if (at >= yearStart) add(totals.year);
    add(totals.total);
    const d = new Date(at).toISOString().slice(0, 10);
    const t = daily.get(d) || zero(); add(t); daily.set(d, t);
  }
  // THE MARKETS' NODE FEES (kanban #600): what each settled market round paid this seat (market-earnings.js), as "other" income - by its
  // settlement's time, in the day, month, year and total, and under its game
  const marketByGame = new Map();
  for (const m of marketRows || []) {
    const msat = BigInt(m.msat || 0n);
    if (msat <= 0n) continue;
    const at = Number(m.madeMs);
    const add = (t) => { t.otherMsat += msat; };
    if (at >= dayStart) add(totals.day);
    if (at >= monthStart) add(totals.month);
    if (at >= yearStart) add(totals.year);
    add(totals.total);
    const d = new Date(at).toISOString().slice(0, 10);
    const t = daily.get(d) || zero(); add(t); daily.set(d, t);
    const g = marketByGame.get(m.game) || { rounds: 0, earned: zero(), month: zero() };
    g.rounds++; add(g.earned); if (at >= monthStart) add(g.month); marketByGame.set(m.game, g);
  }
  // THE LIGHTNING COSTS OF A NODE THAT HOSTS AN LND: the fees its own payments paid, by when they were made
  const lnd = hosts && hosts.lnd && !hosts.lnd.error ? hosts.lnd : null;
  for (const p of (lnd && lnd.paymentFees) || []) {
    const fee = BigInt(p.feeMsat);
    if (p.atMs >= dayStart) totals.day.lightningCostMsat += fee;
    if (p.atMs >= monthStart) totals.month.lightningCostMsat += fee;
    if (p.atMs >= yearStart) totals.year.lightningCostMsat += fee;
  }
  const out = (t) => {
    const income = t.gameVerifyMsat + t.settlementMsat + t.guardianMsat + t.otherMsat;
    const costs = t.lightningCostMsat + t.gatewayCostMsat;
    return Object.fromEntries([...Object.entries(t).map(([k, v]) => [k, String(v)]), ['profitMsat', String(income - costs)]]);
  };
  const days = [];
  for (let d = 29; d >= 0; d--) {
    const key = new Date(dayStart - d * DAY).toISOString().slice(0, 10);
    days.push({ day: key, ...out(daily.get(key) || zero()) });
  }
  // EARNINGS PER GAME: every checked round's shares under its game - earned (settled ACCEPTED) and owed
  const perGame = new Map();
  for (const r of checked) {
    const g = perGame.get(r.game) || { game: r.game, name: r.gameName, rounds: 0, earned: zero(), month: zero(), owed: zero() };
    const add = (t) => { t.gameVerifyMsat += BigInt(r.gameVerifyMsat); t.settlementMsat += BigInt(r.settlementMsat); t.guardianMsat += BigInt(r.guardianMsat); };
    add(r.earned ? g.earned : g.owed);
    if (r.earned && r.settlement.madeMs >= monthStart) add(g.month);
    g.rounds++; perGame.set(r.game, g);
  }
  for (const [game, m] of marketByGame) {
    const hostedAs = apps instanceof Map && apps.get(game);
    const g = perGame.get(game) || { game, name: hostedAs ? hostedAs.name : null, rounds: 0, earned: zero(), month: zero(), owed: zero() };
    g.rounds += m.rounds; g.earned.otherMsat += m.earned.otherMsat; g.month.otherMsat += m.month.otherMsat;
    perGame.set(game, g);
  }
  const byGame = [...perGame.values()].map((g) => ({ game: g.game, name: g.name, rounds: g.rounds, earned: out(g.earned), month: out(g.month), owed: out(g.owed) }));
  const settlements = db.prepare('SELECT round_id, state, why, made_ms FROM lock_settlements ORDER BY made_ms DESC LIMIT 100').all()
    .map((s) => ({ round: hex(s.round_id), state: s.state, madeMs: Number(s.made_ms), why: String(s.why || '').slice(0, 200) }));
  const byState = {};
  for (const s of db.prepare('SELECT state, COUNT(*) AS n FROM lock_settlements GROUP BY state').all()) byState[s.state] = s.n;
  return {
    node: me, nowMs, sinceMs: first && first.t ? Number(first.t) : null,
    totals: { day: out(totals.day), month: out(totals.month), year: out(totals.year), total: out(totals.total), owed: out(totals.owed) },
    days, roundsChecked: checked.length, rounds: checked.slice(0, roundsShown), byGame,
    settlements, settlementsByState: byState, federations: [...federations.values()],
    notes: {
      guardian: 'the guardian third (§22A) goes to the census nodes guarding the round\'s federation; this node\'s share is shown when it guards it',
      lightning: hosts && hosts.lnd ? `this node hosts LND ${hosts.lnd.alias || '(not read: ' + (hosts.lnd.error || '?') + ')'}; its Lightning costs are the fees its own payments paid`
        : 'this node holds no Lightning channel',
      gateway: hosts && hosts.gateway ? `this node hosts gateway ${hosts.gateway.name}; gateway costs are 0: the gateway is what charges, the node pays it nothing`
        : 'this node pays no gateway',
    },
    hosts: hosts && (hosts.lnd || hosts.gateway) ? {
      lnd: hosts.lnd ? (() => { const { paymentFees, ...rest } = hosts.lnd;
        return { ...rest, paymentsWithFee: (paymentFees || []).length, paidFeesMsat: String((paymentFees || []).reduce((t, x) => t + BigInt(x.feeMsat), 0n)) }; })() : null,
      gateway: hosts.gateway || null,
    } : null,
    // A DEV CLIENT BESIDE THIS NODE (dev-client.js): what the donation recipient's client received, holds and withdrew
    devClient: devClient || null,
    devClients: devClients || null,
  };
}

/** The page: one HTML document that reads /dashboard.json and hands it to the React dashboard beside it (/dashboard/react.js, kanban #564: no fall backs). */
export function dashboardHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bitcoin Arena · Node Dashboard</title><style>
:root{--bg:#0f1218;--card:#171c25;--line:#2a3140;--text:#e6e9ef;--dim:#8b93a3;--gv:#f2a93b;--st:#4fa3ff;--gd:#9b7bff;--ok:#3fbf7f;--bad:#e25c5c}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f5f6f8;--card:#fff;--line:#dde1e7;--text:#1b2230;--dim:#5d6676}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif;padding:16px;max-width:1100px;margin:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
.sub{color:var(--dim);margin-bottom:14px;word-break:break-all}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.card h3{margin:0 0 8px;font-size:13px;color:var(--dim)}
.row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 8px;padding:2px 0}.row b{font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:auto}.notes{color:var(--dim);word-break:normal;overflow-wrap:anywhere}.notes p{margin:0 0 6px}
svg{width:100%;height:auto;display:block}table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:#d9a400}.scroll{overflow-x:auto}
.legend span{display:inline-block;margin-right:12px;color:var(--dim)}tr.rr{cursor:pointer}tr.rr:hover td{background:rgba(127,127,127,.08)}tr.pl>td{background:rgba(127,127,127,.05);padding:6px 6px 10px 22px}tr.pl table{font-size:12px}a{color:var(--st)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
/* THE MODERN PAGE (kanban #566): what the React page draws - cards that size to their content, stat tiles, a period switch, tables that fit */
.dash h1{font-size:22px;font-weight:750}.dash h2{font-size:12px;letter-spacing:.07em;margin:26px 0 10px}.dash code{font-family:ui-monospace,monospace;font-size:12.5px}
.dash-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}.dash-head .sub{margin:2px 0 0}
.btn{display:inline-block;padding:8px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);text-decoration:none;font-weight:600}
.seg{display:inline-flex;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:3px;margin:0 0 12px}
.seg button{border:0;background:transparent;color:var(--dim);font:600 13px system-ui;padding:7px 14px;border-radius:9px;cursor:pointer}.seg button.on{background:var(--bg);color:var(--text);box-shadow:0 0 0 1px var(--line) inset}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin:0 0 10px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:4px;min-width:0}
.stat.wide{grid-column:span 2}.stat>span{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:700}
.stat>b{font-size:22px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.stat>small{color:var(--dim);font-size:12.5px;overflow-wrap:anywhere}
.split{display:flex;height:8px;border-radius:4px;overflow:hidden;gap:2px;margin:6px 0 2px}.split i{display:block}
.split-legend{display:flex;flex-wrap:wrap;gap:4px 14px}.split-legend i,.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:0}
.dash .card{border-radius:14px;padding:16px 18px;min-width:0}.dash .card h3{font-size:14px;color:var(--text);margin:0}
.card-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:0 0 10px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;align-items:start}
/* a dev client's card takes the row: its stat cards side by side, its table at full width (in a column of 320 px the dates were cut) */
.cards>.card.dev{grid-column:1/-1}
.kv .row{padding:7px 0;border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent);flex-wrap:nowrap;gap:12px}.kv .row:last-child{border:0}
.kv .row span{color:var(--dim);min-width:0}.kv .row b{white-space:normal;text-align:right;overflow-wrap:anywhere}
.tbl{width:100%;border-collapse:collapse;font-size:13px}.tbl th{color:var(--dim);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em}
.tbl th,.tbl td{padding:7px 8px;border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent)}.tbl .n{text-align:right;font-variant-numeric:tabular-nums}.nowrap{white-space:nowrap}
.chart-head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:0 0 6px}.chart .sub{margin:0}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}.two h2{margin-top:26px}
@media (max-width:560px){.stat.wide{grid-column:auto}.cards{grid-template-columns:1fr}}
/* the setup's progress (kanban #635), as tiles (playtest 2026-10-25: "make this more pretty") */.setup-status{padding:18px 20px}.setup-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.setup-head h3{margin:0}.setup-pill{font:600 12px system-ui;padding:3px 10px;border-radius:999px;white-space:nowrap}.setup-pill.ok{background:rgba(63,185,80,.15);color:#3fb950}.setup-pill.wait{background:rgba(210,153,34,.15);color:#d29922}.setup-pill.bad{background:rgba(248,81,73,.15);color:#f85149}.setup-total{height:6px;border-radius:3px;background:rgba(127,127,127,.18);overflow:hidden;margin-bottom:14px}.setup-total>i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#3fb950,#56d364)}.setup-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}.setup-step{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border-radius:12px;border:1px solid rgba(127,127,127,.2);background:rgba(127,127,127,.06)}.setup-step.s-bad{border-color:rgba(248,81,73,.55)}.setup-ic{flex:0 0 26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:14px}.s-ok .setup-ic{background:rgba(63,185,80,.18);color:#3fb950}.s-wait .setup-ic{background:rgba(210,153,34,.18);color:#d29922}.s-bad .setup-ic{background:rgba(248,81,73,.18);color:#f85149}.setup-body{display:flex;flex-direction:column;gap:3px;min-width:0}.setup-body b{font-size:14px}.setup-text{font-size:13px;line-height:1.4;color:#8b949e;overflow-wrap:anywhere}.setup-step .bar{height:5px;border-radius:3px;background:rgba(127,127,127,.18);overflow:hidden;margin-top:6px;max-width:none}.setup-step .bar>i{display:block;height:100%;background:#d29922}.setup-tip{margin:12px 0 0;font-size:12px;color:#8b949e}
</style></head><body>
<div id="app"></div>
<script type="module">
// THE PAGE IS REACT'S (kanban #564, 2026-10-21: "Delete the old html code of those components you have ported, no fall backs"): the
// bundle beside it (/dashboard/react.js, packages/arena-web/src/dashboard) draws all of it; this script reads and hands in what it draws
import './dashboard/react.js';
const json=async(u)=>{const r=await fetch(u,{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()};
const opt=(u)=>json(u).catch(()=>null);
// THE ROUNDS ARE CLICKABLE (2026-10-03 22:25, plan accepted 2026-10-04): an opened row reads this node's own api/round-result, relative
// (so /guardian-N/ works); the liquidity card (§23A.10) and the capacity plea when this node has them
const readResult=(id)=>json('api/round-result?round='+encodeURIComponent(id));
let shown=false;
// the setup's progress (kanban #635): Bitcoin Core's background sync, the bond's and the peg-in's confirmations
async function load(){let D;try{const [d,liq,cap,setup]=await Promise.all([json('dashboard.json'),opt('liquidity-claim'),opt('capacity?node=me'),opt('setup-status')]);D={...d,liquidity:liq,capacity:(cap&&cap.plea)||null,setup}}
catch(e){if(shown)return;D={error:e.message}}
shown=shown||!D.error;window.ArenaDashboard.draw(document.getElementById('app'),D,readResult)}
load();setInterval(()=>{if(!document.hidden)load()},60000);
// THE OWNER'S KEY FROM THE INSTALLER (playtest 2026-10-25: "Der Installer soll sich mit meiner Seed schon einloggen so dass ich das nicht
// extra wieder machen muss"): opened by the installer's last button with #owner-handoff, this page asks its opener for the key - window to
// window, never in a URL - and keeps it where the owner page reads it (owner.html STORE / NSTORE, per node address), so it opens logged in
if(location.hash==='#owner-handoff'&&window.opener){const base=location.pathname.replace(/\\/[Dd]ashboard\\/?$/,'');
addEventListener('message',(e)=>{const d=e.data;if(e.source!==window.opener||!d||d.type!=='arena-owner-key')return;
try{if(d.kind==='seed'&&/^[0-9a-f]{64}$/.test(d.seed))localStorage.setItem('arena-owner-seed:'+base,d.seed);
else if(d.kind==='nsec'&&/^[0-9a-f]{64}$/.test(d.secret))localStorage.setItem('arena-owner-nostr:'+base,JSON.stringify({how:'nsec',secret:d.secret}))}catch{}
history.replaceState(null,'',location.pathname+location.search)});
window.opener.postMessage({type:'arena-owner-ready'},'*')}
// THE RELEASE IN THE FOOTER (kanban #662): what this node runs, from its public owner/version
fetch(location.pathname.replace(/\\/[Dd]ashboard\\/?$/,'')+'/owner/version',{cache:'no-store'}).then((r)=>r.json()).then((v)=>{if(v&&(v.version||v.commit)){const f=document.createElement('footer');f.className='build';f.textContent=['Bitcoin Arena'+(v.version?' '+v.version:''),v.commit?'build '+String(v.commit).slice(0,8):''].filter(Boolean).join(' · ');document.body.appendChild(f)}}).catch(()=>{});
</script><style>footer.build{max-width:1100px;margin:28px auto 18px;padding:0 16px;color:#8b949e;font-size:12px;text-align:center}</style></body></html>`;
}
