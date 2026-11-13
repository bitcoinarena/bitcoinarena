// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DEV'S DONATION CLIENT (2026-10-03, FEDERATION.md "Donations in the federation"): one private key, whose public
// half is this dev's recipient key in the network's donation set. It asks every seat it knows what that key was given
// (GET /donations), learns from the answers in which federations the funds are, redeems each payout contract into its own
// wallet in that federation, and withdraws to the dev's own LND. What decides is here, testable; the federation is the
// page's own wasm lock client and the LND is lncli, both handed in (bin/arena-donor.mjs).
import { createHash, generateKeyPairSync, createPrivateKey, sign as ecdsaSign } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { donationsReadMessage } from '../../arena-protocol/src/donations-read.js';

const hex = (b) => Buffer.from(b).toString('hex');

/** A NEW KEY: secp256k1, its 32-byte secret and its 33-byte compressed public key - the recipient key a set names. */
export function newKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return keyFromSecret(Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url'));
}

/**
 * EVERY FEDERATION'S INVITE FROM THE SEATS' SIGNED RECORDS (kanban #578, 2026-10-22: "dass dev a und dev b donations
 * überall bekommen"): a client knew only the invites of its donor.json and the one federation a daily.json names, so donations
 * paid in any other federation (4dc88be7, B's successor; every new founding) were seen at the seats and never redeemed. Each
 * seat's GET /federations lists the records it holds; a record names its federation's invite. Answers { federation id hex: invite }
 * from the first `want` seats that answer; a CLOSED record is skipped (nothing is paid into it any more).
 */
// `states` (optional, filled): { federation id hex: { status, successor } } - successor the record's successor_id hex, null for none;
// what moves a dev's money out of a DRAINING federation into its successor (kanban #578, the owner: "federations that are draining
// and are re-created keep their dev settings")
export async function invitesFromSeats({ seats, fetcher = fetch, decode, want = 3, timeoutMs = 15000, states = null }) {
  const out = {};
  let answered = 0;
  for (const seat of seats || []) {
    if (answered >= want) break;
    let d;
    try { d = await (await fetcher(`${String(seat).replace(/\/+$/, '')}/federations`, { signal: AbortSignal.timeout(timeoutMs) })).json(); } catch { continue; }
    if (!d || !Array.isArray(d.federations)) continue;
    answered++;
    for (const f of d.federations) {
      if (!f || f.status === 'CLOSED' || typeof f.record !== 'string') continue;
      try {
        const r = decode(f.record);
        const fid = String(f.federation).toLowerCase();
        if (r && r.invite) out[fid] = r.invite;
        const succ = r && r.successorId ? Buffer.from(r.successorId).toString('hex') : '';
        if (states && !states[fid]) states[fid] = { status: String(f.status || ''), successor: /^0*$/.test(succ) ? null : succ };
      } catch { /* a record that does not read */ }
    }
  }
  return out;
}

/**
 * EVERY DONATION'S DETAILS FOLLOW ITS MONEY (kanban #578, 2026-10-22: "make sure that the donation comments (having the player
 * key hash and round id etc) is also being transferred, we still need to know the details of every single donation"): a move out of
 * a draining federation writes one line to moves.jsonl - when, from and to, how much, and the outpoints of the donations recorded in
 * that federation (donations.jsonl keeps each one's player key, round, entry, contract, amount, time and rate) - so each donation's
 * money can be followed from the federation it was paid in to the one it is held in. Answers the line written.
 */
export function recordMove(movesPath, donationsPath, { from, to, movedMsat, chunks, atMs = Date.now() }) {
  let rows = [];
  try { rows = readFileSync(donationsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { rows = []; }
  const inFrom = rows.filter((r) => String(r.federationId || '').toLowerCase() === String(from).toLowerCase());
  const line = { at: new Date(atMs).toISOString(), from: String(from).toLowerCase(), to: String(to).toLowerCase(), movedMsat: String(movedMsat), chunks,
    donations: inFrom.map((r) => r.outpoint), donationsMsat: String(inFrom.reduce((t, r) => t + BigInt(r.amountMsat || 0), 0n)) };
  const fd = openSync(movesPath, 'a'); try { writeSync(fd, JSON.stringify(line) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  return line;
}

/** The key from its secret (32 bytes): the compressed public key, derived by node's own secp256k1. */
export function keyFromSecret(secret) {
  const d = Buffer.from(secret);
  if (d.length !== 32) throw new Error('a key\'s secret is 32 bytes');
  // a minimal SEC1 DER of d alone; node derives the public point itself
  const der = Buffer.concat([Buffer.from('302e0201010420', 'hex'), d, Buffer.from('a00706052b8104000a', 'hex')]);
  const j = createPrivateKey({ key: der, format: 'der', type: 'sec1' }).export({ format: 'jwk' });
  const x = Buffer.from(j.x, 'base64url'), y = Buffer.from(j.y, 'base64url');
  return { secretHex: d.toString('hex'), recipientPkHex: hex(Buffer.concat([Buffer.from([(y[31] & 1) ? 0x03 : 0x02]), x])) };
}

/** THE WALLET THIS DEV KEEPS IN ONE FEDERATION: its own secret, from the dev's key and that federation's id. */
export const walletSecretFor = (secretHex, federationIdHex) =>
  createHash('sha256').update('BLWP/v1/donor-wallet').update(Buffer.from(secretHex, 'hex')).update(Buffer.from(federationIdHex, 'hex')).digest('hex');

/**
 * WHAT THE KEY WAS GIVEN, AND WHERE: every seat asked, the answers merged by outpoint (a donation each seat verified is
 * one donation), grouped by federation. A seat that does not answer is named and skipped - another seat that verified the
 * same entry answers for it.
 */
// kanban #2133, #2195 (refute of #1618, the donor's copy of the page's flaw): one seat listing 20,000 made-up outpoints under the
// dev's key made one pass ask 20,000 rates, append 20,000 records and send 20,000 federation Refund calls. A seat's list is read
// only to its first DONOR_ROWS_PER_SEAT well-formed rows (outpoint txid:vout, 64-hex federation id, positive whole msat amount);
// a pass asks at most DONOR_RATES_PER_PASS rates and sends at most DONOR_REFUNDS_PER_PASS Refund calls, spent fairly (donorOrder);
// the rest wait for the next pass (the seats delete what a receipt names, so an honest seat's next rows come up).
export const DONOR_ROWS_PER_SEAT = 500;
export const DONOR_RATES_PER_PASS = 200;
export const DONOR_REFUNDS_PER_PASS = 200;
const FIRST_SEAT = Symbol('first seat');
/**
 * The order a pass's budget is spent in: outpoints listed by more distinct seats first; among those listed by as many, the seats
 * take turns (round-robin by the lowest-index seat that listed each), so one seat's rows alone never use the budget that rows other
 * seats list need. Stable: rows with no seat facts keep their order.
 */
export function donorOrder(donations) {
  const tiers = new Map();
  for (const d of donations) {
    const n = Number(d.seats) || 0, owner = d[FIRST_SEAT] ?? -1;
    if (!tiers.has(n)) tiers.set(n, new Map());
    const byOwner = tiers.get(n);
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(d);
  }
  const out = [];
  for (const n of [...tiers.keys()].sort((a, b) => b - a)) {
    const queues = [...tiers.get(n).keys()].sort((a, b) => a - b).map((o) => tiers.get(n).get(o));
    for (let i = 0, more = true; more; i++) {
      more = false;
      for (const q of queues) if (i < q.length) { out.push(q[i]); more = true; }
    }
  }
  return out;
}
const wellFormedRow = (d) => !!d && /^[0-9a-f]{64}:\d+$/.test(String(d.outpoint)) && /^[0-9a-f]{64}$/i.test(String(d.federationId))
  && /^[1-9]\d{0,20}$/.test(String(d.amountMsat));
export async function gatherDonations({ recipientPkHex, seats, fetcher = fetch, since = 0 }) {
  const byOutpoint = new Map();
  const unanswered = [];
  await Promise.all(seats.map(async (seat, si) => {
    try {
      const r = await fetcher(`${seat.replace(/\/$/, '')}/donations?key=${recipientPkHex}&since=${since}`);
      if (!r.ok) { unanswered.push(`${seat}: ${r.status}`); return; }
      const j = await r.json();
      const list = j && Array.isArray(j.donations) ? j.donations : [];
      const mine = new Set(); // kanban #2133: a seat that lists an outpoint twice is one seat
      for (const d of list) {
        if (mine.size >= DONOR_ROWS_PER_SEAT) break;
        if (!wellFormedRow(d) || mine.has(d.outpoint)) continue;
        mine.add(d.outpoint);
        const was = byOutpoint.get(d.outpoint);
        // a seat that names a market donation's parts (kanban #580) completes the row another seat gave without them
        if (was) { was.seats++; if (si < was[FIRST_SEAT]) was[FIRST_SEAT] = si; if (!was.parts && Array.isArray(d.parts) && d.parts.length) was.parts = d.parts; continue; }
        const row = { ...d, seats: 1 };
        Object.defineProperty(row, FIRST_SEAT, { value: si, writable: true, enumerable: false });
        byOutpoint.set(d.outpoint, row);
      }
    } catch (e) { unanswered.push(`${seat}: ${e.message}`); }
  }));
  const byFederation = new Map();
  for (const d of [...byOutpoint.values()].sort((a, b) => a.verifiedMs - b.verifiedMs)) {
    if (!byFederation.has(d.federationId)) byFederation.set(d.federationId, []);
    byFederation.get(d.federationId).push(d);
  }
  return { byFederation, unanswered, total: byOutpoint.size };
}

/** The payout contract a donation output is, as the lock client's `refund` rebuilds it (the seats' donationContractFields). */
// `imageHex`: the sender's 32-byte player key when the seats say it is on the contract, zeros otherwise.
export const donationFields = (recipientPkHex, amountMsat, imageHex = '00'.repeat(32)) => JSON.stringify({
  paymentImage: { kind: 'hash', bytes: imageHex }, amountMsat: String(amountMsat),
  claimPk: recipientPkHex, refundPk: recipientPkHex, expiration: 0,
});

/** "txid:outIdx" as the seats write it. */
export function splitOutpoint(s) {
  const m = /^([0-9a-f]{64}):(\d+)$/.exec(String(s));
  if (!m) throw new Error(`${s} is not an outpoint`);
  return { txid: m[1], outIdx: Number(m[2]) };
}

/**
 * ONE FEDERATION'S DONATIONS COLLECTED: each not yet redeemed is spent by `Refund` under the dev's key into this dev's
 * wallet there. A contract the guardians no longer hold was spent - by this key, the only one that can - and is final.
 * Answers what was redeemed, what was already spent, and what failed (asked again on the next pass).
 */
export async function redeemAll({ client, donations, recipientPkHex, secretHex, done = new Set(), refundsPerPass = DONOR_REFUNDS_PER_PASS }) {
  const redeemed = [], spent = [], failed = [];
  let asked = 0;
  for (const d of donorOrder(donations)) {
    if (done.has(d.outpoint)) continue;
    // kanban #2133, #2195: at most DONOR_REFUNDS_PER_PASS Refund calls a pass, most-listed first; the rest wait for the next pass
    if (asked >= refundsPerPass) break;
    asked++;
    const { txid, outIdx } = splitOutpoint(d.outpoint);
    let said;
    const image = d.senderOnContract && /^[0-9a-f]{64}$/.test(String(d.playerKey || '')) ? d.playerKey : '00'.repeat(32);
    try { said = JSON.parse(await client.refund(txid, outIdx, donationFields(recipientPkHex, d.amountMsat, image), secretHex)); }
    catch (e) { failed.push({ ...d, why: String(e.message || e) }); continue; }
    if (said.accepted === true) redeemed.push({ ...d, txid: said.txid });
    else if (said.stored_before === null || said.stored_before === undefined) spent.push(d);
    else failed.push({ ...d, why: said.error || 'the federation did not accept the redeem' });
  }
  return { redeemed, spent, failed };
}

/**
 * THE WITHDRAW TO THE DEV'S OWN LND, once there is enough to be worth one Lightning fee: the largest invoice the wallet can
 * pay through a gateway (fees taken off by the stock client), made by the dev's LND and paid from the federation.
 */
/**
 * ONE WALLET CLIENT PER FEDERATION FOR THE PROCESS (2026-10-07 11:50): each pass joined the federation
 * again and no client was ever closed - after 29 h a donor held ~720 sockets and 680 MB and spent 54-57% CPU between its 300 s
 * passes, and every one of those clients wrote the same wallet file. `join` is called once per federation; the join itself is
 * kept, so two asks never open two clients; a join that failed is forgotten and tried again on the next pass.
 */
export function walletClients(join) {
  const held = new Map();
  const get = (invite, federationId, secret, store) => {
    if (!held.has(federationId)) {
      const p = Promise.resolve().then(() => join(invite, federationId, secret, store));
      held.set(federationId, p);
      p.catch(() => { if (held.get(federationId) === p) held.delete(federationId); });
    }
    return held.get(federationId);
  };
  /** Drops a federation's client (before its wallet file is replaced by a recovered one); answers it, or null. */
  get.forget = (federationId) => { const p = held.get(federationId) || null; held.delete(federationId); return p; };
  return get;
}

/**
 * E-CASH ISSUED TO THE WALLET AND NEVER CLAIMED, RECOVERED ON ITS OWN (plan agreed by 2026-10-14). Measured that day:
 * 93,359 msat (dev a) and 34,596 msat (dev b) sat as outputs in issuance - refunds of failed withdrawals and change of redeems whose
 * state machines guardian WebSocket failures and restarts had cut off - until a hand-run recovery. One call per pass and federation,
 * after the redeem and before the withdrawal:
 *
 *   none     `pendingOutputs()` lists nothing: nothing is remembered.
 *   noted    something unclaimed that the last pass did not see (or not all of it): its nonces are remembered in `state.unclaimed`,
 *            nothing else is done - the live client may still be claiming a refund seconds old.
 *   recover  every nonce the last pass noted is still unclaimed: the wallet file is copied (`backup`, a pre-recover copy that is never
 *            deleted), Fedimint's own recovery runs into a new store (`recover`), which is reopened (`reopen` -> { balanceMsat,
 *            pendingMsat }) until its balance is the old balance plus what was unclaimed and nothing is pending - never swapped on the
 *            first open's 0 - and only then swapped in (`swap`). Otherwise the old wallet stays and the new store is kept (`keepFailed`).
 * Every recovery is logged in `state.recoveries`.
 */
export async function claimUnclaimed({ federation, pendingOutputs, balanceMsat, state, nowIso = () => new Date().toISOString(),
  backup, recover, reopen, swap, keepFailed, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 40, everyMs = 15000 }) {
  const pending = JSON.parse(await pendingOutputs());
  const nonces = pending.map((x) => String(x.nonce)).sort();
  const msat = pending.reduce((t, x) => t + BigInt(x.amount_msat), 0n);
  state.unclaimed = state.unclaimed || {};
  state.recoveries = state.recoveries || [];
  const was = state.unclaimed[federation];
  if (!nonces.length) { delete state.unclaimed[federation]; return { step: 'none', unclaimedMsat: 0n }; }
  const persisted = was && Array.isArray(was.nonces) && was.nonces.length && was.nonces.every((n) => nonces.includes(n));
  if (!persisted) {
    state.unclaimed[federation] = { nonces, msat: String(msat), since: nowIso() };
    return { step: 'noted', unclaimedMsat: msat, outputs: nonces.length };
  }
  const before = BigInt(await balanceMsat());
  const want = before + msat;
  const at = nowIso();
  const backupPath = await backup(at);
  await recover();
  let got = null;
  for (let i = 0; i < tries; i++) {
    got = await reopen();
    if (BigInt(got.balanceMsat) >= want && BigInt(got.pendingMsat) === 0n) break;
    got = { ...got, short: true };
    if (i < tries - 1) await sleep(everyMs);
  }
  const ok = !!got && !got.short;
  if (ok) await swap(); else await keepFailed(at);
  const entry = { at, federation, unclaimedMsat: String(msat), outputs: nonces.length, balanceBeforeMsat: String(before),
    recoveredMsat: got ? String(got.balanceMsat) : '0', pendingAfterMsat: got ? String(got.pendingMsat) : null, backup: backupPath, ok,
    why: ok ? null : `the recovered store held ${got ? got.balanceMsat : '?'} msat with ${got ? got.pendingMsat : '?'} msat still pending, not ${want}: the old wallet stays` };
  state.recoveries.push(entry);
  if (ok) delete state.unclaimed[federation];
  return { step: ok ? 'recovered' : 'recovery failed', ...entry };
}

export async function withdrawToLnd({ client, lnd, minMsat = 10000n, memo = 'blwp donations', gateways = [] }) {
  // AN EMPTY WALLET IS NOTHING TO WITHDRAW, NOT A FAILED PASS (measured 2026-10-14 15:02Z: after both withdrawals the lock
  // client answered "Balance is too low to send any amount after fees", every pass failed there, and its record stopped)
  let can;
  try { can = BigInt(await client.withdrawableMsat()); } catch (e) { if (/too low/i.test(String(e && e.message))) can = 0n; else throw e; }
  if (can < minMsat) return { withdrawn: false, withdrawableMsat: can, why: `${can} msat withdrawable, below the ${minMsat} msat minimum` };
  // THE GATEWAYS THE NETWORK NAMES FIRST, THEN THE CLIENT'S OWN PICK (measured 2026-10-14: left to the lock client, dev b
  // took a stale quick-tunnel gateway still registered in federation A - "Refunded" at 06:02Z and 14:39Z - while dev a, through the
  // gateway daily.json names, was paid at once). A refunded attempt leaves the e-cash in the wallet, so the next gateway is tried.
  const tried = [];
  for (const gw of [...new Set((gateways || []).filter(Boolean)), null]) {
    const invoice = await lnd.invoice(can, memo);
    let said;
    try { said = JSON.parse(await client.withdraw(invoice, gw || undefined)); } catch (e) { said = { state: 'Failed', why: e.message }; }
    tried.push(`${gw || 'client pick'}: ${said.state}`);
    if (said.state === 'Success') return { withdrawn: true, withdrawableMsat: can, ...said, tried };
    let left; try { left = BigInt(await client.withdrawableMsat()); } catch { left = 0n; }
    if (left < can) return { withdrawn: false, withdrawableMsat: can, ...said, tried, why: said.why || 'the e-cash left the wallet without a Success: not tried again' };
  }
  return { withdrawn: false, withdrawableMsat: can, state: 'Refunded', tried };
}

// A WITHDRAWAL THE NODE'S OWNER ASKED FOR (2026-10-14: "there's a withdrawal feature that withdraws it to
// lightning"): the owner gives an invoice or a Lightning address on the owner page; the node leaves the request in this client's
// directory (withdraw-request.json) and the client pays it from one federation's wallet, through the gateways the network names.

const MULT = { m: 100000000n, u: 100000n, n: 100n };
/** A BOLT11 invoice's amount in msat, from its human-readable part; null when it names none (a zero-amount invoice). */
export function invoiceMsat(invoice) {
  const m = /^ln(?:bcrt|tbs|tb|bc|sb)(\d+)?([munp])?1[02-9ac-hj-np-z]+$/.exec(String(invoice || '').trim().toLowerCase());
  if (!m) throw new Error('that is not a Lightning invoice (lnbc…/lntb…)');
  if (!m[1]) return null;
  const n = BigInt(m[1]);
  if (!m[2]) return n * 100000000000n;
  if (m[2] === 'p') { if (n % 10n) throw new Error('an invoice amount below one msat'); return n / 10n; }
  return n * MULT[m[2]];
}

/** The invoice a Lightning address (LNURL-pay, LUD-16) makes for `msat`: name@domain -> /.well-known/lnurlp/name -> its callback. */
export async function lightningAddressInvoice(address, msat, { fetcher = fetch } = {}) {
  const m = /^([a-z0-9._+-]+)@((?:[a-z0-9-]+\.)+[a-z]{2,}|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/i.exec(String(address || '').trim());
  if (!m) throw new Error('a Lightning address is name@domain');
  const base = /^(localhost|127\.)/.test(m[2]) ? `http://${m[2]}` : `https://${m[2]}`;
  const meta = await (await fetcher(`${base}/.well-known/lnurlp/${m[1].toLowerCase()}`)).json();
  if (meta && meta.status === 'ERROR') throw new Error(`${address}: ${meta.reason || 'refused'}`);
  if (!meta || meta.tag !== 'payRequest' || typeof meta.callback !== 'string') throw new Error(`${address} answers no Lightning pay request`);
  const want = BigInt(msat);
  if (want < BigInt(meta.minSendable) || want > BigInt(meta.maxSendable)) throw new Error(`${address} takes ${meta.minSendable} to ${meta.maxSendable} msat, not ${want}`);
  const u = new URL(meta.callback);
  u.searchParams.set('amount', String(want));
  const r = await (await fetcher(u.toString())).json();
  if (!r || r.status === 'ERROR' || typeof r.pr !== 'string') throw new Error(`${address}: ${(r && r.reason) || 'no invoice'}`);
  if (invoiceMsat(r.pr) !== want) throw new Error(`${address} made an invoice for ${invoiceMsat(r.pr)} msat, not ${want}`);
  return r.pr;
}

/**
 * PAY ONE INVOICE FROM THIS WALLET: the gateways the network names first, then the client's own pick, as withdrawToLnd. The invoice
 * names its amount and that must be withdrawable. A refunded attempt leaves the e-cash in the wallet, so the next gateway is tried
 * with the same invoice; e-cash that left without a Success is never tried again.
 */
export async function payInvoice({ client, invoice, gateways = [] }) {
  const msat = invoiceMsat(invoice);
  if (msat === null) return { paid: false, state: 'Refused', why: 'an invoice without an amount: ask for one that names it' };
  let can;
  try { can = BigInt(await client.withdrawableMsat()); } catch (e) { if (/too low/i.test(String(e && e.message))) can = 0n; else throw e; }
  if (msat > can) return { paid: false, state: 'Refused', msat, withdrawableMsat: can, why: `the invoice asks ${msat} msat; this wallet can send ${can} msat after fees` };
  const tried = [];
  for (const gw of [...new Set((gateways || []).filter(Boolean)), null]) {
    let said;
    try { said = JSON.parse(await client.withdraw(invoice, gw || undefined)); } catch (e) { said = { state: 'Failed', why: e.message }; }
    tried.push(`${gw || 'client pick'}: ${said.state}`);
    if (said.state === 'Success') return { paid: true, msat, withdrawableMsat: can, ...said, tried };
    let left; try { left = BigInt(await client.withdrawableMsat()); } catch { left = 0n; }
    if (left < can) return { paid: false, msat, withdrawableMsat: can, ...said, tried, why: said.why || 'the e-cash left the wallet without a Success: not tried again' };
  }
  return { paid: false, msat, withdrawableMsat: can, state: 'Refunded', tried, why: 'every gateway refunded it' };
}

/**
 * THE GUARDIANS' SECOND ROUTE, AS THE PAGE TAKES IT (index.html RoutedWebSocket): daily.json's testnet.alt maps a host, or a
 * host and its first path segment, to a Cloudflare tunnel; a socket to such an address goes there instead. Measured
 * 2026-10-03 on the test host: the invite's Funnel addresses answered nothing ("Failed to download client config") - the
 * Funnel relay drops connections from that machine. Installed on `globalThis.WebSocket`, which the wasm lock client uses.
 */
export function routeWebSockets(routes, Real = globalThis.WebSocket) {
  if (!Real || !routes || !Object.keys(routes).length) return false;
  class Routed extends Real {
    constructor(url, protocols) {
      let to = String(url);
      try {
        const u = new URL(to);
        const alt = routes[`${u.host}/${u.pathname.split('/')[1]}`] || routes[u.host];
        if (alt && !/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(alt)) { u.host = alt; to = u.toString(); }
      } catch { /* as named */ }
      if (protocols === undefined) super(to); else super(to, protocols);
    }
  }
  globalThis.WebSocket = Routed;
  return true;
}

/**
 * THE RATE AT THE DONATION'S TIME (2026-10-05 08:17; source ruled the same day: a public price API the dev
 * client calls itself, named in each record - no seat asks for a rate). CoinGecko's market chart around the time, per
 * currency; the price nearest the donation's own time is taken. Answers { ok, usd, eur, priceAtMs, provider } or why not.
 */
export const RATE_PROVIDER = 'coingecko api/v3 coins/bitcoin/market_chart/range';
export async function rateAt({ atMs, fetcher = fetch }) {
  const from = Math.floor((Number(atMs) - 3600000) / 1000), to = Math.ceil((Number(atMs) + 3600000) / 1000);
  const out = { ok: true, provider: RATE_PROVIDER, priceAtMs: {} };
  // CHF AND GBP TOO (kanban #578), BEST EFFORT: USD and EUR are the record's as before - a failure there answers why - while a CHF or GBP
  // price the provider does not give (a rate limit on the extra calls) is left out; the owner page fills it later (fiat-rates.js)
  for (const cur of ['usd', 'eur', 'chf', 'gbp']) {
    const must = cur === 'usd' || cur === 'eur';
    let prices;
    try {
      const r = await fetcher(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=${cur}&from=${from}&to=${to}`);
      if (!r.ok) { if (must) return { ok: false, provider: RATE_PROVIDER, why: `${RATE_PROVIDER} answered ${r.status} for ${cur}` }; continue; }
      prices = (await r.json()).prices;
    } catch (e) { if (must) return { ok: false, provider: RATE_PROVIDER, why: `${RATE_PROVIDER}: ${e.message}` }; continue; }
    if (!Array.isArray(prices) || !prices.length) { if (must) return { ok: false, provider: RATE_PROVIDER, why: `${RATE_PROVIDER} has no ${cur} price around ${new Date(Number(atMs)).toISOString()}` }; continue; }
    const [ms, price] = prices.reduce((best, p) => (Math.abs(p[0] - atMs) < Math.abs(best[0] - atMs) ? p : best));
    out[cur] = price;
    out.priceAtMs[cur] = ms;
  }
  return { ok: true, usd: out.usd, eur: out.eur, ...(out.chf ? { chf: out.chf } : {}), ...(out.gbp ? { gbp: out.gbp } : {}), priceAtMs: out.priceAtMs, provider: RATE_PROVIDER };
}

/** One donation as the dev keeps it for good: who sent it, in which round, how much, when, and what it was worth then. */
export const donationRecord = (d, rate, { recordedAt = Date.now() } = {}) => ({
  outpoint: d.outpoint, federationId: d.federationId, amountMsat: String(d.amountMsat), contractId: d.contractId,
  playerKey: d.playerKey || null, senderOnContract: !!d.senderOnContract, roundId: d.roundId, entryId: d.entryId, verifiedMs: Number(d.verifiedMs),
  usdPerBtc: rate.usd, eurPerBtc: rate.eur, ...(rate.chf ? { chfPerBtc: rate.chf } : {}), ...(rate.gbp ? { gbpPerBtc: rate.gbp } : {}), ratesAtMs: rate.priceAtMs, rateProvider: rate.provider, recordedAt,
  // AN ITEM'S DONATION names what was bought (kanban #578): the seat's "<game> · <item id>", and both parts on their own to group by
  ...(d.item ? itemFields(d.item) : {}),
  // A MARKET'S DONATION, ORDER BY ORDER (kanban #580): each filled order's entry, player key and its share of this output in msat (the
  // output times its fee over all the parts' fees, the rest of a msat to the first); one order alone is the row's player
  ...(Array.isArray(d.parts) && d.parts.length ? marketParts(d) : {}),
});
export function marketParts(d) {
  const amount = BigInt(d.amountMsat || 0), weights = d.parts.map((x) => BigInt(x.feeMsat || 0)), total = weights.reduce((t, w) => t + w, 0n);
  const shares = weights.map((w) => (total > 0n ? (amount * w) / total : 0n));
  if (shares.length) shares[0] += amount - shares.reduce((t, x) => t + x, 0n);
  const parts = d.parts.map((x, i) => ({ entryId: String(x.entryId), playerKey: String(x.playerPubkey), msat: String(shares[i]) }));
  return { parts, ...(!d.playerKey && parts.length === 1 ? { playerKey: parts[0].playerKey } : {}) };
}
const itemFields = (label) => { const s = String(label); const at = s.lastIndexOf(' · ');
  return at > 0 ? { item: s, itemGame: s.slice(0, at), itemId: s.slice(at + 3) } : { item: s }; };

/** The dev's permanent record: one JSON line per donation, appended and synced to disk before this returns. Never rewritten. */
export function recordDonations(path, records) {
  const had = new Set(readRecord(path).map((r) => r.outpoint));
  const fresh = records.filter((r) => !had.has(r.outpoint));
  if (!fresh.length) return 0;
  const fd = openSync(path, 'a', 0o600);
  try { writeSync(fd, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  return fresh.length;
}
export const readRecord = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The read receipt the seats check (protocol donations-read.js): ECDSA by the recipient key over the outpoints read. */
export function signDonationsRead({ secretHex, key, atMs, outpoints }) {
  const der = Buffer.concat([Buffer.from('302e0201010420', 'hex'), Buffer.from(secretHex, 'hex'), Buffer.from('a00706052b8104000a', 'hex')]);
  return ecdsaSign('sha256', donationsReadMessage({ key, atMs, outpoints }), { key: createPrivateKey({ key: der, format: 'der', type: 'sec1' }), dsaEncoding: 'der' }).toString('hex');
}

/**
 * RECORD, REDEEM, THEN TELL THE SEATS: each donation's rate is asked and its record written to disk first; a
 * donation whose rate is not to be had is not recorded and not receipted (the seats keep it for the next pass). Then the
 * recorded ones are redeemed; only those recorded AND redeemed or already spent are named in a read receipt to every seat.
 */
export async function settleRead({ path, donations, client, key, seats, fetcher = fetch, now = () => Date.now(), done = new Set() }) {
  const recorded = new Set(readRecord(path).map((r) => r.outpoint));
  const unrecorded = [];
  const fresh = [];
  let rated = 0, waiting = 0;
  for (const d of donorOrder(donations)) {
    if (recorded.has(d.outpoint)) continue;
    // kanban #2133, #2195: at most DONOR_RATES_PER_PASS rate lookups (and so records) a pass, most-listed first
    if (rated >= DONOR_RATES_PER_PASS) { waiting++; continue; }
    rated++;
    const rate = await rateAt({ atMs: d.verifiedMs, fetcher });
    if (!rate.ok) { unrecorded.push({ outpoint: d.outpoint, why: rate.why }); continue; }
    fresh.push(donationRecord(d, rate, { recordedAt: now() }));
  }
  recordDonations(path, fresh);
  for (const r of fresh) recorded.add(r.outpoint);
  const r = await redeemAll({ client, donations: donations.filter((d) => recorded.has(d.outpoint)), recipientPkHex: key.recipientPkHex, secretHex: key.secretHex, done });
  // A DONATION REDEEMED IN AN EARLIER PASS THAT A SEAT STILL LISTS (a seat that indexed it again, or whose
  // earlier receipt it refused) is named again - recorded first like any other - so the seats' copy goes in the end
  const again = donations.filter((d) => done.has(d.outpoint)).map((d) => d.outpoint);
  const read = [...r.redeemed, ...r.spent].map((d) => d.outpoint).concat(again).filter((o) => recorded.has(o));
  const answers = [];
  if (read.length) {
    const atMs = now();
    const body = JSON.stringify({ key: key.recipientPkHex, atMs, outpoints: read, signature: signDonationsRead({ secretHex: key.secretHex, key: key.recipientPkHex, atMs, outpoints: read }) });
    for (const seat of seats) {
      try { const a = await fetcher(`${seat.replace(/\/$/, '')}/donations/read`, { method: 'POST', body }); answers.push({ seat, status: a.status, said: (await a.text()).trim() }); }
      catch (e) { answers.push({ seat, why: e.message }); }
    }
  }
  return { recorded: fresh.length, redeemed: r.redeemed, spent: r.spent, failed: r.failed, unrecorded, waiting, receipted: read.length, answers };
}
