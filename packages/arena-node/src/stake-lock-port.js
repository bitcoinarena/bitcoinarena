// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUND'S FEDERATION, AS A SIGNER NODE ASKS IT (v4.6.2 §23.1 step 5).
//
// Two answers, both the stock Fedimint 0.12.0 client's own, through
// arena-stake-lock (tools/stake-lock, our code on the stock client crates):
//   status(outpoint)    what the guardians hold there - the contract id and
//                       the blocks LEFT to its expiry - and their block count
//   contractId(fields)  the stock hash of a contract the player handed over
// Nothing here hashes a contract or speaks the federation's API: a second
// implementation of either would be a second place for them to disagree.
//
// It runs the tool once per question, as the node's lndPort (node-start.js) runs lncli: the
// federation is the tool's business, and a daemon that linked the client
// crates in would be a daemon in Rust.
import { execFile, spawn } from 'node:child_process';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { existsSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const STAKE_LOCK_SETTINGS = ['ARENA_STAKE_LOCK_BIN', 'ARENA_FEDERATION_CLIENT_DIR'];

const run = (bin, args, timeoutMs) => new Promise((done, fail) => {
  execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    const line = String(stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    // A TOOL KILLED AT ITS TIMEOUT SAYS SO (its stderr was empty and the line was only "Command failed: <the
    // whole command>", which hid why a round never settled)
    if (err && !line && err.killed) {
      const last = String(stderr || '').trim().split('\n').filter(Boolean).pop();
      return fail(new Error(`arena-stake-lock ${args[1] || ''} timed out after ${timeoutMs} ms${last ? ` (its last word: ${last.slice(0, 300)})` : ''}`));
    }
    if (err && !line) return fail(new Error(`arena-stake-lock: ${String(stderr || err.message).trim().split('\n').pop()}`));
    try { done(JSON.parse(line)); } catch { fail(new Error(`arena-stake-lock answered no JSON: ${String(stdout).slice(0, 200)}`)); }
  });
});

const outpointArg = (o) => `${toHex(o.txid)}:${o.outIdx}`;

// ONE LONG-LIVED TOOL FOR THE READ-ONLY QUESTIONS (measured 2026-10-10 on the test host's paid RPS stack: a process
// per question opened the client's database and reached the guardians each time - with 8 s paid rounds, dozens of them at
// 60-80 % CPU each, the machine at load 50 and a paid tap past 1.5 s at p95). `arena-stake-lock --mode serve` keeps its client
// open and answers one JSON line per question. A binary without that mode (an older build), a tool that exits, or a question
// it does not answer in time: the question is asked the old way, one run, and the next start of the server waits a minute.
// A STUCK SERVER IS LEFT AT ONCE (kanban #827, measured 2026-10-31 12:48Z on seat 2: one question held the server 60 s with 20 behind it, the seat took the
// locks after 2 min and no inputs before that, both players' first marks waited for it and both runs were FORFEIT): 10 s, then the server is ended, its
// waiting questions go the old way, one run each, and the next start of the server waits a minute.
export function stakeLockServer({ bin, dataDir, timeoutMs = 10000, spawnFn = spawn, now = () => Date.now(), log = (m) => console.log(m) }) {
  let child = null, ready = null, buf = '', n = 0, downUntil = 0;
  const waiting = new Map();
  // WHAT THE ONE SERVER IS ASKED, AND HOW LONG EACH WAITS (kanban #605, measured 2026-10-24: POST /lock up to 107 s on the test host seats,
  // 0 ms of it on the loop, while one status read takes 0.4-0.6 s; the server answers one question at a time): every minute, the asks
  // of the last minute by mode, the slowest wait and the deepest queue; an answer that waited over 5 s is named at once
  const minute = { at: now(), modes: {}, slowest: 0, deepest: 0 };
  const counted = (mode, ms, ahead) => {
    minute.modes[mode] = (minute.modes[mode] || 0) + 1;
    if (ms > minute.slowest) minute.slowest = ms;
    if (ahead > minute.deepest) minute.deepest = ahead;
    if (ms > 5000) log(`[stake-lock] ${mode} answered after ${ms} ms, ${ahead} ask(s) ahead of it`);
    if (now() - minute.at >= 60000) {
      log(`[stake-lock] last minute: ${Object.entries(minute.modes).map(([m, k]) => `${m} ${k}`).join(', ')}; slowest ${minute.slowest} ms, deepest queue ${minute.deepest}`);
      minute.at = now(); minute.modes = {}; minute.slowest = 0; minute.deepest = 0;
    }
  };
  const fail = (why) => { for (const [, w] of waiting) w.reject(new Error(why)); waiting.clear(); child = null; ready = null; downUntil = now() + 60000; };
  const start = () => {
    if (ready) return ready;
    if (now() < downUntil) return Promise.reject(new Error('the stake-lock server is down for a minute'));
    ready = new Promise((resolve, reject) => {
      let up = false;
      const c = spawnFn(bin, ['--mode', 'serve', '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'ignore'] });
      child = c;
      c.on('error', (e) => { if (!up) reject(e); fail(e.message); });
      c.on('exit', (code) => { if (!up) reject(new Error(`the stake-lock server exited (${code}) - an older binary has no serve mode`)); fail(`the stake-lock server exited (${code})`); });
      c.stdout.setEncoding('utf8');
      c.stdout.on('data', (d) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('{')) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.mode === 'serve' && j.ready) { up = true; resolve(c); continue; }
          const w = waiting.get(j.id);
          if (!w) continue;
          waiting.delete(j.id); clearTimeout(w.timer);
          if (j.ok) w.resolve(j.result); else w.reject(new Error(`arena-stake-lock: ${j.error}`));
        }
      });
      setTimeout(() => { if (!up) { reject(new Error('the stake-lock server did not come up')); try { c.kill(); } catch { /* gone */ } } }, timeoutMs).unref?.();
    });
    ready.catch(() => {});
    return ready;
  };
  return {
    async ask(mode, args) {
      const c = await start();
      const id = ++n;
      const t0 = now(), ahead = waiting.size;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); counted(mode, now() - t0, ahead); log(`[stake-lock] ${mode} unanswered after ${timeoutMs} ms: the server is ended`); try { c.kill(); } catch { /* gone */ } reject(new Error(`the stake-lock server did not answer ${mode} in ${timeoutMs} ms`)); }, timeoutMs);
        timer.unref?.();
        waiting.set(id, { resolve: (v) => { counted(mode, now() - t0, ahead); resolve(v); }, reject: (e) => { counted(mode, now() - t0, ahead); reject(e); }, timer });
        c.stdin.write(JSON.stringify({ id, mode, args }) + '\n');
      });
    },
    close() { if (child) { try { child.kill(); } catch { /* gone */ } } fail('closed'); },
  };
}
// the flags of a one-run call as the server's args: ['--a', 'x', '--b', 'y'] -> { a: 'x', b: 'y' }
const argsOf = (flags) => { const o = {}; for (let i = 0; i + 1 < flags.length; i += 2) o[flags[i].replace(/^--/, '')] = flags[i + 1]; return o; };

/** The tool's arguments for a contract's fields - the same flags its lock mode takes. */
export function contractArgs(f) {
  const image = f.paymentImage.kind === 'point' ? ['--point', toHex(f.paymentImage.bytes)] : ['--hash', toHex(f.paymentImage.bytes)];
  return [...image, '--amount-msat', String(f.amountMsat), '--claim-pk', toHex(f.claimPk),
    '--refund-pk', toHex(f.refundPk), '--expiration', String(f.expiration)];
}

// THE FEDERATION'S GATEWAYS AND FEE RULE, KEPT A MINUTE FOR EVERY CALLER (2026-10-02, the the test host's load): the
// winnings resend loop asked both on every pass over its held rounds - one stock-client run each, about one every 6 s per
// signer node - and each run opened the federation client's database: ~1.7 MB/s written by every idle testnet4 seat,
// 12 MB/s together, while no table changed. One read in flight; a failed read is not kept. (The doors did this already.)
// AND AN ANSWER ALREADY HELD IS GIVEN AT ONCE PAST ITS MINUTE, READ AGAIN BEHIND IT (2026-10-02, the join's 2-3 s):
// the federation's fee rule, guardians and gateways are its config, and the paid entry door waited on a fresh read of the
// fee rule whenever the minute had run out - POST /entry 0.29-0.90 s at seat 1, 0 ms of it on the loop. Only the first
// read ever waits; a failed re-read keeps the answer held.
// AND THE LAST GOOD ANSWER OUTLIVES A RESTART (kanban #830, the owner 2026-10-31: "Das musst du auch lösen dass das nicht wieder passiert"): a
// join was refused because a restarted seat had nothing held and its first gateway read timed out after 60 s. `held` gives what the last run kept on disk;
// only a node with nothing there waits for its first read.
const READ_TIMEOUT_MS = 20000;            // a read asked the old way, past the server's 10 s: a join waits on it
const HELD_MAX_MS = 6 * 3600000;          // a federation's config changes in days, its gateways in hours
export const keptFor = (ms, fn, now = () => Date.now(), held = () => null) => {
  let at = 0, v = null, p = null;
  const read = () => {
    if (!p) p = Promise.resolve().then(fn).then((r) => { v = r; at = now(); return r; }).finally(() => { p = null; });
    return p;
  };
  return () => {
    if (!v) { try { v = held(); } catch { /* nothing kept */ } }
    if (v && now() - at < ms) return Promise.resolve(v);
    if (v) { read().catch(() => { /* the held answer stands */ }); return Promise.resolve(v); }
    return read();
  };
};

// READ-ONLY ASKS TAKE THEIR OWN CLIENT DIRECTORY (JOIN-TIME-1359, 2026-10-02: "The join takes too long"): the seven
// testnet4 seats shared one federation client directory, and its database admits one process at a time - so every seat's
// lock status, fee rule and gateway read queued behind every other's, and a paid entry held by all 7 was SEEN by them one
// after another, ~1.3 s apart, 13-19 s after it was held (measured on testnet4, rounds 1a21b8d0 and 1537ed99). `readDataDir`
// (a copy of the joined directory, one per seat) answers status, guardians, gateways and fees, which submit nothing; send and
// settle, which do, stay on `dataDir`.
// `settleTimeoutMs` (measured 2026-10-10 on the regtest Up/Down market: a book round's settle - every filled
// order's stake and fee lock claimed, every payout out, ~50 locks - was killed at the 60 s every other question gets, again
// and again, and the round never settled): the one write that moves a whole round gets five times as long (5 minutes)
export function stakeLockPort({ bin, dataDir, readDataDir = dataDir, timeoutMs = 60000, settleTimeoutMs = timeoutMs * 5, keepMs = 60000, now = () => Date.now(), serve = true, spawnFn = spawn }) {
  // THE READ-ONLY QUESTIONS THROUGH ONE SERVER on the read directory; a failed server question is asked the old way.
  // NEVER ON THE SHARED WRITE DIRECTORY (measured 2026-10-11 on the regtest Up/Down market: the paid runner's
  // port named no read directory, so its server held the one client database every seat settles through - each settle
  // waited on its flock until it was killed, and no book round ever settled). A port with no directory of its own to read
  // asks every question the old way, one run each.
  const server = serve && readDataDir !== dataDir ? stakeLockServer({ bin, dataDir: readDataDir, timeoutMs: Math.min(timeoutMs, 10000), spawnFn, now }) : null;
  const read = async (flags) => {
    if (server) {
      try { return await server.ask(flags[1], argsOf(flags.slice(2).filter((x, i, a) => !(x === '--data-dir' || a[i - 1] === '--data-dir')))); } catch (e) {
        // SEND-CLAIMED ON A TOOL BUILT BEFORE IT (kanban #1185): its server answers every mode the one run does, so a server that does not
        // know it is a binary that does not - the one run would wait on the read directory the server holds before it says so; said at once
        if (flags[1] === 'send-claimed' && /serve answers .* - not send-claimed/.test(String(e && e.message))) throw e;
        /* the old way below */
      }
    }
    return run(bin, flags, Math.min(timeoutMs, READ_TIMEOUT_MS));
  };
  // A CONFIG READ IS KEPT ON DISK BESIDE THE CLIENT: the raw answer, so a restart shapes it as the read does
  const heldFile = (mode) => join(readDataDir, `held-${mode}.json`);
  const keep = (mode, j) => { try { writeFileSync(heldFile(mode), JSON.stringify({ atMs: now(), j })); } catch { /* the next read tries again */ } return j; };
  const heldAnswer = (mode, shape) => () => {
    const h = JSON.parse(readFileSync(heldFile(mode), 'utf8'));
    return now() - h.atMs < HELD_MAX_MS ? shape(h.j) : null;
  };
  const shapeGuardians = (j) => ({ federationId: fromHex(String(j.federation_id)), guardians: Number(j.guardians), threshold: Number(j.threshold),
    keys: (j.keys || []).map((k) => fromHex(String(k.key))) });
  const shapeFees = (j) => ({ ppm: BigInt(j.fee_ppm), baseMsat: BigInt(j.fee_base_msat) });
  const port = {
    close() { if (server) server.close(); },
    async status(outpoint) {
      const j = await read(['--mode', 'status', '--data-dir', readDataDir, '--outpoint', outpointArg(outpoint)]);
      return {
        blockCount: Number(j.block_count),
        stored: j.stored ? { contractId: String(j.stored.contract_id), blocksLeft: Number(j.stored.blocks_left) } : null,
      };
    },
    /**
     * DID A GATEWAY CLAIM THE OUTGOING CONTRACT AT THIS OUTPOINT (kanban #1185, the tool's send-claimed): the preimage the guardians
     * stored when its Claim(preimage) input was accepted. { claimed, state: 'claimed' | 'stored' | 'gone', preimage? } - 'gone' is
     * refunded or never made, which the guardians do not tell apart. A tool without the mode throws: settlement reads that as 'mixed'.
     */
    async sendClaimed(outpoint) {
      const j = await read(['--mode', 'send-claimed', '--data-dir', readDataDir, '--outpoint', outpointArg(outpoint)]);
      if (j.mode !== 'send-claimed' || typeof j.claimed !== 'boolean') throw new Error(`this stake-lock tool cannot read a gateway's claim: ${j.error || JSON.stringify(j).slice(0, 120)}`);
      return { claimed: j.claimed === true && typeof j.preimage === 'string' && j.preimage.length === 64, state: String(j.state),
        preimage: j.preimage ? fromHex(String(j.preimage)) : null };
    },
    async contractId(fields) {
      const j = await read(['--mode', 'id', ...contractArgs(fields)]);
      return String(j.contract_id);
    },
    /**
     * THE FEDERATION'S GUARDIANS, off its own config (§23.6; 2026-09-15 07:33): its id, each
     * guardian's 33-byte broadcast key, and its consensus threshold - what federationIsBonded counts.
     */
    // KEPT A MINUTE TOO (JOIN-TIME, 2026-10-02: "Join click to the round actually loaded: 2 to 3 seconds"): every
    // POST /round - each player's PLAY - ran the stock client for the guardian set, ~0.5 s a round open; it changes in days.
    guardians() { return guardiansKept(); },
    async guardiansRead() {
      return shapeGuardians(keep('guardians', await read(['--mode', 'guardians', '--data-dir', readDataDir])));
    },
    /**
     * THE FEDERATION'S GATEWAYS (§23.6): every name its guardians registered, and whether each answered
     * `routing_info` for this federation - with the Lightning node key it answered with, which is its
     * identity. Read-only. It says nothing about inbound, and nothing here pretends it does.
     */
    gateways() { return gatewaysKept(); },
    async gatewaysRead() {
      return shapeGateways(keep('gateways', await read(['--mode', 'gateways', '--data-dir', readDataDir])));
    },
    shapeGateways(j) {
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
    /** THE SEAT'S E-CASH IN THIS FEDERATION (kanban #614): what its client holds, msat. */
    async ecashBalance() {
      const j = await run(bin, ['--mode', 'balance', '--data-dir', dataDir], timeoutMs);
      return BigInt(j.msat);
    },
    /**
     * E-cash reissued into the seat's client here: { state: 'Success' | 'Rejected' | 'AlreadyReceived', msat } (kanban #614). An
     * AlreadyReceived from a tool of kanban #1160 also says how the earlier receive of that string ended (`earlier`) and what it carried
     * (`carriedMsat`); an older tool says neither.
     */
    async ecashReceive(ecash) {
      const j = await run(bin, ['--mode', 'ecash-receive', '--data-dir', dataDir, '--ecash', String(ecash)], timeoutMs);
      return { state: String(j.state), msat: BigInt(j.msat || 0), earlier: j.earlier === undefined ? null : String(j.earlier),
        carriedMsat: j.carried_msat === undefined || j.carried_msat === null ? null : BigInt(j.carried_msat) };
    },
    /**
     * Exactly `amountMsat` of the seat's notes here, as e-cash another wallet of this federation receives (kanban #614). With `key`
     * (kanban #1160) the send is named in the client's operation log, and a send of that key made before is answered again, not repeated.
     */
    async ecashSend(amountMsat, { key = null } = {}) {
      const j = await run(bin, ['--mode', 'ecash-send', '--data-dir', dataDir, '--amount-msat', String(amountMsat), ...(key ? ['--key', String(key)] : [])], timeoutMs);
      return { ecash: String(j.ecash), msat: BigInt(j.msat), again: j.again === true };
    },
    /** THE KEYED SEND READ BACK (kanban #1160): { found, ecash, msat } - found false: this client never spent for `key`. A tool from before #1160 throws. */
    async ecashSent(key) {
      const j = await run(bin, ['--mode', 'ecash-sent', '--data-dir', dataDir, '--key', String(key)], timeoutMs);
      if (j.mode !== 'ecash-sent' || typeof j.found !== 'boolean') throw new Error(`this stake-lock tool cannot read a keyed send back: ${j.error || JSON.stringify(j).slice(0, 120)}`);
      return j.found ? { found: true, ecash: String(j.ecash), msat: BigInt(j.msat) } : { found: false };
    },
    async send({ gateway, outpoint = null, paymentHash, amountMsat, expiration, claimPk, refundPk, invoice, auth = null }) {
      const args = ['--mode', 'send', '--data-dir', dataDir, '--hash', String(paymentHash), '--amount-msat', String(amountMsat),
        '--expiration', String(expiration), '--claim-pk', String(claimPk), '--refund-pk', toHex(refundPk), '--invoice', String(invoice),
        ...(auth ? ['--auth', toHex(auth), '--outpoint', outpointArg(outpoint), '--gateway', String(gateway)] : [])];
      const j = await run(bin, args, timeoutMs);
      return { contractId: String(j.contract_id), message: fromHex(String(j.auth_message_hex)),
        sent: j.sent === true, preimage: j.preimage ? fromHex(String(j.preimage)) : null, why: j.why || null };
    },
    /**
     * THE RESERVES' MOVE INTO THIS FEDERATION (decision A): an invoice of `gateway` whose incoming contract only
     * `claimPk` - the destination's 5-of-7 reserve key - can claim, its preimage the hash of `seed` (the move's own).
     */
    async receiveToKey({ claimPk, amountMsat, seed, gateway, expirySecs = 86400 }) {
      const j = await run(bin, ['--mode', 'receive-to-key', '--data-dir', dataDir, '--claim-pk', toHex(claimPk), '--amount-msat', String(amountMsat),
        '--seed', toHex(seed), '--gateway', String(gateway), '--expiry-secs', String(expirySecs)], timeoutMs);
      return { invoice: String(j.invoice), paymentHash: String(j.payment_hash), amountMsat: BigInt(j.amount_msat), contractAmountMsat: BigInt(j.contract_amount_msat),
        contractId: String(j.contract_id), contractHex: String(j.contract_hex), claimPk: String(j.claim_pk), expiration: Number(j.expiration) };
    },
    /**
     * AND ITS CLAIM: what the contract commits to (whoever asks, with `waitS` 0 nothing is waited for), and once a gateway funded it,
     * the claim into one pre-expired output to `payoutPk` - without `signature` its 32 bytes to sign, with one submitted.
     */
    async claimIncoming({ contractHex, seed, payoutPk, nonce, signature = null, waitS = 30 }) {
      const j = await run(bin, ['--mode', 'claim-incoming', '--data-dir', dataDir, '--contract', String(contractHex), '--seed', toHex(seed), '--payout-pk', toHex(payoutPk),
        '--nonce', toHex(nonce), '--wait-s', String(waitS), ...(signature ? ['--signature', toHex(signature)] : [])], settleTimeoutMs);
      return { funded: j.funded === true, commitment: j.commitment || null, contractId: String(j.contract_id), outpoint: j.outpoint || null,
        txid: j.txid || null, message: j.message_hex || null, payout: j.payout || null, preimage: j.preimage || null,
        accepted: j.accepted === true, error: j.error || null, why: j.why || null };
    },
    /** The guardians' own LNv2 fee rule, off the federation's config (W4). */
    fees() { return feesKept(); },
    async feesRead() {
      return shapeFees(keep('fees', await read(['--mode', 'fees', '--data-dir', readDataDir])));
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
      const j = await run(bin, args, settleTimeoutMs);
      return { txid: String(j.txid), message: String(j.message_hex), accepted: j.accepted === true, error: j.error || null,
        payouts: j.payouts || [], payoutsStored: j.payouts_stored || null, locksAfter: j.locks_after || null,
        unspentMsat: j.unspent_msat === undefined ? null : BigInt(j.unspent_msat) };
    },
  };
  const shapeGateways = (j) => port.shapeGateways(j);
  const gatewaysKept = keptFor(keepMs, () => port.gatewaysRead(), now, heldAnswer('gateways', shapeGateways));
  const guardiansKept = keptFor(keepMs, () => port.guardiansRead(), now, heldAnswer('guardians', shapeGuardians));
  const feesKept = keptFor(keepMs, () => port.feesRead(), now, heldAnswer('fees', shapeFees));
  return port;
}

/**
 * THE PORT FROM TWO SETTINGS, ALL OR NONE: the tool, and the data directory of a
 * client that has joined the round's federation (the signer node's own, read-only here).
 * @returns {{ ok: true, given: false } | { ok: true, given: true, stakeLocks } | { ok: false, why }}
 */
/**
 * EVERY FEDERATION, ONE PORT EACH (RULED 2026-10-13: "Every node serves every federation. That is one
 * network of 14 nodes serving both federations"). With two federations in one census a drawn node serves rounds of a
 * federation it did not found, so it holds a client of each: its own (`home`, as before) and one per other federation,
 * joined on first need under `baseDir/<federation id>` with the invite that federation's signed record carries
 * (`inviteOf`, the records this seat mirrors) - `bin --mode join`, through the connect overrides this node runs with.
 *
 * The router IS the home port (every method as before, so nothing that never names a federation changes) plus
 * `forFederation(idHex)`: the port of that federation - joined first if need be - or null with the reason in `whyNot`.
 */
export function federationPorts({ home, bin, baseDir, inviteOf = () => null, makePort = (o) => stakeLockPort(o), joinTimeoutMs = 180000,
  runJoin = (args) => run(bin, args, joinTimeoutMs), exists = (p) => existsSync(p), log = () => {},
  copyDir = (from, to) => cpSync(from, to, { recursive: true, filter: (src) => !/client\.db\.lock$/.test(src) }) }) {
  // A READ COPY OF ITS OWN FOR EVERY OTHER FEDERATION (kanban #586, measured 2026-10-23 15:53Z under 20 market bots: the test host seats'
  // locks in federation 4dc88be7 were checked one run per question - `arena-stake-lock --mode status` at 30-85 % CPU each, the
  // test host at load 128): the joined directory is copied once beside it, `<dir>.read`, and its read-only questions (status,
  // guardians, gateways, fees) go through one long-lived server there, as the home federation's do; send and settle stay on the
  // joined directory. No copy (a full disk, a test): every question the old way, as before.
  const readCopyOf = (dir) => {
    const r = `${dir}.read`;
    try { if (!exists(join(r, 'client.db'))) { copyDir(dir, r); log(`[federations] read copy ${r}`); } return r; }
    catch (e) { log(`[federations] no read copy of ${dir}: ${e.message}`); return dir; }
  };
  const ports = new Map();       // federation id hex -> port
  const joining = new Map();     // federation id hex -> Promise
  const whyNot = new Map();
  let homeId = null;
  const homeFederation = async () => {
    if (homeId) return homeId;
    try { const g = await home.guardians(); homeId = toHex(g.federationId); } catch { /* asked again next time */ }
    return homeId;
  };
  async function forFederation(idHex) {
    const fid = String(idHex || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fid)) return null;
    if (fid === await homeFederation()) return home;
    if (ports.has(fid)) return ports.get(fid);
    const dir = join(baseDir, fid);
    if (!exists(join(dir, 'client.db'))) {
      if (!joining.has(fid)) {
        const invite = inviteOf(fid);
        if (!invite) { whyNot.set(fid, 'this node holds no signed record, so no invite, of that federation'); return null; }
        joining.set(fid, runJoin(['--mode', 'join', '--data-dir', dir, '--invite', invite])
          .then((j) => { if (String(j.federation_id) !== fid) throw new Error(`that invite joined ${String(j.federation_id).slice(0, 16)}`); log(`[federations] joined ${fid.slice(0, 16)}`); },
            (e) => { throw new Error(`could not join federation ${fid.slice(0, 16)}: ${e.message}`); })
          .finally(() => joining.delete(fid)));
      }
      try { await joining.get(fid); } catch (e) { whyNot.set(fid, e.message); return null; }
    }
    if (ports.has(fid)) return ports.get(fid);           // a caller that waited on the same join
    const port = makePort({ bin, dataDir: dir, readDataDir: readCopyOf(dir) });
    ports.set(fid, port);
    return port;
  }
  return Object.assign(Object.create(home), { forFederation, homeFederation, whyNot: (idHex) => whyNot.get(String(idHex).toLowerCase()) || null,
    close() { home.close(); for (const p of ports.values()) p.close(); } });
}

/**
 * THE RELEASE'S TOOL WHEN THE SETTINGS NAME NONE (kanban #824, measured 2026-10-31 10:39Z: mactest19911b updated 2026.1.9.20 -> 2026.1.9.21 by the
 * updater of 1.9.20, which does not know these settings, and its arena.conf stayed without them): the node takes the tool beside it. Own settings win.
 */
export function stakeLockDefaults(env, { release, home, platform = process.platform, exists = existsSync }) {
  if (env.ARENA_STAKE_LOCK_BIN || env.ARENA_FEDERATION_CLIENT_DIR) return false;
  const bin = join(release, 'runtime', 'custody', `arena-stake-lock${platform === 'win32' ? '.exe' : ''}`);
  if (!exists(bin)) return false;
  env.ARENA_STAKE_LOCK_BIN = bin; env.ARENA_FEDERATION_CLIENT_DIR = join(home, 'federation-client');
  return true;
}

export function stakeLocksFromEnv(env) {
  const got = STAKE_LOCK_SETTINGS.filter((k) => env[k]);
  if (!got.length) return { ok: true, given: false };
  if (got.length !== STAKE_LOCK_SETTINGS.length)
    return { ok: false, why: `${STAKE_LOCK_SETTINGS.join(' and ')} go together: set both, or neither` };
  const home = stakeLockPort({ bin: env.ARENA_STAKE_LOCK_BIN, dataDir: env.ARENA_FEDERATION_CLIENT_DIR,
    readDataDir: env.ARENA_FEDERATION_CLIENT_READ_DIR || env.ARENA_FEDERATION_CLIENT_DIR });
  // the other federations' clients: ARENA_FEDERATION_CLIENTS_DIR, or beside the home client; joined with
  // ARENA_STAKE_LOCK_JOIN_BIN when given (a build whose join honours the overrides), else the lock tool itself.
  // `inviteOf` is set by the server once its federation records exist (stakeLocks.inviteOf = ...)
  const router = federationPorts({ home, bin: env.ARENA_STAKE_LOCK_BIN,
    baseDir: env.ARENA_FEDERATION_CLIENTS_DIR || join(dirname(env.ARENA_FEDERATION_CLIENT_DIR), 'federations'),
    inviteOf: (fid) => (typeof router.inviteOf === 'function' ? router.inviteOf(fid) : null),
    runJoin: (args) => run(env.ARENA_STAKE_LOCK_JOIN_BIN || env.ARENA_STAKE_LOCK_BIN, args, 180000),
    log: (m) => console.log(m) });
  router.inviteOf = null;
  return { ok: true, given: true, stakeLocks: router };
}
