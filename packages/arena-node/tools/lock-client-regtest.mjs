// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOCK CLIENT, DRIVEN FROM NODE, ON A REAL FEDERATION (W1a). Run by
// lock-client-regtest.sh after rehearsal step 1's setup: stock fedimintd 0.12.0,
// 4 guardians, 3 of 4, one gateway, regtest.
//
//   the page's own attestedClaimKey (W3) asks two signer nodes for the claim key;
//   the wasm lock client (packages/arena-client/lock-client) joins from the
//   invite, deposits through the gateway, and locks Point(stake_point) to it;
//   the entry names the outpoint; both signer nodes are handed the contract (W2).
// And two that must be refused: an outpoint that holds no lock, and a lock to
// a key nobody attested.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { readFileSync } from 'node:fs';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { assumeAssigned } from '../test/assignment.js';
import { attestedClaimKey } from '../../arena-client/src/join.js';
import { lockFromClient } from '../../arena-client/src/lock-result.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { CORE_HASH } from './core-hash.mjs';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const env = process.env;
const P = env.PROBE;
const say = (o) => console.log(JSON.stringify(o));
const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const scalar = () => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } };
const evenPlayer = () => { let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02); return schnorr.getPublicKey(k); };
const lncliPay = (invoice) => new Promise((done) => execFile(`${env.LND_BIN}/lncli`,
  [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest', 'payinvoice', '--force', invoice],
  { timeout: 120000 }, (err, out) => done((String(out).match(/Payment status: [A-Z_]+/) || [err ? err.message : '?'])[0])));

// A NODE HARNESS HAS NO `window`; a page does. If the wasm client reaches for one, it is the global.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const require = createRequire(import.meta.url);
const { LockClient } = require(`${env.WASM_PKG}/blwp_lock_client.js`);

// HARNESS KEY (W1a): the signer nodes are handed the rehearsal's claim key. The page
// rehearsal (arena-client/tools/page-lock.mjs) uses the signer nodes' own.
const claimPk = fromHex(JSON.parse(readFileSync(`${P}/keys.json`, 'utf8')).claimPk);
const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
const signerNodes = [];
for (let i = 0; i < 2; i++)
  signerNodes.push(await serve(openStore(':memory:'), { plugins: [NEXTBLOCK], port: 0, funded: () => true, stakeLocks: port, claimKeyFor: () => claimPk }));
const nodes = signerNodes.map((d) => `http://127.0.0.1:${d.port}`);
try {
  const STAKE = 1000000n;
  const now = BigInt(Date.now());
  const c = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
    gameId: NEXTBLOCK_GAME_ID, simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS, entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n,
    objectionWindowMs: 3000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: fromHex(LockClient.federationIdOf(env.INVITE)),
    stakeExpiryBlocks: 144, publicationRelays: nodes, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
    committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
    rankNumerator: 3, rankDenominator: 4, nodes: signerNodes.map((d) => d.round.pubkey),
  };
  const rid = roundId(c);
  for (const d of signerNodes) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    if (r.status !== 201) throw new Error(`round: ${r.status} ${await r.text()}`);
    assumeAssigned(d.round, rid, c.nodes);
  }
  const round = { ...c, id: rid };
  const net = netStakeMsat({ stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n });

  // THE PAGE'S OWN CHECK picks the key the lock names (W3).
  const att = await attestedClaimKey({ round, signerNodes: c.nodes, nodes, curve: pageCurve });
  say({ step: 'attested claim key', ok: att.ok, attested: att.attested, needed: att.needed, key: att.ok ? toHex(att.claimPk) : att.why });
  if (!att.ok) throw new Error(att.why);

  // THE LOCK CLIENT: join, deposit through the gateway, and lock.
  let t = Date.now();
  // THE LOCK CLIENT'S join TAKES FOUR NOW (W1b): the federation the invite names -
  // refused unless it is the one given - a secret, and the tab's store. This driver
  // still called the W1a one-argument join and died reading the missing store
  // ("Cannot read properties of undefined (reading 'length')", measured 2026-09-14).
  // A Node run has no tab: a store in memory, the shape store.rs reads.
  const held = new Map();
  const memStore = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
  const lc = await LockClient.join(env.INVITE, LockClient.federationIdOf(env.INVITE), toHex(rand(32)), memStore);
  say({ step: 'join', ms: Date.now() - t, balanceMsat: await lc.balanceMsat() });
  t = Date.now();
  // 3200000: four stake locks' worth and a fee lock for each entry (pick (a) - the door takes no entry
  // without one where the round mints them); 3000000 held three stake locks and one fee lock.
  const rcv = JSON.parse(await lc.receive('3200000', env.GATEWAY));
  const paid = await lncliPay(rcv.invoice);
  const final = await lc.awaitReceive(rcv.operation);
  say({ step: 'deposit', msat: 3200000, alice: paid, final, ms: Date.now() - t, balanceMsat: await lc.balanceMsat() });

  // THE FEDERATION'S OWN FEE RULE AND THE GATE, before any entry (Pick b; pick (a)): at this round's
  // 1000 sat the gate mints, so every entry brings a fee lock. Measured before: A, B and C brought
  // none and the door refused A - "an entry that brings no fee lock is not taken" (409) - since
  // 5a3b227, and the driver printed the error and went on to exit 0.
  const rule = JSON.parse(await lc.feeRule());
  const fees = { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) };
  const gate1000 = feeLockPays({ contract: c, fees });
  const gate100 = feeLockPays({ contract: { ...c, stakeMsat: 100000n }, fees });
  say({ step: 'fee rule and gate', rule, gate1000: { pays: gate1000.pays, lock: String(gate1000.lockMsat), perSignerNodeNet: (gate1000.perSignerNodeNetMsat || []).map(String) },
    gate100: { pays: gate100.pays, why: gate100.why.slice(0, 120) } });
  if (!gate1000.pays) throw new Error(`the gate refused a 1000 sat round: ${gate1000.why}`);

  const stakeOf = () => { const p = scalar(); return { p, point: feldmanGroup.pointFromScalar(scalarFrom32(p) % FIELD), player: evenPlayer() }; };
  const joinedEntry = async (s, outpoint, claimKey, fee = null) => {
    // WHERE THE ROUND MINTS FEE LOCKS THE ENTRY BRINGS ONE (pick (a)), to H(F) under the attested key,
    // handed to both signer nodes after the entry - unless the caller brings its own (D, whose order is its test).
    let hand = null;
    if (!fee && gate1000.pays) {
      const F = rand(32);
      const got = lockFromClient(await lc.lockHash(toHex(sha256(F)), String(entryFeeMsat(STAKE)), toHex(att.claimPk), toHex(refundKeyOf(s.player)), 150),
        { hash: sha256(F), claimPk: att.claimPk, refundPk: refundKeyOf(s.player) });
      fee = { preimage: F, outpoint: got.outpoint };
      hand = got.fields;
    }
    const e = rand(32);
    const dealt = await dealHandout({ preimage: s.p, signerNodes: c.nodes, roundId: rid, playerPubkey: s.player,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
    const entry = {
      roundId: rid, playerPubkey: s.player, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: sha256(s.p), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n, joinTick: 0,
      worldSecret: rand(32), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
      feePreimage: fee ? fee.preimage : new Uint8Array(32), stakeLockOutpoint: outpoint,
      feeLockOutpoint: fee ? fee.outpoint : { txid: new Uint8Array(32), outIdx: 0n },
      claimKeyAttestationRef: claimKey.ref,
    };
    const eid = entryId(entry);
    for (const d of signerNodes) {
      await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
      const r = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      if (r.status !== 201) throw new Error(`entry: ${r.status} ${await r.text()}`);
      if (hand) {
        const fl = await fetch(`http://127.0.0.1:${d.port}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(hand)) });
        if (fl.status !== 201) throw new Error(`fee-lock: ${fl.status} ${await fl.text()}`);
      }
    }
    return eid;
  };
  const handOver = async (label, eid, fields) => {
    const out = [];
    for (const d of signerNodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
      const seen = d.round.stakeSeen(eid);
      out.push({ status: r.status, committedMsat: seen ? String(seen.paidMsat) : null, why: (await r.text()).trim().slice(0, 110) });
    }
    say({ handover: label, signerNodes: out });
  };

  // A: THE PLAYER'S LOCK, to the attested key.
  const A = stakeOf();
  t = Date.now();
  const lockA = await lc.lock(toHex(A.point), String(net), toHex(att.claimPk), toHex(refundKeyOf(A.player)), 150);
  const a = lockFromClient(lockA, { point: A.point, claimPk: att.claimPk, refundPk: refundKeyOf(A.player) });
  say({ step: 'lock A', ms: Date.now() - t, outpoint: `${toHex(a.outpoint.txid)}:${a.outpoint.outIdx}`, contract: a.contractId, balanceMsat: await lc.balanceMsat() });
  const eidA = await joinedEntry(A, a.outpoint, att);
  await handOver('A, the lock client\'s own lock', eidA, a.fields);

  // MUTANT 1: the lock skipped - an entry naming an outpoint that holds none, handed A's contract.
  const B = stakeOf();
  const eidB = await joinedEntry(B, { txid: a.outpoint.txid, outIdx: a.outpoint.outIdx + 9n }, att);
  await handOver('B, no lock at its outpoint (the lock skipped)', eidB, { ...a.fields, paymentImage: { kind: 'point', bytes: B.point }, refundPk: refundKeyOf(B.player) });

  // MUTANT 2: a lock to a key nobody attested.
  const C = stakeOf();
  const rogue = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
  const lockC = await lc.lock(toHex(C.point), String(net), toHex(rogue), toHex(refundKeyOf(C.player)), 150);
  const cc = lockFromClient(lockC, { point: C.point, claimPk: rogue, refundPk: refundKeyOf(C.player) });
  const eidC = await joinedEntry(C, cc.outpoint, att);
  await handOver('C, locked to an unattested key', eidC, cc.fields);

  // D (Pick b, 2026-09-14): THE FEE LOCK, ONLY WHEN IT CAN PAY A SIGNER NODE. The
  // federation's own fee rule, asked of the wasm client; the gate at this round's
  // 1000 sat and, for contrast, at 100 sat; then at 1000 sat a real hash-image
  // lock of the entry's 20000 msat fee to H(F), handed to both signer nodes' /fee-lock.
  const D = stakeOf();
  const F = rand(32);
  const lockD = await lc.lock(toHex(D.point), String(net), toHex(att.claimPk), toHex(refundKeyOf(D.player)), 150);
  const d = lockFromClient(lockD, { point: D.point, claimPk: att.claimPk, refundPk: refundKeyOf(D.player) });
  t = Date.now();
  const feeD = await lc.lockHash(toHex(sha256(F)), String(entryFeeMsat(STAKE)), toHex(att.claimPk), toHex(refundKeyOf(D.player)), 150);
  const fd = lockFromClient(feeD, { hash: sha256(F), claimPk: att.claimPk, refundPk: refundKeyOf(D.player) });
  say({ step: 'fee lock D', ms: Date.now() - t, outpoint: `${toHex(fd.outpoint.txid)}:${fd.outpoint.outIdx}`, contract: fd.contractId,
    msat: String(fd.fields.amountMsat), image: fd.fields.paymentImage.kind, balanceMsat: await lc.balanceMsat() });
  const eidD = await joinedEntry(D, d.outpoint, att, { preimage: F, outpoint: fd.outpoint });
  await handOver('D, its stake lock', eidD, d.fields);
  const feeOut = [];
  for (const s of signerNodes) {
    const r = await fetch(`http://127.0.0.1:${s.port}/fee-lock?entry=${toHex(eidD)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fd.fields)) });
    feeOut.push({ status: r.status, kept: !!s.round.feeLock(eidD), why: (await r.text()).trim().slice(0, 110) });
  }
  say({ handover: 'D, its fee lock to /fee-lock', signerNodes: feeOut });
} catch (e) {
  say({ error: e.message });
  process.exitCode = 1;
} finally { for (const d of signerNodes) await d.close(); }
// THE WASM CLIENT'S GUARDIAN WEBSOCKETS KEEP NODE'S EVENT LOOP ALIVE after the
// last step - measured: every step done, the process still up 9 minutes later,
// its lines held in the pipe. So it ends here, with what it measured.
process.exit(process.exitCode || 0);
