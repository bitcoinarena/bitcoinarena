// A SEAT VERIFIES A REAL STAKE LOCK ON A REAL FEDERATION (v4.6.2 §23.1 step 5).
// Driven by seat-lock-regtest.sh, which stands up stock fedimintd 0.12.0 (4
// guardians, 3 of 4) on regtest, deposits through a gateway, and makes the
// locks with blwp-stake-lock.
//
//   node seat-lock-regtest.mjs prepare <dir>          three stakes: P, its point, an even-y player
//   node seat-lock-regtest.mjs seat <dir> <keys.json>  a seat, the real port, the handovers
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { lockFieldsToJson } from '../src/stake-lock-seat.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { CORE_HASH } from './core-hash.mjs';

const [cmd, dir, keysPath] = process.argv.slice(2);
const rand = (n) => new Uint8Array(randomBytes(n));
const scalar = () => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const STAKE = 1000000n;

if (cmd === 'prepare') {
  const stakes = {};
  for (const name of ['A', 'B', 'C']) {
    const p = scalar();
    let player;
    do { player = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(player, true)[0] !== 0x02);
    const x = schnorr.getPublicKey(player);
    stakes[name] = { p: toHex(p), point: toHex(feldmanGroup.pointFromScalar(scalarFrom32(p) % FIELD)),
      player: toHex(x), refundPk: toHex(refundKeyOf(x)) };
  }
  writeFileSync(`${dir}/stakes.json`, JSON.stringify(stakes, null, 1));
  const net = netStakeMsat({ stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n });
  console.log(JSON.stringify({ A: stakes.A.point, B: stakes.B.point, AR: stakes.A.refundPk, BR: stakes.B.refundPk, net: String(net) }));
  process.exit(0);
}

if (cmd !== 'seat') throw new Error('usage: seat-lock-regtest.mjs prepare|seat <dir> [keys.json]');
const stakes = JSON.parse(readFileSync(`${dir}/stakes.json`, 'utf8'));
const claimPk = fromHex(JSON.parse(readFileSync(keysPath, 'utf8')).claimPk);
const lockOf = (name) => JSON.parse(readFileSync(`${dir}/lock-${name}.json`, 'utf8'));
const port = stakeLockPort({ bin: process.env.LOCK_BIN, dataDir: `${dir}/client` });
const seat = await serve(openStore(':memory:'), {
  port: 0, funded: () => true, randomnessFor: () => ({ hash: b32(0x9b), height: 900001, timeMs: 900n }),
  stakeLocks: port, claimKeyFor: () => claimPk,
});
const say = (o) => console.log(JSON.stringify(o));
try {
  const now = BigInt(Date.now());
  const c = {
    networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
    gameVerifySlots: 2, settlementSlots: 2, simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS,
    entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n, objectionWindowMs: 3000n, custody: 'FEDERATION',
    slashMinimumServed: 20, slashRemainder: 'BURN', federationId: b32(0xfe), stakeExpiryBlocks: 144,
    publicationRelays: [`http://127.0.0.1:${seat.port}`], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE,
    bondMinSats: 50000n, blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [seat.round.pubkey, b32(0x33)],
  };
  const rid = roundId(c);
  const opened = await fetch(`http://127.0.0.1:${seat.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
  if (opened.status !== 201) throw new Error(`the round did not open: ${opened.status} ${await opened.text()}`);
  seat.round.db.prepare('SELECT 1').get();
  const { assumeSeated } = await import('../test/seating.js');
  assumeSeated(seat.round, rid, c.nodes);

  const seatEntry = async (name, outpoint) => {
    const s = stakes[name];
    const e = rand(32);
    const dealt = await dealHandout({
      preimage: fromHex(s.p), seats: c.nodes, roundId: rid, playerPubkey: fromHex(s.player),
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
      coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup,
    });
    if (!dealt.ok) throw new Error(dealt.why);
    if (toHex(dealt.handout.commitments[0]) !== s.point) throw new Error(`${name}: A0 is not the locked point`);
    const entry = {
      roundId: rid, playerPubkey: fromHex(s.player), sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: sha256(fromHex(s.p)), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
      joinTick: 0, worldSecret: rand(32), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
      feePreimage: new Uint8Array(32), stakeLockOutpoint: outpoint, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      claimKeyAttestationRef: new Uint8Array(32),
    };
    const h = await fetch(`http://127.0.0.1:${seat.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const en = await fetch(`http://127.0.0.1:${seat.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    if (h.status !== 201 || en.status !== 201) throw new Error(`${name}: handout ${h.status}, entry ${en.status} ${await en.text()}`);
    return { entry, eid: entryId(entry) };
  };
  const fieldsOf = (name, lock) => ({
    paymentImage: { kind: 'point', bytes: fromHex(stakes[name].point) }, amountMsat: BigInt(lock.amount_msat),
    claimPk, refundPk: fromHex(stakes[name].refundPk), expiration: Number(lock.computed_expiration),
  });
  const handOver = async (label, eid, fields) => {
    const t = Date.now();
    const r = await fetch(`http://127.0.0.1:${seat.port}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
    const why = (await r.text()).trim();
    const seen = seat.round.stakeSeen(eid);
    const stake = (await fetch(`http://127.0.0.1:${seat.port}/stake?entry=${toHex(eid)}`)).status;
    say({ handover: label, status: r.status, ms: Date.now() - t, stakeSeenMsat: seen ? String(seen.paidMsat) : null, stake, why: why.slice(0, 160) });
  };
  const opOf = (lock) => ({ txid: fromHex(lock.txid), outIdx: BigInt(lock.out_idx) });

  const A = lockOf('A'); const B = lockOf('B');
  const a = await seatEntry('A', opOf(A));
  const bb = await seatEntry('B', opOf(B));
  const cc = await seatEntry('C', { txid: fromHex(B.txid), outIdx: BigInt(B.out_idx) + 7n });
  const st0 = await port.status(opOf(A));
  say({ federation: 'status', blockCount: st0.blockCount, A: { expiration: A.computed_expiration, stored: st0.stored } });

  await handOver('B, its own lock (+150)', bb.eid, fieldsOf('B', B));
  await handOver('B, the amount changed by 1 msat', bb.eid, { ...fieldsOf('B', B), amountMsat: BigInt(B.amount_msat) - 1n });
  await handOver('C, an outpoint that holds no lock', cc.eid, fieldsOf('B', B));

  // AND ONCE THE FEDERATION HAS COUNTED ONE MORE BLOCK: A was locked at exactly
  // height + 144, as §23.1 step 4 says; step 5 wants >= current + 144.
  writeFileSync(`${dir}/mine-now`, '');
  const start = st0.blockCount;
  let st = st0;
  for (let i = 0; i < 120 && st.blockCount <= start; i++) { await new Promise((r) => setTimeout(r, 1000)); st = await port.status(opOf(A)); }
  say({ federation: 'status', blockCount: st.blockCount, advancedFrom: start });
  await handOver('A, its own lock (+144 exactly), one block later', a.eid, fieldsOf('A', A));
} finally { await seat.close(); }
