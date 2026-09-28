// A PAYING FEDERATION ROUND ON TWO SIGNER NODES AND A FAKE LOCK PORT, PLAYED TO ITS CLOSE (moved out of
// lock-settlement.test.js so the winnings test drives the very same round): `lockRound` stands it, `lockAndPlay`
// locks a player's stake and fee and plays their run, `closeRound`, `standing` and `untilSettled` watch it settle.
import { CLOCK } from './block-clock.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeAssigned } from './assignment.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { askerOrder } from '../src/payout.js';
import { testInvoice } from './bolt11-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

// A WINNER NAMES A LIGHTNING ADDRESS (ruled 2026-09-23: only a qualifier who named one is paid; the others' shares
// are pooled over those who did). `lnurl` is that address: it answers LUD-16/LUD-06 with real-format invoices whose
// preimages it hands the fake port's gateway - or lies about the amount or the description hash, when told to.
export const ADDRESS = 'winner@pay.example';
export const METADATA = JSON.stringify([['text/plain', 'a BLWP winning']]);
export function lnurl(port, { lieAmount = false, lieHash = false } = {}) {
  const issued = [];
  const fetchLike = async (url) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/.well-known/lnurlp/'))
      return { json: async () => ({ tag: 'payRequest', callback: `https://${u.host}/cb`, metadata: METADATA, minSendable: 1000, maxSendable: 100000000000 }) };
    if (u.pathname === '/cb') {
      const amountMsat = BigInt(u.searchParams.get('amount'));
      const preimage = new Uint8Array(32).map(() => Math.floor(Math.random() * 256));
      const paymentHash = sha256(preimage);
      const invoice = testInvoice({ amountMsat: lieAmount ? amountMsat + 1n : amountMsat, paymentHash,
        descriptionHash: lieHash ? sha256(new TextEncoder().encode('another metadata')) : sha256(new TextEncoder().encode(METADATA)) });
      port.preimages.set(toHex(paymentHash), preimage);
      issued.push({ host: u.host, amountMsat, paymentHash: toHex(paymentHash), invoice });
      return { json: async () => ({ pr: invoice, routes: [] }) };
    }
    throw new Error(`no such LNURL path ${u.pathname}`);
  };
  return { fetchLike, issued };
}

/** The address, signed by the entry's session key, POSTed to every signer node in `daemons`. */
export async function nameAddress(daemons, played, address = ADDRESS) {
  const signed = new TextEncoder().encode(address);
  const sig = ed25519.sign(signed, played.session);
  for (const d of daemons) {
    const r = await fetch(`http://127.0.0.1:${d.port}/payout-address?entry=${toHex(played.eid)}`,
      { method: 'POST', body: Buffer.concat([Buffer.from(signed), Buffer.from(sig)]) });
    assert.equal(r.status, 201, await r.text());
  }
}

export const curve = { ...feldmanGroup, tweakPoint };

export async function lockRound({ minScore = 1, stakeMsat = STAKE, port = lockPort(), serveOpts = {} } = {}) {
  const address = lnurl(port);
  // A CHAIN THAT BONDS THE ROUND'S TWO SIGNER NODES (RULED 2026-09-25: a paying round opens only on a node that reads the
  // chain). Both signer nodes are running daemons, so the round's claim key is their own live DKG, as before.
  const slot = bondedChainSlot(port);
  const mk = () => serve(openStore(':memory:'), { port: 0, ...opts, stakeLocks: slot.port, poolCurve: curve, finality: { everyMs: 100 },
    chainFor: slot.chainFor, randomnessFor: slot.randomnessFor, lnurlFetch: address.fetchLike, ...serveOpts });
  // THE CHAIN §13A'S WINDOWS ARE READ FROM (RULED 2026-09-24): one block clock both signer nodes read.
  const a = await mk(); a.round.chainView = CLOCK.chainView();
  const b = await mk(); b.round.chainView = CLOCK.chainView();
  for (const [d, o] of [[a, b], [b, a]]) {
    const there = [`http://127.0.0.1:${o.port}`];
    d.verifier.peers = there;
   
    d.stakeSecrets.peers = there;
    d.dkg.peers = there;
  }
  const drafted = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, minScore, stakeMsat };
  // ONLY THE TWO FIELDS THE CHAIN DICTATES (RULED 2026-09-25): the census root its bonds derive to, and a committee time
  // among its blocks. The round id follows from them.
  const bonded = bondedChainFor(drafted.nodes, drafted, slot, { endpoints: [a, b].map((d) => `ws://127.0.0.1:${d.port}`) });
  const c = { ...drafted, censusRoot: bonded.censusRoot, committeeTimeMs: bonded.committeeTimeMs };
  const rid = roundId(c);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  const held = a.dkg.signerNodeFor(c.nodes);
  assert.equal(held.ok, true, held.why);
  // THE ROUND'S OWN BEACON (RULED 2026-09-25): the block of the bonded chain the node replays from - the players seed their
  // marks from the same one, not from the fixtures' constant RANDOMNESS.
  const beacon = slot.randomnessFor({ contract: c });
  assert.ok(beacon && beacon.hash, 'the bonded chain names no beacon for the round');
  console.log(`  BEACON (lockRound): ${toHex(beacon.hash)} at ${beacon.height}`);
  return { a, b, c, rid, port, slot, lnurl: address, claimPk: held.pool.groupPublicKey, randomness: beacon.hash,
    close: async () => { await a.close(); await b.close(); } };
}

// `feeLock` DEFAULTS TO TRUE (2026-09-21): on a federation that charges no base fee this round's gate mints
// fee locks at every size measured, so an entry that brings none is refused at the door - which is pick (a)
// working, not a failure. A test that is ABOUT that refusal builds its own entry below.
// `address`: the entry names the fixture's Lightning address at every signer node once it has played.
export async function lockAndPlay(w, who, { feeLock = true, feeFirst = false, address = false } = {}) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  // PICK A: the fee locked to H(F), F handed over openly in the entry (F5).
  const feeSecret = feeLock ? rand(32) : new Uint8Array(32);
  const feeOutpoint = feeLock ? { txid: rand(32), outIdx: 1n } : { txid: new Uint8Array(32), outIdx: 0n };
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: w.c.stakeMsat, feeMsat: entryFeeMsat(w.c.stakeMsat), donationMsat: 0n,
    joinTick: 0, worldSecret: who.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint,
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  const feeFields = feeLock ? { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat, claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 } : null;
  if (feeLock) await w.port.put(feeOutpoint, feeFields);
  const input = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: who.ticks }, (_, t) => wordsAt(t)), liquidations: [] };
  const st = init(seedWordForEntry(entry, w.randomness || RANDOMNESS));
  for (let t = 0; t < who.ticks; t++) step(st, ...wordsAt(t));
  const mark = { roundId: w.rid, entryId: eid, tick: who.ticks,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
    // PICK (a): THE STAKE COUNTS WHICHEVER LOCK COMES LAST - the fee lock may be handed first.
    const handFee = async () => {
      const fee = await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      assert.equal(fee.status, 201, await fee.text());
    };
    if (feeLock && feeFirst) {
      await handFee();
      assert.equal(d.round.stakeSeen(eid), null, 'a stake counted on its fee lock alone, before its stake lock');
    }
    const locked = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
    assert.equal(locked.status, 201, await locked.text());
    if (feeLock && !feeFirst) await handFee();
    assert.equal(await say(d.port, encodeInputBatch(input)), String(who.ticks));
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
  }
  const played = { eid, entry, fields, outpoint, feeOutpoint, session };
  if (address) await nameAddress([w.a, w.b], played, address === true ? ADDRESS : address);
  return played;
}

// THE SIGNER NODE THAT COMBINES AND SUBMITS: the round's asker, seat 0 of M3.3-19's order (the keys sorted, rotated by
// an index from the round id). Its row says what the settlement moved; the others say they found it in the federation.
export const proposerOf = (w) => {
  const nodes = [w.a, w.b].sort((x, y) => (toHex(x.round.pubkey) < toHex(y.round.pubkey) ? -1 : 1));
  const first = askerOrder(w.rid, nodes.map((d) => d.round.pubkey)).order[0];
  return nodes.find((d) => toHex(d.round.pubkey) === toHex(first));
};
export const standing = async (d, w) => (await fetch(`http://127.0.0.1:${d.port}/lock-settlement?round=${toHex(w.rid)}`)).json();
export const closeRound = (w) => Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);

export async function untilSettled(w, ms = 30000) {
  let got;
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(250)) {
    got = await standing(w.a, w);
    if (got.state === 'ACCEPTED') return got;
  }
  return got;
}
