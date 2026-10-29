// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE NODE POSTS THE ROUNDS ITSELF (kanban #702, 2026-10-26: "The round runners must be an integrated part of the node. Who decides what
 * round is posted today? There is something in the spec"). The spec's duty (multiplayer_p2p.md §5A.5, arena-protocol/src/duty.js) names one
 * node a day to post the next day's rounds of every app in every federation, and the next node an hour later if it did not. Until now six
 * runner processes did it, started by hand from operator wallets. Here every node runs it, every minute, on what it already has:
 *
 *   ITS CHAIN     the last DUTY_VIEW_BLOCKS blocks of its own bitcoind (the day's anchor, the markers, publications, beacons)
 *   ITS CENSUS    the census at the day's anchor as every node derives it (main.js ballot.censusEntriesAt): the duty order is the same on
 *                 every node, and anyone can check it
 *   ITS SEATS     the census's other nodes (their advertised addresses): the catalog of apps (GET /games), their chains (GET /headers),
 *                 their rounds (GET /rounds); its own seat for its federations' records (GET /federations)
 *   ITS WALLET    Bitcoin Core's wallet on the same bitcoind (arena.conf duty_wallet, else the only wallet loaded) - confirmed coins first,
 *                 at duty_fee_rate (0.1 sat/vB), raised to at most duty_max_fee_rate (1 sat/vB) near the committee time
 *   ITS KEY       every grid it posts names this node's key as its creator and signs each series id with it (2026.0.3 creator), so
 *                 who posted a day is read from the series' own lines - and the publication fee is paid back to it from the series
 *
 * A node that cannot pay - no wallet, a wallet with no confirmed coins, a chain read through Electrum - says so in its log and on GET /duty
 * and posts nothing: the day falls to the next node an hour later (duty.js dayPostDue). arena.conf duty_post: auto (the default: on while the
 * wallet holds confirmed coins), on, off.
 */
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { daySlotOf, targetDay, dayStartMs, DUTY_FALLBACK_MS, DUTY_BACKUP_AFTER_MS, DUTY_BACKUP_RANK_CAP } from '../../arena-protocol/src/duty.js';
import { seriesId, isGridSeries } from '../../arena-protocol/src/series.js';
import { createGridBase, createDayDuty, DUTY_APPS } from './duty-day.js';
import { buildGrid, publishGridTx, announceGrid, postSeriesLine } from './grid-build.js';
import * as guard from './duty-guard.js';

export const DUTY_EVERY_MS = 60000;
export const DUTY_VIEW_BLOCKS = 400;
const sats = (btc) => Math.round(Number(btc) * 1e8);

/**
 * THE FEDERATIONS A DAY NAMES NOW (kanban #502/#549): `feds` (hex) as the seats' signed records list them - a DRAINING (or CRITICAL while
 * draining) one that names an OPEN successor is posted as that successor. -> { feds, moved: [{ from, to, why }] }
 */
export function successorsOf(feds, list) {
  const rec = new Map((list || []).map((x) => [String(x.federation).toLowerCase(), x]));
  const out = [], moved = [];
  for (const f of feds) {
    const x = rec.get(f), succ = x && x.successor ? String(x.successor).toLowerCase() : null;
    const to = x && ['DRAINING', 'CRITICAL'].includes(x.status) && succ && rec.get(succ) && rec.get(succ).status === 'OPEN' ? succ : f;
    if (to !== f) moved.push({ from: f.slice(0, 16), to: to.slice(0, 16), why: `${f.slice(0, 8)} is ${x.status}` });
    if (!out.includes(to)) out.push(to);
  }
  return { feds: out, moved };
}

/**
 * THE FEDERATIONS A NODE POSTS IN, from its seat's signed records (`list`): `named` (arena.conf duty_federations) when given; else the ones
 * the network's last days were posted in (`played`, the federations of the grid series this node holds of the duty's apps) - #702, measured
 * on seat 4 2026-10-26: its records list four OPEN federations, two of them throwaway test federations (T2 9919a571, e2f42eea) no day was
 * ever posted in - and only while no such series is held, every OPEN one. A draining (or critical) one is posted as its OPEN successor.
 */
export function planFederations(list, { named = [], played = [] } = {}) {
  const rec = new Map((list || []).filter((x) => x && /^[0-9a-f]{64}$/i.test(String(x.federation))).map((x) => [String(x.federation).toLowerCase(), x]));
  const base = named.length ? named : played.length ? played : [...rec.values()].filter((x) => x.status === 'OPEN').map((x) => String(x.federation).toLowerCase());
  return successorsOf(base.map((f) => String(f).toLowerCase()).filter((f) => rec.has(f)), list).feds.filter((f) => rec.get(f) && rec.get(f).status === 'OPEN');
}

/** arena.conf duty_post (ARENA_DUTY_POST): auto | on | off - anything else is auto, said. */
export function dutySetting(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['on', '1', 'yes', 'true'].includes(v)) return 'on';
  if (['off', '0', 'no', 'false'].includes(v)) return 'off';
  return 'auto';
}

/**
 * CAN THIS NODE PAY, FROM WHAT ITS WALLET SAID: `listed` the wallets loaded (listwallets) or the error, `named` arena.conf duty_wallet,
 * `unspent` the wallet's listunspent or the error. -> { canPay, wallet, confirmedSats, why }
 */
export function walletVerdict({ listed, named = '', unspent = null }) {
  if (listed instanceof Error) {
    const m = listed.message;
    if (/Electrum mode/i.test(m)) return { canPay: false, wallet: null, confirmedSats: null, why: 'this node reads its chain through Electrum: it has no Bitcoin Core wallet to pay a posting from' };
    if (/Method not found|-32601/i.test(m)) return { canPay: false, wallet: null, confirmedSats: null, why: 'this node\'s Bitcoin Core runs without a wallet (disablewallet)' };
    return { canPay: false, wallet: null, confirmedSats: null, why: `the wallet could not be read: ${m.slice(0, 160)}` };
  }
  const wallets = (listed || []).map(String);
  const wallet = named || (wallets.length === 1 ? wallets[0] : null);
  if (!wallet) return { canPay: false, wallet: null, confirmedSats: null, why: wallets.length ? `${wallets.length} wallets are loaded and none is named: set duty_wallet in arena.conf` : 'Bitcoin Core has no wallet loaded: create one and send it some coins' };
  if (named && wallets.length && !wallets.includes(named)) return { canPay: false, wallet, confirmedSats: null, why: `the wallet "${named}" (duty_wallet) is not loaded in Bitcoin Core` };
  if (unspent instanceof Error) return { canPay: false, wallet, confirmedSats: null, why: `the wallet "${wallet}" could not be read: ${unspent.message.slice(0, 160)}` };
  const confirmedSats = (unspent || []).filter((c) => c.spendable !== false && Number(c.confirmations) > 0).reduce((s, c) => s + sats(c.amount), 0);
  if (!(confirmedSats > 0)) return { canPay: false, wallet, confirmedSats, why: `the wallet "${wallet}" holds no confirmed coins` };
  return { canPay: true, wallet, confirmedSats, why: null };
}

// THE FIELDS A DAY'S TEMPLATE CARRIES OVER FROM THE LAST ONE THIS NODE HOLDS OF THE SAME APP - the network's shape of a round (its stake,
// committee size, bond floor, windows, relays) - and nothing that names a particular series (its census, times, creator, rules, root)
const CARRIED = ['protocolVersion', 'networkId', 'configHash', 'simCoreHash', 'objectionWindowMs', 'custody', 'stakeExpiryBlocks', 'slashMinimumServed',
  'slashRemainder', 'censusConfirmations', 'randomnessRule', 'publicationRelays', 'gameVerifySlots', 'settlementSlots', 'stakeMsat', 'bondMinSats',
  'blockTicks', 'exposureReference', 'corridorHalfWidth', 'spawnFreeRadius', 'timeFloor', 'timeCeil', 'minScore', 'rankNumerator', 'rankDenominator',
  'nodes', 'startDeadlineTicks', 'gameId'];
// AND THE SHAPE A NODE THAT HOLDS NONE STARTS FROM: testnet4's as the duty posted it on 2026-10-26 (seat 31221's held templates)
export const DUTY_TEMPLATE = Object.freeze({ protocolVersion: 3, configHash: new Uint8Array(32), simCoreHash: new Uint8Array(32), objectionWindowMs: 600000n,
  custody: 'FEDERATION', stakeExpiryBlocks: 144, slashMinimumServed: 20, slashRemainder: 'SPLIT', censusConfirmations: 6, randomnessRule: 'bitcoin-block-hash',
  publicationRelays: [], gameVerifySlots: 7, settlementSlots: 7, stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000,
  corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 0, rankNumerator: 3, rankDenominator: 4, nodes: [] });
const RPS_TICKS = { blockTicks: 600, startDeadlineTicks: 300 };

/**
 * THE DAY'S TEMPLATE FOR AN APP: the newest grid template this node holds whose game is a version of it (`family`, a Set of game ids hex),
 * its network's - else DUTY_TEMPLATE on `networkId`, its relays this node's own address. -> { contract, from: 'held' | 'built-in' }
 */
export function dayTemplate({ held, family, networkId, game, ownRelay = null }) {
  const nid = toHex(networkId);
  const mine = (held || []).filter((t) => t && isGridSeries(t) && t.networkId && toHex(t.networkId) === nid && t.gameId && family.has(toHex(t.gameId)))
    .sort((a, b) => Number(BigInt(b.startTimeMs) - BigInt(a.startTimeMs)));
  if (mine.length) {
    const c = {};
    for (const k of CARRIED) if (mine[0][k] !== undefined) c[k] = mine[0][k];
    return { contract: c, from: 'held' };
  }
  return { contract: { ...DUTY_TEMPLATE, ...(game === 'rps' ? RPS_TICKS : {}), networkId, publicationRelays: ownRelay ? [ownRelay] : [] }, from: 'built-in' };
}

/**
 * WHO POSTED A DAY (kanban #702 addition, 2026-10-26: "In health also say who posted that round" - "Since its pre deterministic"): the
 * creator key of the series its marked transaction publishes (`templateOf(idHex)` the line this node holds), its rank in the day's duty
 * order (1-based), and whether a fallback node posted it. Null poster when this node holds none of its series.
 */
export function posterOf({ series, templateOf, order }) {
  let poster = null;
  for (const id of series || []) { const t = templateOf(id); if (t && t.creatorPubkey instanceof Uint8Array) { poster = toHex(t.creatorPubkey); break; } }
  const rank = poster ? order.findIndex((k) => toHex(k) === poster) : -1;
  return { poster, posterRank: rank >= 0 ? rank + 1 : null, fallback: rank > 0 };
}

/**
 * THE NODE'S ROUND POSTER. Handed in by main.js:
 *   call                      the node's bitcoind RPC;  walletCall(name) the same bitcoind's wallet RPC
 *   networkIdHex()            the chain's network id (hex), null while unknown
 *   censusEntriesAt(nid, h)   the census at a height as every node derives it (ballot)
 *   dutyCensus(contract)      the census a round contract is drawn from (root and entries), as the seats derive it
 *   chainBlocks(from, to)     the blocks over [from, to] (header, transactions), cached
 *   dir                       where its postings are kept (<store>.duty)
 *   env                       ARENA_DUTY_POST, ARENA_DUTY_WALLET, ARENA_DUTY_FEE_RATE, ARENA_DUTY_MAX_FEE_RATE, ARENA_DUTY_APPS,
 *                             ARENA_DUTY_ITEM_<APP>, ARENA_FUNDED_ROUNDS_FILE, ARENA_DUTY_EMERGENCY
 *   nodeSecret                this node's identity secret: it signs the series it creates
 * and, once its seat listens, attach({ port, host, endpoint, heldTemplates, nameFunded, donationSetAt, nodeKey }) from server.js.
 */
export function createDutyPoster({ call, walletCall, networkIdHex, censusEntriesAt, dutyCensus, chainBlocks, dir, env = {}, nodeSecret,
  fetchFn = fetch, log = (l) => console.log(l), now = Date.now, everyMs = DUTY_EVERY_MS }) {
  const setting = dutySetting(env.ARENA_DUTY_POST);
  const feeRate = Number(env.ARENA_DUTY_FEE_RATE || 0.1), maxFeeRate = Number(env.ARENA_DUTY_MAX_FEE_RATE || 1);
  const apps = String(env.ARENA_DUTY_APPS || DUTY_APPS.join(',')).split(',').map((x) => x.trim()).filter((x) => DUTY_APPS.includes(x));
  const say = (o) => log(`[duty] ${JSON.stringify({ at: new Date(now()).toISOString(), ...o })}`);
  let seat = null, timer = null, busy = false;
  let wallet = { canPay: false, wallet: null, confirmedSats: null, why: 'not read yet' };
  let lastError = null;
  const engines = new Map();
  let lastSeats = [];
  const self = () => (seat ? `http://${seat.host === '0.0.0.0' ? '127.0.0.1' : seat.host}:${seat.port}` : null);
  const reach = (u) => String(u || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
  const seatJson = async (url, ms = 15000) => { const r = await fetchFn(url, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };

  // THE WALLET'S WORD, read every look: listwallets, then the named (or only) wallet's confirmed coins
  const readWallet = async () => {
    let listed; try { listed = await call('listwallets', []); } catch (e) { listed = e; }
    const named = String(env.ARENA_DUTY_WALLET || '').trim();
    let pre = walletVerdict({ listed, named, unspent: [] });
    if (!pre.wallet || listed instanceof Error) return pre;
    let unspent; try { unspent = await walletCall(pre.wallet)('listunspent', [1, 9999999, [], false]); } catch (e) { unspent = e; }
    return walletVerdict({ listed, named, unspent });
  };
  const on = () => setting === 'on' || (setting === 'auto' && wallet.canPay);
  const canPay = async () => (wallet.canPay ? { ok: true } : { ok: false, why: setting === 'off' ? 'round posting is off (duty_post=off)' : wallet.why });

  // ITS CHAIN, the last DUTY_VIEW_BLOCKS blocks - read again only when the best block changes (a reorg reads the window afresh)
  let view = null, viewBest = null, viewBlocks = DUTY_VIEW_BLOCKS;
  // WIDER WHEN A DAY'S ANCHOR LIES BELOW THE WINDOW (duty-day.js orderOf), up to the census lookback
  const widen = () => { if (viewBlocks < 2016) { viewBlocks = Math.min(2016, viewBlocks * 2); viewBest = null; } };
  const chainView = async () => {
    const best = String(await call('getbestblockhash', []));
    if (view && best === viewBest) return view;
    const tip = Number(await call('getblockcount', []));
    const from = Math.max(0, tip - viewBlocks + 1);
    const got = await chainBlocks(from, tip);
    view = { blocks: got.blocks, firstHeight: from }; viewBest = best;
    return view;
  };
  // THE SEATS TO ASK: this node's own first, then every other node of the census with an address - the census at a height that moves every
  // 36 blocks (read once there and kept, not a new 2,016-block census at every block)
  const seatUrls = async () => {
    const own = self();
    try {
      const nid = networkIdHex(); const tip = Number(await call('getblockcount', [])) - 6;
      const entries = nid ? (await censusEntriesAt(nid, tip - (tip % 36))) || [] : [];
      const mine = seat && seat.nodeKey ? toHex(seat.nodeKey) : '';
      lastSeats = [...new Set(entries.filter((e) => toHex(e.pubkey) !== mine && e.advert && e.advert.endpoint).map((e) => reach(e.advert.endpoint)))];
    } catch { /* the last list */ }
    return [...(own ? [own] : []), ...lastSeats];
  };
  // WHO IS WHERE: a census node's address, for GET /duty's names
  const endpointOf = new Map();
  const remember = (entries) => { for (const e of entries || []) if (e.advert && e.advert.endpoint) endpointOf.set(toHex(e.pubkey), reach(e.advert.endpoint)); };

  // THE APPS THIS NODE HOSTS, BY NAME: their developer keys (a version of an app is one under the same key) - from its own GET /games
  let devOf = {};
  const readDevs = async () => {
    const own = self(); if (!own) return;
    try {
      const cat = guard.catalogOf([await seatJson(`${own}/games`)], { decode: decodeManifest, idOf: gameIdOf });
      const out = {};
      for (const [game, name] of Object.entries(guard.DUTY_APP_NAMES)) { const g = [...cat.values()].find((x) => x.name === name); if (g) out[game] = g.dev; }
      devOf = out;
    } catch { /* the last */ }
  };
  // THE DAY'S TEMPLATE AND THE CONTRACT A CENSUS IS READ WITH, per app (the game's own held shape)
  const familyOf = async (game, gb) => {
    const cat = (await gb.seatCatalog().catch(() => null)) || new Map();
    return new Set([...cat.values()].filter((g) => g.name === guard.DUTY_APP_NAMES[game] && (!devOf[game] || g.dev === devOf[game])).map((g) => g.id));
  };
  const templates = new Map();     // game -> { contract, from }
  const contractAt = (game, height) => ({ ...(templates.get(game) || dayTemplate({ held: [], family: new Set(), networkId: fromHex(networkIdHex()), game })).contract, censusHeight: height });
  const censusFor = async (contract) => {
    const c = await dutyCensus(contract);
    if (!c || !c.ok) throw new Error(`no census at ${contract.censusHeight}: ${c ? c.why : 'not read'}`);
    return c;
  };
  // ONE GRID BUILT, FUNDED FROM THIS NODE'S WALLET, SENT AND ANNOUNCED - the node's openGrid (waitBeacon false: the engine posts the series)
  const openGrid = (game) => async (kind, opts) => {
    const base = kind.base || {};
    const t = templates.get(game);
    // THE PROTOCOL A GRID IS WRITTEN IN: the day's shape's, or the newest version's requirement when that is higher
    const protocolVersion = Math.max(Number(t.contract.protocolVersion || 3), Number(base.requiredProtocol || 0));
    const contract = { ...t.contract, protocolVersion, censusHeight: kind.fields.censusHeight };
    const census = await censusFor({ ...contract, ...kind.fields });
    const built = buildGrid({ contract, kind, ...opts, censusRootFor: () => census.root, censusEntries: () => census.entries,
      blockTicksAt: null });
    const sent = await publishGridTx({ outs: built.outs, rpc: walletCall(wallet.wallet), feeRate: opts.feeRate, dry: env.ARENA_GRID_DRY === '1' });
    if (sent.dry) return { ok: false, dry: true, accepted: sent.accepted, reject: sent.reject, bytes: sent.vsize, feeSat: String(sent.fee), series: built.ids.map(toHex), rounds: built.rounds };
    // NAMED FUNDED HERE, AND IN THE FUNDED FILE THIS MACHINE'S SEATS SHARE (as the runner named them), before any seat is asked
    for (const id of built.ids) {
      try { seat.nameFunded(toHex(id)); } catch { /* none */ }
      if (env.ARENA_FUNDED_ROUNDS_FILE) { try { appendFileSync(env.ARENA_FUNDED_ROUNDS_FILE, `${toHex(id)}\n`); } catch (e) { say({ dutyDay: 'funded file not written', why: e.message }); } }
    }
    announceGrid({ lines: built.lines, tx: sent.hex, targets: await seatUrls(), fetchFn })
      .then((s) => say({ dutyDay: 'announced', txid: sent.txid.slice(0, 16), seats: `${s.took}/${s.of}` })).catch(() => {});
    return { ok: true, published: true, txid: sent.txid, series: built.ids.map(toHex), lines: built.lines, rounds: built.rounds, lastCloseMs: built.lastCloseMs, firstStartMs: built.start };
  };
  const postSeries = async (line) => postSeriesLine(line, (await seatUrls()).map((u) => [u.replace(/^https?:\/\//, ''), u]), { fetchFn });
  const fedsNow = async () => {
    const own = self();
    const named = String(env.ARENA_DUTY_FEDERATIONS || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[0-9a-f]{64}$/.test(x));
    // THE FEDERATIONS THE LAST THREE DAYS' GRIDS OF THE DUTY'S APPS NAMED, as this node holds them
    const fams = new Set(); for (const g of apps) for (const id of (await familyOf(g, gridBaseOf()))) fams.add(id);
    const since = BigInt(now() - 3 * 86400000);
    const played = [...new Set(seat.heldTemplates().filter((t) => t && isGridSeries(t) && t.gameId && fams.has(toHex(t.gameId)) && BigInt(t.startTimeMs) >= since
      && t.federationId instanceof Uint8Array).map((t) => toHex(t.federationId)))];
    return planFederations((await seatJson(`${own}/federations`)).federations || [], { named, played });
  };

  // TWO ENGINES PER APP: the day's primary grid (rank 1) and its backup (rank 2, duty.js) - the backup never from the node that posted the primary
  const engineFor = (game, gb, role = 'primary') => {
    const key = role === 'backup' ? `${game}:backup` : game;
    if (engines.has(key)) return engines.get(key);
    const nid = networkIdHex();
    const e = createDayDuty({ game, role, item: String(env[`ARENA_DUTY_ITEM_${game.toUpperCase()}`] || `${game}-day`), networkId: fromHex(nid),
      postedPrimary: async (slot) => { const p = engines.get(game); return !!p && (p.state().mine || []).some((x) => x.slot === slot && !x.emergency); },
      local: new Set([toHex(seat.nodeKey)]), dir: join(dir, role === 'backup' ? `${game}-backup` : game),
      chain: { view: chainView, widen, censusKeysAt: async (h) => { const es = await censusEntriesAt(nid, h); remember(es); return es ? es.map((x) => x.pubkey) : null; }, seatUrls },
      chainCall: call, walletRpc: (m, p) => walletCall(wallet.wallet || '')(m, p), gridBase: gb.gridBase, openGrid: openGrid(game), postSeries, fedsNow,
      seatCatalog: gb.seatCatalog, devOf: new Proxy({}, { get: (_, k) => devOf[k] }), creator: { creatorSecret: nodeSecret }, stakeMsat: undefined, feeRate, maxFeeRate,
      emergencyOn: env.ARENA_DUTY_EMERGENCY !== '0', seatsAgreeOn: async (hash) => gb.agreementOf(hash, await gb.seatChains()), canPay, fetchFn, say, now });
    engines.set(key, e);
    return e;
  };
  let gridBases = null;
  const gridBaseOf = () => gridBases || (gridBases = createGridBase({ chainCall: call,
    censusEntriesAt: async (h, game) => (await censusFor(contractAt(game, h))).entries,
    contractAt: (game, h) => contractAt(game, h), catalogSeats: seatUrls, chainSeats: seatUrls, localCount: 1, devOf: new Proxy({}, { get: (_, k) => devOf[k] }),
    cores: new Proxy({}, { get: (_, k) => { const t = templates.get(k); return t && t.from === 'held' && t.contract.simCoreHash && toHex(t.contract.simCoreHash) !== '0'.repeat(64) ? toHex(t.contract.simCoreHash) : undefined; } }),
    rpsBase: RPS_TICKS, donationSetAt: (h) => seat.donationSetAt(fromHex(networkIdHex()), h),
    decode: decodeManifest, idOf: gameIdOf, blockHashOf, fetchFn, say, now }));

  /** One pass over every app: the wallet, the day's templates, then each app's duty (never throws). */
  const pass = async () => {
    if (busy || !seat) return;
    busy = true;
    try {
      wallet = await readWallet();
      if (setting === 'off') return;
      if (!networkIdHex()) { lastError = { atMs: now(), app: null, why: 'this node knows no network yet (donation_network)' }; return; }
      await readDevs();
      const gb = gridBaseOf();
      for (const game of apps) {
        if (!devOf[game]) { engines.delete(game); engines.delete(`${game}:backup`); continue; }   // an app this node does not host: the next node in order posts it
        try {
          templates.set(game, dayTemplate({ held: seat.heldTemplates(), family: await familyOf(game, gb), networkId: fromHex(networkIdHex()), game, ownRelay: seat.endpoint ? reach(seat.endpoint) : self() }));
          for (const role of ['primary', 'backup']) {
            const st = await engineFor(game, gb, role).look();
            if (st.error && (!lastError || st.error.atMs > lastError.atMs)) lastError = { ...st.error, app: game, role };
          }
        } catch (err) { lastError = { atMs: now(), app: game, why: err.message }; say({ dutyDay: 'pass failed', game, why: err.message }); }
      }
    } catch (err) { lastError = { atMs: now(), app: null, why: err.message }; } finally { busy = false; }
  };

  /** GET /duty: what the last pass saw - cheap, no chain read. */
  const status = () => {
    const nowMs = now(), slot = daySlotOf(nowMs);
    const node = seat && seat.nodeKey ? toHex(seat.nodeKey) : null;
    const days = [];
    const first = [...engines.values()][0];
    for (const [s, period] of [[slot - 1, 'today'], [slot, 'next']]) {
      const o = first && first.state().orders ? first.state().orders[s] : null;
      const order = o ? o.order : [];
      const templateOf = (id) => (seat ? seat.heldTemplates().find((t) => { try { return toHex(seriesId(t)) === id; } catch { return false; } }) : null);
      days.push({ slot: s, covers: new Date(targetDay(s).startMs).toISOString().slice(0, 10), period, anchor: o ? o.anchor : null,
        order: order.slice(0, 3).map((k, i) => ({ rank: i + 1, key: toHex(k), endpoint: endpointOf.get(toHex(k)) || null, self: toHex(k) === node,
          dueFrom: new Date(guard.dayDueFromMs(s, i)).toISOString(),
          // AND THE BACKUP (duty.js): rank 2 from DUTY_BACKUP_AFTER_MS into the day, each next rank an hour later
          ...(i >= 1 ? { backupDueFrom: new Date(dayStartMs(s) + DUTY_BACKUP_AFTER_MS + (Math.min(i, DUTY_BACKUP_RANK_CAP) - 1) * DUTY_FALLBACK_MS).toISOString() } : {}) })),
        apps: [...engines.values()].map((e) => {
          const st = e.state();
          const ms = (st.markers || []).filter((m) => m.slot === s);
          const postings = ms.map((m) => { const p = posterOf({ series: m.series, templateOf, order });
            const mine = (st.mine || []).some((x) => x.txid === m.txid);
            const poster = p.poster || (mine ? node : null);
            const rank = poster ? order.findIndex((k) => toHex(k) === poster) : -1;
            return { txid: m.txid, height: m.height, emergency: !!m.emergency, role: e.role, poster, posterEndpoint: poster ? endpointOf.get(poster) || null : null,
              posterRank: rank >= 0 ? rank + 1 : null, fallback: rank > 0 }; });
          const state = ms.some((m) => m.height !== null) ? 'posted' : ms.length ? 'in mempool' : nowMs >= dayStartMs(s + 1) ? 'missed' : nowMs >= dayStartMs(s) ? 'due' : 'not due yet';
          return { app: e.game, name: guard.DUTY_APP_NAMES[e.game], role: e.role, state, postings };
        }) });
    }
    return { ok: true, node, nowMs: String(nowMs), setting, on: on(), wallet: { canPay: wallet.canPay, why: wallet.why, confirmedSats: wallet.confirmedSats, wallet: wallet.wallet },
      feeRate, maxFeeRate, rankCap: guard.DUTY_DAY_RANK_CAP, days,
      mine: { posted: [...engines.values()].flatMap((e) => e.state().mine || []).map((x) => ({ ...x, atMs: String(x.atMs) })),
        wouldPost: [...engines.values()].flatMap((e) => e.state().wouldPost || []) },
      lastError: lastError ? { atMs: String(lastError.atMs), app: lastError.app || null, role: lastError.role || null, why: lastError.why } : null };
  };

  return {
    setting,
    attach(ctx) {
      seat = ctx;
      say({ dutyDay: 'poster', setting, apps, feeRate, maxFeeRate, key: toHex(ctx.nodeKey).slice(0, 16) });
      if (setting === 'off') { say({ dutyDay: 'off', why: 'duty_post=off in arena.conf: this node posts no rounds; the next node in the duty order does' }); return; }
      const t0 = setTimeout(() => { pass(); }, 30000); if (t0.unref) t0.unref();
      timer = setInterval(() => { pass(); }, everyMs); if (timer.unref) timer.unref();
      this._t0 = t0;
    },
    stop() { if (timer) clearInterval(timer); if (this._t0) clearTimeout(this._t0); timer = null; },
    pass, status,
    // for the tests: one pass at once
    get engines() { return engines; },
  };
}

/** THE NODE'S IDENTITY KEY AS A CREATOR KEY: the x-only key schnorr derives from its secret. */
export const creatorKeyOf = (secret) => schnorr.getPublicKey(secret);
