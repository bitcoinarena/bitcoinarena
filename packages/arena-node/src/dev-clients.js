// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S OWN DEV CLIENTS (2026-10-14: "It needs to show the donations for the protocol and game dev. The node
// operator may set up the dev client for all of that, via the ui. It shows the stats then and there's a withdrawal feature that
// withdraws it to lightning").
//
// A dev client is a donation recipient's key and its wallets: arena-donor's `loop`, one directory each, under `root` (beside the
// node's database). The owner sets one up on the owner page - a new key, or a dev key it already has (imported: its wallets are
// recovered from the federation, never joined fresh) - and the node runs it as a child process, restarted when it stops. The owner
// withdraws over Lightning from the page: the node leaves the request in the client's directory and the client pays it (an invoice,
// or a Lightning address). Removing a client stops it and keeps its directory: a key is never deleted.
//
// The stats are the client's own files (dev-client.js: donations.jsonl, state.json - never key.json), each donation split into the
// protocol developers' part and its game's part by the sets' shares: a donation pays half to the protocol set and half to the game's
// set (donation.js splitTwoSets), so a key named in both gets one output carrying both parts.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, chmodSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { devClientSnapshot } from './dev-client.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const slugOf = (label) => String(label || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v, mode) => { writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 1), mode ? { mode } : undefined); renameSync(`${p}.tmp`, p); if (mode) chmodSync(p, mode); };

/**
 * ONE RECIPIENT KEY'S DONATIONS, BY WHOM THEY WERE FOR: `rows` (donations.jsonl), `protocolBps` (this key's share in the newest
 * protocol set, 0 when not named), `gameOf(roundId)` -> { name, bps } | null (the round's game and this key's share in its set).
 * A donation to a key in both sets is split p : g; a round whose game this seat does not know is counted as unknown.
 */
// AN ITEM'S DONATION (item-purchase-seat.js): its round id is 32 zero bytes. Its game: the row's own itemGame (kanban #578), else
// `itemOf(entryId)` - the purchase this seat kept under that id; without either it counts as unknown, as before
export const isItemRow = (r) => /^0{64}$/.test(String((r && r.roundId) || ''));
export function gameOfRow(r, { gameOf = () => null, itemOf = null, gameByName = null } = {}) {
  if (!isItemRow(r)) return gameOf(String((r && r.roundId) || ''));
  if (r.itemGame && gameByName) { const g = gameByName(String(r.itemGame)); if (g) return g; }
  return itemOf ? itemOf(String(r.entryId || '')) : null;
}
// THE COUNTS AT ONE PEEK (kanban #578, 2026-10-22: "also display the number of donations for protocol devs and number of ingame
// items, number of market rounds"; "add the item that is being purchased ... group it by game and item name"): `protocolDonations`, and
// per game its donations, its distinct rounds (`rounds`; a market's are market rounds, `market: true`), its items bought (`items`) and
// those items grouped by item (`itemsBy`: [{ item, donations, msat }], the most given first)
export function attributeDonations(rows, { protocolBps = 0, gameOf = () => null, itemOf = null, gameByName = null } = {}) {
  let protocol = 0n, unknown = 0n, protocolDonations = 0;
  const games = new Map();
  for (const r of rows || []) {
    const amount = BigInt(r.amountMsat || 0);
    const g = gameOfRow(r, { gameOf, itemOf, gameByName });
    if (!g) { unknown += amount; continue; }
    const p = BigInt(protocolBps), q = BigInt(g.bps || 0);
    const toProtocol = p + q > 0n ? (amount * p) / (p + q) : 0n;
    const toGame = p + q > 0n ? amount - toProtocol : 0n;
    protocol += toProtocol;
    if (toProtocol > 0n) protocolDonations += 1;
    const x = games.get(g.name) || { game: g.name, title: g.title || g.name, msat: 0n, donations: 0, market: !!g.market, roundIds: new Set(), items: 0, itemsBy: new Map() };
    x.msat += toGame; x.donations += 1;
    if (isItemRow(r)) {
      x.items += 1;
      const id = String(r.itemId || (r.item ? String(r.item).split(' · ').pop() : '') || 'an item');
      const i = x.itemsBy.get(id) || { item: id, donations: 0, msat: 0n }; i.donations += 1; i.msat += toGame; x.itemsBy.set(id, i);
    } else x.roundIds.add(String(r.roundId || ''));
    games.set(g.name, x);
    if (p + q === 0n) unknown += amount;
  }
  return { protocolMsat: String(protocol), protocolDonations,
    games: [...games.values()].map(({ roundIds, itemsBy, ...x }) => ({ ...x, msat: String(x.msat), rounds: roundIds.size,
      itemsBy: [...itemsBy.values()].sort((a, b) => (b.msat > a.msat ? 1 : b.msat < a.msat ? -1 : b.donations - a.donations)).map((i) => ({ ...i, msat: String(i.msat) })) })),
    unknownMsat: String(unknown) };
}

/**
 * WHAT A DEV KEY EARNED, BY PERIOD (2026-10-16: "Shows the dev protocol and dev game earnings (grouped by game)
 * with daily, weekly, monthly : yearly earnings, also shows your stake of the total dev earnings (protocol / game)"). The same
 * split as attributeDonations, each donation counted in the UTC day, the ISO week (from Monday), the month and the year it was
 * verified in, measured from `nowMs`; `days` the last N UTC days one by one. Amounts are msat strings; unknown rounds are kept apart.
 */
export const PERIODS = Object.freeze(['day', 'week', 'month', 'year', 'all']);
export function devEarnings(rows, { protocolBps = 0, gameOf = () => null, itemOf = null, gameByName = null, nowMs = Date.now(), days = 30 } = {}) {
  const now = new Date(nowMs);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const starts = { day: dayStart, week: dayStart - ((now.getUTCDay() + 6) % 7) * 86400000,
    month: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), year: Date.UTC(now.getUTCFullYear(), 0, 1), all: -Infinity };
  const blank = () => ({ protocol: 0n, games: new Map(), unknown: 0n });
  const periods = Object.fromEntries(PERIODS.map((k) => [k, blank()]));
  const daily = new Map();
  for (let i = days - 1; i >= 0; i--) daily.set(new Date(dayStart - i * 86400000).toISOString().slice(0, 10), blank());
  const add = (b, part, title, msat) => {
    if (part === null) { b.unknown += msat; return; }
    if (part === '') { b.protocol += msat; return; }
    const x = b.games.get(part) || { game: part, title, msat: 0n }; x.msat += msat; b.games.set(part, x);
  };
  for (const r of rows || []) {
    const amount = BigInt(r.amountMsat || 0);
    const at = Number(r.verifiedMs || r.recordedAt || 0);
    const g = gameOfRow(r, { gameOf, itemOf, gameByName });
    const parts = [];
    if (!g) parts.push([null, null, amount]);
    else {
      const p = BigInt(protocolBps), q = BigInt(g.bps || 0);
      if (p + q === 0n) parts.push([null, null, amount]);
      else { const toProtocol = (amount * p) / (p + q); parts.push(['', null, toProtocol], [g.name, g.title || g.name, amount - toProtocol]); }
    }
    const day = Number.isFinite(at) && at > 0 ? new Date(at).toISOString().slice(0, 10) : null;
    for (const [part, title, msat] of parts) {
      for (const k of PERIODS) if (at >= starts[k] && at <= nowMs + 60000) add(periods[k], part, title, msat);
      if (day && daily.has(day)) add(daily.get(day), part, title, msat);
    }
  }
  const out = (b) => ({ protocolMsat: String(b.protocol), games: [...b.games.values()].map((x) => ({ ...x, msat: String(x.msat) })),
    unknownMsat: String(b.unknown), totalMsat: String(b.protocol + [...b.games.values()].reduce((t, x) => t + x.msat, 0n) + b.unknown) });
  return { nowMs, periods: Object.fromEntries(PERIODS.map((k) => [k, out(periods[k])])), days: [...daily.entries()].map(([day, b]) => ({ day, ...out(b) })) };
}

/**
 * The node's side. `root`: the clients' directories. `donorBin`: arena-donor.mjs. `defaults`: what every new client's donor.json
 * takes - { seats, invites, invitesFrom, wasmPkg, gateways } (the node's own knowledge, so the owner types none of it).
 * `keys`: { newKey(), keyFromSecret(Buffer) } (arena-donor's). `spawn` and `restartMs` for tests.
 */
/** EACH DONATION ON ITS OWN, split as attributeDonations splits them: { r, game, title, market, item, protocolMsat, appMsat, window, player } - a row of a
 *  round this node no longer holds has no game and no parts (counted apart, as `unknownMsat` there) */
export function donationParts(rows, { protocolBps = 0, gameOf = () => null, itemOf = null, gameByName = null, windowOf = () => null, playerOf = (r) => (r.playerKey ? String(r.playerKey) : null) } = {}) {
  return (rows || []).map((r) => {
    const g = gameOfRow(r, { gameOf, itemOf, gameByName }), amount = BigInt(r.amountMsat || 0);
    const p = BigInt(protocolBps), q = BigInt((g && g.bps) || 0);
    const toProtocol = g && p + q > 0n ? (amount * p) / (p + q) : 0n;
    return { r, game: g ? g.name : null, title: g ? (g.title || g.name) : null, market: !!(g && g.market),
      item: isItemRow(r) ? String(r.itemId || (r.item ? String(r.item).split(' · ').pop() : '') || 'an item') : null,
      protocolMsat: toProtocol, appMsat: g && p + q > 0n ? amount - toProtocol : 0n,
      // a market round's window and the player of the entry (kanban #580) - a market's donation row names no player key itself
      window: !isItemRow(r) && g && g.market ? windowOf(String(r.roundId || '')) : null, player: playerOf(r),
      // a market's donation, order by order (kanban #580): each filled order's entry, player key and share
      parts: Array.isArray(r.parts) ? r.parts.map((x) => ({ entry: String(x.entryId || ''), player: String(x.playerKey || ''), msat: String(x.msat || '0') })) : null };
  });
}

/**
 * A PAGE OF THE DONATIONS TABLE (kanban #578): `info` = the donations each with its app or item and its protocol and app parts (the
 * server's devAttribute perRow), `rates` = { outpoint: { eur, usd, chf, gbp } } (fiat-rates.js). The apps with their counts; then the rows
 * of one app, its items with it ('items' for the items of all apps, 'unknown' for rounds no longer held) matching `q` in player, round, entry, item or outpoint, newest
 * first, `offset` .. `offset + limit` (5 .. 200); the sums of all matching rows, in msat and in each currency at each donation's own rate.
 */
/**
 * WHERE A DONATION CAME FROM (kanban #672: "That donation is tagged so we know its origin and we can filter by it in the donation owner
 * dashboard"): a gift's tag from its item ("donation · protocol · from site" - donation-gift-seat.js giftItem), "gift" for one given before
 * the tags, "item" for an item purchase, "round" for a round's own donation.
 */
export function donationOrigin(x) {
  const it = String((x.r && x.r.item) || '');
  const m = / · from (.+)$/.exec(it);
  if (m) return m[1];
  if (/^donation · /.test(it)) return 'gift';
  return x.item ? 'item' : 'round';
}
const ORIGIN_TITLE = (o) => (o === 'site' ? 'Donate on the site' : o.startsWith('app:') ? `Donate in ${o.slice(4)}` : o === 'gift' ? 'Donate (before tags)' : o === 'item' ? 'Item purchases' : o === 'round' ? 'Rounds' : o);

export function donationsPage(info, rates = {}, { app = '', origin = '', q = '', limit = 25, offset = 0 } = {}) {
  const at = (r) => Number(r.verifiedMs || r.recordedAt || 0);
  const apps = new Map();
  const count = (k, title, market) => { const a = apps.get(k) || { app: k, title, market, count: 0 }; a.count++; apps.set(k, a); };
  for (const x of info) { count(x.game || 'unknown', x.game ? x.title : 'Older rounds', !!x.market); if (x.item) count('items', 'Items (all apps)', false); }
  const origins = new Map();
  for (const x of info) { const o = donationOrigin(x); origins.set(o, (origins.get(o) || 0) + 1); }
  app = String(app || ''); origin = String(origin || ''); q = String(q || '').toLowerCase().trim();
  const rows = info.filter((x) => (!app || (app === 'items' ? x.item : app === 'unknown' ? !x.game : x.game === app)) && (!origin || donationOrigin(x) === origin)
    && (!q || [x.player || x.r.playerKey, x.r.roundId, x.r.entryId, x.r.item, x.r.outpoint, ...(x.parts || []).flatMap((y) => [y.player, y.entry])].some((v) => String(v || '').toLowerCase().includes(q)))).sort((a, b) => at(b.r) - at(a.r));
  limit = Math.max(5, Math.min(200, Number(limit) || 25)); offset = Math.max(0, Number(offset) || 0);
  const msatOf = (x, part) => (part === 'protocol' ? x.protocolMsat : part === 'app' ? x.appMsat : BigInt(x.r.amountMsat || 0));
  const fiat = (x, part) => Object.fromEntries(Object.entries(rates[x.r.outpoint] || {}).map(([c, perBtc]) => [c, Math.round((Number(msatOf(x, part)) / 1e11) * perBtc * 10000) / 10000]));
  const parts = ['all', 'protocol', 'app'];
  const sums = { msat: '0', protocolMsat: '0', appMsat: '0', fiat: Object.fromEntries(parts.map((p) => [p, {}])) };
  for (const [k, p] of [['msat', 'all'], ['protocolMsat', 'protocol'], ['appMsat', 'app']]) sums[k] = String(rows.reduce((t, x) => t + msatOf(x, p), 0n));
  for (const p of parts) { const t = sums.fiat[p]; for (const x of rows) for (const [c, v] of Object.entries(fiat(x, p))) t[c] = (t[c] || 0) + v; for (const c of Object.keys(t)) t[c] = Math.round(t[c] * 10000) / 10000; }
  return { total: rows.length, offset, limit, apps: [...apps.values()], origins: [...origins].map(([o, count]) => ({ origin: o, title: ORIGIN_TITLE(o), count })), sums,
    rows: rows.slice(offset, offset + limit).map((x) => ({ atMs: at(x.r), amountMsat: String(x.r.amountMsat || '0'), protocolMsat: String(x.protocolMsat), appMsat: String(x.appMsat),
      app: x.game, title: x.title, market: !!x.market, item: x.item, round: x.item ? null : String(x.r.roundId || ''),
      origin: donationOrigin(x), entry: String(x.r.entryId || ''), player: x.player !== undefined ? x.player : (x.r.playerKey ? String(x.r.playerKey) : null), window: x.window || null, parts: x.parts || null, outpoint: String(x.r.outpoint || ''),
      fiat: Object.fromEntries(parts.map((p) => [p, fiat(x, p)])) })) };
}

export function createDevClients({ root, donorBin, nodeBin = process.execPath, defaults = {}, keys, spawn = spawnChild, restartMs = 30000, log = () => {} }) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const running = new Map();       // slug -> { child, stopping }
  const dirOf = (slug) => join(root, slug);
  const isClient = (slug) => SLUG.test(slug) && existsSync(join(dirOf(slug), 'donor.json')) && existsSync(join(dirOf(slug), 'key.json'));

  function start(slug) {
    if (running.has(slug) || !isClient(slug)) return;
    const dir = dirOf(slug);
    const out = openSync(join(dir, 'donor.log'), 'a');
    const child = spawn(nodeBin, [donorBin, 'loop', dir], { stdio: ['ignore', out, out], detached: false });
    closeSync(out);
    const held = { child, stopping: false, startedAt: Date.now() };
    running.set(slug, held);
    log(`[dev] client ${slug} started (pid ${child.pid})`);
    child.on('exit', (code, signal) => {
      if (running.get(slug) === held) running.delete(slug);
      if (held.stopping) return;
      log(`[dev] client ${slug} stopped (${signal || code}); started again in ${restartMs / 1000} s`);
      setTimeout(() => { if (isClient(slug)) start(slug); }, restartMs).unref?.();
    });
  }

  return {
    /** Every client in `root` started (at the node's start). */
    startAll() { for (const s of readdirSync(root)) if (isClient(s)) start(s); },
    stopAll() { for (const [, h] of running) { h.stopping = true; try { h.child.kill('SIGTERM'); } catch { /* gone */ } } running.clear(); },

    /** A NEW CLIENT: { label, secretHex? , minWithdrawMsat? }. Answers { ok, slug, recipientPk, imported } or { ok: false, why }. */
    setup({ label, secretHex, minWithdrawMsat } = {}) {
      const slug = slugOf(label);
      if (!SLUG.test(slug)) return { ok: false, status: 400, why: 'a label of letters and digits (up to 32)' };
      if (existsSync(dirOf(slug))) return { ok: false, status: 409, why: `a dev client "${slug}" exists on this node` };
      if (!defaults.wasmPkg) return { ok: false, status: 501, why: 'this node names no lock client for its dev clients (ARENA_DEV_WASM_PKG)' };
      let k;
      if (secretHex !== undefined && secretHex !== null && String(secretHex).trim() !== '') {
        const h = String(secretHex).trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(h)) return { ok: false, status: 400, why: 'a dev key\'s secret is 64 hex characters' };
        try { k = keys.keyFromSecret(Buffer.from(h, 'hex')); } catch (e) { return { ok: false, status: 400, why: `not a key: ${e.message}` }; }
      } else k = keys.newKey();
      const imported = secretHex !== undefined && secretHex !== null && String(secretHex).trim() !== '';
      for (const s of readdirSync(root)) {
        const cfg = readJson(join(dirOf(s), 'donor.json'));
        if (cfg && cfg.recipientPkHex === k.recipientPkHex && !/\.removed-/.test(s)) return { ok: false, status: 409, why: `this key already has a client here ("${s}"): two clients on one key would spend the same notes` };
      }
      const dir = dirOf(slug);
      mkdirSync(dir, { mode: 0o700 });
      writeJson(join(dir, 'key.json'), { label: String(label), ...k }, 0o600);
      writeJson(join(dir, 'donor.json'), {
        label: String(label), recipientPkHex: k.recipientPkHex, seats: defaults.seats || [], invites: defaults.invites || {},
        invitesFrom: defaults.invitesFrom || [], gateways: defaults.gateways || [], wasmPkg: defaults.wasmPkg,
        minWithdrawMsat: String(minWithdrawMsat || '10000'), intervalSec: 300, imported, setUpBy: 'owner page', setUpAt: new Date().toISOString(),
      });
      log(`[dev] client ${slug} set up by the owner (${imported ? 'an imported key' : 'a new key'} ${k.recipientPkHex.slice(0, 16)})`);
      start(slug);
      return { ok: true, slug, recipientPk: k.recipientPkHex, imported };
    },

    /** THE OWNER'S WITHDRAWAL: { slug, invoice | lnAddress, msat?, federation? }, left for the client; answered in its state. */
    withdraw({ slug, invoice, lnAddress, msat, federation } = {}) {
      if (!isClient(String(slug))) return { ok: false, status: 404, why: 'no such dev client on this node' };
      const inv = invoice ? String(invoice).trim() : '';
      const addr = lnAddress ? String(lnAddress).trim() : '';
      if (!inv === !addr) return { ok: false, status: 400, why: 'give an invoice or a Lightning address' };
      if (inv && !/^ln(bcrt|tbs|tb|bc|sb)[0-9a-z]+$/i.test(inv)) return { ok: false, status: 400, why: 'that is not a Lightning invoice (lnbc…/lntb…)' };
      if (addr && !/^[a-z0-9._+-]+@[a-z0-9.:-]+$/i.test(addr)) return { ok: false, status: 400, why: 'a Lightning address is name@domain' };
      if (msat !== undefined && msat !== null && msat !== '' && !/^\d+$/.test(String(msat))) return { ok: false, status: 400, why: 'an amount in msat, a whole number' };
      const reqPath = join(dirOf(slug), 'withdraw-request.json');
      if (existsSync(reqPath)) return { ok: false, status: 409, why: 'a withdrawal is waiting to be taken: try again in a few seconds' };
      const id = randomBytes(8).toString('hex');
      writeJson(reqPath, { id, at: new Date().toISOString(), ...(inv ? { invoice: inv } : { lnAddress: addr }), ...(msat ? { msat: String(msat) } : {}), ...(federation ? { federation: String(federation) } : {}) });
      log(`[dev] client ${slug}: the owner asked for a withdrawal to ${inv ? 'an invoice' : addr} (${id})`);
      return { ok: true, id };
    },

    /** STOPPED, NEVER DELETED: the directory is renamed, its key kept. */
    remove({ slug } = {}) {
      if (!isClient(String(slug))) return { ok: false, status: 404, why: 'no such dev client on this node' };
      const h = running.get(slug);
      if (h) { h.stopping = true; try { h.child.kill('SIGTERM'); } catch { /* gone */ } running.delete(slug); }
      const kept = `${slug}.removed-${Date.now()}`;
      renameSync(dirOf(slug), join(root, kept));
      log(`[dev] client ${slug} removed; its directory and key are kept as ${kept}`);
      return { ok: true, kept };
    },

    /** THE CLIENT'S KEY, FOR ITS OWN BALLOT SIGNATURES (§27A.4.1): { recipientPkHex, secretHex } - never answered to a page. */
    keyOf(slug) {
      if (!isClient(String(slug))) return null;
      const k = readJson(join(dirOf(slug), 'key.json'));
      return k && /^[0-9a-f]{64}$/.test(k.secretHex || '') ? { recipientPkHex: k.recipientPkHex, secretHex: k.secretHex } : null;
    },

    /** Every client's record rows and the seats its donor.json names (the rounds whose game the node must look up). */
    rowsAndSeats() {
      const rows = []; const seats = new Set();
      for (const slug of readdirSync(root).filter(isClient)) {
        const dir = dirOf(slug);
        const cfg = readJson(join(dir, 'donor.json'), {}) || {};
        for (const u of cfg.seats || []) seats.add(String(u));
        if (!existsSync(join(dir, 'donations.jsonl'))) continue;
        for (const l of readFileSync(join(dir, 'donations.jsonl'), 'utf8').split('\n')) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch { /* a torn line */ } }
      }
      return { rows, seats: [...seats] };
    },

    /** Every client: its snapshot, whether it runs, what the owner's withdrawals answered; `attribute(rows, recipientPk)` adds the split. */
    /** WHERE A CLIENT KEEPS ITS RECORD, for the donations table: { dir, pk } (kanban #578) - never its key.json */
    clientOf(slug) {
      if (!isClient(slug)) return null;
      return { dir: dirOf(slug), pk: (readJson(join(dirOf(slug), 'donor.json'), {}) || {}).recipientPkHex };
    },
    /** THE CLIENT'S DONATIONS IN A CURRENCY (fiat-rates.js, kanban #578): each at its own historic rate, the sums per period, the price now */
    async fiatFor(slug, { fetcher = fetch } = {}) {
      if (!isClient(slug)) return null;
      const { fillFiatRates, fiatSummary, ratesNow, rowsOf } = await import('./fiat-rates.js');
      const dir = dirOf(slug), rows = rowsOf(dir);
      const rates = await fillFiatRates(dir, rows, { fetcher });
      const sum = fiatSummary(rows, rates);
      const recent = rows.slice(-20).reverse().map((r) => r.outpoint);
      return { now: await ratesNow({ fetcher }), totals: sum.totals, unrated: sum.unrated, recent: Object.fromEntries(recent.map((o) => [o, sum.values[o] || {}])) };
    },
    list({ attribute = null } = {}) {
      return readdirSync(root).filter(isClient).sort().map((slug) => {
        const dir = dirOf(slug);
        const snap = devClientSnapshot(dir, { recent: 20 });
        const state = readJson(join(dir, 'state.json'), {}) || {};
        const cfg = readJson(join(dir, 'donor.json'), {}) || {};
        const h = running.get(slug);
        let split = null;
        if (attribute) {
          const rows = existsSync(join(dir, 'donations.jsonl')) ? readFileSync(join(dir, 'donations.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
          split = attribute(rows, cfg.recipientPkHex);
        }
        return { slug, ...snap, imported: !!cfg.imported, running: !!h, pid: h ? h.child.pid : null,
          waiting: existsSync(join(dir, 'withdraw-request.json')), requests: (state.requests || []).slice().reverse(), split };
      });
    },
  };
}
