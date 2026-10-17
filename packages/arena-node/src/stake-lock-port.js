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
import { execFile, spawn } from 'node:child_process';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const STAKE_LOCK_SETTINGS = ['ARENA_STAKE_LOCK_BIN', 'ARENA_FEDERATION_CLIENT_DIR'];

const run = (bin, args, timeoutMs) => new Promise((done, fail) => {
  execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    const line = String(stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    // A TOOL KILLED AT ITS TIMEOUT SAYS SO (kanban #336: its stderr was empty and the line was only "Command failed: <the
    // whole command>", which hid why a round never settled)
    if (err && !line && err.killed) {
      const last = String(stderr || '').trim().split('\n').filter(Boolean).pop();
      return fail(new Error(`blwp-stake-lock ${args[1] || ''} timed out after ${timeoutMs} ms${last ? ` (its last word: ${last.slice(0, 300)})` : ''}`));
    }
    if (err && !line) return fail(new Error(`blwp-stake-lock: ${String(stderr || err.message).trim().split('\n').pop()}`));
    try { done(JSON.parse(line)); } catch { fail(new Error(`blwp-stake-lock answered no JSON: ${String(stdout).slice(0, 200)}`)); }
  });
});

const outpointArg = (o) => `${toHex(o.txid)}:${o.outIdx}`;

// ONE LONG-LIVED TOOL FOR THE READ-ONLY QUESTIONS (kanban #293, measured 2026-10-10 on the test host's paid RPS stack: a process
// per question opened the client's database and reached the guardians each time - with 8 s paid rounds, dozens of them at
// 60-80 % CPU each, the machine at load 50 and a paid tap past 1.5 s at p95). `blwp-stake-lock --mode serve` keeps its client
// open and answers one JSON line per question. A binary without that mode (an older build), a tool that exits, or a question
// it does not answer in time: the question is asked the old way, one run, and the next start of the server waits a minute.
export function stakeLockServer({ bin, dataDir, timeoutMs = 60000, spawnFn = spawn, now = () => Date.now() }) {
  let child = null, ready = null, buf = '', n = 0, downUntil = 0;
  const waiting = new Map();
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
          if (j.ok) w.resolve(j.result); else w.reject(new Error(`blwp-stake-lock: ${j.error}`));
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
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`the stake-lock server did not answer ${mode} in ${timeoutMs} ms`)); }, timeoutMs);
        timer.unref?.();
        waiting.set(id, { resolve, reject, timer });
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
// `settleTimeoutMs` (kanban #336, measured 2026-10-10 on the regtest Up/Down market: a book round's settle - every filled
// order's stake and fee lock claimed, every payout out, ~50 locks - was killed at the 60 s every other question gets, again
// and again, and the round never settled): the one write that moves a whole round gets five times as long (5 minutes)
export function stakeLockPort({ bin, dataDir, readDataDir = dataDir, timeoutMs = 60000, settleTimeoutMs = timeoutMs * 5, keepMs = 60000, now = () => Date.now(), serve = true, spawnFn = spawn }) {
  // THE READ-ONLY QUESTIONS THROUGH ONE SERVER on the read directory; a failed server question is asked the old way.
  // NEVER ON THE SHARED WRITE DIRECTORY (kanban #336, measured 2026-10-11 on the regtest Up/Down market: the paid runner's
  // port named no read directory, so its server held the one client database every seat settles through - each settle
  // waited on its flock until it was killed, and no book round ever settled). A port with no directory of its own to read
  // asks every question the old way, one run each.
  const server = serve && readDataDir !== dataDir ? stakeLockServer({ bin, dataDir: readDataDir, timeoutMs, spawnFn, now }) : null;
  const read = async (flags) => {
    if (server) { try { return await server.ask(flags[1], argsOf(flags.slice(2).filter((x, i, a) => !(x === '--data-dir' || a[i - 1] === '--data-dir')))); } catch { /* the old way below */ } }
    return run(bin, flags, timeoutMs);
  };
  const port = {
    close() { if (server) server.close(); },
    async status(outpoint) {
      const j = await read(['--mode', 'status', '--data-dir', readDataDir, '--outpoint', outpointArg(outpoint)]);
      return {
        blockCount: Number(j.block_count),
        stored: j.stored ? { contractId: String(j.stored.contract_id), blocksLeft: Number(j.stored.blocks_left) } : null,
      };
    },
    async contractId(fields) {
      const j = await read(['--mode', 'id', ...contractArgs(fields)]);
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
      const j = await read(['--mode', 'guardians', '--data-dir', readDataDir]);
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
      const j = await read(['--mode', 'gateways', '--data-dir', readDataDir]);
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
    /**
     * THE RESERVES' MOVE INTO THIS FEDERATION (kanban #397, decision A): an invoice of `gateway` whose incoming contract only
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
      const j = await read(['--mode', 'fees', '--data-dir', readDataDir]);
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
      const j = await run(bin, args, settleTimeoutMs);
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
/**
 * EVERY FEDERATION, ONE PORT EACH (kanban #348, RULED the owner 2026-10-13: "Every node serves every federation. That is one
 * network of 14 nodes serving both federations"). With two federations in one census a drawn node serves rounds of a
 * federation it did not found, so it holds a client of each: its own (`home`, as before) and one per other federation,
 * joined on first need under `baseDir/<federation id>` with the invite that federation's signed record carries
 * (`inviteOf`, the records this seat mirrors) - `bin --mode join`, through the connect overrides this node runs with.
 *
 * The router IS the home port (every method as before, so nothing that never names a federation changes) plus
 * `forFederation(idHex)`: the port of that federation - joined first if need be - or null with the reason in `whyNot`.
 */
export function federationPorts({ home, bin, baseDir, inviteOf = () => null, makePort = (o) => stakeLockPort(o), joinTimeoutMs = 180000,
  runJoin = (args) => run(bin, args, joinTimeoutMs), exists = (p) => existsSync(p), log = () => {} }) {
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
    const port = makePort({ bin, dataDir: dir, readDataDir: dir });
    ports.set(fid, port);
    return port;
  }
  return Object.assign(Object.create(home), { forFederation, homeFederation, whyNot: (idHex) => whyNot.get(String(idHex).toLowerCase()) || null,
    close() { home.close(); for (const p of ports.values()) p.close(); } });
}

export function stakeLocksFromEnv(env) {
  const got = STAKE_LOCK_SETTINGS.filter((k) => env[k]);
  if (!got.length) return { ok: true, given: false };
  if (got.length !== STAKE_LOCK_SETTINGS.length)
    return { ok: false, why: `${STAKE_LOCK_SETTINGS.join(' and ')} go together: set both, or neither` };
  const home = stakeLockPort({ bin: env.ARENA_STAKE_LOCK_BIN, dataDir: env.ARENA_FEDERATION_CLIENT_DIR,
    readDataDir: env.ARENA_FEDERATION_CLIENT_READ_DIR || env.ARENA_FEDERATION_CLIENT_DIR });
  // the other federations' clients (kanban #348): ARENA_FEDERATION_CLIENTS_DIR, or beside the home client; joined with
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
