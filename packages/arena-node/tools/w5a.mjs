// W5a ON A REAL FEDERATION: THE PLAYER'S REFUND AND WITHDRAW (v4.6.2 §23.2,
// "the default path - nobody acting - is always the refund"). Run by
// w5a-regtest.sh after the federation is up.
//
// On the Daily's own 2-of-2 round naming the federation, the signer nodes making the
// round's claim key themselves (nothing injected), two players - one whose key
// is even-y, one odd-y - lock their stakes the way the page does and are
// committed by both signer nodes. Then, each from a LATER SESSION that holds only its
// seed (an empty tab store):
//   a refund before the lock's expiry         - the guardians must refuse it
//   blocks mined past the lock's own expiry
//   the refund again                          - accepted; the lock is gone
//   a second refund of the same lock          - refused
//   a withdraw of what the refund credited, over the listed gateway, to the
//   player's lnd                             - the sats that land, and the fees
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { standUpRound } from './round-2of2.mjs';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { awaitAttestedClaimKey, stakeFor, postHandout, entryFor, playerFor } from '../../arena-client/src/join.js';
import { lockStake, fundPlayerWallet, handLock, refundStake } from '../../arena-client/src/page-lock.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

// THE STAKE FROM THE PLAYER WALLET (§24A.1, RULED 2026-09-25): the top-up into the player wallet is its own act,
// then the stake is spent from it - the same arguments, the same tab, the same onDeposit.
const fundedLockStake = async (a) => { await fundPlayerWallet(a); return lockStake(a); };

const env = process.env;
const P = env.PROBE;
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => new Uint8Array(randomBytes(n));

// THE LOCK CLIENT, as the page loads it (the glue is ESM; dist is CommonJS).
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const dist = new URL('../../arena-client/dist/', import.meta.url).pathname;
const glueDir = mkdtempSync(join(tmpdir(), 'w5a-glue-'));
copyFileSync(join(dist, 'blwp_lock_client.js'), join(glueDir, 'blwp_lock_client.mjs'));
const glue = await import(join(glueDir, 'blwp_lock_client.mjs'));
await glue.default({ module_or_path: readFileSync(join(dist, 'blwp_lock_client_bg.wasm')) });
const { LockClient } = glue;
const federationId = fromHex(LockClient.federationIdOf(env.INVITE));

const bcn = (...a) => execFileSync(`${env.BITCOIN_BIN}/bitcoin-cli`,
  ['-regtest', '-rpcport=30101', `-datadir=${P}/btc`, '-rpcuser=blwp', '-rpcpassword=blwp', ...a], { encoding: 'utf8' }).trim();
const lncli = (...a) => new Promise((done) => execFile(`${env.LND_BIN}/lncli`,
  [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest', ...a],
  { timeout: 120000 }, (err, out) => done({ err: err ? err.message.slice(0, 160) : null, out: String(out) })));
const pay = async (invoice) => ((await lncli('payinvoice', '--force', invoice)).out.match(/Payment status: [A-Z_]+/) || ['?'])[0];
const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });

/** A tab's storage, empty: a later session holding only the seed. */
function tab() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const short = (r) => ({
  accepted: r.accepted, error: r.error ? String(r.error).slice(0, 160) : null, txid: r.txid,
  federationBlockCount: r.block_count, expiration: r.expiration,
  lockBefore: r.stored_before ? 'held' : 'none', lockAfter: r.stored_after ? 'held' : 'none',
  balanceBefore: r.balance_before, balanceAfter: r.balance_after,
});

const round = await standUpRound({ host: '127.0.0.1', portA: 18561, portB: 18562, stakeMsat: 1000000n,
  federationId, invite: env.INVITE, signerNode: { stakeLocks: port } });
const rid = fromHex(round.id);
const contract = round.contract;
const withId = { ...contract, id: rid };
let code = 0;
try {
  // THE SIGNER NODES' OWN CLAIM KEY, attested as the page attests it.
  const claimKey = await awaitAttestedClaimKey({ round: withId, signerNodes: contract.nodes, nodes: round.nodes, curve: pageCurve });
  say({ step: 'claim key', ok: claimKey.ok, attested: claimKey.attested, needed: claimKey.needed,
    key: claimKey.ok ? toHex(claimKey.claimPk).slice(0, 16) : claimKey.why });
  if (!claimKey.ok) throw new Error(claimKey.why);

  // TWO PLAYERS LOCK, AS THE PAGE LOCKS: one even-y key, one odd-y.
  const players = [];
  for (const parity of ['even-y', 'odd-y']) {
    let seed;
    let player;
    for (;;) {
      seed = random(32);
      player = playerFor(withId, { seed, curve: pageCurve });
      if ((secp256k1.getPublicKey(player.secret, true)[0] === 2) === (parity === 'even-y')) break;
    }
    const stake = await stakeFor(withId, { signerNodes: contract.nodes, curve: pageCurve, random, playerPubkey: player.pubkey, needed: 2 });
    const put = await postHandout(stake, round.nodes, { needed: 2 });
    let paying = Promise.resolve(null);
    const lock = await fundedLockStake({ round: contract, roundId: rid, invite: env.INVITE, seed, stake, claimKey,
      playerPubkey: player.pubkey, LockClient, storage: tab(), onDeposit: (d) => { paying = pay(d.invoice); } });
    const paid = await paying;
    const entry = { roundId: rid, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      ...entryFor(withId, { seed, curve: pageCurve, random, stake, claimKey, stakeLock: lock }) };
    const joined = [];
    for (const base of round.nodes) joined.push((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status);
    const handed = await handLock({ entryId: entryId(entry), fields: lock.fields, nodes: round.nodes, needed: 2 });
    players.push({ parity, seed, lock });
    say({ step: 'locked', parity, deposit: paid, handouts: put.accepted, outpoint: `${toHex(lock.outpoint.txid)}:${lock.outpoint.outIdx}`,
      amountMsat: lock.fields.amountMsat, expiration: lock.fields.expiration, entries: joined,
      locks: handed.said.map((s) => s.status), committed: handed.committed });
  }

  // BEFORE THE EXPIRY: a later session, the seed only - refused by the guardians.
  for (const p of players) {
    const r = await refundStake({ round: contract, roundId: rid, invite: env.INVITE, seed: p.seed, curve: pageCurve,
      LockClient, storage: tab(), nodes: round.nodes });
    say({ step: 'refund before expiry', parity: p.parity, ...short(r.refunds[0]) });
  }

  // MINED PAST THE LOCKS' OWN EXPIRY, and waited for the guardians to see it.
  const expiration = Math.max(...players.map((p) => p.lock.fields.expiration));
  let st = await port.status(players[0].lock.outpoint);
  const blocks = expiration - st.blockCount + 1;
  bcn('generatetoaddress', String(blocks), bcn('-rpcwallet=probe', 'getnewaddress'));
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    st = await port.status(players[0].lock.outpoint);
    if (st.blockCount >= expiration) break;
    await wait(2000);
  }
  say({ step: 'mined', blocks, federationBlockCount: st.blockCount, expiration, waitedMs: Date.now() - t0 });

  // AFTER THE EXPIRY: the refund from the seed alone and a second refund, for
  // BOTH players, before any withdraw - measured: a withdraw can panic the wasm
  // module (std time on wasm32), and nothing after it would run.
  const clients = [];
  for (const p of players) {
    const r = await refundStake({ round: contract, roundId: rid, invite: env.INVITE, seed: p.seed, curve: pageCurve,
      LockClient, storage: tab(), nodes: round.nodes });
    const one = r.refunds[0];
    say({ step: 'refund after expiry', parity: p.parity, ...short(one),
      creditedMsat: one.accepted ? one.balance_after - one.balance_before : null,
      refundFeeMsat: one.accepted ? Number(p.lock.fields.amountMsat) - (one.balance_after - one.balance_before) : null });
    const again = await refundStake({ round: contract, roundId: rid, invite: env.INVITE, seed: p.seed, curve: pageCurve,
      LockClient, storage: tab(), nodes: round.nodes });
    say({ step: 'second refund of the same lock', parity: p.parity, ...short(again.refunds[0]) });
    clients.push({ p, r });
  }

  // THE WITHDRAW, LAST. A panic inside the wasm surfaces as an uncaught
  // exception, not a rejection: it is recorded as this step's answer.
  process.on('uncaughtException', (e) => {
    say({ step: 'withdraw', error: String(e && e.message).slice(0, 200) });
    round.close().finally(() => process.exit(1));
  });
  for (const { p, r } of clients) {
    const withdrawable = BigInt(await r.client.withdrawableMsat());
    const added = await lncli('addinvoice', `--amt_msat=${withdrawable}`, '--memo=w5a');
    const inv = JSON.parse(added.out || '{}');
    const w = JSON.parse(await r.client.withdraw(inv.payment_request));
    const looked = JSON.parse((await lncli('lookupinvoice', inv.r_hash)).out || '{}');
    say({ step: 'withdraw', parity: p.parity, gateway: w.gateway, balanceBefore: w.balance_before, withdrawableMsat: withdrawable,
      state: w.state, amountOutMsat: w.invoice_msat, remainingBalanceMsat: w.balance_after,
      sendFeesMsat: w.balance_before - w.balance_after - Number(withdrawable), lndState: looked.state, lndReceivedMsat: looked.amt_paid_msat });
  }
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
} finally {
  await round.close();
}
// The lock client's guardian sockets keep Node alive; it ends here with what it measured.
process.exit(code);
