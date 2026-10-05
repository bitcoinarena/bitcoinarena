// A DEV'S DONATION CLIENT (the owner 2026-10-03, FEDERATION.md "Donations in the federation"): one private key, whose public
// half is this dev's recipient key in the network's donation set. It asks every seat it knows what that key was given
// (GET /donations), learns from the answers in which federations the funds are, redeems each payout contract into its own
// wallet in that federation, and withdraws to the dev's own LND. What decides is here, testable; the federation is the
// page's own wasm lock client and the LND is lncli, both handed in (bin/blwp-donor.mjs).
import { createHash, generateKeyPairSync, createPrivateKey, sign as ecdsaSign } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { donationsReadMessage } from '../../protocol/src/donations-read.js';

const hex = (b) => Buffer.from(b).toString('hex');

/** A NEW KEY: secp256k1, its 32-byte secret and its 33-byte compressed public key - the recipient key a set names. */
export function newKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return keyFromSecret(Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url'));
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
export async function gatherDonations({ recipientPkHex, seats, fetcher = fetch, since = 0 }) {
  const byOutpoint = new Map();
  const unanswered = [];
  await Promise.all(seats.map(async (seat) => {
    try {
      const r = await fetcher(`${seat.replace(/\/$/, '')}/donations?key=${recipientPkHex}&since=${since}`);
      if (!r.ok) { unanswered.push(`${seat}: ${r.status}`); return; }
      const j = await r.json();
      for (const d of j.donations || []) {
        const was = byOutpoint.get(d.outpoint);
        if (was) { was.seats++; continue; }
        byOutpoint.set(d.outpoint, { ...d, seats: 1 });
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
// `imageHex`: the sender's 32-byte player key when the seats say it is on the contract (kanban #156), zeros otherwise.
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
export async function redeemAll({ client, donations, recipientPkHex, secretHex, done = new Set() }) {
  const redeemed = [], spent = [], failed = [];
  for (const d of donations) {
    if (done.has(d.outpoint)) continue;
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
export async function withdrawToLnd({ client, lnd, minMsat = 10000n, memo = 'blwp donations' }) {
  const can = BigInt(await client.withdrawableMsat());
  if (can < minMsat) return { withdrawn: false, withdrawableMsat: can, why: `${can} msat withdrawable, below the ${minMsat} msat minimum` };
  const invoice = await lnd.invoice(can, memo);
  const said = JSON.parse(await client.withdraw(invoice, null));
  return { withdrawn: said.state === 'Success', withdrawableMsat: can, ...said };
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
 * THE RATE AT THE DONATION'S TIME (kanban #156, the owner 2026-10-05 08:17; source ruled the same day: a public price API the dev
 * client calls itself, named in each record - no seat asks for a rate). CoinGecko's market chart around the time, per
 * currency; the price nearest the donation's own time is taken. Answers { ok, usd, eur, priceAtMs, provider } or why not.
 */
export const RATE_PROVIDER = 'coingecko api/v3 coins/bitcoin/market_chart/range';
export async function rateAt({ atMs, fetcher = fetch }) {
  const from = Math.floor((Number(atMs) - 3600000) / 1000), to = Math.ceil((Number(atMs) + 3600000) / 1000);
  const out = { ok: true, provider: RATE_PROVIDER, priceAtMs: {} };
  for (const cur of ['usd', 'eur']) {
    let prices;
    try {
      const r = await fetcher(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=${cur}&from=${from}&to=${to}`);
      if (!r.ok) return { ok: false, provider: RATE_PROVIDER, why: `${RATE_PROVIDER} answered ${r.status} for ${cur}` };
      prices = (await r.json()).prices;
    } catch (e) { return { ok: false, provider: RATE_PROVIDER, why: `${RATE_PROVIDER}: ${e.message}` }; }
    if (!Array.isArray(prices) || !prices.length) return { ok: false, provider: RATE_PROVIDER, why: `${RATE_PROVIDER} has no ${cur} price around ${new Date(Number(atMs)).toISOString()}` };
    const [ms, price] = prices.reduce((best, p) => (Math.abs(p[0] - atMs) < Math.abs(best[0] - atMs) ? p : best));
    out[cur] = price;
    out.priceAtMs[cur] = ms;
  }
  return { ok: true, usd: out.usd, eur: out.eur, priceAtMs: out.priceAtMs, provider: RATE_PROVIDER };
}

/** One donation as the dev keeps it for good: who sent it, in which round, how much, when, and what it was worth then. */
export const donationRecord = (d, rate, { recordedAt = Date.now() } = {}) => ({
  outpoint: d.outpoint, federationId: d.federationId, amountMsat: String(d.amountMsat), contractId: d.contractId,
  playerKey: d.playerKey || null, senderOnContract: !!d.senderOnContract, roundId: d.roundId, entryId: d.entryId, verifiedMs: Number(d.verifiedMs),
  usdPerBtc: rate.usd, eurPerBtc: rate.eur, ratesAtMs: rate.priceAtMs, rateProvider: rate.provider, recordedAt,
});

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
 * RECORD, REDEEM, THEN TELL THE SEATS (kanban #156): each donation's rate is asked and its record written to disk first; a
 * donation whose rate is not to be had is not recorded and not receipted (the seats keep it for the next pass). Then the
 * recorded ones are redeemed; only those recorded AND redeemed or already spent are named in a read receipt to every seat.
 */
export async function settleRead({ path, donations, client, key, seats, fetcher = fetch, now = () => Date.now(), done = new Set() }) {
  const recorded = new Set(readRecord(path).map((r) => r.outpoint));
  const unrecorded = [];
  const fresh = [];
  for (const d of donations) {
    if (recorded.has(d.outpoint)) continue;
    const rate = await rateAt({ atMs: d.verifiedMs, fetcher });
    if (!rate.ok) { unrecorded.push({ outpoint: d.outpoint, why: rate.why }); continue; }
    fresh.push(donationRecord(d, rate, { recordedAt: now() }));
  }
  recordDonations(path, fresh);
  for (const r of fresh) recorded.add(r.outpoint);
  const r = await redeemAll({ client, donations: donations.filter((d) => recorded.has(d.outpoint)), recipientPkHex: key.recipientPkHex, secretHex: key.secretHex, done });
  const read = [...r.redeemed, ...r.spent].map((d) => d.outpoint).filter((o) => recorded.has(o));
  const answers = [];
  if (read.length) {
    const atMs = now();
    const body = JSON.stringify({ key: key.recipientPkHex, atMs, outpoints: read, signature: signDonationsRead({ secretHex: key.secretHex, key: key.recipientPkHex, atMs, outpoints: read }) });
    for (const seat of seats) {
      try { const a = await fetcher(`${seat.replace(/\/$/, '')}/donations/read`, { method: 'POST', body }); answers.push({ seat, status: a.status, said: (await a.text()).trim() }); }
      catch (e) { answers.push({ seat, why: e.message }); }
    }
  }
  return { recorded: fresh.length, redeemed: r.redeemed, spent: r.spent, failed: r.failed, unrecorded, receipted: read.length, answers };
}
