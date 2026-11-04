// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STARTED BOND LEAVES ITS HOLD BY A RELEASE OR A FALLBACK, AND ITS CARRIERS PAY (spec 5A.3B, kanban #972, decision #1083). Real keys, real BIP-341 sighashes and real hold outputs: the
// signers sign bytes they built themselves, so a stub would measure nothing. Bitcoin's own answer is the regtest harness's (tools/slash-release-regtest.mjs); here, what every
// signer builds and whether the bytes agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { holdOutputKey, panelThreshold, slashStartLeaf, tapLeafHash } from '../../arena-protocol/src/bond-script.js';
import { arbitrationCommitment, arbitrationCommitmentIn } from '../../arena-protocol/src/arbitration-tx.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { decodeSlashPayoutTable, slashPayoutTableId } from '../../arena-protocol/src/slash.js';
import { carrierPegInId } from '../../arena-protocol/src/census-key.js';
import { carrierSlices, holdSpendDigest, releaseWitness, signedHoldSpend, slashEscrowOutput, slashHoldSpend, startFeeRate, vsizeOfSpend } from '../../arena-protocol/src/slash-release.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint } from '../src/curve.js';
import { createSlashRelease } from '../src/slash-release-run.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const person = (n) => { const secret = taggedHash('ARENA/test/ReleaseRun', Uint8Array.from([n])); return { secret, key: schnorr.getPublicKey(secret), hex: toHex(schnorr.getPublicKey(secret)) }; };
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const clocks = { holdBlocks: 1, returnBlocks: 12, fallbackBlocks: 24 };
const A = [1, 2, 3, 4].map(person), B = [5, 6, 7, 8].map(person);
const panels = { panelA: A.map((p) => p.key), panelB: B.map((p) => p.key) };
const accused = person(40), census = person(41);
const BOND = 1_000_000n, MATURITY = 600, START_HEIGHT = 400, SLASH_HEIGHT = 399;
const hold = holdOutputKey({ ownerKey: accused.key, censusKey: census.key, ...panels, bondMaturity: MATURITY, ...clocks }, { tweakPoint });
const proofBytes = Uint8Array.from([9, 9, 9]);
const proofId = taggedHash('ARENA/v1/SlashProof', proofBytes);
const roundId = b32(0x51);
const bond = { txid: b32(0x71), vout: 1 };
const feeCoin = { txid: b32(0x72), vout: 0, value: 700n, script: fromHex(`5120${'73'.repeat(32)}`) };

// THE START AS A SEAT FILES IT: the bond by its slash leaf, a fee coin, output 0 the whole bond to the round's hold, the proof's OP_RETURN
const startTx = { version: 2, locktime: 0, inputs: [{ txid: bond.txid, vout: bond.vout, sequence: 0xfffffffd }, { txid: feeCoin.txid, vout: 0, sequence: 0xfffffffd }],
  outputs: [{ value: BOND, script: hold.script }, arbitrationCommitment(proofId, SLASH_HEIGHT, new TextEncoder().encode('arena'))] };
const startRaw = serializeSpend({ ...startTx, witnesses: [[new Uint8Array(64), new Uint8Array(65), slashStartLeaf(accused.key, census.key), new Uint8Array(65)], [new Uint8Array(64), new Uint8Array(34), new Uint8Array(33)]] });
const startTxid = parseTransaction(startRaw).txid;
const startHex = toHex([...startTxid].reverse());

const player = person(60), other = person(61);
const fedA = 'fa'.repeat(32), fedB = 'fb'.repeat(32);
const scriptOfKey = (k, fid) => fromHex(`5120${toHex(taggedHash('ARENA/test/PegIn', Uint8Array.from([...fromHex(k), ...fromHex(fid)])))}`);
const reserveKey = (fid) => Uint8Array.from([0x02, ...fromHex(fid)]);
const federations = [{ federation: fedA, status: 'OPEN', reserveKey: toHex(reserveKey(fedA)), reserveSats: '100000', exposureCapSats: '1000000' },
  { federation: fedB, status: 'OPEN', reserveKey: toHex(reserveKey(fedB)), reserveSats: '500000', exposureCapSats: '1000000' }];
const contract = { federationId: fromHex(fedA), slashRemainder: 'SPLIT', minScore: 1, censusHeight: 300 };
const LOSS = 300_000_000n;

test('the start\'s fee rate is its fee over its size, rounded up, never under 1 sat/vB', () => {
  const vsize = vsizeOfSpend({ ...startTx, inputs: startTx.inputs, witnesses: parseTransaction(startRaw).witnesses });
  const rate = startFeeRate({ startRaw, prevouts: [{ value: BOND }, { value: 700n }] });
  assert.equal(rate, (700n + BigInt(vsize) - 1n) / BigInt(vsize));
  assert.equal(startFeeRate({ startRaw, prevouts: [{ value: BOND }, { value: 1n }] }), 1n, 'the floor');
  assert.throws(() => startFeeRate({ startRaw, prevouts: [{ value: BOND }] }), /every input/);
});

const tableInputs = (carriers, over = {}) => ({ networkId: NETWORK_ID_REGTEST, roundId, bond, filer: { script: feeCoin.script, sats: feeCoin.value },
  carriers, federations: federations.map((f) => ({ ...f, script: scriptOfKey(carriers[0] ? carriers[0].key : A[0].hex, f.federation) })), retired: [],
  escrowScript: slashEscrowOutput({ ...panels, censusKey: census.key, fallbackBlocks: clocks.fallbackBlocks }, { tweakPoint }).script,
  entriesFor: (left) => [{ entryId: b32(0x31), playerPubkey: player.key, lossMsat: LOSS < left * 1000n ? LOSS : left * 1000n }], ...over });
const outpoint = { txid: startTxid, vout: 0, value: BOND };
const releaseOf = (carriers, rate = 3n, over = {}) => slashHoldSpend({ path: 'release', hold, outpoint, panels, proofId, slashHeight: SLASH_HEIGHT, rate, clocks, table: tableInputs(carriers, over) });
const carriersOf = (bonds) => A.map((p, i) => ({ key: p.hex, script: scriptOfKey(p.hex, fedA), bondSats: bonds[i] }));

test('a release is the same bytes every time it is built from the same reading, and its fee is its rate times its own size', () => {
  const x = releaseOf(carriersOf([BOND, BOND, BOND, BOND])), y = releaseOf(carriersOf([BOND, BOND, BOND, BOND]));
  assert.ok(x.ok, x.why);
  assert.equal(toHex(x.bytes), toHex(y.bytes), 'byte-equal tables');
  assert.equal(toHex(x.digest), toHex(y.digest), 'one digest');
  const t = x.table;
  assert.equal(t.outputs.reduce((a, o) => a + o.value, 0n) + x.feeSats, BOND, 'outputs + fee = the bond, exactly');
  assert.deepEqual(t.outputs.map((o) => o.pays), ['filer', 'player_carrier', 'reserves', 'reserves'], 'the filer, the player\'s carrier, then the reserves');
  assert.equal(t.outputs[0].value, 700n, 'the filer is repaid its fee input');
  assert.equal(t.outputs[1].value, 300_000n, 'the loss whole, in sats rounded up');
  // THE RESERVES SPREAD BY LOAD: A at 10 %, B at 50 %; A is filled to B's load first, then both together
  const [ra, rb] = t.outputs.slice(2).map((o) => o.value);
  assert.ok(ra > rb, `the lower load takes more: ${ra} and ${rb}`);
  assert.equal(t.reserves.length, 2);
  // EXACTLY t OF EACH PANEL, REAL SIGNATURES: the size the fee was reckoned on is the signed size
  const sigs = new Map([...A.slice(1), ...B.slice(0, 3)].map((p) => [p.hex, schnorr.sign(x.digest, p.secret)]));
  const witness = releaseWitness({ hold, ...panels, signatures: sigs });
  assert.equal(witness.length, 8 + 2, 'one item per panel key, then the leaf and the control block');
  assert.equal(witness.slice(0, 8).filter((w) => w.length === 64).length, 2 * panelThreshold(4), 'exactly t of each');
  const { raw } = signedHoldSpend({ spend: x.spend, witness });
  const parsed = parseTransaction(raw);
  assert.equal(vsizeOfSpend({ ...x.spend.tx, witnesses: parsed.witnesses }), x.vsize);
  assert.equal(x.feeSats, 3n * BigInt(x.vsize));
  const said = arbitrationCommitmentIn([parsed.outputs[0]]);
  assert.equal(toHex(said.proofId), toHex(proofId)); assert.equal(said.slashHeight, SLASH_HEIGHT); assert.equal(toHex(said.hint), toHex(x.tableId), 'its OP_RETURN names the table');
  assert.equal(parsed.inputs[0].sequence, clocks.holdBlocks);
  assert.throws(() => releaseWitness({ hold, ...panels, signatures: new Map([...sigs].slice(0, 5)) }), /panel B must give/);
});

test('a reading that differs builds other bytes: one more carrier, or another load', () => {
  const x = releaseOf(carriersOf([BOND, BOND, BOND, BOND]));
  const fewer = releaseOf(carriersOf([BOND, BOND, BOND, BOND]).slice(1));
  assert.notEqual(toHex(x.tableId), toHex(fewer.tableId));
  const loads = slashHoldSpend({ path: 'release', hold, outpoint, panels, proofId, slashHeight: SLASH_HEIGHT, rate: 3n, clocks,
    table: { ...tableInputs(carriersOf([BOND, BOND, BOND, BOND])), federations: federations.map((f) => ({ ...f, reserveSats: '0', script: scriptOfKey(A[0].hex, f.federation) })) } });
  assert.notEqual(toHex(x.tableId), toHex(loads.tableId));
});

test('a carrier carries no more than its own bond, and a loss is cut across carriers in score order', () => {
  const x = releaseOf(carriersOf([100_000n, 150_000n, BOND, BOND]));
  assert.ok(x.ok, x.why);
  const slices = carrierSlices(x.table);
  assert.deepEqual(slices.map((c) => c.value), [100_000n, 150_000n, 50_000n]);
  assert.deepEqual(slices.map((c) => c.slices.map((s) => s.msat)), [[100_000_000n], [150_000_000n], [50_000_000n]]);
  assert.ok(slices.every((c) => c.slices.every((s) => toHex(s.playerPubkey) === player.hex)));
});

test('a fallback carries the same OP_RETURN fields and a table of the same format, signed by one key', () => {
  const f = slashHoldSpend({ path: 'fallback', hold, outpoint, proofId, slashHeight: SLASH_HEIGHT, rate: 3n, clocks,
    table: { ...tableInputs(carriersOf([BOND, BOND, BOND, BOND])), escrowScript: slashEscrowOutput({ censusKey: census.key, fallbackBlocks: clocks.fallbackBlocks }, { tweakPoint }).script } });
  assert.ok(f.ok, f.why);
  assert.equal(f.spend.tx.inputs[0].sequence, clocks.fallbackBlocks);
  assert.equal(toHex(f.digest), toHex(holdSpendDigest({ spend: f.spend, hold, path: 'fallback' })));
  assert.ok(f.vsize < releaseOf(carriersOf([BOND, BOND, BOND, BOND])).vsize, 'one signature is smaller than t + t');
  assert.equal(decodeSlashPayoutTable(f.bytes).proofId.length, 32);
  assert.throws(() => slashEscrowOutput({}, { tweakPoint }), /census key/);
});

// ---- THE RUN: eight panel members, each with its own store, reading each other at their doors ----
function world({ lossesOk = true } = {}) {
  const members = [...A, ...B];
  const runs = new Map();
  const sent = [], kept = [], paid = [];
  const urlOf = (k) => `http://seat-${k}`;
  const fetchFn = async (url) => {
    const u = new URL(url); const k = u.host.slice(5);
    const run = runs.get(k);
    const answer = (body, status = 200) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (!run) return answer({ why: 'no such seat' }, 404);
    if (u.pathname === '/slash-release') return answer(run.served(u.searchParams.get('start')));
    if (u.pathname === '/slash-pegin') { try { return answer(await run.ownPegIn(u.searchParams.get('start'), u.searchParams.get('federation'), u.searchParams.get('use') || 'players')); } catch (e) { return answer({ why: e.message }, 409); } }
    return answer({}, 404);
  };
  const entries = [{ pubkey: accused.key, txid: bond.txid, vout: bond.vout, bondSats: String(BOND), script: fromHex(`5120${'74'.repeat(32)}`), hold: { txid: toHex(startTxid), vout: 0, height: START_HEIGHT },
    advert: { bondScriptTemplateVersion: 3, censusKey: census.key, ownerPubkey: accused.key, bondMaturityHeight: MATURITY } },
  ...members.map((p) => ({ pubkey: p.key, txid: b32(1), vout: 0, bondSats: String(BOND), advert: { bondScriptTemplateVersion: 3, censusKey: census.key, ownerPubkey: accused.key, bondMaturityHeight: MATURITY } }))];
  const feeFunding = serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: b32(9), vout: 0, sequence: 0 }], outputs: [{ value: 700n, script: feeCoin.script }], witnesses: [[new Uint8Array(64)]] });
  const rawTx = async (txid) => (txid === startHex ? startRaw : txid === toHex([...feeCoin.txid].reverse()) ? feeFunding : null);
  for (const p of members) {
    let made = 0;
    const port = { peginAddress: async () => `addr-${p.hex}-${made++}`, peginClaim: async () => ({ claimedMsat: 400_000_000n }),
      payouts: async (list) => { paid.push({ carrier: p.hex, list }); return { txid: 'cc'.repeat(32), payouts: list.map((x, i) => ({ refundPk: x.key, outIdx: i, contractId: `c${i}` })) }; } };
    runs.set(p.hex, createSlashRelease({ key: p.key, secret: p.secret, networkId: NETWORK_ID_REGTEST, clocks, db: new DatabaseSync(':memory:'), tweakPoint,
      tipHeight: async () => START_HEIGHT + 1, entriesAtTip: async () => entries, rawTx, unspent: async () => true,
      fetchProof: async () => proofBytes, judge: Object.assign(async () => ({ verdict: true, held: { offence: 'X' } }), { read: () => ({ ok: true, roundId, contract }) }),
      panelsOf: () => ({ ok: true, ...panels }), lossesFor: async () => (lossesOk ? { ok: true, losses: new Map([[player.hex, LOSS]]), entryIds: new Map([[player.hex, b32(0x31)]]) } : { ok: false, why: 'no seat answers' }),
      federations: async () => federations, portFor: async () => port, scriptOf: (address) => fromHex(`5120${toHex(taggedHash('ARENA/test/Address', new TextEncoder().encode(address)))}`),
      reserveKeyOf: async (fid) => reserveKey(fid), keepReserveRow: (row) => kept.push({ carrier: p.hex, row }), urlOf, send: async (hex) => { sent.push({ by: p.hex, hex }); return toHex([...parseTransaction(fromHex(hex)).txid].reverse()); }, fetchFn }));
  }
  return { runs, members, sent, kept, paid };
}

test('eight panel members build one table, read each other\'s signatures, and the release goes out with exactly t of each', async () => {
  const w = world();
  for (const p of w.members) await w.runs.get(p.hex).pass();
  for (const p of w.members) await w.runs.get(p.hex).pass();
  const tables = w.members.map((p) => w.runs.get(p.hex).served(startHex).release.table);
  assert.equal(new Set(tables).size, 1, 'every signer\'s table is byte-equal');
  assert.ok(w.sent.length >= 1, 'a release was sent');
  const tx = parseTransaction(fromHex(w.sent[0].hex));
  assert.equal(new Set(w.sent.map((s) => toHex(parseTransaction(fromHex(s.hex)).txid))).size, 1, 'whoever sends it, one txid');
  const t = decodeSlashPayoutTable(fromHex(tables[0]));
  assert.equal(toHex(arbitrationCommitmentIn([tx.outputs[0]]).hint), toHex(slashPayoutTableId(t)));
  const digest = holdSpendDigest({ spend: { tx: { version: 2, locktime: 0, inputs: [{ txid: startTxid, vout: 0, sequence: clocks.holdBlocks }], outputs: tx.outputs }, prevouts: [{ value: BOND, script: hold.script }] }, hold, path: 'release' });
  const sorted = (keys) => [...keys].sort((x, y) => (toHex(x) < toHex(y) ? -1 : 1));
  const order = [...sorted(panels.panelA), ...sorted(panels.panelB)];
  const stack = tx.witnesses[0].slice(0, 8).reverse();
  const good = stack.map((s, i) => s.length === 64 && verify(s, digest, order[i]));
  assert.equal(good.slice(0, 4).filter(Boolean).length, 3, 'panel A: exactly 3 good signatures');
  assert.equal(good.slice(4).filter(Boolean).length, 3, 'panel B: exactly 3');
  // THE PLAYER'S CARRIER IS PANEL A'S FIRST, BY ITS SIGNED PEG-IN; THE RESERVES' PARTS GO TO THE FIRST WITH A PEG-IN OF THEIR FEDERATION
  const first = A[0].hex;
  assert.equal(t.outputs[1].script.length, 34);
  assert.equal(toHex(t.outputs[1].script), (await w.runs.get(first).ownPegIn(startHex, fedA, 'players')).script, 'the players\' part to panel A\'s first, by its own signed peg-in');
  assert.equal(toHex(t.outputs[2].script), (await w.runs.get(first).ownPegIn(startHex, fedA, 'reserves')).script, 'and a reserves\' part to another address of it');
  // THE CARRIER PAYS: the loss whole to the player's key, the rest of its claim to the reserve key, kept as a reserve row of kind slash
  await w.runs.get(first).carry();
  const pay = w.paid.find((x) => x.carrier === first && x.list.some((y) => y.key === toHex(refundKeyOf(player.key))));
  assert.ok(pay, 'the carrier paid');
  assert.equal(w.paid.filter((x) => x.carrier === first).length, 3, 'three outputs carried: the players\' part and a reserves\' part in each federation');
  const toPlayer = pay.list.find((x) => x.key === toHex(refundKeyOf(player.key)));
  assert.equal(toPlayer.msat, LOSS, 'each real loss to the player\'s key');
  const toReserve = pay.list.find((x) => x.key === toHex(reserveKey(fedA)));
  assert.equal(toReserve.msat, 400_000_000n - 10_000n - LOSS, 'the rest of the claim, less the payout\'s fee margin, to the reserve key');
  assert.ok(w.kept.some((k) => k.carrier === first && k.row.item === 'slash' && k.row.amountMsat === toReserve.msat), 'a reserve row of kind slash');
  // A SECOND CARRIER PASS PAYS NOTHING TWICE
  const before = w.paid.length;
  await w.runs.get(first).carry();
  assert.equal(w.paid.length, before, 'paid once');
});

test('a member that cannot read the losses signs nothing, and a peg-in not signed by its node is not a carrier', async () => {
  const w = world({ lossesOk: false });
  for (const p of w.members) await w.runs.get(p.hex).pass();
  assert.equal(w.sent.length, 0);
  assert.ok(w.members.every((p) => !w.runs.get(p.hex).served(startHex).release));
  const peg = await w.runs.get(A[0].hex).ownPegIn(startHex, fedA);
  assert.ok(verify(fromHex(peg.signature), carrierPegInId(NETWORK_ID_REGTEST, fromHex(peg.script)), A[0].key));
  assert.ok(!verify(fromHex(peg.signature), carrierPegInId(NETWORK_ID_REGTEST, fromHex(peg.script)), A[1].key));
});
