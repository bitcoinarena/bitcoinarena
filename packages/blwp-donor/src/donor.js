// A DEV'S DONATION CLIENT (the owner 2026-10-03, FEDERATION.md "Donations in the federation"): one private key, whose public
// half is this dev's recipient key in the network's donation set. It asks every seat it knows what that key was given
// (GET /donations), learns from the answers in which federations the funds are, redeems each payout contract into its own
// wallet in that federation, and withdraws to the dev's own LND. What decides is here, testable; the federation is the
// page's own wasm lock client and the LND is lncli, both handed in (bin/blwp-donor.mjs).
import { createHash, generateKeyPairSync, createPrivateKey } from 'node:crypto';

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
export const donationFields = (recipientPkHex, amountMsat) => JSON.stringify({
  paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(amountMsat),
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
    try { said = JSON.parse(await client.refund(txid, outIdx, donationFields(recipientPkHex, d.amountMsat), secretHex)); }
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
