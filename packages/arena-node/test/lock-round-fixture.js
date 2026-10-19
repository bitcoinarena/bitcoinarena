// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAYING FEDERATION ROUND ON TWO SIGNER NODES AND A FAKE LOCK PORT, PLAYED TO ITS CLOSE (moved out of
// lock-settlement.test.js so the winnings test drives the very same round): `lockRound` stands it, `lockAndPlay`
// locks a player's stake and fee and plays their run, `closeRound`, `standing` and `untilSettled` watch it settle.
import { headToHeadCommit } from '../../arena-protocol/src/head-to-head.js';
import { CLOCK } from './block-clock.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeAssigned } from './assignment.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { askerOrder } from '../src/payout.js';
import { testInvoice } from './bolt11-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { resultFinality } from '../src/finality.js';
import { PROVISIONALLY_FINAL } from '../../arena-protocol/src/objection.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, GENESIS_HASH, wordsAt, playFor, warmPlay, contractFor, presentDay, say, secretScalar, opts, wait } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { init, step } from '../../nextblock/src/sim.js';
import { loaded, bedFrom } from './window-fixture.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat, entryFeeBpsOf } from '../../arena-protocol/src/fee.js';
import { pluginForRound } from '../src/plugins.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { HOSTED } from './plugins/hosted.js';
import { splitDonation } from '../../arena-protocol/src/donation.js';
import { donationContractFields } from '../src/stake-lock-signer-node.js';

// A WINNER NAMES A LIGHTNING ADDRESS (ruled 2026-09-23: only a qualifier who named one is paid; the others' shares
// are pooled over those who did). `lnurl` is that address: it answers LUD-16/LUD-06 with real-format invoices whose
// preimages it hands the fake port's gateway - or lies about the amount or the description hash, when told to.
export const ADDRESS = 'winner@pay.example';
export const METADATA = JSON.stringify([['text/plain', 'a BLWP winning']]);
export function lnurl(port, { lieAmount = false, lieHash = false } = {}) {
  const issued = [];
  // `box.donationDown`: the donation recipients do not answer (nothing listening), until a test sets it false
  const box = { issued, donationDown: false };
  const fetchLike = async (url) => {
    const u = new URL(url);
    if (box.donationDown && u.pathname.startsWith('/lnurlp/')) throw new Error(`connect ECONNREFUSED ${u.host}`);
    // AND THE DONATION SET'S RECIPIENTS (a walk-away's 25%, RULED 2026-09-30): their LNURLs name /lnurlp/<name>.
    if (u.pathname.startsWith('/.well-known/lnurlp/') || u.pathname.startsWith('/lnurlp/'))
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
  box.fetchLike = fetchLike;
  return box;
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

// `n`: THE ROUND'S SIGNER NODES - 2 (a 2-of-2), or 7 (5 of 7, receiptsNeeded); `a` and `b` are the first two.
// `round`: fields of the round's contract over the fixture's (another game's id, core, config and run length).
// `alignCloseMs`: the round shifted forward so its entry close lands on that period's grid (a market's own clock);
// `stakeExpiryFor(contract)`: the round's own lock span (lock-expiry.js), from its final times
export async function lockRound({ minScore = 1, stakeMsat = STAKE, port = lockPort(), serveOpts = {}, n = 2, endMs = testNow() + 3000, round = {}, alignCloseMs = null, stakeExpiryFor = null } = {}) {
  const address = lnurl(port);
  // A CHAIN THAT BONDS THE ROUND'S TWO SIGNER NODES (RULED 2026-09-25: a paying round opens only on a node that reads the
  // chain). Both signer nodes are running daemons, so the round's claim key is their own live DKG, as before.
  const slot = bondedChainSlot(port);
  const mk = () => serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, stakeLocks: slot.port, poolCurve: curve, finality: { everyMs: 100 },
    chainFor: slot.chainFor, randomnessFor: slot.randomnessFor, lnurlFetch: address.fetchLike, ...serveOpts });
  // THE CHAIN §13A'S WINDOWS ARE READ FROM (RULED 2026-09-24): one block clock both signer nodes read.
  const nodes = [];
  for (let i = 0; i < n; i++) { const d = await mk(); d.round.chainView = CLOCK.chainView(); nodes.push(d); }
  const [a, b] = nodes;
  for (const d of nodes) {
    const there = nodes.filter((o) => o !== d).map((o) => `http://127.0.0.1:${o.port}`);
    d.verifier.peers = there;
    d.stakeSecrets.peers = there;
    d.dkg.peers = there;
  }
  // THE GAMES THE NODES' ADVERTISEMENTS HOST: the games they were handed
  const hostedGames = (serveOpts.plugins || HOSTED).map((p) => p.gameId);
  return openLockRound({ a, b, nodes, port, slot, lnurl: address, hostedGames, close: async () => { for (const d of nodes) await d.close(); } },
    { minScore, stakeMsat, endMs, round, alignCloseMs, stakeExpiryFor });
}

/**
 * A ROUND OPENED ON SIGNER NODES ALREADY STANDING (a second round on the same two nodes, of another game):
 * `on` is what lockRound stood - its nodes, lock port, chain slot and address - and the round is built, bonded, opened and
 * keyed on them as lockRound's first. Answers the same object lockRound does, for this round.
 */
export async function openLockRound(on, { minScore = 1, stakeMsat = STAKE, endMs = testNow() + 3000, round = {}, alignCloseMs = null, stakeExpiryFor = null } = {}) {
  const { nodes, slot } = on;
  const [a] = nodes;
  const n = nodes.length;
  const first = { ...contractFor(nodes.map((d) => d.round.pubkey), BigInt(WINDOW_MS), nodes.map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, minScore, stakeMsat, ...round };
  // THE ROUND ENDS NOW, NOT IN 1970 (§13A/§13C,: a result counts only if its seat held it before the round's end
  // + 600 s + 5 s). The fixture's rounds were dated in 1970, so every result they held came decades after their window
  // closed - under the deadline every run of them would be VOID. A round ends 3 s after it is built (or at `endMs`); its
  // results are held inside its window, and closeRound skips the fixtures' clock past final_after. `endMs: null`: the old
  // 1970 dates, for a test about a round whose window is long gone.
  let drafted = endMs === null ? first : presentDay(first, endMs);
  if (alignCloseMs) {
    const p = BigInt(alignCloseMs), off = drafted.entryCloseMs % p, shift = off === 0n ? 0n : p - off;
    drafted = { ...drafted, committeeTimeMs: drafted.committeeTimeMs + shift, startTimeMs: drafted.startTimeMs + shift, entryCloseMs: drafted.entryCloseMs + shift };
  }
  if (stakeExpiryFor) drafted = { ...drafted, stakeExpiryBlocks: stakeExpiryFor(drafted) };
  // ONLY THE TWO FIELDS THE CHAIN DICTATES (RULED 2026-09-25): the census root its bonds derive to, and a committee time
  // among its blocks. The round id follows from them.
  const bonded = bondedChainFor(drafted.nodes, drafted, slot, { endpoints: nodes.map((d) => `ws://127.0.0.1:${d.port}`),
    ...(on.hostedGames ? { hostedGames: on.hostedGames } : {}),
    // a round of a later version is seated only on nodes whose advert lists it: the bonded nodes then speak 1 .. that version
    ...(drafted.protocolVersion > 1 ? { protocolVersions: Array.from({ length: drafted.protocolVersion }, (_, i) => i + 1) } : {}) });
  const c = { ...drafted, censusRoot: bonded.censusRoot, committeeTimeMs: bonded.committeeTimeMs };
  const rid = roundId(c);
  for (const d of nodes) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of nodes) await d.dkg.run(c.nodes);
  const held = a.dkg.signerNodeFor(c.nodes);
  assert.equal(held.ok, true, held.why);
  // THE ROUND'S OWN BEACON (RULED 2026-09-25): the block of the bonded chain the node replays from - the players seed their
  // marks from the same one, not from the fixtures' constant RANDOMNESS.
  const beacon = slot.randomnessFor({ contract: c });
  assert.ok(beacon && beacon.hash, 'the bonded chain names no beacon for the round');
  console.log(`  BEACON (lockRound): ${toHex(beacon.hash)} at ${beacon.height}`);
  return { ...on, needed: receiptsNeeded(n), c, rid, claimPk: held.pool.groupPublicKey, randomness: beacon.hash };
}

// `feeLock` DEFAULTS TO TRUE (2026-09-21): on a federation that charges no base fee this round's gate mints
// fee locks at every size measured, so an entry that brings none is refused at the door - which is pick (a)
// working, not a failure. A test that is ABOUT that refusal builds its own entry below.
// `address`: the entry names the fixture's Lightning address at every signer node once it has played.
// `game`: { adapter, config } - the run played by that game's core, not the truck's, with no loads in its batch.
// `donation`: { msat, target } - the entry donates `msat`, split over `target` (one set, or a round's { network, game }; kanban
//) into one payout contract per share above 0 msat, each held by the federation at an outpoint the entry names.
// `pick`: the outcome an entry into an attested round backs (§0A.7a) - such an entry plays no run, so pass noMarks.
// `hidden`: { move, salt } - an entry into a head-to-head round names H(round || session key || move || salt); such
// an entry plays no run either (noMarks), and reveals after entry close (POST /reveal).
// THE ROUND'S GAME'S ENTRY FEE: a market's node fee and donation together (1 % by default, both in the fee lock
// until it resolves), a game's the network's - as the page pays it
const gameFeeBps = (w) => { const f = pluginForRound(w.c, (w.a || w.nodes[0]).round.plugins); return f.ok ? entryFeeBpsOf(f.plugin.manifest) : undefined; };
// `order`: { price (PRICE_SCALE units), expiryMs } - a market order: the entry buys `pick` at that limit
export async function lockAndPlay(w, who, { feeLock = true, feeFirst = false, address = false, noMarks = false, fork = null, staleMarks = 1, game = null, donation = null, pick = undefined, hidden = null, order = null, only = null, expirySpan = null, frontendPk = null } = {}) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  // PICK A: the fee locked to H(F), F handed over openly in the entry (F5).
  const feeSecret = feeLock ? rand(32) : new Uint8Array(32);
  const feeOutpoint = feeLock ? { txid: rand(32), outIdx: 1n } : { txid: new Uint8Array(32), outIdx: 0n };
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: (w.needed || 2) - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    needed: w.needed || 2, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = { txid: rand(32), outIdx: 0n };
  await warmPlay(who, w.randomness);
  const play = playFor(who, w.randomness);
  const entry = {
    roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: w.c.stakeMsat, feeMsat: entryFeeMsat(w.c.stakeMsat, gameFeeBps(w)), donationMsat: donation ? donation.msat : 0n,
    joinTick: 0, worldSecret: play.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint,
    claimKeyAttestationRef: b32(0x9a),
    ...(pick !== undefined ? { pick } : {}),
    ...(order ? { limitPrice: Number(order.price), orderExpiryMs: order.expiryMs ?? 0n } : {}),
    // the website that brought this entry: its payout key, in the entry's signed bytes
    ...(frontendPk ? { frontendPk } : {}),
  };
  if (hidden) entry.commit = headToHeadCommit({ roundId: w.rid, entryKey: entry.sessionPubkey, move: hidden.move, salt: hidden.salt });
  // THE DONATION'S OUTPUTS: one payout contract per share, to its key, for exactly its amount
  const donated = [];
  if (donation && donation.msat > 0n) {
    const split = splitDonation({ donationMsat: donation.msat, recipients: donation.target });
    assert.ok(split.owed, split.why);
    for (const sh of split.shares.filter((x) => x.amountMsat > 0n)) {
      const outpoint = { txid: rand(32), outIdx: 0n };
      await w.port.put(outpoint, donationContractFields({ recipientPk: sh.recipientPk, amountMsat: sh.amountMsat }));
      donated.push({ outpoint, recipientPk: sh.recipientPk, amountMsat: sh.amountMsat });
    }
    entry.donationOutpoints = donated.map((d) => d.outpoint);
  }
  const eid = entryId(entry);
  // THE LOCK SPAN: the round's own when it names more than the ruled 144 (a market's, - as the page locks for
  // round.stakeExpiryBlocks), else the fixture's 200 as before; `expirySpan` a test's own (a lock made at the old 144)
  const span = expirySpan ?? (w.c.stakeExpiryBlocks > 144 ? w.c.stakeExpiryBlocks : 200);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + span };
  await w.port.put(outpoint, fields);
  const feeFields = feeLock ? { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat, claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + span } : null;
  if (feeLock) await w.port.put(feeOutpoint, feeFields);
  const input = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: who.ticks }, (_, t) => play.words(t)), liquidations: [], loads: game ? [] : bedFrom(0) };
  let endHash;
  // A GAME'S RUN IN TWO BATCHES: a first mark at `game.firstMark` (before the round's start deadline - a run
  // that only ends at its run length cannot make its first mark at its end), then the rest and the last mark.
  let gameRun = null;
  if (game) {
    const gs = game.adapter.start(seedWordForEntry(entry, w.randomness || RANDOMNESS), game.config, { runTicks: w.c.blockTicks });
    const first = game.firstMark || 60;
    const hashOf = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));
    for (let t = 0; t < first; t++) game.adapter.step(gs, play.words(t));
    const b1 = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
      ticks: Array.from({ length: first }, (_, t) => play.words(t)), liquidations: [], loads: [] };
    const m1 = { roundId: w.rid, entryId: eid, tick: first, stateHash: hashOf(game.adapter.stateHash(gs)), inputChainHash: batchId(b1),
      previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
    for (let t = first; t < who.ticks; t++) game.adapter.step(gs, play.words(t));
    const b2 = { roundId: w.rid, entryId: eid, previousHash: batchId(b1), firstTick: first,
      ticks: Array.from({ length: who.ticks - first }, (_, t) => play.words(first + t)), liquidations: [], loads: [] };
    const m2 = { roundId: w.rid, entryId: eid, tick: who.ticks, stateHash: hashOf(game.adapter.stateHash(gs)), inputChainHash: batchId(b2),
      previousHash: checkpointId(m1), sessionPubkey: ed25519.getPublicKey(session) };
    const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
    gameRun = { b1, b2, m1: sign(m1), m2: sign(m2), first };
    endHash = game.adapter.stateHash(gs);
  } else {
    const st = loaded(init(seedWordForEntry(entry, w.randomness || RANDOMNESS)));
    for (let t = 0; t < who.ticks; t++) step(st, ...play.words(t));
    endHash = stateHash(st);
  }
  const mark = { roundId: w.rid, entryId: eid, tick: who.ticks,
    stateHash: Uint8Array.from(endHash.match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  for (const d of w.nodes || [w.a, w.b]) {
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
    // `only`: the seats (by index) handed the locks - the others hold the entry and never verify a lock of it
    if (only && !only.includes((w.nodes || [w.a, w.b]).indexOf(d))) continue;
    const locked = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
    assert.equal(locked.status, 201, await locked.text());
    if (feeLock && !feeFirst) await handFee();
    // `noMarks`: seated and staked, and nothing sent - a walk-away (§15 at the door)
    if (noMarks) continue;
    if (fork) continue;                                   // the fork's run goes out below, seat by seat
    if (gameRun) {
      // a later seat may already hold a batch, forwarded by the first (its answer is then 0 new ticks)
      for (const [msg, want] of [[encodeInputBatch(gameRun.b1), String(gameRun.first)], [gameRun.m1, SIGNED_RECEIPT_BYTES],
        [encodeInputBatch(gameRun.b2), String(who.ticks - gameRun.first)], [gameRun.m2, SIGNED_RECEIPT_BYTES]]) {
        const got = await say(d.port, msg);
        if (typeof want === 'number') assert.equal(got.length, want, typeof got === 'string' ? `the mark was refused: ${got}` : undefined);
        else assert.ok(got === want || got === '0', `a batch was answered ${String(got).slice(0, 160)}`);
      }
      continue;
    }
    assert.equal(await say(d.port, encodeInputBatch(input)), String(who.ticks));
    const receipt = await say(d.port, signedMark);
    assert.equal(receipt.length, SIGNED_RECEIPT_BYTES, typeof receipt === 'string' ? `the mark was refused: ${receipt}` : undefined);
  }
  // `fork` (§13B at a later tick): the run in two batches, a first mark at tick 60, and at its end mark X to
  // the first seat and a contradicting mark Y to the second - `fork: 'tick'` Y at the same tick with another state,
  // `fork: 'parent'` Y one tick earlier from the same parent. Both signed by the entry's session key; each seat holds one.
  let forked = null;
  if (fork) {
    const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
    const b1 = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
      ticks: Array.from({ length: 60 }, (_, t) => play.words(t)), liquidations: [], loads: bedFrom(0) };
    const b2 = { roundId: w.rid, entryId: eid, previousHash: batchId(b1), firstTick: 60,
      ticks: Array.from({ length: who.ticks - 60 }, (_, t) => play.words(60 + t)), liquidations: [], loads: [] };
    const s60 = loaded(init(seedWordForEntry(entry, w.randomness || RANDOMNESS)));
    for (let t = 0; t < 60; t++) step(s60, ...play.words(t));
    const hashOf = (x) => Uint8Array.from(stateHash(x).match(/../g).map((v) => parseInt(v, 16)));
    const m1 = { roundId: w.rid, entryId: eid, tick: 60, stateHash: hashOf(s60), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS,
      sessionPubkey: ed25519.getPublicKey(session) };
    const x = { ...mark, inputChainHash: batchId(b2), previousHash: checkpointId(m1) };
    const y = fork === 'parent' ? { ...x, tick: who.ticks - 1, stateHash: sha256(x.stateHash) } : { ...x, stateHash: sha256(x.stateHash) };   // 'tick', 'one-seat'
    // `fork: 'stale'` - A PAGE STUCK ON AN OLD HEAD (measured on testnet4): the head H at the tick before the end,
    // receipted by every seat, then a later mark S naming the OLD parent (the first mark) - refused at every seat, never carried
    let stale = null;
    if (fork === 'stale') {
      const s999 = loaded(init(seedWordForEntry(entry, w.randomness || RANDOMNESS)));
      for (let t = 0; t < who.ticks - 1; t++) step(s999, ...play.words(t));
      const h = { ...x, tick: who.ticks - 1, stateHash: Uint8Array.from(stateHash(s999).match(/../g).map((v) => parseInt(v, 16))) };
      stale = { h, s: { ...x } };                         // S: the run's end, naming m1 - H's parent - not H
    }
    const nodes = w.nodes || [w.a, w.b];
    forked = { x: sign(x), y: sign(y), tick: Math.min(x.tick, y.tick), mode: fork };
    const said = (a) => (a instanceof Uint8Array ? `${a.length} bytes` : String(a).slice(0, 120));
    for (const [i, d] of nodes.entries()) {
      const answers = [];
      answers.push(said(await say(d.port, encodeInputBatch(b1))));
      answers.push(said(await say(d.port, sign(m1))));
      answers.push(said(await say(d.port, encodeInputBatch(b2))));
      // `fork: 'one-seat'`: both marks to the first seat (the second refused there as an equivocation, and kept), X alone to the rest
      if (stale) {
        answers.push(said(await say(d.port, sign(stale.h))));
        (forked.staleAnswers = forked.staleAnswers || []).push(said(await say(d.port, sign(stale.s))));
        // `staleMarks: N` (measured live: 63 refused marks from one stuck page): N - 1 more, each naming the
        // same old parent with another state - every one refused, every one a "second child" on paper
        for (let k = 1; k < staleMarks; k++)
          forked.staleAnswers.push(said(await say(d.port, sign({ ...stale.s, stateHash: sha256(Uint8Array.of(k, ...stale.s.stateHash)) }))));
        continue;
      }
      answers.push(said(await say(d.port, fork === 'one-seat' ? forked.x : (i === 0 ? forked.x : forked.y))));
      if (fork === 'one-seat' && i === 0) forked.refusedAtFirst = said(await say(d.port, forked.y));
      // a later seat may already hold the first batch, forwarded by the first (its answer is then 0 new ticks)
      assert.deepEqual([i > 0 && answers[0] === '0' ? '60' : answers[0], ...answers.slice(1)],
        ['60', `${SIGNED_RECEIPT_BYTES} bytes`, String(who.ticks - 60), `${SIGNED_RECEIPT_BYTES} bytes`],
        `seat ${i} did not take the fork run: ${JSON.stringify(answers)}`);
    }
  }
  // `late`: the run's batch and first mark, for a test that sends them after the start deadline (§15's same door)
  const played = { eid, entry, fields, outpoint, feeOutpoint, session, late: [encodeInputBatch(input), signedMark], forked, donated };
  if (address) await nameAddress(w.nodes || [w.a, w.b], played, address === true ? ADDRESS : address);
  return played;
}

// THE SIGNER NODE THAT COMBINES AND SUBMITS: the round's asker, seat 0 of M3.3-19's order (the keys sorted, rotated by
// an index from the round id). Its row says what the settlement moved; the others say they found it in the federation.
export const proposerOf = (w) => {
  const nodes = [...(w.nodes || [w.a, w.b])].sort((x, y) => (toHex(x.round.pubkey) < toHex(y.round.pubkey) ? -1 : 1));
  const first = askerOrder(w.rid, nodes.map((d) => d.round.pubkey)).order[0];
  return nodes.find((d) => toHex(d.round.pubkey) === toHex(first));
};
export const standing = async (d, w) => (await fetch(`http://127.0.0.1:${d.port}/lock-settlement?round=${toHex(w.rid)}`)).json();
// CLOSE, AND - THE REPLAYS DONE, EVERY RESULT HELD INSIDE THE WINDOW - SKIP THE FIXTURES' CLOCK PAST final_after (the round's
// end + 600 s + 5 s), where a seat decides the window and may sign FINAL. `window: false` stays inside the window.
export async function closeRound(w, { window = true } = {}) {
  const nodes = w.nodes || [w.a, w.b];
  const said = await Promise.all(nodes.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
  for (const d of nodes) for (const p of d.verifier.done || []) { try { await p; } catch { /* a close that failed says so itself */ } }
  // AND EVERY AGREED RUN PUBLISHED AT EVERY SEAT, as a live seat does seconds after its result - inside the window (§13A:
  // a posting counts only if its seat held it before final_after). Up to 30 s; a run that never agrees is not waited for.
  // IN LIVE ORDER: the round's end first (the §15 door decides its walk-aways by then, and signs them), every entry decided
  // inside the window - agreed and published, or void at the door - and only then past final_after.
  if (window) {
    const win = windowsOf(w.c);
    skipTo(Number(win.openMs) + 1000);
    const ready = () => nodes.every((d) => d.round.entriesOf(w.rid).every(({ entryId }) => {
      if (d.round.entryVoid(entryId) || d.round.noQuorum(entryId)) return true;
      const f = resultFinality(d.round, w.rid, entryId);
      return f.state === PROVISIONALLY_FINAL && f.published === true;
    }));
    for (const stop = Date.now() + 30000; Date.now() < stop && !ready(); await wait(100));
    skipTo(Number(win.finalAfterMs) + 50);
  }
  return said;
}

export async function untilSettled(w, ms = 30000) {
  let got;
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(250)) {
    got = await standing(w.a, w);
    if (got.state === 'ACCEPTED') return got;
  }
  return got;
}
