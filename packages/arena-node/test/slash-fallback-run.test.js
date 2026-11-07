// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FALLBACK'S FROST GATHERING (spec 5A.3B, kanban #972, decision #1083): the census key's holders, each with its own store, its own run and its own signer, ask each
// other at their doors (POST /census-sign/commit kind fallback, then /census-sign/share). A real key, dealt as a polynomial of degree 3 (threshold 4, shares x 1..8), real
// FROST shares and a real BIP-340 sighash of the hold's fallback leaf: what comes out is either one signature of the key over the bytes every holder built, or nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { holdOutputKey, slashStartLeaf } from '../../arena-protocol/src/bond-script.js';
import { arbitrationCommitment, arbitrationCommitmentIn } from '../../arena-protocol/src/arbitration-tx.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { decodeSlashPayoutTable, slashPayoutTableId } from '../../arena-protocol/src/slash.js';
import { holdSpendDigest } from '../../arena-protocol/src/slash-release.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { CARRIER_PAYOUT_MARGIN_MSAT } from '../../arena-protocol/src/genesis.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint } from '../src/curve.js';
import { createCensusSigner } from '../src/census-sign.js';
import { censusKeyWork } from '../src/census-key-work.js';
import { createSlashRelease } from '../src/slash-release-run.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const toScalar = (b) => BigInt(`0x${toHex(b)}`) % N;
const tag = (n) => taggedHash('ARENA/test/FallbackRun', Uint8Array.of(n));
// THE CENSUS KEY: a polynomial of degree 3 under an even key, so 4 shares sign
const THRESHOLD = 4;
const dealt = (() => {
  let a0 = toScalar(tag(1));
  if (secp256k1.getPublicKey(tag(1), true)[0] === 3) a0 = N - a0;
  const co = [a0, toScalar(tag(2)), toScalar(tag(3)), toScalar(tag(4))];
  return { publicKey: schnorr.getPublicKey(tag(1)), share: (x) => co.reduce((sum, c, i) => (sum + c * BigInt(x) ** BigInt(i)) % N, 0n) };
})();
const census = { key: dealt.publicKey, hex: toHex(dealt.publicKey) };
const person = (n) => { const secret = tag(100 + n); return { secret, key: schnorr.getPublicKey(secret), hex: toHex(schnorr.getPublicKey(secret)) }; };
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);

const clocks = { holdBlocks: 1, returnBlocks: 36, fallbackBlocks: 24 };
const A = [1, 2, 3, 4].map(person), B = [5, 6, 7, 8].map(person);
const panels = { panelA: A.map((p) => p.key), panelB: B.map((p) => p.key) };
// THE HOLDERS: the accused and a seat of the round hold the most shares, so a carrier list that did not leave them out would start with them
const accused = person(40), seat = person(41);
const others = [person(50), person(51), person(52), person(53)];
const LAYOUT = [[accused, [1, 2]], [seat, [3, 4]], [others[0], [5]], [others[1], [6]], [others[2], [7]], [others[3], [8]]];
const BOND = 1_000_000n, MATURITY = 600, START_HEIGHT = 400, SLASH_HEIGHT = 399;
const hold = holdOutputKey({ ownerKey: accused.key, censusKey: census.key, ...panels, bondMaturity: MATURITY, ...clocks }, { tweakPoint });
const proofBytes = Uint8Array.from([7, 7, 7]);
const proofId = taggedHash('ARENA/v1/SlashProof', proofBytes);
const roundId = b32(0x52);
const bond = { txid: b32(0x81), vout: 1 };
const feeCoin = { txid: b32(0x82), vout: 0, value: 700n, script: fromHex(`5120${'83'.repeat(32)}`) };
const startTx = { version: 2, locktime: 0, inputs: [{ txid: bond.txid, vout: bond.vout, sequence: 0xfffffffd }, { txid: feeCoin.txid, vout: 0, sequence: 0xfffffffd }],
  outputs: [{ value: BOND, script: hold.script }, arbitrationCommitment(proofId, SLASH_HEIGHT, new TextEncoder().encode('arena'))] };
const startRaw = serializeSpend({ ...startTx, witnesses: [[new Uint8Array(64), new Uint8Array(65), slashStartLeaf(accused.key, census.key), new Uint8Array(65)], [new Uint8Array(64), new Uint8Array(34), new Uint8Array(33)]] });
const startTxid = parseTransaction(startRaw).txid;
const startHex = toHex([...startTxid].reverse());
const feeFunding = serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: b32(9), vout: 0, sequence: 0 }], outputs: [{ value: 700n, script: feeCoin.script }], witnesses: [[new Uint8Array(64)]] });

const player = person(60);
const fedA = 'fa'.repeat(32), fedB = 'fb'.repeat(32);
const reserveKey = (fid) => Uint8Array.from([0x02, ...fromHex(fid)]);
const federations = [{ federation: fedA, status: 'OPEN', reserveKey: toHex(reserveKey(fedA)), reserveSats: '100000', exposureCapSats: '1000000' },
  { federation: fedB, status: 'OPEN', reserveKey: toHex(reserveKey(fedB)), reserveSats: '500000', exposureCapSats: '1000000' }];
const contract = { federationId: fromHex(fedA), slashRemainder: 'SPLIT', minScore: 1, censusHeight: 300 };
const LOSS = 300_000_000n;
const advert = { bondScriptTemplateVersion: 3, censusKey: census.key, ownerPubkey: accused.key, bondMaturityHeight: MATURITY };
const entries = [{ pubkey: accused.key, txid: bond.txid, vout: bond.vout, bondSats: String(BOND), script: fromHex(`5120${'84'.repeat(32)}`), hold: { txid: toHex(startTxid), vout: 0, height: START_HEIGHT }, advert },
  ...[seat, ...others, ...A, ...B].map((p, i) => ({ pubkey: p.key, txid: b32(10 + i), vout: 0, bondSats: String(BOND), advert }))];

/**
 * The holders of `LAYOUT`, each a seat of its own: its run (createSlashRelease) and its census signer, which hands a `kind: fallback` ask to that run's checkFallback, as
 * slash-start-run.js does. `down` answers nothing at its door; `deviant` reads the player's loss otherwise, so it builds another table (the loads no longer would: a fallback
 * opens past the reserve key's cap, so its reserves' part is all in the escrow, kanban #1130).
 */
function world({ down = [], deviant = [], tip = START_HEIGHT + clocks.fallbackBlocks - 1 } = {}) {
  const urlOf = (k) => `http://seat-${k}`;
  const seats = new Map(), sent = [], dbs = new Map();
  const holders = LAYOUT.map(([p, xs]) => ({ key: p.hex, shares: xs.length }));
  const answer = (body, status = 200) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url), k = u.host.slice(5);
    if (down.includes(k)) throw new Error('connect ECONNREFUSED');
    const s = seats.get(k);
    if (!s) return answer({ why: 'no such seat' }, 404);
    if (u.pathname === '/census-sign/commit') return answer(await s.signer.takeCommit(JSON.parse(init.body)));
    if (u.pathname === '/census-sign/share') return answer(await s.signer.takeShare(JSON.parse(init.body)));
    if (u.pathname === '/slash-release') return answer(s.run.served(u.searchParams.get('start')));
    if (u.pathname === '/slash-pegin') { try { return answer(await s.run.ownPegIn(u.searchParams.get('start'), u.searchParams.get('federation'), u.searchParams.get('use') || 'players')); } catch (e) { return answer({ why: e.message }, 409); } }
    return answer({}, 404);
  };
  const rawTx = async (txid) => (txid === startHex ? startRaw : txid === toHex([...feeCoin.txid].reverse()) ? feeFunding : null);
  // ONE CHAIN: the first send of a txid is taken, any later one is refused as bitcoind refuses it
  const send = (by) => async (hex) => {
    const txid = toHex([...parseTransaction(fromHex(hex)).txid].reverse());
    if (sent.some((x) => x.txid === txid)) throw new Error('txn-already-in-mempool');
    sent.push({ by, hex, txid });
    return txid;
  };
  for (const [p, xs] of LAYOUT) {
    const shares = { shares: new Map(xs.map((x) => [x, dealt.share(x)])) };
    const db = new DatabaseSync(':memory:');
    dbs.set(p.hex, db);
    let made = 0;
    const port = { peginAddress: async () => `addr-${p.hex}-${made++}` };
    const s = {};
    s.run = createSlashRelease({ key: p.key, secret: p.secret, networkId: NETWORK_ID_REGTEST, clocks, db, tweakPoint, tipHeight: async () => tip, entriesAtTip: async () => entries, rawTx,
      unspent: async () => true, fetchProof: async () => proofBytes, judge: Object.assign(async () => ({ verdict: true, held: { offence: 'X' } }), { read: () => ({ ok: true, roundId, contract }) }),
      panelsOf: () => ({ ok: true, ...panels }), seatsOf: async () => [seat.hex],
      lossesFor: async () => ({ ok: true, losses: new Map([[player.hex, deviant.includes(p.hex) ? LOSS - 1000n : LOSS]]), entryIds: new Map([[player.hex, b32(0x31)]]) }),
      federations: async () => (deviant.includes(p.hex) ? federations.map((f) => ({ ...f, reserveSats: '0' })) : federations), portFor: async () => port,
      scriptOf: (address) => fromHex(`5120${toHex(taggedHash('ARENA/test/Address', new TextEncoder().encode(address)))}`), reserveKeyOf: async (fid) => reserveKey(fid), urlOf,
      heldKey: (k) => (toHex(k) === census.hex ? shares : null), thresholdOf: (k) => (k === census.hex ? THRESHOLD : null), holdersOf: async (k) => (k === census.hex ? holders : []),
      signer: () => s.signer, send: send(p.hex), stepMs: 0, fetchFn });
    s.signer = createCensusSigner({ key: p.key, work: censusKeyWork, held: (k) => (toHex(k) === census.hex ? shares : null), rosterOf: () => ({ total: 8, threshold: THRESHOLD }),
      check: (request) => (request && request.kind === 'fallback' ? s.run.checkFallback(request) : { ok: false, why: 'this test signs only fallbacks' }) });
    seats.set(p.hex, s);
  }
  const passOf = async (p) => (await seats.get(p.hex).run.pass()).find((x) => x.path === 'fallback');
  return { seats, sent, dbs, passOf };
}

/** The fallback a holder sent, checked as Bitcoin checks it: one signature of the census key on the fallback leaf's sighash, the start's output 0 its only input. */
function checkSent(raw) {
  const tx = parseTransaction(fromHex(raw));
  assert.equal(tx.inputs.length, 1);
  assert.equal(toHex(tx.inputs[0].previousTxid), toHex(startTxid));
  assert.equal(tx.inputs[0].previousVout, 0);
  assert.equal(tx.inputs[0].sequence, clocks.fallbackBlocks, 'it waits slash_fallback_blocks');
  const [sig, leaf, control] = tx.witnesses[0];
  assert.equal(tx.witnesses[0].length, 3, 'one signature, the leaf, its control block');
  assert.equal(toHex(leaf), toHex(hold.scripts.fallback));
  const digest = holdSpendDigest({ spend: { tx: { version: tx.version, locktime: tx.locktime, inputs: [{ txid: startTxid, vout: 0, sequence: clocks.fallbackBlocks }], outputs: tx.outputs }, prevouts: [{ value: BOND, script: hold.script }] }, hold, path: 'fallback' });
  assert.ok(verify(sig, digest, census.key), 'a BIP-340 signature of the census key over the fallback\'s own sighash');
  assert.equal(control.length, 33 + 32 * (hold.leaves.release ? 2 : 1));
  return tx;
}

test('every holder answers: one fallback goes out, signed by the key over the table every holder built, and neither the accused nor a seat of the round carries', async () => {
  const w = world();
  const first = await w.passOf(others[0]);
  assert.ok(first && first.ok, first && first.why);
  assert.ok(first.shares >= THRESHOLD);
  assert.equal(w.sent.length, 1);
  const tx = checkSent(w.sent[0].hex);
  // THE REST FILE TOO, IN THIS TEST'S TURN OF 0 MS: the same txid, refused by the chain as known, and taken as sent
  for (const p of [accused, seat, ...others.slice(1)]) { const r = await w.passOf(p); assert.ok(r.ok, r.why); assert.equal(r.txid, first.txid); }
  assert.equal(w.sent.length, 1, 'one transaction on the chain');
  const tables = LAYOUT.map(([p]) => w.seats.get(p.hex).run.served(startHex).fallback.table);
  assert.equal(new Set(tables).size, 1, 'every holder\'s table is byte-equal');
  const t = decodeSlashPayoutTable(fromHex(tables[0]));
  assert.equal(toHex(arbitrationCommitmentIn([tx.outputs[0]]).hint), toHex(slashPayoutTableId(t)), 'its OP_RETURN names that table');
  assert.equal(toHex(arbitrationCommitmentIn([tx.outputs[0]]).proofId), toHex(proofId));
  assert.deepEqual(tx.outputs.slice(1).map((o) => [o.value, toHex(o.script)]), t.outputs.map((o) => [o.value, toHex(o.script)]), 'it pays its table, in order');
  // THE CARRIERS: the holders less the accused and the round's seats. Those two were never asked for a peg-in, and no output pays a script of theirs
  for (const p of [accused, seat]) assert.equal(w.dbs.get(p.hex).prepare('SELECT COUNT(*) AS n FROM slash_pegins').get().n, 0, `${p === accused ? 'the accused' : 'the seat'} made no peg-in`);
  const pegScripts = new Map(others.map((p) => [p.hex, w.dbs.get(p.hex).prepare('SELECT script FROM slash_pegins WHERE start = ?').all(startHex).map((r) => toHex(new Uint8Array(r.script)))]));
  const carried = t.outputs.filter((o) => o.pays === 'player_carrier' || o.pays === 'reserves');
  assert.ok(carried.length >= 1);
  for (const o of carried) assert.ok([...pegScripts.values()].some((list) => list.includes(toHex(o.script))), 'each carried output pays a peg-in of a holder that is no seat of the round');
  // THE PLAYERS' PART GOES TO THE FIRST OF THEM: equal shares, so by key
  const firstCarrier = [...others].sort((a, b) => (a.hex < b.hex ? -1 : 1))[0];
  const players = t.outputs.find((o) => o.pays === 'player_carrier');
  assert.equal(toHex(players.script), (await w.seats.get(firstCarrier.hex).run.ownPegIn(startHex, fedA, 'players')).script);
  assert.equal(players.value * 1000n, LOSS + CARRIER_PAYOUT_MARGIN_MSAT.regtest, 'the loss plus the carrier margin the fallback\'s table names too (kanban #1086)');
  assert.deepEqual([t.marginMsat, t.marginOff], [CARRIER_PAYOUT_MARGIN_MSAT.regtest, 'reserves']);
});

test('exactly t shares answer (the accused and the seat down): the fallback goes out with the four of them', async () => {
  const w = world({ down: [accused.hex, seat.hex] });
  const r = await w.passOf(others[2]);
  assert.ok(r.ok, r.why);
  assert.equal(r.shares, THRESHOLD);
  assert.deepEqual([...r.signers].sort(), others.map((p) => p.hex).sort());
  assert.equal(w.sent.length, 1);
  checkSent(w.sent[0].hex);
});

test('a holder whose own table differs signs nothing: asked, it refuses by its table id, and filing itself, it gathers no one', async () => {
  const deviant = others[0];
  const w = world({ deviant: [deviant.hex] });
  // IT FILES FIRST: its request names its own table, which no other holder built; its own one share is all it has
  const own = await w.passOf(deviant);
  assert.equal(own.ok, false);
  assert.equal(own.why, `1 of the ${THRESHOLD} shares of that key answered`);
  assert.equal(own.refused.length, LAYOUT.length - 1, 'every other holder refused');
  assert.ok(own.refused.every((x) => /^this seat's own table is /.test(x.why)), own.refused.map((x) => x.why).join('; '));
  assert.equal(w.sent.length, 0);
  // ANOTHER FILES: the deviant refuses by its table id, and the other seven shares sign
  const filed = await w.passOf(others[1]);
  assert.ok(filed.ok, filed.why);
  assert.ok(!filed.signers.includes(deviant.hex), 'its share is not in the signature');
  const mine = w.seats.get(deviant.hex).run.served(startHex);
  const request = { kind: 'fallback', start: startHex, proof: toHex(proofBytes), tableId: w.seats.get(others[1].hex).run.served(startHex).fallback.tableId };
  assert.notEqual(mine.fallback.tableId, request.tableId, 'two readings, two tables');
  const asked = await w.seats.get(deviant.hex).signer.takeCommit(request);
  assert.equal(asked.ok, false);
  assert.equal(asked.why, `this seat's own table is ${mine.fallback.tableId.slice(0, 16)}, not ${request.tableId.slice(0, 16)}`);
  assert.equal(w.sent.length, 1, 'the fallback went out without it');
  const tx = checkSent(w.sent[0].hex);
  assert.equal(toHex(arbitrationCommitmentIn([tx.outputs[0]]).hint), request.tableId, 'under the majority\'s table');
});

test('fewer than t shares answer: no spend, and a holder asked before the clock has run refuses', async () => {
  const w = world({ down: [accused.hex, seat.hex, others[3].hex] });
  for (const p of others.slice(0, 3)) {
    const r = await w.passOf(p);
    assert.equal(r.ok, false);
    assert.equal(r.why, `3 of the ${THRESHOLD} shares of that key answered`);
  }
  assert.equal(w.sent.length, 0, 'nothing sent');
  const early = world({ tip: START_HEIGHT + clocks.fallbackBlocks - 2 });
  assert.deepEqual(await early.passOf(others[0]), undefined, 'a holder files nothing before the fallback opens');
  const said = await early.seats.get(others[1].hex).signer.takeCommit({ kind: 'fallback', start: startHex, proof: toHex(proofBytes), tableId: '00'.repeat(32) });
  assert.equal(said.why, 'that hold\'s fallback has not opened yet');
});
