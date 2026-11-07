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
import { carrierMarginOf } from '../../arena-protocol/src/slash-presig.js';
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
const clocks = { holdBlocks: 1, returnBlocks: 36, fallbackBlocks: 24 };
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
function world({ lossesOk = true, federationsOf = async () => federations, tip = () => START_HEIGHT + 1, cut = () => false, serve = (k, body) => body, handles = undefined, logs = null,
  portOf = null, hang = () => false } = {}) {
  let lossReads = 0;
  const members = [...A, ...B];
  const runs = new Map();
  const sent = [], kept = [], paid = [];
  const urlOf = (k) => `http://seat-${k}`;
  // `cut(from, to, path)`: that seat's door does not answer that asker (a timeout, as on the #972 run); `serve(k, body)` what seat k's /slash-release says
  const fetchOf = (from) => async (url) => {
    const u = new URL(url); const k = u.host.slice(5);
    if (cut(from, k, u.pathname)) throw new Error('The operation was aborted due to timeout');
    const run = runs.get(k);
    const answer = (body, status = 200) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (!run) return answer({ why: 'no such seat' }, 404);
    if (u.pathname === '/slash-release') return answer(serve(k, JSON.parse(JSON.stringify(run.served(u.searchParams.get('start'))))));
    if (u.pathname === '/slash-pegin') { try { return answer(await run.ownPegIn(u.searchParams.get('start'), u.searchParams.get('federation'), u.searchParams.get('use') || 'players')); } catch (e) { return answer({ why: e.message }, 409); } }
    return answer({}, 404);
  };
  const entries = [{ pubkey: accused.key, txid: bond.txid, vout: bond.vout, bondSats: String(BOND), script: fromHex(`5120${'74'.repeat(32)}`), hold: { txid: toHex(startTxid), vout: 0, height: START_HEIGHT },
    advert: { bondScriptTemplateVersion: 3, censusKey: census.key, ownerPubkey: accused.key, bondMaturityHeight: MATURITY } },
  ...members.map((p) => ({ pubkey: p.key, txid: b32(1), vout: 0, bondSats: String(BOND), advert: { bondScriptTemplateVersion: 3, censusKey: census.key, ownerPubkey: accused.key, bondMaturityHeight: MATURITY } }))];
  const feeFunding = serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: b32(9), vout: 0, sequence: 0 }], outputs: [{ value: 700n, script: feeCoin.script }], witnesses: [[new Uint8Array(64)]] });
  const rawTx = async (txid) => (txid === startHex ? startRaw : txid === toHex([...feeCoin.txid].reverse()) ? feeFunding : null);
  // EACH SEAT'S STORE OUTLIVES ITS RUN: `restart(k)` makes seat k's run again on the same store, as a stopped seat comes back (kanban #1192)
  const dbs = new Map(members.map((p) => [p.hex, new DatabaseSync(':memory:')]));
  const make = (p) => {
    let made = 0;
    const port = { peginAddress: async () => `addr-${p.hex}-${made++}`, peginClaim: async () => ({ claimedMsat: 400_000_000n }),
      payouts: async (list) => { paid.push({ carrier: p.hex, list }); return { txid: 'cc'.repeat(32), payouts: list.map((x, i) => ({ refundPk: x.key, outIdx: i, contractId: `c${i}` })) }; } };
    // `portOf(p, port, paid)`: the carrier's client as a test makes it (kanban #1174: a tool whose answer is lost after it paid)
    if (portOf) Object.assign(port, portOf(p, port, paid));
    runs.set(p.hex, createSlashRelease({ key: p.key, secret: p.secret, networkId: NETWORK_ID_REGTEST, clocks, db: dbs.get(p.hex), tweakPoint,
      tipHeight: async () => tip(), entriesAtTip: async () => entries, rawTx, unspent: async () => true,
      fetchProof: async () => proofBytes, judge: Object.assign(async () => ({ verdict: true, held: { offence: 'X' } }), { read: () => ({ ok: true, roundId, contract }) }),
      panelsOf: () => ({ ok: true, ...panels }), ...(handles ? { handles } : {}), ...(logs ? { log: (l) => logs.push(l) } : {}), lossesFor: async () => (lossReads++, lossesOk ? { ok: true, losses: new Map([[player.hex, LOSS]]), entryIds: new Map([[player.hex, b32(0x31)]]) } : { ok: false, why: 'no seat answers' }),
      federations: federationsOf, portFor: async () => port, scriptOf: (address) => fromHex(`5120${toHex(taggedHash('ARENA/test/Address', new TextEncoder().encode(address)))}`),
      reserveKeyOf: async (fid) => reserveKey(fid), keepReserveRow: (row) => kept.push({ carrier: p.hex, row }), urlOf, send: async (hex) => { sent.push({ by: p.hex, hex }); if (hang(p.hex)) return new Promise(() => {}); return toHex([...parseTransaction(fromHex(hex)).txid].reverse()); }, fetchFn: fetchOf(p.hex) }));
  };
  for (const p of members) make(p);
  return { runs, members, sent, kept, paid, lossReads: () => lossReads, restart: (hex) => make(members.find((p) => p.hex === hex)), dbs };
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

test('#1129: a signer that has not read a standing federation\'s reserve key signs no table without its reserves\' row, and signs the full one once it has', async () => {
  // fedB's guardian seats stand (reservePending) but its key is not read yet: before #1129 every member built and signed a table with fedA's reserves' part alone
  let known = false;
  const view = async () => federations.map((f) => (f.federation === fedB && !known ? { ...f, reserveKey: null, reservePending: true } : f));
  const w = world({ federationsOf: view });
  const said = [];
  for (const p of w.members) said.push(...(await w.runs.get(p.hex).pass()));
  assert.equal(w.sent.length, 0, 'nothing sent');
  assert.ok(w.members.every((p) => !w.runs.get(p.hex).served(startHex).release), 'no member keeps or signs a table');
  assert.ok(said.some((r) => r.path === 'release' && new RegExp(`reserve key of federation ${fedB.slice(0, 16)} is not read here yet`).test(r.why)), 'the wait names the federation');
  // A FEDERATION WITH NO GUARDIAN SEATS (no key, not pending) takes no part and holds nothing up
  const none = world({ federationsOf: async () => federations.map((f) => (f.federation === fedB ? { ...f, reserveKey: null, reservePending: false } : f)) });
  for (const p of none.members) await none.runs.get(p.hex).pass();
  for (const p of none.members) await none.runs.get(p.hex).pass();
  assert.ok(none.sent.length >= 1, 'released without that federation');
  // THE KEY READ: the table every member builds has both reserves' rows
  known = true;
  for (const p of w.members) await w.runs.get(p.hex).pass();
  for (const p of w.members) await w.runs.get(p.hex).pass();
  const tables = w.members.map((p) => w.runs.get(p.hex).served(startHex).release.table);
  assert.equal(new Set(tables).size, 1, 'byte-equal at every member');
  assert.deepEqual(decodeSlashPayoutTable(fromHex(tables[0])).reserves.map((r) => toHex(r.federationId)), [fedA, fedB], 'a reserves\' row for each federation');
  assert.ok(w.sent.length >= 1, 'and the release goes out');
});

test('a member that cannot read the losses signs nothing, and a peg-in not signed by its node is not a carrier', async () => {
  const w = world({ lossesOk: false });
  for (const p of w.members) await w.runs.get(p.hex).pass();
  assert.equal(w.sent.length, 0);
  assert.ok(w.members.every((p) => !w.runs.get(p.hex).served(startHex).release));
  const peg = await w.runs.get(A[0].hex).ownPegIn(startHex, fedA);
  const id = carrierPegInId({ networkId: NETWORK_ID_REGTEST, start: { txid: startTxid, vout: 0 }, federationId: fromHex(fedA), use: 'players', script: fromHex(peg.script) });
  assert.ok(verify(fromHex(peg.signature), id, A[0].key));
  assert.ok(!verify(fromHex(peg.signature), id, A[1].key));
});

// ---- RULED 2026-11-04, kanban #1130: THE PROPOSAL NAMES ITS CARRIERS; A RESERVE KEY'S WAIT HAS A CAP ----
const CARRIER_MARGIN = carrierMarginOf(NETWORK_ID_REGTEST);
const sentTable = (w) => { const tx = parseTransaction(fromHex(w.sent[0].hex)); return toHex(arbitrationCommitmentIn([tx.outputs[0]]).hint); };

test('#1130: signers that read different peg-ins sign the same proposal - the one that names its carriers - and it goes out', async () => {
  // A[0]'s peg-in door answers no one but itself (the 20 s timeout of the #972 run): before #1130 every other signer built a table without A[0], A[0] one with it
  const w = world({ cut: (from, to, path) => path === '/slash-pegin' && to === A[0].hex && from !== A[0].hex });
  await w.runs.get(A[0].hex).pass();
  const proposed = w.runs.get(A[0].hex).served(startHex).release;
  assert.ok(proposed.pegins.some((p) => p.node === A[0].hex && p.use === 'players'), 'A[0]\'s proposal names its own players\' peg-in');
  for (const p of w.members.slice(1)) await w.runs.get(p.hex).pass();
  // B[0] could not read A[0]'s peg-in itself; it checked the one the proposal names and signed the proposal over its own rebuild
  const b0 = w.runs.get(B[0].hex).served(startHex).release;
  assert.ok(b0.proposals.some((p) => p.tableId === proposed.tableId && p.signatures.some((x) => x.node === B[0].hex)), 'B[0] signed A[0]\'s proposal');
  for (const p of w.members) await w.runs.get(p.hex).pass();
  assert.ok(w.sent.length >= 1, 'a release went out');
  const t = decodeSlashPayoutTable(w.runs.get(A[0].hex).tableById(sentTable(w)));
  assert.equal(toHex(t.outputs[1].script), (await w.runs.get(A[0].hex).ownPegIn(startHex, fedA, 'players')).script, 'the players\' part to A[0], panel A\'s first, by the peg-in its proposal named');
  assert.equal(new Set(w.members.map((p) => w.runs.get(p.hex).served(startHex).release.tableId)).size, 1, 'and every member\'s own proposal is that table by now: the peg-ins were handed on');
});

test('#1130: a peg-in signed for another federation or use is refused, and no proposal naming it is signed', async () => {
  // A[1] hands on A[0]'s fedB reserves' address relabelled as its fedA players' peg-in: a carrier's own signed script, for another federation and use
  let forged = null;
  const w = world({ serve: (k, body) => {
    if (k !== A[1].hex || !forged || !body.release) return body;
    const pegins = [...body.release.pegins.filter((p) => !(p.node === A[0].hex && p.use === 'players')), forged];
    return { ...body, pegins, release: { ...body.release, tableId: '77'.repeat(32), pegins, proposals: [] } };
  }, cut: (from, to, path) => path === '/slash-pegin' && to === A[0].hex && from !== A[0].hex });
  const real = await w.runs.get(A[0].hex).ownPegIn(startHex, fedB, 'reserves');
  forged = { node: A[0].hex, federation: fedA, use: 'players', script: real.script, signature: real.signature };
  for (const p of w.members.slice(1)) await w.runs.get(p.hex).pass();
  for (const p of w.members.slice(1)) {
    const s = w.runs.get(p.hex).served(startHex);
    assert.ok(s.pegins.some((x) => x.node === A[2].hex && x.use === 'players'), 'checked peg-ins are held and served');
    assert.ok(!s.pegins.some((x) => x.node === A[0].hex && x.use === 'players'), `${p.hex.slice(0, 8)} took no players' peg-in of A[0]: the one handed on was signed for fedB's reserves`);
    assert.ok(!s.release.proposals.some((x) => x.tableId === '77'.repeat(32)), 'and signed no proposal naming it');
  }
});

test('#1130: a reserve key still unread at the start\'s confirmation + slash_fallback_blocks / 4 (formula #1340) puts the whole reserves\' part in the escrow, from exactly that height', async () => {
  let tip = START_HEIGHT + 1;
  const cap = START_HEIGHT + clocks.fallbackBlocks / 4;
  const w = world({ tip: () => tip, federationsOf: async () => federations.map((f) => (f.federation === fedB ? { ...f, reserveKey: null, reservePending: true } : f)) });
  tip = cap - 1;
  const said = [];
  for (const p of w.members) said.push(...(await w.runs.get(p.hex).pass()));
  assert.equal(w.sent.length, 0, 'one block before the cap it still waits');
  assert.ok(said.some((r) => new RegExp(`not read here yet: no table is built without its reserves' row before height ${cap}`).test(r.why || '')), 'by name, with the cap');
  tip = cap;
  for (const p of w.members) await w.runs.get(p.hex).pass();
  for (const p of w.members) await w.runs.get(p.hex).pass();
  assert.ok(w.sent.length >= 1, 'at the cap the release goes out');
  const tables = w.members.map((p) => w.runs.get(p.hex).served(startHex).release.table);
  assert.equal(new Set(tables).size, 1, 'byte-equal at every member');
  const t = decodeSlashPayoutTable(fromHex(tables[0]));
  assert.deepEqual(t.outputs.map((o) => o.pays), ['filer', 'player_carrier', 'escrow'], 'the filer and the players unchanged, the whole reserves\' part in the escrow - fedA\'s too, whose key was read');
  assert.equal(t.reserves.length, 0);
  assert.equal(t.outputs[1].value * 1000n, LOSS + CARRIER_MARGIN, 'the players\' output is the loss plus the margin, as before the cap');
});

test('#1044: a judged start whose offence no loss rule reads is dropped once - no table built, no losses read, said once - and never retried', async () => {
  const logs = [];
  const w = world({ handles: (held) => held.offence !== 'X', logs, tip: () => START_HEIGHT + clocks.fallbackBlocks + 1 });
  const said = [];
  for (let k = 0; k < 3; k++) for (const p of w.members) said.push(...(await w.runs.get(p.hex).pass()));
  assert.equal(w.lossReads(), 0, 'no build asks for the losses');
  assert.equal(w.sent.length, 0);
  assert.ok(w.members.every((p) => !w.runs.get(p.hex).served(startHex).release && !w.runs.get(p.hex).served(startHex).fallback));
  assert.equal(said.filter((r) => r.dropped).length, w.members.length, 'dropped once at each member, on its first pass');
  assert.equal(logs.filter((l) => /dropped from release and fallback/.test(l)).length, w.members.length, 'one line each');
});

// ---- kanban #1174: A CARRIER'S PAYOUT, ONCE, WHATEVER STOPS ----
// THE STAKE-LOCK TOOL AS IT IS NOW: `pay` under a key submits one operation per key (the client refuses a second) and answers it again after;
// `pay-sent` reads a key's payout back. `lose` the answers lost (the tool paid, the seat never heard: a crash, a timeout) - one per call
function keyedTool(p, paid, { lose = 0, readBack = true } = {}) {
  const byKey = new Map();
  let lost = lose;
  const out = (txid, list) => ({ txid, payouts: list.map((x, i) => ({ refundPk: x.key, outIdx: i, contractId: `c${i}` })) });
  return {
    payouts: async (list, { key: asked = null } = {}) => {
      const key = readBack ? asked : null;   // a tool from before #1174 takes no key: every pay pays
      if (key && byKey.has(key)) return { ...out(byKey.get(key).txid, list), again: true };
      const txid = `${(paid.length + 1).toString(16).padStart(2, '0')}`.repeat(32);
      paid.push({ carrier: p.hex, list, key });
      if (key) byKey.set(key, { txid });
      if (lost > 0) { lost--; throw new Error('the tool did not answer in 600 s (killed)'); }
      return out(txid, list);
    },
    ...(readBack ? { payoutsSent: async (list, key) => (byKey.has(key) ? { found: true, ...out(byKey.get(key).txid, list) } : { found: false }) }
      : { payoutsSent: async () => { throw new Error('this stake-lock tool cannot read a keyed payout back: no mode pay-sent'); } }),
  };
}

test('kanban #1174: a carrier whose tool paid and whose answer was lost pays nothing twice: the payout is ASKED on disk first, then read back by its key', async () => {
  const facts = {};
  for (const [name, o] of [['lostAnswer', { lose: 1 }], ['oldTool', { lose: 1, readBack: false }]]) {
    const w = world({ portOf: (p, port, paid) => keyedTool(p, paid, o) });
    for (const q of w.members) await w.runs.get(q.hex).pass();
    for (const q of w.members) await w.runs.get(q.hex).pass();
    const first = A[0].hex, run = w.runs.get(first);
    // three passes of the carrier: the first loses one answer
    const passes = [];
    for (let i = 0; i < 3; i++) passes.push((await run.carry()).filter((r) => r.why).map((r) => r.why.replace(/[0-9a-f]{16,}/g, '<id>').slice(0, 240)));
    const mine = w.paid.filter((x) => x.carrier === first);
    const toPlayer = mine.filter((x) => x.list.some((y) => y.key === toHex(refundKeyOf(player.key))));
    const carried = run.served(startHex).carried || [];
    facts[name] = { payoutsMade: mine.length, playerPaidTimes: toPlayer.length, outputsPaid: carried.filter((c) => c.paidTxid).length, outputs: carried.length,
      states: carried.map((c) => (c.pay ? c.pay.step : null)), waits: [...new Set(passes.flat())] };
  }
  console.log('  MEASURED #1174 payOn:', JSON.stringify(facts));
  // three outputs carried (the players' part and a reserves' part in each federation): three payouts, the player paid once
  assert.deepEqual([facts.lostAnswer.payoutsMade, facts.lostAnswer.playerPaidTimes, facts.lostAnswer.outputsPaid], [3, 1, 3], 'a lost answer was paid again');
  assert.deepEqual(facts.lostAnswer.states, ['PAID', 'PAID', 'PAID']);
  // a tool that cannot read a key back: the payout is held, never paid twice, and said
  assert.equal(facts.oldTool.playerPaidTimes, 1, 'an old tool paid the player twice');
  assert.equal(facts.oldTool.payoutsMade, 3);
  assert.ok(facts.oldTool.waits.some((x) => /held, never paid twice/.test(x)), JSON.stringify(facts.oldTool.waits));
});

// ---- kanban #1192: THE RELEASE'S STATE IS ON DISK, AND ONE MEMBER'S DOOR CANNOT MAKE A SEAT BUILD WITHOUT END ----
test('kanban #1192: a member that sent the release and restarts builds, gathers and sends nothing again', async () => {
  const w = world();
  for (const p of w.members) await w.runs.get(p.hex).pass();
  for (const p of w.members) await w.runs.get(p.hex).pass();
  assert.ok(w.sent.length >= 1, 'a release was sent');
  const senders = [...new Set(w.sent.map((s) => s.by))];
  const reads = w.lossReads(), sends = w.sent.length;
  for (const k of senders) { w.restart(k); await w.runs.get(k).pass(); await w.runs.get(k).pass(); }
  const facts = { senders: senders.length, buildsAfterRestart: w.lossReads() - reads, sendsAfterRestart: w.sent.length - sends };
  console.log('  MEASURED #1192 restart after the send:', JSON.stringify(facts));
  assert.deepEqual([facts.buildsAfterRestart, facts.sendsAfterRestart], [0, 0], 'a restarted sender rebuilt or re-sent its release');
  assert.ok(senders.every((k) => w.runs.get(k).served(startHex).release.sent), 'its door says sent');
});

test('kanban #1192: a member stopped while its release was being sent sends the very bytes again after the restart, with no build', async () => {
  let hung = false;
  const w = world({ hang: () => hung });
  for (const p of w.members) await w.runs.get(p.hex).pass();
  const early = w.sent.length;
  // THE SECOND ROUND SENDS; EACH SEND REACHES THE CHAIN AND THE SEAT STOPS BEFORE IT ANSWERS
  hung = true;
  for (const p of w.members) {
    let over = false;
    w.runs.get(p.hex).pass().then(() => { over = true; }, () => { over = true; });
    const stop = Date.now() + 30000;
    while (!over && !w.sent.some((s) => s.by === p.hex) && Date.now() < stop) await new Promise((r) => setTimeout(r, 10));
  }
  const stopped = [...new Set(w.sent.slice(early).map((s) => s.by))];
  assert.ok(stopped.length >= 1);
  const first = new Map(stopped.map((k) => [k, w.sent.slice(early).find((s) => s.by === k).hex]));
  hung = false;
  const reads = w.lossReads(), at = w.sent.length;
  for (const k of stopped) { w.restart(k); await w.runs.get(k).pass(); }
  const again = w.sent.slice(at);
  const facts = { stopped: stopped.length, buildsAfterRestart: w.lossReads() - reads, resent: again.length, sameBytes: again.every((s) => s.hex === first.get(s.by)),
    sent: stopped.map((k) => !!w.runs.get(k).served(startHex).release.sent) };
  console.log('  MEASURED #1192 stop during the send:', JSON.stringify(facts));
  assert.equal(facts.buildsAfterRestart, 0, 'rebuilt instead of sending what was on disk');
  assert.equal(facts.resent, stopped.length);
  assert.equal(facts.sameBytes, true, 'the bytes sent again are the bytes sent before the stop');
  assert.ok(facts.sent.every(Boolean));
});

test('kanban #1192: a member serving many proposals that check makes another seat build at most a few per pass', async () => {
  const bad = A[3];
  const pegOf = (script) => ({ node: bad.hex, federation: fedA, use: 'players', script: toHex(script),
    signature: toHex(schnorr.sign(carrierPegInId({ networkId: NETWORK_ID_REGTEST, start: { txid: startTxid, vout: 0 }, federationId: fromHex(fedA), use: 'players', script }), bad.secret)) });
  // 40 proposals naming a peg-in of its own under 40 scripts, each signed by it (so each checks), and 40 more naming the real peg-ins under made-up table ids
  const extra = (real) => [
    ...Array.from({ length: 40 }, (_, i) => ({ tableId: toHex(taggedHash('ARENA/test/Junk', Uint8Array.of(i))), table: '00',
      pegins: [...real.filter((x) => !(x.node === bad.hex && x.use === 'players')), pegOf(fromHex(`5120${toHex(taggedHash('ARENA/test/BadPeg', Uint8Array.of(i)))}`))], signatures: [] })),
    ...Array.from({ length: 40 }, (_, i) => ({ tableId: toHex(taggedHash('ARENA/test/Junk2', Uint8Array.of(i))), table: '00', pegins: real, signatures: [] }))];
  let on = false;
  const w = world({ serve: (k, body) => { if (on && k === bad.hex && body.release && body.release.pegins) body.release.proposals = [...(body.release.proposals || []), ...extra(body.release.pegins)]; return body; } });
  for (const p of w.members) await w.runs.get(p.hex).pass();
  on = true;
  const victim = B[0].hex;
  const reads = w.lossReads();
  await w.runs.get(victim).pass();
  const builds = w.lossReads() - reads;
  console.log('  MEASURED #1192 one member serving 80 extra proposals:', JSON.stringify({ buildsInOnePass: builds }));
  assert.ok(builds <= 1 + 2 * w.members.length, `${builds} builds in one pass`);
  // AND THE RELEASE STILL GOES OUT
  for (const p of w.members) await w.runs.get(p.hex).pass();
  assert.ok(w.sent.length >= 1, 'the release went out');
});
