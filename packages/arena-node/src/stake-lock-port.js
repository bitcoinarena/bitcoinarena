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
import { spawn } from 'node:child_process';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { existsSync, cpSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const STAKE_LOCK_SETTINGS = ['ARENA_STAKE_LOCK_BIN', 'ARENA_FEDERATION_CLIENT_DIR'];

// A TOOL PAST ITS TIME IS ENDED, AND STAYS ENDED (kanban #1078, measured 2026-11-03 on the second test host's seat 2: 234
// `--mode status` runs left behind over 15 h, each waiting on its read directory's client.db.lock, 219 of them deaf to SIGTERM).
// The timeout used to send SIGTERM once and nothing after. Now: SIGTERM, and SIGKILL `KILL_GRACE_MS` later if it is still
// there; the caller is answered at the timeout, not when the tool finally goes. Every tool still running when the seat
// exits (a signal ends main.js through process.exit) is killed with it, so none outlives the seat that started it.
export const KILL_GRACE_MS = 2000;
const liveTools = new Set();
let exitHooked = false;
const killOnExit = (c) => {
  liveTools.add(c);
  c.once?.('exit', () => liveTools.delete(c));
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', () => { for (const t of liveTools) { try { t.kill('SIGKILL'); } catch { /* gone */ } } });
  }
};
const gone = (c) => c.exitCode != null || c.signalCode != null;
export const endTool = (c, graceMs = KILL_GRACE_MS) => {
  if (!c || gone(c)) return;
  try { c.kill('SIGTERM'); } catch { /* gone */ }
  const t = setTimeout(() => { if (!gone(c)) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }, graceMs);
  t.unref?.();   // a seat that exits sooner kills it on its way out (killOnExit)
};
/** The tools this process started that have not exited yet (a test's view of what a timeout leaves behind). */
export const liveToolCount = () => liveTools.size;

// (`onGone` is called once the tool has exited - after its answer, and after a timeout's kill too)
// (`stdin` text is written to the tool's standard input - arena-claim-read takes its sessions there)
const run = (bin, args, timeoutMs, { spawnFn = spawn, graceMs = KILL_GRACE_MS, onGone = () => {}, stdin = null } = {}) => new Promise((done, fail) => {
  let stdout = '', stderr = '', settled = false, timer = null, wentAway = false;
  const away = () => { if (!wentAway) { wentAway = true; onGone(); } };
  const answer = (timedOut, err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    // A TOOL KILLED AT ITS TIMEOUT SAYS SO (its stderr was empty and the line was only "Command failed: <the
    // whole command>", which hid why a round never settled)
    if (timedOut && !line) {
      const last = stderr.trim().split('\n').filter(Boolean).pop();
      return fail(new Error(`arena-stake-lock ${args[1] || ''} timed out after ${timeoutMs} ms${last ? ` (its last word: ${last.slice(0, 300)})` : ''}`));
    }
    if (err && !line) return fail(new Error(`arena-stake-lock: ${String(stderr || err.message).trim().split('\n').pop()}`));
    try { done(JSON.parse(line)); } catch { fail(new Error(`arena-stake-lock answered no JSON: ${stdout.slice(0, 200)}`)); }
  };
  let c;
  try { c = spawnFn(bin, args, { stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); } catch (e) { answer(false, e); away(); return; }
  if (stdin !== null && c.stdin) { c.stdin.on('error', () => { /* the tool answers or fails on its own */ }); c.stdin.end(stdin); }
  killOnExit(c);
  timer = setTimeout(() => { endTool(c, graceMs); answer(true, null); }, timeoutMs);
  c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
  c.stdout.on('data', (d) => { if (stdout.length < (1 << 20)) stdout += d; });
  c.stderr.on('data', (d) => { if (stderr.length < (1 << 20)) stderr += d; });
  c.on('error', (e) => { answer(false, e); if (c.pid === undefined) away(); });
  c.on('close', (code, signal) => { answer(false, code === 0 ? null : new Error(`Command failed (${signal || code}): ${bin} ${args.join(' ')}`)); away(); });
});

// ONE FALLBACK RUN AT A TIME PER READ DIRECTORY (kanban #1079, measured 2026-11-03 on the second test host's seat 2: 26 one-shot
// status, gateways and fees runs at once on one federation's read directory, one holding client.db/LOCK and every other waiting on
// client.db.lock - each wait counted against its own timeout, so they timed out one after another while the server could not
// open the db past them). A read asked the old way now waits its turn on its directory: one run there at a time, the same
// question already running there is answered by that run, and a question still waiting at its timeout is refused without a run.
const lanes = new Map();   // read directory -> { busy, queue: [{ key, start }], same: Map(key -> Promise) }
const laneOf = (dir) => { let l = lanes.get(dir); if (!l) { l = { busy: false, queue: [], same: new Map() }; lanes.set(dir, l); } return l; };
const nextInLane = (dir, l) => {
  if (l.busy) return;
  const w = l.queue.shift();
  if (!w) { if (!l.same.size) lanes.delete(dir); return; }
  l.busy = true;
  w.start().finally(() => { l.busy = false; nextInLane(dir, l); });
};
const runInLane = (dir, bin, flags, timeoutMs) => {
  const l = laneOf(dir);
  const key = flags.join('\u0000');
  if (l.same.has(key)) return l.same.get(key);
  const t0 = Date.now();
  const p = new Promise((done, fail) => {
    // the turn ends when the tool has EXITED, not when it answered: a run killed at its timeout holds the lock until it is gone
    const w = { key, start: () => new Promise((free) => { clearTimeout(w.timer); const left = timeoutMs - (Date.now() - t0);
      if (left <= 0) { fail(new Error(`arena-stake-lock ${flags[1] || ''} timed out after ${timeoutMs} ms`)); free(); return; }
      run(bin, flags, left, { onGone: free }).then(done, fail); }) };
    w.timer = setTimeout(() => { const i = l.queue.indexOf(w); if (i < 0) return; l.queue.splice(i, 1);
      fail(new Error(`arena-stake-lock ${flags[1] || ''} timed out after ${timeoutMs} ms (waiting its turn on the read directory)`)); }, timeoutMs);
    w.timer.unref?.();
    l.queue.push(w);
  }).finally(() => { if (l.same.get(key) === p) l.same.delete(key); if (!l.busy && !l.queue.length && !l.same.size) lanes.delete(dir); });
  l.same.set(key, p);
  nextInLane(dir, l);
  return p;
};
/** Fallback runs running or waiting on a read directory (a test's view of the lane). */
export const laneDepth = (dir) => { const l = lanes.get(dir); return l ? l.queue.length + (l.busy ? 1 : 0) : 0; };

const outpointArg = (o) => `${toHex(o.txid)}:${o.outIdx}`;
// A PROTOCOL-27 SETTLEMENT'S LOCKS AND PAYOUTS as arena-settle and arena-body both read them, so both build one body from one build
const locksArg = (claims) => claims.map((c) => `${outpointArg(c.outpoint)}:${toHex(c.preimage)}`).join(',');
const payoutsArg = (payouts) => payouts.map((p) => (p.sent
  ? `invoice:${p.sent.paymentHash}:${p.sent.gatewayPk}:${toHex(p.payoutPk)}:${p.sent.expiration}:${p.msat}`
  : `${toHex(p.payoutPk)}:${p.msat}`)).join(',');

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
      killOnExit(c);
      c.on('error', (e) => { if (!up) reject(e); fail(e.message); });
      // A SERVER ENDED WHILE AN ASK WAS BEING WRITTEN (11-01 23:16Z, fed2 seat 1): the pipe's EPIPE had no listener and took the whole seat down.
      c.stdin.on('error', (e) => { if (child === c) fail(`the stake-lock server's pipe: ${e.message}`); });
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
      setTimeout(() => { if (!up) { reject(new Error('the stake-lock server did not come up')); endTool(c); } }, timeoutMs).unref?.();
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
        const timer = setTimeout(() => { waiting.delete(id); counted(mode, now() - t0, ahead); log(`[stake-lock] ${mode} unanswered after ${timeoutMs} ms: the server is ended`); endTool(c); reject(new Error(`the stake-lock server did not answer ${mode} in ${timeoutMs} ms`)); }, timeoutMs);
        timer.unref?.();
        waiting.set(id, { resolve: (v) => { counted(mode, now() - t0, ahead); resolve(v); }, reject: (e) => { counted(mode, now() - t0, ahead); reject(e); }, timer });
        c.stdin.write(JSON.stringify({ id, mode, args }) + '\n');
      });
    },
    close() { if (child) endTool(child); fail('closed'); },
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
// AND THE LAST GOOD ANSWER OUTLIVES A RESTART (kanban #830, 2026-10-31: "Das musst du auch lösen dass das nicht wieder passiert"): a
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
    // (a question that opens no client - the contract id - needs no turn)
    if (!flags.includes('--data-dir')) return run(bin, flags, Math.min(timeoutMs, READ_TIMEOUT_MS));
    return runInLane(readDataDir, bin, flags, Math.min(timeoutMs, READ_TIMEOUT_MS));
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
    /**
     * THE FEDERATION'S LNv2 MODULE CONSENSUS VERSION (protocol 27, ruling #1134 1): what a threshold of its guardians agree on
     * (module_consensus_version through request_current_consensus), { major, minor, arenaLock }. A federation on stock LNv2 answers no
     * such endpoint: that is an error here, and the gate reads it as "not running".
     */
    /** What the guardians hold at an outpoint as an Arena lock (stake-lock arena-status): { blockCount, stored: { contractId, blocksLeft, expiration, fallbackAfter } | null }. */
    async arenaStatus(outpoint) {
      const j = await read(['--mode', 'arena-status', '--data-dir', readDataDir, '--outpoint', outpointArg(outpoint)]);
      return { blockCount: Number(j.block_count),
        stored: j.stored ? { contractId: String(j.stored.contract_id), blocksLeft: Number(j.stored.blocks_left), expiration: Number(j.stored.expiration),
          fallbackAfter: Number(j.stored.fallback_after) } : null };
    },
    async moduleVersion() {
      const j = await read(['--mode', 'arena-version', '--data-dir', readDataDir]);
      return { major: Number(j.major), minor: Number(j.minor), arenaLock: j.arena_lock === true };
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
     * A CARRIER OF A SLASH (spec 5A.3B, kanban #972): a peg-in address of this client, the release or the fallback paying into it; the deposit claimed once the federation takes it;
     * and payout contracts, each to a key for an amount, as the arbitration set's payOutSlash pays (arbiter.js). `payouts` [{ key (33 bytes hex), msat }].
     */
    async peginAddress() {
      const j = await run(bin, ['--mode', 'pegin-address', '--data-dir', dataDir], timeoutMs);
      if (!j.address) throw new Error(`no peg-in address: ${j.error || JSON.stringify(j).slice(0, 160)}`);
      return String(j.address);
    },
    /**
     * THE CLAIM OF ONE DEPOSIT (kanban #1093): `outpoint` 'txid:vout' (display order) and `sats` its value name the deposit, so the tool answers what the federation credited
     * THAT deposit (walletv2: one peg-in address per client, every deposit on it; its record per outpoint), never "the balance grew" - which read another escrow's deposit
     * as this one's. The legacy wallet gives each deposit its own address, so there the address names it and the balance's rise is its claim. Without an outpoint: as before.
     */
    async peginClaim(address, opts = {}) {
      const { outpoint = null, sats = null, waitS = 840 } = typeof opts === 'number' ? { waitS: opts } : (opts || {});
      const args = ['--mode', 'pegin-claim', '--data-dir', dataDir, '--address', String(address), '--timeout-s', String(waitS)];
      if (outpoint) args.push('--outpoint', String(outpoint), ...(sats !== null && sats !== undefined ? ['--sats', String(sats)] : []));
      const j = await run(bin, args, (waitS + 60) * 1000);
      if (j.claimed_msat !== undefined && j.claimed_msat !== null) {
        if (outpoint && j.outpoint && String(j.outpoint).toLowerCase() !== String(outpoint).toLowerCase()) throw new Error(`the tool claimed ${j.outpoint}, not ${outpoint}`);
        if (!(BigInt(j.claimed_msat) > 0n)) throw new Error(`the peg-in is not claimed yet: ${j.error || JSON.stringify(j).slice(0, 160)}`);
        return { claimedMsat: BigInt(j.claimed_msat) };
      }
      // A WALLETV2 ANSWER WITHOUT A PER-OUTPOINT CLAIM is a tool from before #1093: its balance rise may be another deposit's
      if (outpoint && j.kind === 'walletv2') throw new Error('this stake-lock tool claims a walletv2 peg-in by the balance, not by its outpoint: rebuild it (kanban #1093)');
      if (!(j.balance_after_msat > j.balance_before_msat)) throw new Error(`the peg-in is not claimed yet: ${j.error || JSON.stringify(j).slice(0, 160)}`);
      return { claimedMsat: BigInt(j.balance_after_msat) - BigInt(j.balance_before_msat) };
    },
    /** `key` (kanban #1174): the payout's idempotency key - the tool submits one transaction per key and answers it again ("again") after. */
    async payouts(list, { key = null } = {}) {
      const j = await run(bin, ['--mode', 'pay', '--data-dir', dataDir, '--payouts', list.map((p) => `${p.key}:${p.msat}`).join(','), ...(key ? ['--key', String(key)] : [])], timeoutMs * 5);
      if (!j.txid) throw new Error(`no payout transaction: ${j.error || JSON.stringify(j).slice(0, 160)}`);
      return { txid: String(j.txid), again: j.again === true, payouts: (j.payouts || []).map((y) => ({ refundPk: String(y.refund_pk).toLowerCase(), outIdx: y.out_idx, contractId: y.contract_id })) };
    },
    /**
     * WHAT A KEYED PAYOUT PAID (kanban #1174, the tool's pay-sent): { found, txid, payouts, rejected } - found false: never submitted under that key;
     * rejected: the guardians refused it, nothing paid. A tool built before this cannot answer: it throws, and the caller holds (never pays twice).
     */
    async payoutsSent(list, key) {
      const j = await run(bin, ['--mode', 'pay-sent', '--data-dir', dataDir, '--payouts', list.map((p) => `${p.key}:${p.msat}`).join(','), '--key', String(key)], timeoutMs);
      if (j.mode !== 'pay-sent' || typeof j.found !== 'boolean') throw new Error(`this stake-lock tool cannot read a keyed payout back: ${j.error || JSON.stringify(j).slice(0, 120)}`);
      return { found: j.found, rejected: j.rejected === true, why: j.why || null, txid: j.txid ? String(j.txid) : null,
        payouts: (j.payouts || []).map((y) => ({ refundPk: String(y.refund_pk).toLowerCase(), outIdx: y.out_idx, contractId: y.contract_id })) };
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
    /**
     * A PROTOCOL-27 SETTLEMENT (stake-lock arena-settle, rulings #1131 3, #1135): every Arena lock in as Claim, the payouts out, a payout key Z
     * (arena-lock.js zKey) standing for the signer set's key. Without `signers`: the BODY and its id, what the seats ack and commit over. With
     * `signers` (S, ascending seat indices): the real transaction, its txid (`message` the 32 bytes MuSig2 signs) and KeyAgg(S) (`aggKey`, x-only
     * hex); the tool refuses a real transaction that strips to another body. With `signature`: submitted.
     */
    async arenaSettle({ claims, payouts, nonce, signers = null, signature = null }) {
      const args = ['--mode', 'arena-settle', '--data-dir', dataDir,
        '--locks', locksArg(claims),
        '--payouts', payoutsArg(payouts),
        '--nonce', toHex(nonce), ...(signers ? ['--signers', signers.join(',')] : []), ...(signature ? ['--signature', toHex(signature)] : [])];
      const j = await run(bin, args, settleTimeoutMs);
      return { bodyId: String(j.body_id), zSlots: j.z_slots || [], txid: j.txid ? String(j.txid) : null, message: j.message_hex ? String(j.message_hex) : null,
        aggKey: j.agg_key ? String(j.agg_key) : null, payouts: j.payouts || [], accepted: j.accepted === true, error: j.error || null,
        verifies: j.signature_verifies_under_agg_key === true, locksSpent: j.locks_spent === true };
    },
    /**
     * THE PRESIGNED REFUND (c) OF A GATEWAY SEND (stake-lock arena-send-refund, rulings #1134 2, #1135 2, #1136): the send contract at `send`
     * (the real settlement txid, its index) by Refund into one pre-expired payout to `qualifierPk`. Without `signature` the txid S signs; with it,
     * submitted (anyone, from the send's expiration).
     */
    async arenaSendRefund({ send, amountMsat, refundPk, qualifierPk, signature = null }) {
      const j = await run(bin, ['--mode', 'arena-send-refund', '--data-dir', dataDir, '--send', outpointArg(send), '--amount-msat', String(amountMsat),
        '--refund-pk', toHex(refundPk), '--qualifier-pk', toHex(qualifierPk), ...(signature ? ['--signature', toHex(signature)] : [])], timeoutMs);
      return { txid: String(j.txid), message: String(j.message_hex), nonce: String(j.nonce), payoutMsat: j.payout_msat === undefined ? null : BigInt(j.payout_msat),
        accepted: j.accepted === true, error: j.error || null, verifies: j.signature_verifies === true };
    },
    /**
     * THE FEDERATION'S SIGNED HISTORY FOR A NAMED CLAIM'S PROOF (kanban #1044 B1, ruling #1131 4): the sessions `from`..`to` (to: the last finished
     * one when null) as consensus bytes, and the client config they verify against - stake-lock session-export, written to a file beside the client.
     * { federationId, config, firstSession, sessions: [bytes] }.
     */
    async sessionExport({ from, to = null }) {
      const file = join(readDataDir, `named-sessions-${process.pid}-${now()}.json`);
      try {
        await run(bin, ['--mode', 'session-export', '--data-dir', readDataDir, '--from', String(from), ...(to === null ? [] : ['--to', String(to)]), '--out', file], settleTimeoutMs);
        const ex = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(ex.sessions) || typeof ex.config !== 'string' || Number(ex.firstSession) !== Number(from)) throw new Error('the session export is not the range asked');
        return { federationId: String(ex.federationId), config: fromHex(ex.config), firstSession: Number(ex.firstSession), sessions: ex.sessions.map((h) => fromHex(String(h))) };
      } finally { try { unlinkSync(file); } catch { /* none written */ } }
    },
    /** How many sessions the federation has finished (stake-lock session-count): a round's funding sessions start at or after it (kanban #1044 B1). */
    async sessionCount() {
      const j = await read(['--mode', 'session-count', '--data-dir', readDataDir]);
      if (!Number.isSafeInteger(j.count)) throw new Error(`no session count: ${j.error || JSON.stringify(j).slice(0, 160)}`);
      return j.count;
    },
    /** THE PROOF READER (stake-lock arena-claim-read, offline): `input` claimReadInput's shape; the tool's answer as it printed it. */
    async arenaClaimRead(input) { return readClaims(bin, input, settleTimeoutMs, spawnFn); },
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
 * THE NAMED CLAIM'S PROOF READER, NEEDING NO CLIENT (kanban #1044 B1): the stake-lock tool's `arena-claim-read` over a proof's own config and sessions
 * (stdin), every session verified against the config's broadcast keys there. Answers the tool's line, or null where no tool runs or it reads no such
 * mode (a judge then cannot say).
 */
export async function readClaims(bin, input, timeoutMs = 120000, spawnFn = spawn) {
  if (!bin) return null;
  try {
    const j = await run(bin, ['--mode', 'arena-claim-read'], timeoutMs, { spawnFn, stdin: JSON.stringify(input) });
    return j && j.mode === 'arena-claim-read' ? j : null;
  } catch { return null; }
}

/**
 * A LEVEL-1 PROOF (a)'S CORRECT BODY, REBUILT OFFLINE (kanban #1044 B1): the stake-lock tool's `arena-body` over the proof's own config and sessions
 * (claimReadInput's shape) and the correct table's build ({ claims, payouts, nonce }, tableBuild's) - the claimed locks' contracts read from the sessions
 * that funded them, since a proof exists only once its claim spent them at the guardians. Answers { ok: true, bodyId (hex) } or { ok: false, why }
 * where the proof's own bytes do not rebuild it, or null where no tool runs here or it reads no such mode (a judge then cannot say).
 */
export async function readBody(bin, input, build, timeoutMs = 120000, spawnFn = spawn) {
  if (!bin) return null;
  try {
    const j = await run(bin, ['--mode', 'arena-body'], timeoutMs, { spawnFn,
      stdin: JSON.stringify({ ...input, locks: locksArg(build.claims), payouts: payoutsArg(build.payouts), nonce: toHex(build.nonce) }) });
    if (!j || j.mode !== 'arena-body') return null;
    return j.ok === true ? { ok: true, bodyId: String(j.body_id).toLowerCase() } : { ok: false, why: String(j.why || 'the tool rebuilt no body') };
  } catch { return null; }
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
  // macOS at load 128): the joined directory is copied once beside it, `<dir>.read`, and its read-only questions (status,
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
