// THE ROUND'S FEDERATION, AS A SIGNER NODE ASKS IT (v4.6.2 §23.1 step 5).
//
// Two answers, both the stock Fedimint 0.12.0 client's own, through
// blwp-stake-lock (tools/stake-lock, our code on the stock client crates):
//   status(outpoint)    what the guardians hold there - the contract id and
//                       the blocks LEFT to its expiry - and their block count
//   contractId(fields)  the stock hash of a contract the player handed over
// Nothing here hashes a contract or speaks the federation's API: a second
// implementation of either would be a second place for them to disagree.
//
// It runs the tool once per question, as the node's lndPort (node-start.js) runs lncli: the
// federation is the tool's business, and a daemon that linked the client
// crates in would be a daemon in Rust.
import { execFile } from 'node:child_process';
import { toHex, fromHex } from '../../protocol/src/hash.js';

export const STAKE_LOCK_SETTINGS = ['BLWP_STAKE_LOCK_BIN', 'BLWP_FEDERATION_CLIENT_DIR'];

const run = (bin, args, timeoutMs) => new Promise((done, fail) => {
  execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    const line = String(stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    if (err && !line) return fail(new Error(`blwp-stake-lock: ${String(stderr || err.message).trim().split('\n').pop()}`));
    try { done(JSON.parse(line)); } catch { fail(new Error(`blwp-stake-lock answered no JSON: ${String(stdout).slice(0, 200)}`)); }
  });
});

const outpointArg = (o) => `${toHex(o.txid)}:${o.outIdx}`;

/** The tool's arguments for a contract's fields - the same flags its lock mode takes. */
export function contractArgs(f) {
  const image = f.paymentImage.kind === 'point' ? ['--point', toHex(f.paymentImage.bytes)] : ['--hash', toHex(f.paymentImage.bytes)];
  return [...image, '--amount-msat', String(f.amountMsat), '--claim-pk', toHex(f.claimPk),
    '--refund-pk', toHex(f.refundPk), '--expiration', String(f.expiration)];
}

// THE FEDERATION'S GATEWAYS AND FEE RULE, KEPT A MINUTE FOR EVERY CALLER (the owner 2026-10-02, the the test host's load): the
// winnings resend loop asked both on every pass over its held rounds - one stock-client run each, about one every 6 s per
// signer node - and each run opened the federation client's database: ~1.7 MB/s written by every idle testnet4 seat,
// 12 MB/s together, while no table changed. One read in flight; a failed read is not kept. (The doors did this already.)
// AND AN ANSWER ALREADY HELD IS GIVEN AT ONCE PAST ITS MINUTE, READ AGAIN BEHIND IT (the owner 2026-10-02, the join's 2-3 s):
// the federation's fee rule, guardians and gateways are its config, and the paid entry door waited on a fresh read of the
// fee rule whenever the minute had run out - POST /entry 0.29-0.90 s at seat 1, 0 ms of it on the loop. Only the first
// read ever waits; a failed re-read keeps the answer held.
export const keptFor = (ms, fn, now = () => Date.now()) => {
  let at = 0, v = null, p = null;
  const read = () => {
    if (!p) p = Promise.resolve().then(fn).then((r) => { v = r; at = now(); return r; }).finally(() => { p = null; });
    return p;
  };
  return () => {
    if (v && now() - at < ms) return Promise.resolve(v);
    if (v) { read().catch(() => { /* the held answer stands */ }); return Promise.resolve(v); }
    return read();
  };
};

// READ-ONLY ASKS TAKE THEIR OWN CLIENT DIRECTORY (JOIN-TIME-1359, the owner 2026-10-02: "The join takes too long"): the seven
// testnet4 seats shared one federation client directory, and its database admits one process at a time - so every seat's
// lock status, fee rule and gateway read queued behind every other's, and a paid entry held by all 7 was SEEN by them one
// after another, ~1.3 s apart, 13-19 s after it was held (measured on testnet4, rounds 1a21b8d0 and 1537ed99). `readDataDir`
// (a copy of the joined directory, one per seat) answers status, guardians, gateways and fees, which submit nothing; send and
// settle, which do, stay on `dataDir`.
export function stakeLockPort({ bin, dataDir, readDataDir = dataDir, timeoutMs = 60000, keepMs = 60000, now = () => Date.now() }) {
  const port = {
    async status(outpoint) {
      const j = await run(bin, ['--mode', 'status', '--data-dir', readDataDir, '--outpoint', outpointArg(outpoint)], timeoutMs);
      return {
        blockCount: Number(j.block_count),
        stored: j.stored ? { contractId: String(j.stored.contract_id), blocksLeft: Number(j.stored.blocks_left) } : null,
      };
    },
    async contractId(fields) {
      const j = await run(bin, ['--mode', 'id', ...contractArgs(fields)], timeoutMs);
      return String(j.contract_id);
    },
    /**
     * THE FEDERATION'S GUARDIANS, off its own config (§23.6; the owner 2026-09-15 07:33): its id, each
     * guardian's 33-byte broadcast key, and its consensus threshold - what federationIsBonded counts.
     */
    // KEPT A MINUTE TOO (JOIN-TIME, the owner 2026-10-02: "Join click to the round actually loaded: 2 to 3 seconds"): every
    // POST /round - each player's PLAY - ran the stock client for the guardian set, ~0.5 s a round open; it changes in days.
    guardians() { return guardiansKept(); },
    async guardiansRead() {
      const j = await run(bin, ['--mode', 'guardians', '--data-dir', readDataDir], timeoutMs);
      return { federationId: fromHex(String(j.federation_id)), guardians: Number(j.guardians), threshold: Number(j.threshold),
        keys: (j.keys || []).map((k) => fromHex(String(k.key))) };
    },
    /**
     * THE FEDERATION'S GATEWAYS (§23.6): every name its guardians registered, and whether each answered
     * `routing_info` for this federation - with the Lightning node key it answered with, which is its
     * identity. Read-only. It says nothing about inbound, and nothing here pretends it does.
     */
    gateways() { return gatewaysKept(); },
    async gatewaysRead() {
      const j = await run(bin, ['--mode', 'gateways', '--data-dir', readDataDir], timeoutMs);
      return { federationId: fromHex(String(j.federation_id)),
        height: j.block_count === undefined ? null : Number(j.block_count),
        gateways: (j.gateways || []).map((g) => ({ url: String(g.url), live: g.live === true,
          lightningPublicKey: g.lightning_public_key ? String(g.lightning_public_key) : null,
          modulePublicKey: g.module_public_key ? String(g.module_public_key) : null,
          sendFeeDefault: g.send_fee_default ? { baseMsat: BigInt(g.send_fee_default.base_msat), ppm: BigInt(g.send_fee_default.ppm) } : null,
          expirationDeltaDefault: g.expiration_delta_default === undefined ? null : Number(g.expiration_delta_default),
          expirationDeltaMinimum: g.expiration_delta_minimum === undefined ? null : Number(g.expiration_delta_minimum),
          why: g.why || null })) };
    },
    /**
     * A SENT WINNING, ASKED OF ITS GATEWAY (protocol/winnings-send.js). Without `auth`: the contract's id and the
     * message the committee must sign - the invoice's consensus hash, which the gateway checks under the
     * contract's refund key. With it: the stock client's send_payment to `gateway`, and the preimage if it paid.
     */
    async send({ gateway, outpoint = null, paymentHash, amountMsat, expiration, claimPk, refundPk, invoice, auth = null }) {
      const args = ['--mode', 'send', '--data-dir', dataDir, '--hash', String(paymentHash), '--amount-msat', String(amountMsat),
        '--expiration', String(expiration), '--claim-pk', String(claimPk), '--refund-pk', toHex(refundPk), '--invoice', String(invoice),
        ...(auth ? ['--auth', toHex(auth), '--outpoint', outpointArg(outpoint), '--gateway', String(gateway)] : [])];
      const j = await run(bin, args, timeoutMs);
      return { contractId: String(j.contract_id), message: fromHex(String(j.auth_message_hex)),
        sent: j.sent === true, preimage: j.preimage ? fromHex(String(j.preimage)) : null, why: j.why || null };
    },
    /** The guardians' own LNv2 fee rule, off the federation's config (W4). */
    fees() { return feesKept(); },
    async feesRead() {
      const j = await run(bin, ['--mode', 'fees', '--data-dir', readDataDir], timeoutMs);
      return { ppm: BigInt(j.fee_ppm), baseMsat: BigInt(j.fee_base_msat) };
    },
    /**
     * THE ROUND'S ONE SETTLEMENT (W4): every claimed lock in as Claim(P), the
     * exact payouts out. Without `signature` the stock client only rebuilds it
     * and answers the 32 bytes to sign; with one it submits and says what the
     * guardians hold afterwards.
     */
    async settle({ claimPk, claims, payouts, nonce, signature = null, refunds = [] }) {
      const args = ['--mode', 'settle', '--data-dir', dataDir, '--claim-pk', toHex(claimPk),
        '--locks', claims.map((c) => `${outpointArg(c.outpoint)}:${toHex(c.preimage)}:${c.amountMsat}`).join(','),
        // AN EXPIRED WINNINGS CONTRACT, spent back by the committee's refund key into its re-send (winnings-send.js).
        ...(refunds.length ? ['--refunds', refunds.map((r) => `${outpointArg(r.outpoint)}:${r.amountMsat}`).join(',')] : []),
        // A SENT WINNING (protocol/winnings-send.js) is the gateway's outgoing contract to the winner's invoice,
        // refunding to the committee key; every other payout is the pre-expired contract to its key.
        '--payouts', payouts.map((p) => (p.sent
          ? `invoice:${p.sent.paymentHash}:${p.sent.gatewayPk}:${toHex(p.payoutPk)}:${p.sent.expiration}:${p.msat}`
          : `${toHex(p.payoutPk)}:${p.msat}`)).join(','),
        '--nonce', toHex(nonce), ...(signature ? ['--signature', toHex(signature)] : [])];
      const j = await run(bin, args, timeoutMs);
      return { txid: String(j.txid), message: String(j.message_hex), accepted: j.accepted === true, error: j.error || null,
        payouts: j.payouts || [], payoutsStored: j.payouts_stored || null, locksAfter: j.locks_after || null,
        unspentMsat: j.unspent_msat === undefined ? null : BigInt(j.unspent_msat) };
    },
  };
  const gatewaysKept = keptFor(keepMs, () => port.gatewaysRead(), now);
  const guardiansKept = keptFor(keepMs, () => port.guardiansRead(), now);
  const feesKept = keptFor(keepMs, () => port.feesRead(), now);
  return port;
}

/**
 * THE PORT FROM TWO SETTINGS, ALL OR NONE: the tool, and the data directory of a
 * client that has joined the round's federation (the signer node's own, read-only here).
 * @returns {{ ok: true, given: false } | { ok: true, given: true, stakeLocks } | { ok: false, why }}
 */
export function stakeLocksFromEnv(env) {
  const got = STAKE_LOCK_SETTINGS.filter((k) => env[k]);
  if (!got.length) return { ok: true, given: false };
  if (got.length !== STAKE_LOCK_SETTINGS.length)
    return { ok: false, why: `${STAKE_LOCK_SETTINGS.join(' and ')} go together: set both, or neither` };
  return { ok: true, given: true, stakeLocks: stakeLockPort({ bin: env.BLWP_STAKE_LOCK_BIN, dataDir: env.BLWP_FEDERATION_CLIENT_DIR,
    readDataDir: env.BLWP_FEDERATION_CLIENT_READ_DIR || env.BLWP_FEDERATION_CLIENT_DIR }) };
}
