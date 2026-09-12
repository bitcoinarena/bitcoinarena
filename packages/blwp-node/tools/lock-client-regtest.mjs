// THE LOCK CLIENT, DRIVEN FROM NODE, ON A REAL FEDERATION (W1a). Run by
// lock-client-regtest.sh after rehearsal step 1's setup: stock fedimintd 0.12.0,
// 4 guardians, 3 of 4, one gateway, regtest.
//
//   the page's own attestedClaimKey (W3) asks two seats for the claim key;
//   the wasm lock client (packages/blwp-client/lock-client) joins from the
//   invite, deposits through the gateway, and locks Point(stake_point) to it;
//   the entry names the outpoint; both seats are handed the contract (W2).
// And two that must be refused: an outpoint that holds no lock, and a lock to
// a key nobody attested.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { lockFieldsToJson } from '../src/stake-lock-seat.js';
import { assumeSeated } from '../test/seating.js';
import { attestedClaimKey } from '../../blwp-client/src/join.js';
import { lockFromClient } from '../../blwp-client/src/lock-result.js';
import { pageCurve } from '../../blwp-client/src/page-curve.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { CORE_HASH } from './core-hash.mjs';

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

// HARNESS KEY (W1a): the seats are handed the rehearsal's claim key. The page
// rehearsal (blwp-client/tools/page-lock.mjs) uses the seats' own.
const claimPk = fromHex(JSON.parse(readFileSync(`${P}/keys.json`, 'utf8')).claimPk);
const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
const seats = [];
for (let i = 0; i < 2; i++)
  seats.push(await serve(openStore(':memory:'), { port: 0, funded: () => true, stakeLocks: port, claimKeyFor: () => claimPk }));
const nodes = seats.map((d) => `http://127.0.0.1:${d.port}`);
try {
  const STAKE = 1000000n;
  const now = BigInt(Date.now());
  const c = {
    networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
    simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS, entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n,
    objectionWindowMs: 3000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', federationId: b32(0xfe),
    stakeExpiryBlocks: 144, publicationRelays: nodes, donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
    committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
    rankNumerator: 3, rankDenominator: 4, nodes: seats.map((d) => d.round.pubkey),
  };
  const rid = roundId(c);
  for (const d of seats) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    if (r.status !== 201) throw new Error(`round: ${r.status} ${await r.text()}`);
    assumeSeated(d.round, rid, c.nodes);
  }
  const round = { ...c, id: rid };
  const net = netStakeMsat({ stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n });

  // THE PAGE'S OWN CHECK picks the key the lock names (W3).
  const att = await attestedClaimKey({ round, seats: c.nodes, nodes, curve: pageCurve });
  say({ step: 'attested claim key', ok: att.ok, attested: att.attested, needed: att.needed, key: att.ok ? toHex(att.claimPk) : att.why });
  if (!att.ok) throw new Error(att.why);

  // THE LOCK CLIENT: join, deposit through the gateway, and lock.
  let t = Date.now();
  const lc = await LockClient.join(env.INVITE);
  say({ step: 'join', ms: Date.now() - t, balanceMsat: await lc.balanceMsat() });
  t = Date.now();
  const rcv = JSON.parse(await lc.receive('3000000', env.GATEWAY));
  const paid = await lncliPay(rcv.invoice);
  const final = await lc.awaitReceive(rcv.operation);
  say({ step: 'deposit', msat: 3000000, alice: paid, final, ms: Date.now() - t, balanceMsat: await lc.balanceMsat() });

  const stakeOf = () => { const p = scalar(); return { p, point: feldmanGroup.pointFromScalar(scalarFrom32(p) % FIELD), player: evenPlayer() }; };
  const seatEntry = async (s, outpoint, claimKey) => {
    const e = rand(32);
    const dealt = await dealHandout({ preimage: s.p, seats: c.nodes, roundId: rid, playerPubkey: s.player,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
    const entry = {
      roundId: rid, playerPubkey: s.player, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: sha256(s.p), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n, joinTick: 0,
      worldSecret: rand(32), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
      feePreimage: new Uint8Array(32), stakeLockOutpoint: outpoint, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      claimKeyAttestationRef: claimKey.ref,
    };
    for (const d of seats) {
      await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
      const r = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      if (r.status !== 201) throw new Error(`entry: ${r.status} ${await r.text()}`);
    }
    return entryId(entry);
  };
  const handOver = async (label, eid, fields) => {
    const out = [];
    for (const d of seats) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
      const seen = d.round.stakeSeen(eid);
      out.push({ status: r.status, committedMsat: seen ? String(seen.paidMsat) : null, why: (await r.text()).trim().slice(0, 110) });
    }
    say({ handover: label, seats: out });
  };

  // A: THE PLAYER'S LOCK, to the attested key.
  const A = stakeOf();
  t = Date.now();
  const lockA = await lc.lock(toHex(A.point), String(net), toHex(att.claimPk), toHex(refundKeyOf(A.player)), 150);
  const a = lockFromClient(lockA, { point: A.point, claimPk: att.claimPk, refundPk: refundKeyOf(A.player) });
  say({ step: 'lock A', ms: Date.now() - t, outpoint: `${toHex(a.outpoint.txid)}:${a.outpoint.outIdx}`, contract: a.contractId, balanceMsat: await lc.balanceMsat() });
  const eidA = await seatEntry(A, a.outpoint, att);
  await handOver('A, the lock client\'s own lock', eidA, a.fields);

  // MUTANT 1: the lock skipped - an entry naming an outpoint that holds none, handed A's contract.
  const B = stakeOf();
  const eidB = await seatEntry(B, { txid: a.outpoint.txid, outIdx: a.outpoint.outIdx + 9n }, att);
  await handOver('B, no lock at its outpoint (the lock skipped)', eidB, { ...a.fields, paymentImage: { kind: 'point', bytes: B.point }, refundPk: refundKeyOf(B.player) });

  // MUTANT 2: a lock to a key nobody attested.
  const C = stakeOf();
  const rogue = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
  const lockC = await lc.lock(toHex(C.point), String(net), toHex(rogue), toHex(refundKeyOf(C.player)), 150);
  const cc = lockFromClient(lockC, { point: C.point, claimPk: rogue, refundPk: refundKeyOf(C.player) });
  const eidC = await seatEntry(C, cc.outpoint, att);
  await handOver('C, locked to an unattested key', eidC, cc.fields);
} catch (e) {
  say({ error: e.message });
  process.exitCode = 1;
} finally { for (const d of seats) await d.close(); }
// THE WASM CLIENT'S GUARDIAN WEBSOCKETS KEEP NODE'S EVENT LOOP ALIVE after the
// last step - measured: every step done, the process still up 9 minutes later,
// its lines held in the pipe. So it ends here, with what it measured.
process.exit(process.exitCode || 0);
