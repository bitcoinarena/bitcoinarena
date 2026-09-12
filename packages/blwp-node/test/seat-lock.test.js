// A SEAT VERIFIES THE PLAYER'S STAKE LOCK BEFORE THE STAKE IS COMMITTED (§23.1 step 5).
//
// Custody is the stake lock (FEDERATION.md, the owner 2026-09-11): the player's
// client locks the net stake in the round's federation as a stock LNv2
// OutgoingContract - payment_image Point(stake_point), claim_pk the round's
// key, refund_pk the player, expiration >= height + 144. "STAKE_COMMITTED is
// recorded once >=5 settlement nodes have VERIFIED the locks: the contract id
// at stake_lock_outpoint equals the hash of a contract whose ..." (§23.1 step
// 5). The federation is reached through a port, as Lightning is.
//
// MEASURED BEFORE (TASKBOOK, acffd59): a seat of a federation round, a lock
// stored at the entry's outpoint - POST /lock 404, /stake 409 for want of
// Lightning, the federation asked 0 times, the stake never seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { lockFieldsToJson } from '../src/stake-lock-seat.js';
import { assumeSeated } from './seating.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { b32, rand, STAKE, WINDOW_MS, contractFor, opts } from './window-fixture.js';

const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };
const CLAIM = Uint8Array.from([0x02, ...b32(0xc1)]);

/** A federation port that holds locks by outpoint and counts every ask. */
export function lockPort({ height = 1000 } = {}) {
  const locks = new Map();
  const port = {
    asked: 0, height, locks,
    async status(outpoint) {
      port.asked++;
      const at = locks.get(`${toHex(outpoint.txid)}:${outpoint.outIdx}`);
      return { blockCount: port.height, stored: at ? { contractId: at.id, blocksLeft: at.fields.expiration - port.height } : null };
    },
    // A stand-in for the stock client's hash of a contract: any function of every field.
    async contractId(f) {
      port.asked++;
      return toHex(sha256(new TextEncoder().encode(JSON.stringify([f.paymentImage.kind, toHex(f.paymentImage.bytes),
        String(f.amountMsat), toHex(f.claimPk), toHex(f.refundPk), f.expiration]))));
    },
    async put(outpoint, fields) { locks.set(`${toHex(outpoint.txid)}:${outpoint.outIdx}`, { fields, id: await port.contractId(fields) }); port.asked--; },
  };
  return port;
}

/** One seat of a paying FEDERATION round, a player's stake dealt and seated, the entry naming its lock. */
export async function seatedWithLock(extra = {}, { federationId = b32(0xfe) } = {}) {
  const port = lockPort();
  const d = await serve(openStore(':memory:'), { port: 0, ...opts, stakeLocks: port, ...extra });
  const c = { ...contractFor([d.round.pubkey, b32(0x33)], BigInt(WINDOW_MS), [`http://127.0.0.1:${d.port}`]), federationId };
  const rid = roundId(c);
  assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
  assumeSeated(d.round, rid, c.nodes);
  const preimage = secretScalar();
  const e = rand(32);
  const player = rand(32);
  const dealt = await dealHandout({
    preimage, seats: c.nodes, roundId: rid, playerPubkey: player,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup,
  });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: rid, playerPubkey: player, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x16), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: new Uint8Array(32), stakeLockOutpoint: outpoint, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: new Uint8Array(32),
  };
  assert.equal((await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
  const seated = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
  assert.equal(seated.status, 201, await seated.text());
  const eid = entryId(entry);
  // THE LOCK THE PLAYER MADE, as the federation stores it.
  const fields = {
    paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry),
    claimPk: CLAIM, refundPk: refundKeyOf(player), expiration: port.height + 200,
  };
  await port.put(outpoint, fields);
  return { d, port, c, rid, entry, eid, fields, outpoint, close: () => d.close() };
}

const WITH_KEY = { claimKeyFor: () => CLAIM };
const handOver = (s, fields) => fetch(`http://127.0.0.1:${s.d.port}/lock?entry=${toHex(s.eid)}`,
  { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
const stakeStatus = async (s) => (await fetch(`http://127.0.0.1:${s.d.port}/stake?entry=${toHex(s.eid)}`)).status;

test('the player\'s own lock is verified: the seat asks the federation, the contract is the one it holds, every field matches, and the stake is seen - /stake answers held', async () => {
  const s = await seatedWithLock(WITH_KEY);
  try {
    const before = await stakeStatus(s);
    const r = await handOver(s, s.fields);
    const said = await r.text();
    const seen = s.d.round.stakeSeen(s.eid);
    const facts = {
      stakeBefore: before, lockDoor: r.status, federationAsked: s.port.asked,
      stakeSeenMsat: seen ? String(seen.paidMsat) : null, netStake: String(netStakeMsat(s.entry)),
      stakeAfter: await stakeStatus(s), lockKept: !!s.d.round.stakeLock(s.eid),
    };
    console.log('  FACTS (the player\'s own lock):', JSON.stringify(facts), '|', said.trim().slice(0, 100));
    assert.deepEqual(facts, {
      stakeBefore: 409, lockDoor: 201, federationAsked: 2, stakeSeenMsat: String(netStakeMsat(s.entry)),
      netStake: String(netStakeMsat(s.entry)), stakeAfter: 200, lockKept: true,
    });
  } finally { await s.close(); }
});

test('a lock that is not the entry\'s is refused by name, and the stake stays unseen', async () => {
  const cases = [
    ['no lock at the outpoint', async (s) => { s.port.locks.clear(); return s.fields; }, /holds no lock at the entry's stake_lock_outpoint/],
    ['a contract other than the one stored', async (s) => ({ ...s.fields, amountMsat: s.fields.amountMsat + 1n }), /its id is another/],
    ['a stored lock for the wrong amount', async (s) => { const f = { ...s.fields, amountMsat: s.fields.amountMsat - 1n }; await s.port.put(s.outpoint, f); return f; }, /holds \d+ msat, and the entry's net stake/],
    ['a hash image', async (s) => { const f = { ...s.fields, paymentImage: { kind: 'hash', bytes: s.entry.stakeCommitment } }; await s.port.put(s.outpoint, f); return f; }, /payment image is not the entry's stake point/],
    ['another claim key', async (s) => { const f = { ...s.fields, claimPk: Uint8Array.from([0x02, ...b32(0xc2)]) }; await s.port.put(s.outpoint, f); return f; }, /claim_pk is not this round's attested claim key/],
    ['another refund key', async (s) => { const f = { ...s.fields, refundPk: Uint8Array.from([0x02, ...b32(0x77)]) }; await s.port.put(s.outpoint, f); return f; }, /refund_pk is not the entry's player key/],
    ['too short an expiry', async (s) => { const f = { ...s.fields, expiration: s.port.height + 100 }; await s.port.put(s.outpoint, f); return f; }, /a loser could refund before settlement/],
  ];
  const facts = [];
  for (const [name, make, why] of cases) {
    const s = await seatedWithLock(WITH_KEY);
    try {
      const r = await handOver(s, await make(s));
      const said = await r.text();
      facts.push(name);
      assert.equal(r.status, 409, `${name}: accepted (${said})`);
      assert.match(said, why, `${name}: refused for another reason`);
      assert.equal(s.d.round.stakeSeen(s.eid), null, `${name}: the stake was seen`);
      assert.equal(await stakeStatus(s), 409, `${name}: /stake answered`);
    } finally { await s.close(); }
  }
  console.log(`  ${facts.length} wrong locks refused by name: ${facts.join('; ')}`);
});

test('a round that names no federation takes no lock: its stake is not one', async () => {
  const s = await seatedWithLock(WITH_KEY, { federationId: new Uint8Array(32) });
  try {
    const r = await handOver(s, s.fields);
    assert.equal(r.status, 409);
    assert.match(await r.text(), /names no federation/);
    assert.equal(s.d.round.stakeSeen(s.eid), null);
    assert.equal(s.port.asked, 0, 'the federation was asked about a round that names none');
  } finally { await s.close(); }
});
