// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A SLASH LEFT IN ESCROW IS SIGNED, CARRIED AND PAID ON (spec 5A.3B, RULED 2026-11-03, kanban #1085). Real keys, real BIP-341 sighashes, real hold and escrow outputs, a
// real FROST census key, and one small chain that holds outputs by height, takes a spend only if its inputs are there and its relative locks have run (BIP-68), and confirms
// what was sent at the next block. Each seat has its own store and run and reads the others at their doors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { holdOutputKey, slashStartLeaf } from '../../arena-protocol/src/bond-script.js';
import { arbitrationCommitment } from '../../arena-protocol/src/arbitration-tx.js';
import { serializeSpend, tapSighash } from '../../arena-protocol/src/bond-spend.js';
import { decodeSlashEscrowOutputs, decodeSlashPayoutTable, slashEscrowOutputsId, slashPayoutTableId } from '../../arena-protocol/src/slash.js';
import { carrierSlices, escrowSlices, slashEscrowOutput, slashEscrowSpend, vsizeOfSpend } from '../../arena-protocol/src/slash-release.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import * as genesis from '../../arena-protocol/src/genesis.js';
const { CARRIER_PAYOUT_MARGIN_MSAT } = genesis;
const CARRIER_PAYOUT_FEE_MSAT = genesis.CARRIER_PAYOUT_FEE_MSAT ?? CARRIER_PAYOUT_MARGIN_MSAT;   // before #1093 the whole margin was the payout's
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint } from '../src/curve.js';
import { createCensusSigner } from '../src/census-sign.js';
import { censusKeyWork } from '../src/census-key-work.js';
import { createSlashRelease } from '../src/slash-release-run.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const tag = (n) => taggedHash('ARENA/test/EscrowRun', Uint8Array.of(n));
const toScalar = (b) => BigInt(`0x${toHex(b)}`) % N;
// THE CENSUS KEY: degree 3 under an even key, so 4 shares sign
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
const display = (internal) => toHex([...internal].reverse());

const clocks = { holdBlocks: 1, returnBlocks: 36, fallbackBlocks: 24 };
const A = [1, 2, 3, 4].map(person), B = [5, 6, 7, 8].map(person);
const panels = { panelA: A.map((p) => p.key), panelB: B.map((p) => p.key) };
const accused = person(40), seat = person(41), others = [person(50), person(51), person(52), person(53)];
const LAYOUT = [[accused, [1, 2]], [seat, [3, 4]], [others[0], [5]], [others[1], [6]], [others[2], [7]], [others[3], [8]]];
const BOND = 1_000_000n, MATURITY = 600, START_HEIGHT = 400, SLASH_HEIGHT = 399;
const proofBytes = Uint8Array.from([5, 5, 5]);
const proofId = taggedHash('ARENA/v1/SlashProof', proofBytes);
const roundId = b32(0x53);
const bond = { txid: b32(0x91), vout: 1 };
const feeCoin = { txid: b32(0x92), vout: 0, value: 700n, script: fromHex(`5120${'93'.repeat(32)}`) };
const player = person(60), player2 = person(61);
const fedA = 'fa'.repeat(32), fedB = 'fb'.repeat(32);
const reserveKey = (fid) => Uint8Array.from([0x02, ...fromHex(fid)]);
const fed = (id, reserve) => ({ federation: id, status: 'OPEN', reserveKey: toHex(reserveKey(id)), reserveSats: String(reserve), exposureCapSats: '1000000' });
const ROOMY = [fed(fedA, 100000), fed(fedB, 500000)], FULL = [fed(fedA, 800000), fed(fedB, 800000)];
const contract = { federationId: fromHex(fedA), slashRemainder: 'SPLIT', minScore: 1, censusHeight: 300 };
const LOSS = 300_000_000n;
const advert = { bondScriptTemplateVersion: 3, censusKey: census.key, ownerPubkey: accused.key, bondMaturityHeight: MATURITY };
/** What one federation payout costs the paying client (one payout's measured 352 msat): under the carrier's margin. */
const PAYOUT_FEE_MSAT = 352n;
/** The carrier payout margin regtest's tables name (kanban #1086): every players' output holds it past the loss, out of the reserves' share. */
const MARGIN = CARRIER_PAYOUT_MARGIN_MSAT.regtest;
const FEE_HOLD = CARRIER_PAYOUT_FEE_MSAT.regtest;          // what a carrier keeps back for its payout's fee (kanban #1093)
const PEGIN_FEE_MSAT = 416_000n;                         // a walletv2 peg-in fee measured in the real-Fedimint liquidation run (kanban #1093)
const scriptOfAddress = (address) => fromHex(`5120${toHex(taggedHash('ARENA/test/Address', new TextEncoder().encode(address)))}`);

function startOf(hold) {
  const tx = { version: 2, locktime: 0, inputs: [{ txid: bond.txid, vout: bond.vout, sequence: 0xfffffffd }, { txid: feeCoin.txid, vout: 0, sequence: 0xfffffffd }],
    outputs: [{ value: BOND, script: hold.script }, arbitrationCommitment(proofId, SLASH_HEIGHT, new TextEncoder().encode('arena'))] };
  const raw = serializeSpend({ ...tx, witnesses: [[new Uint8Array(64), new Uint8Array(65), slashStartLeaf(accused.key, census.key), new Uint8Array(65)], [new Uint8Array(64), new Uint8Array(34), new Uint8Array(33)]] });
  return { raw, txid: parseTransaction(raw).txid, hex: display(parseTransaction(raw).txid) };
}
const feeFunding = serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: b32(9), vout: 0, sequence: 0 }], outputs: [{ value: 700n, script: feeCoin.script }], witnesses: [[new Uint8Array(64)]] });

/** ONE CHAIN: outputs by height; a send needs its inputs confirmed and their relative locks run at the next block, conflicts refused; `mine()` confirms the mempool. */
function chain(tip) {
  const utxo = new Map(), mempool = [], raws = new Map();
  const c = {
    tip,
    add(txidHex, vout, value, script, height) { utxo.set(`${txidHex}:${vout}`, { sats: value, script: toHex(script), height }); },
    txOut: async (txid, vout) => { const o = utxo.get(`${txid}:${vout}`); return o ? { sats: o.sats, script: o.script, confirmations: c.tip - o.height + 1 } : null; },
    rawTx: async (txid) => raws.get(txid) || null,
    send: async (hex) => {
      const tx = parseTransaction(fromHex(hex)), txid = display(tx.txid);
      if (mempool.some((m) => m.txid === txid) || utxo.has(`${txid}:0`) || utxo.has(`${txid}:1`)) throw new Error('txn-already-in-mempool');
      for (const i of tx.inputs) {
        const name = `${display(i.previousTxid)}:${i.previousVout}`, o = utxo.get(name);
        if (!o) throw new Error('bad-txns-inputs-missingorspent');
        if (mempool.some((m) => m.spends.includes(name))) throw new Error('txn-mempool-conflict');
        if (!(i.sequence & 0x80000000) && c.tip + 1 - o.height < (i.sequence & 0xffff)) throw new Error('non-BIP68-final');
      }
      mempool.push({ txid, tx, hex, spends: tx.inputs.map((i) => `${display(i.previousTxid)}:${i.previousVout}`) });
      return txid;
    },
    mine() {
      c.tip += 1;
      for (const m of mempool.splice(0)) {
        for (const s of m.spends) utxo.delete(s);
        m.tx.outputs.forEach((o, i) => { if (o.script[0] !== 0x6a) utxo.set(`${m.txid}:${i}`, { sats: o.value, script: toHex(o.script), height: c.tip }); });
        raws.set(m.txid, fromHex(m.hex));
        c.mined.push(m);
      }
    },
    mined: [],
    mempool,
  };
  return c;
}

/**
 * A WORLD OF SEATS: `who` [{ p, shares? }] each with its own store and run on one chain. `ports()` says whether a seat has a federation client (it carries only then);
 * `federationsAt(h)` the reserves' view on the records at h; `losses` what the round's players lost.
 */
function world({ who, holders = [], hold, tip, ports = () => true, federationsNow = () => FULL, federationsAt = () => FULL, deviant = [], losses = [[player, LOSS]], stepMs = 0, floats = new Map() }) {
  const start = startOf(hold);
  const c = chain(tip);
  c.add(start.hex, 0, BOND, hold.script, START_HEIGHT);
  const urlOf = (k) => `http://seat-${k}`;
  const seats = new Map(), paid = [], kept = [];
  const answer = (body, status = 200) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url), k = u.host.slice(5), s = seats.get(k);
    if (!s) return answer({ why: 'no such seat' }, 404);
    if (u.pathname === '/census-sign/commit') return answer(await s.signer.takeCommit(JSON.parse(init.body)));
    if (u.pathname === '/census-sign/share') return answer(await s.signer.takeShare(JSON.parse(init.body)));
    if (u.pathname === '/slash-release') return answer(s.run.served(u.searchParams.get('start')));
    if (u.pathname === '/slash-pegin') { try { return answer(await s.run.ownPegIn(u.searchParams.get('start'), u.searchParams.get('federation'), u.searchParams.get('use') || 'players')); } catch (e) { return answer({ why: e.message }, 409); } }
    const carriers = /^\/slash\/([0-9a-f]{64})\/carriers$/.exec(u.pathname);
    if (carriers && init.method === 'POST') { const t = await s.run.takeCarrierPegIn(carriers[1], JSON.parse(init.body)); return answer(t, t.ok ? 200 : t.status); }
    if (carriers) return answer(s.run.servedCarriers(carriers[1]));
    return answer({}, 404);
  };
  const entries = [{ pubkey: accused.key, txid: bond.txid, vout: bond.vout, bondSats: String(BOND), script: fromHex(`5120${'94'.repeat(32)}`), hold: { txid: toHex(start.txid), vout: 0, height: START_HEIGHT }, advert },
    ...[seat, ...others, ...A, ...B].map((p, i) => ({ pubkey: p.key, txid: b32(10 + i), vout: 0, bondSats: String(BOND), advert }))];
  const live = { entries };
  const rawTx = async (txid) => (txid === start.hex ? start.raw : txid === display(feeCoin.txid) ? feeFunding : c.rawTx(txid));
  const holderList = holders.map(([p, xs]) => ({ key: p.hex, shares: xs.length }));
  for (const { p, xs = [] } of who) {
    const shares = xs.length ? { shares: new Map(xs.map((x) => [x, dealt.share(x)])) } : null;
    let made = 0;
    // ONE CLIENT PER FEDERATION, each with its own e-cash: what it claimed and was floated (`floats` [carrier hex, federation] -> msat), less what it paid out
    const clients = new Map();
    const portOf = (fid) => {
      if (!clients.has(fid)) {
        let held = floats.get(`${p.hex}:${fid}`) ?? 0n;
        clients.set(fid, { peginAddress: async () => `addr-${p.hex}-${made++}`, peginClaim: async (address) => { const m = c.claims.get(address) ?? 0n; held += m; return { claimedMsat: m }; },
          ecashBalance: async () => held,
          payouts: async (list) => {
            const out = list.reduce((a, x) => a + x.msat, 0n);
            if (out + PAYOUT_FEE_MSAT > held) throw new Error(`the client holds ${held} msat, not ${out} and the fee`);
            held -= out + PAYOUT_FEE_MSAT;
            paid.push({ carrier: p.hex, federation: fid, list });
            return { txid: 'cc'.repeat(32), payouts: list.map((x, i) => ({ refundPk: x.key, outIdx: i, contractId: `c${i}` })) };
          } });
      }
      return clients.get(fid);
    };
    const s = { clients: (fid) => portOf(fid) };
    s.run = createSlashRelease({ key: p.key, secret: p.secret, networkId: NETWORK_ID_REGTEST, clocks, db: new DatabaseSync(':memory:'), tweakPoint,
      tipHeight: async () => c.tip, entriesAtTip: async () => live.entries, rawTx, unspent: async (t, v) => !!(await c.txOut(t, v)), txOut: c.txOut,
      fetchProof: async () => proofBytes, judge: Object.assign(async () => ({ verdict: true, held: { offence: 'X' } }), { read: () => ({ ok: true, roundId, contract }) }),
      panelsOf: () => ({ ok: true, ...panels }), seatsOf: async () => [seat.hex],
      lossesFor: async () => ({ ok: true, losses: new Map(losses.map(([q, l]) => [q.hex, l])), entryIds: new Map(losses.map(([q], i) => [q.hex, b32(0x31 + i)])) }),
      federations: async () => (deviant.includes(p.hex) ? federationsNow().map((f) => ({ ...f, reserveSats: '0' })) : federationsNow()), federationsAt: async (h) => federationsAt(h),
      portFor: async (fid) => (ports(p) ? portOf(fid) : null), scriptOf: scriptOfAddress, reserveKeyOf: async (fid) => reserveKey(fid), keepReserveRow: (row) => kept.push({ carrier: p.hex, row }), urlOf,
      heldKey: (k) => (shares && toHex(k) === census.hex ? shares : null), thresholdOf: (k) => (k === census.hex ? THRESHOLD : null), holdersOf: async (k) => (k === census.hex ? holderList : []),
      signer: () => s.signer, send: c.send, stepMs, fetchFn });
    s.signer = createCensusSigner({ key: p.key, work: censusKeyWork, held: (k) => (shares && toHex(k) === census.hex ? shares : null), rosterOf: () => ({ total: 8, threshold: THRESHOLD }), check: (request) => s.run.checkOther(request) });
    seats.set(p.hex, s);
  }
  c.claims = new Map();                           // address -> what its client claims there: what the output to it paid
  const passAll = async (list = who) => { const out = []; for (const { p } of list) out.push(...(await seats.get(p.hex).run.pass()).map((x) => ({ by: p.hex, ...x }))); return out; };
  return { c, seats, paid, kept, start, live, passAll, run: (p) => seats.get(p.hex).run, clients: (p, fid) => seats.get(p.hex).clients(fid) };
}

const releaseHold = holdOutputKey({ ownerKey: accused.key, censusKey: census.key, ...panels, bondMaturity: MATURITY, ...clocks }, { tweakPoint });
const panelWho = [...A, ...B].map((p) => ({ p }));

/** The release, made with no carrier able to take anything: its table holds it all in the escrow. Answers the world after the release is mined, its table and escrow. */
async function releasedToEscrow(opts = {}) {
  let carriersOn = false;
  const w = world({ who: panelWho, hold: releaseHold, tip: START_HEIGHT + 1, ports: () => carriersOn, ...opts });
  await w.passAll();
  await w.passAll();
  assert.equal(w.c.mempool.length, 1, 'the release went out');
  w.c.mine();
  w.live.entries = w.live.entries.filter((e) => !e.hold);   // the hold is spent: the bond is gone from the census
  const sent = w.c.mined[0];
  const table = decodeSlashPayoutTable(fromHex(w.run(B[0]).served(w.start.hex).release.table));
  const at = table.outputs.findIndex((o) => o.pays === 'escrow');
  assert.deepEqual(table.outputs.map((o) => o.pays), ['filer', 'escrow'], 'no carrier: the table holds it all in escrow');
  return { w, table, escrowAt: { txid: sent.txid, vout: at + 1, value: table.outputs[at].value }, on: () => { carriersOn = true; } };
}
const escrowSpendsOf = (w) => w.c.mined.filter((m) => m.tx.outputs[0].script[0] === 0x6a && m.tx.outputs[0].script[1] === 64);
/** Each output of `tx` to one of `p`'s peg-in addresses claims its value there less the federation's peg-in fee `feeMsat` (its client's claim). Answers those outputs' indexes in `tx`. */
const claimAll = (w, p, tx, feeMsat = 0n) => {
  const at = [];
  for (let n = 0; n < 16; n++) {
    const address = `addr-${p.hex}-${n}`, script = toHex(scriptOfAddress(address));
    const i = tx.outputs.findIndex((o) => toHex(o.script) === script);
    if (i >= 0) { w.c.claims.set(address, tx.outputs[i].value * 1000n - feeMsat); at.push(i); }
  }
  return at;
};
const paysOf = (m) => decodeSlashEscrowOutputs(m.outputsBytes).outputs.map((o) => [o.pays, o.value]);
function readSpend(w, m) {
  const rel = [...w.seats.values()].map((s) => s.run.served(w.start.hex).escrow).find((e) => e && e.proposals.some((p) => p.txid === m.txid));
  const p = rel.proposals.find((x) => x.txid === m.txid);
  return { ...m, outputsBytes: fromHex(p.outputs), proposal: p };
}

// ---- THE PURE PART: the spend every signer builds, and its fee ----
const escrowPanels = slashEscrowOutput({ ...panels, censusKey: census.key, fallbackBlocks: clocks.fallbackBlocks }, { tweakPoint });
const escrowBare = slashEscrowOutput({ censusKey: census.key, fallbackBlocks: clocks.fallbackBlocks }, { tweakPoint });
const pureTable = (entries, escrowValue) => ({ networkId: NETWORK_ID_REGTEST, roundId, proofId, bondTxid: bond.txid, bondVout: 1, entries, reserves: [], marginMsat: MARGIN, marginOff: 'reserves',
  outputs: [{ value: 700n, script: feeCoin.script, pays: 'filer' }, { value: escrowValue, script: escrowPanels.script, pays: 'escrow' }] });
const carrier = (p, fid, n = 0) => ({ key: p.hex, federation: fid, script: scriptOfAddress(`${p.hex}-${fid}-${n}`), bondSats: BOND });

test('the escrow has the hold\'s release leaf with no wait and its fallback leaf, no return leaf; with no panels only the fallback leaf', () => {
  assert.deepEqual(Object.keys(escrowPanels.leaves).sort(), ['fallback', 'release']);
  assert.deepEqual(Object.keys(escrowBare.leaves), ['fallback']);
  assert.equal(escrowPanels.scripts.release[0], 0x20, 'the release leaf starts with panel A\'s first key: no CHECKSEQUENCEVERIFY');
  assert.equal(toHex(escrowPanels.scripts.fallback), toHex(releaseHold.scripts.fallback), 'the fallback leaf is the hold\'s own');
  assert.equal(escrowPanels.controlBlock('release').length, 33 + 32);
  assert.equal(escrowBare.controlBlock('fallback').length, 33);
  assert.notEqual(toHex(escrowPanels.script), toHex(escrowBare.script));
});

test('an escrow spend is the same bytes for every signer at the height it names, and another height\'s records build other bytes', () => {
  const table = pureTable([{ entryId: b32(0x31), playerPubkey: player.key, lossMsat: LOSS }], 997_000n);
  const args = (over = {}) => ({ path: 'release', escrow: { txid: b32(0xe1), vout: 2, value: 997_000n }, output: escrowPanels, table, tableId: slashPayoutTableId(table), loadHeight: 432,
    carriers: [carrier(A[0], fedA), carrier(A[1], fedA), carrier(A[0], fedB)], playersFederation: fedA, federations: ROOMY, rate: 2n, panels, fallbackBlocks: clocks.fallbackBlocks, ...over });
  const x = slashEscrowSpend(args()), y = slashEscrowSpend(args());
  assert.ok(x.ok, x.why);
  assert.equal(toHex(x.bytes), toHex(y.bytes)); assert.equal(toHex(x.digest), toHex(y.digest));
  assert.equal(decodeSlashEscrowOutputs(x.bytes).loadHeight, 432, 'outputs[] names its height');
  assert.equal(toHex(x.spend.tx.outputs[0].script), toHex(Uint8Array.from([0x6a, 64, ...slashPayoutTableId(table), ...slashEscrowOutputsId(x.outputs)])));
  assert.equal(x.spend.tx.inputs[0].sequence, 0xfffffffd, 'the panels\' leaf waits for nothing');
  const other = slashEscrowSpend(args({ loadHeight: 438, federations: [fed(fedA, 100000), fed(fedB, 100000)] }));
  assert.notEqual(toHex(other.outputsId), toHex(x.outputsId), 'another height, other records, other bytes');
  const fb = slashEscrowSpend(args({ path: 'fallback', panels: null, output: escrowBare }));
  assert.equal(fb.spend.tx.inputs[0].sequence, clocks.fallbackBlocks, 'the census key\'s leaf waits slash_fallback_blocks');
  // ONE OUTPUT PER PEG-IN: the players' part to panel A's first, the reserves of A to the next with a peg-in of A, the reserves of B to the first with one of B
  const outs = x.outputs.outputs;
  assert.deepEqual(outs.map((o) => o.pays), ['player_carrier', 'reserves', 'reserves']);
  assert.equal(toHex(outs[0].script), toHex(carrier(A[0], fedA).script));
  assert.equal(outs[0].value * 1000n, LOSS + MARGIN, 'the loss whole plus the carrier\'s margin, out of the reserves\' share');
  assert.deepEqual([x.outputs.marginMsat, x.outputs.marginOff], [MARGIN, 'reserves'], 'outputs[] names the table\'s margin and where it came from');
  assert.deepEqual(new Set(outs.slice(1).map((o) => toHex(o.script))), new Set([toHex(carrier(A[1], fedA).script), toHex(carrier(A[0], fedB).script)]));
});

test('the fee comes off the reserves\' part; with no reserves\' part, off each player\'s part pro rata to its loss', () => {
  // A RESERVES' PART: the players get their losses whole, the fee is the rate times the spend's own size
  const table = pureTable([{ entryId: b32(0x31), playerPubkey: player.key, lossMsat: LOSS }], 997_000n);
  const x = slashEscrowSpend({ path: 'release', escrow: { txid: b32(0xe1), vout: 2, value: 997_000n }, output: escrowPanels, table, tableId: slashPayoutTableId(table), loadHeight: 432,
    carriers: [carrier(A[0], fedA), carrier(A[1], fedA)], playersFederation: fedA, federations: ROOMY, rate: 3n, panels, fallbackBlocks: clocks.fallbackBlocks });
  assert.ok(x.ok, x.why);
  assert.equal(x.short, false);
  assert.equal(x.outputs.outputs.filter((o) => o.pays === 'player_carrier').reduce((a, o) => a + o.value, 0n) * 1000n, LOSS + MARGIN, 'players whole, and the margin');
  assert.equal(x.feeSats, 3n * BigInt(x.vsize), 'the fee is the rate times its own size');
  assert.equal(x.outputs.outputs.reduce((a, o) => a + o.value, 0n) + x.feeSats, 997_000n, 'outputs + fee = the escrow');
  const [slices] = escrowSlices({ table, spends: [{ value: 997_000n, outputs: x.outputs.outputs }] }).spends;
  assert.equal(slices[0].slices[0].msat, LOSS, 'the carrier carries the loss whole');
  // ONLY PLAYERS' MONEY: two losses, 2 to 1, and an escrow of exactly what they are owed
  const two = pureTable([{ entryId: b32(0x31), playerPubkey: player.key, lossMsat: 200_000_000n }, { entryId: b32(0x32), playerPubkey: player2.key, lossMsat: 100_000_000n }], 300_000n);
  const y = slashEscrowSpend({ path: 'release', escrow: { txid: b32(0xe2), vout: 2, value: 300_000n }, output: escrowPanels, table: two, tableId: slashPayoutTableId(two), loadHeight: 432,
    carriers: [carrier(A[0], fedA)], playersFederation: fedA, federations: ROOMY, rate: 3n, panels, fallbackBlocks: clocks.fallbackBlocks });
  assert.ok(y.ok, y.why);
  assert.equal(y.short, true);
  assert.deepEqual([y.outputs.marginMsat, y.outputs.marginOff], [MARGIN, 'players'], 'no reserves\' share: outputs[] says the players bear the margin');
  assert.deepEqual(decodeSlashEscrowOutputs(y.bytes).marginOff, 'players', 'in its bytes');
  assert.deepEqual(y.outputs.outputs.map((o) => o.pays), ['player_carrier'], 'no reserves, nothing back');
  assert.equal(y.outputs.outputs[0].value, 300_000n - y.feeSats);
  const cut = escrowSlices({ table: two, spends: [{ value: 300_000n, outputs: y.outputs.outputs }] });
  const [p1, p2] = cut.spends[0][0].slices.map((s) => s.msat);
  const feeMsat = y.feeSats * 1000n;
  assert.equal(p1 + p2, (300_000n - y.feeSats) * 1000n);
  assert.ok(200_000_000n - p1 - (feeMsat * 2n) / 3n <= 1n && 100_000_000n - p2 - feeMsat / 3n <= 1n, `pro rata to the loss: ${200_000_000n - p1} and ${100_000_000n - p2} of a ${feeMsat} msat fee`);
  // A BOND THAT WAS ALREADY CARRIED: nothing is owed, and with no room nothing is due
  const none = slashEscrowSpend({ path: 'release', escrow: { txid: b32(0xe3), vout: 2, value: 997_000n }, output: escrowPanels, table: pureTable([], 997_000n), tableId: b32(1), loadHeight: 432,
    carriers: [carrier(A[0], fedA)], playersFederation: fedA, federations: FULL, rate: 3n, panels, fallbackBlocks: clocks.fallbackBlocks });
  assert.equal(none.ok, false); assert.equal(none.due, false);
});

// ---- THE RUN ----
test('the panels sign one escrow spend byte for byte at the height it names, once a carrier has published a peg-in, and the carrier pays the player', async () => {
  const { w, escrowAt, on } = await releasedToEscrow({ federationsAt: (h) => (h >= 408 ? ROOMY : FULL) });
  // NO CARRIER YET: nothing is due, whatever the windows
  w.c.tip = 406;
  await w.passAll(); await w.passAll();
  assert.equal(w.c.mempool.length, 0, 'not due before a carrier publishes a peg-in');
  // THE CARRIERS PUBLISH (their clients are up); the next window builds and the panels sign
  on();
  await w.passAll();
  w.c.tip = 408;
  await w.passAll(); await w.passAll();
  assert.equal(w.c.mempool.length, 1, 'one escrow spend went out');
  w.c.mine();
  const sent = readSpend(w, escrowSpendsOf(w)[0]);
  assert.equal(sent.proposal.loadHeight, 408, 'it names the window\'s height');
  assert.equal(toHex(sent.tx.inputs[0].previousTxid), toHex(fromHex(escrowAt.txid).reverse())); assert.equal(sent.tx.inputs[0].previousVout, escrowAt.vout);
  for (const p of [...A, ...B]) {
    const mine = w.run(p).served(w.start.hex).escrow.proposals.find((x) => x.outputsId === sent.proposal.outputsId);
    assert.ok(mine && mine.own, `${p.hex.slice(0, 8)} built and signed the same bytes`);
  }
  const sigs = sent.tx.witnesses[0].slice(0, 8).filter((x) => x.length === 64).length;
  assert.equal(sigs, 6, 'exactly t of each panel');
  assert.deepEqual(paysOf(sent).map(([p]) => p), ['player_carrier', 'reserves', 'reserves'], 'the players, then the reserves spread by room at 408: the escrow is spent to the end');
  // THE CARRIER PAYS THE PLAYER ON: it carries the players' part in A and B's reserves' part, and its client of A holds nothing but what it claims (the case #1086 rules on)
  const toCarrier = sent.tx.outputs[1];
  const carried = claimAll(w, A[0], sent.tx);
  assert.deepEqual(carried.map((i) => paysOf(sent)[i - 1][0]), ['player_carrier', 'reserves'], 'the players\' part, and one reserves\' part');
  const res = sent.tx.outputs[carried[1]];
  assert.equal(await w.clients(A[0], fedA).ecashBalance(), 0n, 'no spare e-cash in A');
  const done = await w.run(A[0]).carry();
  const pay = w.paid.find((x) => x.carrier === A[0].hex && x.list.some((y) => y.key === toHex(refundKeyOf(player.key))));
  assert.ok(pay, `the carrier paid: ${JSON.stringify(done.map((d) => d.why || d.paidTxid))}`);
  // THE OUTPUT IS THE LOSS PLUS THE MARGIN (RULED 2026-11-03, kanban #1086): THE PLAYER GETS THE LOSS EXACTLY, AND THE CARRIER KEEPS NOTHING
  assert.equal(toCarrier.value * 1000n, LOSS + MARGIN, 'the players\' output is the loss plus the margin');
  const got = pay.list.find((y) => y.key === toHex(refundKeyOf(player.key))).msat;
  console.log(`  ESCROW, B's RESERVES ON THE CARRIER, NO SPARE E-CASH IN A: output ${toCarrier.value * 1000n} msat, player got ${got} msat, fee ${PAYOUT_FEE_MSAT} msat`);
  assert.equal(got, 300_000_000n, 'the whole loss, 300,000,000 msat, from the escrow');
  assert.deepEqual(pay.list.filter((y) => y.key !== toHex(refundKeyOf(player.key))).map((y) => [y.key, y.msat]), [[toHex(reserveKey(fedA)), MARGIN - FEE_HOLD]],
    'nothing else out of the players\' output but what the peg-in left of the margin (no peg-in fee here), to A\'s reserve key (kanban #1093)');
  const toRes = w.paid.find((x) => x.carrier === A[0].hex && x.list.some((y) => y.key === toHex(reserveKey(fedB))));
  assert.ok(toRes, 'the reserves\' part paid on');
  assert.equal(toRes.list[0].msat, res.value * 1000n - FEE_HOLD, 'B\'s reserves\' part less its own payout\'s fee hold only');
  // WHAT THE FEE LEFT OF THE PLAYERS' OUTPUT'S MARGIN IS OWED TO A'S RESERVE KEY, not kept: the client of A holds exactly that, and the carrier's next reserves' payout there takes it
  assert.equal(await w.clients(A[0], fedA).ecashBalance(), FEE_HOLD - PAYOUT_FEE_MSAT, 'the unused fee hold, in the client of A');
  const st = done.find((d) => d.index === carried[0] - 1 && d.paidTxid);
  assert.equal(st.marginUnusedMsat, String(FEE_HOLD - PAYOUT_FEE_MSAT), 'measured: the fee hold less the payout\'s fee, owed on');
  // AND GET /slash-release?start= SAYS SO (kanban #972, run 9 on the main test host: an escrow carry was kept under escrow:<outpoint>, and no door listed it)
  const listed = w.run(A[0]).served(w.start.hex).carried.filter((c) => c.path === 'escrow');
  assert.ok(listed.some((c) => c.paidTxid && (c.players || []).some((y) => y.key === toHex(refundKeyOf(player.key)) && BigInt(y.msat) === 300_000_000n)),
    `the carrier's door lists the escrow carry under its start: ${JSON.stringify(listed).slice(0, 300)}`);
});

test('#1129: a signer that has not read a standing federation\'s reserve key builds and signs no escrow spend without its reserves\' part, and the full one once it has', async () => {
  let known = false;
  const view = (h) => (h >= 408 ? ROOMY : FULL).map((f) => (f.federation === fedB && !known ? { ...f, reserveKey: null, reservePending: true } : f));
  const { w, on } = await releasedToEscrow({ federationsAt: view });
  on();
  await w.passAll();
  w.c.tip = 408;
  const said = [...(await w.passAll()), ...(await w.passAll())];
  assert.equal(w.c.mempool.length, 0, 'no escrow spend while fedB\'s key is unread');
  assert.ok([...A, ...B].every((p) => !(w.run(p).served(w.start.hex).escrow || { proposals: [] }).proposals.length), 'no member keeps or signs outputs[]');
  assert.ok(said.some((r) => new RegExp(`reserve key of federation ${fedB.slice(0, 16)} is not read here yet`).test(r.why || '')), `the wait names the federation: ${JSON.stringify(said.map((r) => r.why).filter(Boolean).slice(0, 4))}`);
  known = true;
  await w.passAll(); await w.passAll();
  assert.equal(w.c.mempool.length, 1, 'once the key is read, one escrow spend goes out');
  w.c.mine();
  const sent = readSpend(w, escrowSpendsOf(w)[0]);
  assert.deepEqual(paysOf(sent).map(([p]) => p), ['player_carrier', 'reserves', 'reserves'], 'with a reserves\' part in each federation');
});

test('#1093: the players\' federation takes its peg-in fee off the players\' output: the margin pays it, the player gets the loss at face, and what it left goes to the reserve key', async () => {
  const { w, on } = await releasedToEscrow({ federationsAt: (h) => (h >= 408 ? ROOMY : FULL) });
  w.c.tip = 406;
  await w.passAll(); await w.passAll();
  on();
  await w.passAll();
  w.c.tip = 408;
  await w.passAll(); await w.passAll();
  assert.equal(w.c.mempool.length, 1, 'one escrow spend went out');
  w.c.mine();
  const sent = readSpend(w, escrowSpendsOf(w)[0]);
  const carried = claimAll(w, A[0], sent.tx, PEGIN_FEE_MSAT);
  const toCarrier = sent.tx.outputs[carried[0]];
  assert.equal(paysOf(sent)[carried[0] - 1][0], 'player_carrier');
  const done = await w.run(A[0]).carry();
  const pay = w.paid.find((x) => x.carrier === A[0].hex && x.list.some((y) => y.key === toHex(refundKeyOf(player.key))));
  assert.ok(pay, `the carrier paid: ${JSON.stringify(done.map((d) => d.why || d.paidTxid))}`);
  assert.equal(pay.list.find((y) => y.key === toHex(refundKeyOf(player.key))).msat, LOSS, 'the whole loss, at face, after a 416 sat peg-in fee');
  assert.deepEqual(pay.list.filter((y) => y.key !== toHex(refundKeyOf(player.key))).map((y) => [y.key, y.msat]), [[toHex(reserveKey(fedA)), toCarrier.value * 1000n - PEGIN_FEE_MSAT - LOSS - FEE_HOLD]],
    'what the peg-in left of the margin, past the payout fee, to A\'s reserve key in the same payout');
  assert.ok(MARGIN - FEE_HOLD >= PEGIN_FEE_MSAT, 'the network\'s margin covers the measured walletv2 peg-in fee');
});

test('the reserves\' share takes the margin even when it goes back to the escrow; with no reserves\' share the players bear it pro rata, and outputs[] says so', async () => {
  // NO ROOM EVER, BUT MONEY PAST THE PLAYERS IN ESCROW: that is the reserves' share, the margin comes off it, the players are paid whole
  const q = await releasedToEscrow({ federationsAt: () => FULL, losses: [[player, 200_000_000n], [player2, 100_000_000n]] });
  q.on();
  await q.w.passAll();
  q.w.c.tip = 414;
  await q.w.passAll(); await q.w.passAll();
  assert.equal(q.w.c.mempool.length, 1);
  q.w.c.mine();
  const s2 = readSpend(q.w, escrowSpendsOf(q.w)[0]);
  assert.deepEqual(paysOf(s2), [['player_carrier', 300_000n + MARGIN / 1000n], ['escrow', paysOf(s2)[1][1]]], 'the players\' part and the margin, the reserves\' share back to the escrow');
  assert.equal(decodeSlashEscrowOutputs(s2.outputsBytes).marginOff, 'reserves');
  assert.deepEqual(claimAll(q.w, A[0], s2.tx), [1]);
  await q.w.run(A[0]).carry();
  const pay = q.w.paid.find((x) => x.carrier === A[0].hex);
  const got = (k) => pay.list.find((y) => y.key === toHex(refundKeyOf(k))).msat;
  assert.deepEqual([got(player.key), got(player2.key)], [200_000_000n, 100_000_000n], 'both losses whole');
  // ONLY PLAYERS' MONEY IN ESCROW: the losses are larger than the bond, so the table's escrow holds exactly the players' share and the spend's fee leaves them short
  const r = await releasedToEscrow({ federationsAt: () => ROOMY, losses: [[player, 2_000_000_000n], [player2, 1_000_000_000n]] });
  r.on();
  await r.w.passAll();
  r.w.c.tip = 414;
  await r.w.passAll(); await r.w.passAll();
  assert.equal(r.w.c.mempool.length, 1);
  r.w.c.mine();
  const s3 = readSpend(r.w, escrowSpendsOf(r.w)[0]);
  const named = decodeSlashEscrowOutputs(s3.outputsBytes);
  assert.deepEqual(named.outputs.map((o) => o.pays), ['player_carrier'], 'no reserves\' part, nothing back');
  assert.deepEqual([named.marginMsat, named.marginOff], [MARGIN, 'players'], 'outputs[] says the players bear the margin');
  assert.deepEqual(claimAll(r.w, A[0], s3.tx), [1]);
  await r.w.run(A[0]).carry();
  const p3 = r.w.paid.find((x) => x.carrier === A[0].hex);
  assert.ok(p3, 'the carrier paid');
  const at = (k) => p3.list.find((y) => y.key === toHex(refundKeyOf(k))).msat;
  const there = named.outputs[0].value * 1000n - FEE_HOLD;   // the players bear the payout's fee hold (and in a real federation the peg-in fee) pro rata
  const [x1, x2] = escrowSlices({ table: decodeSlashPayoutTable(fromHex(r.w.run(B[0]).served(r.w.start.hex).release.table)), spends: [{ ...named, value: s3.tx.outputs.reduce((a, o) => a + o.value, 0n) }] }).spends[0][0].slices.map((y) => y.msat);
  assert.equal(at(player.key), (x1 * there) / (x1 + x2), 'the margin pro rata to the loss: 2/3');
  assert.equal(at(player2.key), (x2 * there) / (x1 + x2), '1/3');
  assert.ok(x1 - at(player.key) - (FEE_HOLD * 2n) / 3n <= 1n && x2 - at(player2.key) - FEE_HOLD / 3n <= 1n, `each short by its part of the fee hold: ${x1 - at(player.key)} and ${x2 - at(player2.key)}`);
  console.log(`  NO RESERVES' SHARE: slices ${x1} and ${x2} msat, paid ${at(player.key)} and ${at(player2.key)} msat (fee hold ${FEE_HOLD} pro rata)`);
});

test('a spend is due on room at the height it names, not before, and the players\' part on a peg-in alone', async () => {
  // ONLY RESERVES IN ESCROW (no loss, no room at the release): due when a federation has room at the named height
  const r = await releasedToEscrow({ losses: [], federationsNow: () => FULL, federationsAt: (h) => (h >= 414 ? ROOMY : FULL) });
  r.on();
  r.w.c.tip = 408;
  await r.w.passAll(); await r.w.passAll();
  assert.equal(r.w.c.mempool.length, 0, 'peg-ins published, no room at 408: nothing');
  r.w.c.tip = 414;
  await r.w.passAll(); await r.w.passAll();
  assert.equal(r.w.c.mempool.length, 1, 'room at 414: due');
  r.w.c.mine();
  const sent = readSpend(r.w, escrowSpendsOf(r.w)[0]);
  assert.equal(sent.proposal.loadHeight, 414);
  assert.ok(paysOf(sent).every(([p]) => p !== 'player_carrier'));
  // PLAYERS OWED, NO ROOM EVER: due on a peg-in alone, the rest back to the escrow
  const q = await releasedToEscrow({ federationsAt: () => FULL });
  q.w.c.tip = 408;
  await q.w.passAll(); await q.w.passAll();
  assert.equal(q.w.c.mempool.length, 0, 'no carrier, no spend');
  q.on();
  await q.w.passAll();
  q.w.c.tip = 414;
  await q.w.passAll(); await q.w.passAll();
  assert.equal(q.w.c.mempool.length, 1);
  q.w.c.mine();
  const s2 = readSpend(q.w, escrowSpendsOf(q.w)[0]);
  assert.deepEqual(paysOf(s2).map(([p]) => p), ['player_carrier', 'escrow']);
  assert.equal(paysOf(s2)[0][1] * 1000n, LOSS + MARGIN);
});

test('with the panels silent, the census key spends the escrow after slash_fallback_blocks from its confirmation, and not a block before', async () => {
  // THE ESCROW OF A FALLBACK: the holders took the hold with no carrier, so the escrow has the fallback leaf alone
  let carriersOn = false;
  const holderWho = LAYOUT.map(([p, xs]) => ({ p, xs }));
  const w = world({ who: holderWho, holders: LAYOUT, hold: releaseHold, tip: START_HEIGHT + clocks.fallbackBlocks - 1, ports: () => carriersOn });
  await w.passAll();
  assert.equal(w.c.mempool.length, 1, 'the fallback went out');
  w.c.mine();
  w.live.entries = w.live.entries.filter((e) => !e.hold);
  const conf = w.c.tip;
  const table = decodeSlashPayoutTable(fromHex(w.run(others[0]).served(w.start.hex).fallback.table));
  assert.deepEqual(table.outputs.map((o) => o.pays), ['filer', 'escrow']);
  assert.equal(toHex(table.outputs[1].script), toHex(escrowBare.script), 'only the fallback leaf');
  carriersOn = true;
  // ONE BLOCK BEFORE THE LEAF OPENS: peg-ins published, nothing filed
  w.c.tip = conf + clocks.fallbackBlocks - 2;
  await w.passAll(); await w.passAll();
  assert.equal(w.c.mempool.length, 0, 'not before slash_fallback_blocks');
  w.c.tip = conf + clocks.fallbackBlocks - 1;
  const out = await w.passAll();
  assert.equal(w.c.mempool.length, 1, `the census key spent it: ${JSON.stringify(out.filter((x) => x.path === 'escrow-fallback').map((x) => x.why))}`);
  const m = w.c.mempool[0];
  assert.equal(m.tx.inputs[0].sequence, clocks.fallbackBlocks);
  const [sig, leaf, control] = m.tx.witnesses[0];
  assert.equal(toHex(leaf), toHex(escrowBare.scripts.fallback)); assert.equal(control.length, 33);
  const digest = tapSighash({ version: 2, locktime: 0, inputs: m.tx.inputs.map((i) => ({ txid: i.previousTxid, vout: i.previousVout, sequence: i.sequence })), outputs: m.tx.outputs,
    prevouts: [{ value: table.outputs[1].value, script: escrowBare.script }], inputIndex: 0, leafHash: escrowBare.leaves.fallback });
  assert.ok(verify(sig, digest, census.key), 'one BIP-340 signature of the census key over the escrow spend\'s own sighash');
  w.c.mine();
  // THE CARRIERS ARE THE HOLDERS, LESS THE ACCUSED AND THE ROUND'S SEAT
  const sent = readSpend(w, escrowSpendsOf(w)[0]);
  assert.equal(paysOf(sent)[0][0], 'player_carrier');
  const kept = w.run(others[0]).servedCarriers(toHex(slashPayoutTableId(table))).carriers;
  const first = [...others].sort((a, b) => (a.hex < b.hex ? -1 : 1))[0];   // one share each once the accused and the seat are out: by key
  assert.ok(kept.some((r) => r.node === first.hex && r.federation === fedA && r.script === toHex(sent.tx.outputs[1].script)), 'the players\' part to the first holder left, by its CarrierPegIn');
  assert.ok(kept.length > 0 && kept.every((r) => r.node !== accused.hex && r.node !== seat.hex), 'neither the accused nor the round\'s seat carries');
});

test('a carrier whose own table differed pays on for the table that confirmed, after checking it', async () => {
  // A[0] READS THE LOADS OTHERWISE: its table differs, it signs nothing, and the other seven send the release that names its peg-in
  const w = world({ who: panelWho, hold: releaseHold, tip: START_HEIGHT + 1, federationsNow: () => ROOMY, deviant: [A[0].hex] });
  await w.passAll(); await w.passAll();
  assert.equal(w.c.mempool.length, 1);
  w.c.mine();
  w.live.entries = w.live.entries.filter((e) => !e.hold);
  const own = decodeSlashPayoutTable(fromHex(w.run(A[0]).served(w.start.hex).release.table));
  const went = decodeSlashPayoutTable(fromHex(w.run(B[0]).served(w.start.hex).release.table));
  assert.notEqual(toHex(slashPayoutTableId(own)), toHex(slashPayoutTableId(went)), 'two readings, two tables');
  const players = carrierSlices(went)[0];
  // A[0] CARRIES THE PLAYERS' PART AND BOTH RESERVES' PARTS: the players' output is the loss plus the margin the table names, out of the reserves' share
  const carried = claimAll(w, A[0], w.c.mined[0].tx);
  assert.deepEqual(carried.map((i) => went.outputs[i - 1].pays), ['player_carrier', 'reserves', 'reserves']);
  assert.deepEqual([went.marginMsat, went.marginOff], [MARGIN, 'reserves'], 'the table names the margin');
  assert.equal(players.value * 1000n, LOSS + MARGIN);
  await w.run(A[0]).carry();
  const c = await w.run(A[0]).confirmedOf(w.start.hex);
  assert.equal(c.tableId, toHex(slashPayoutTableId(went)), 'it reads the confirmed table');
  const pay = w.paid.find((x) => x.carrier === A[0].hex && x.list.some((y) => y.key === toHex(refundKeyOf(player.key))));
  assert.ok(pay, 'it paid on');
  assert.equal(pay.list.find((y) => y.key === toHex(refundKeyOf(player.key))).msat, LOSS, 'the confirmed table\'s slice, whole');
  assert.deepEqual(pay.list.filter((y) => y.key !== toHex(refundKeyOf(player.key))).map((y) => [y.key, y.msat]), [[toHex(reserveKey(fedA)), MARGIN - FEE_HOLD]],
    'past the slice only what the peg-in left of the margin, to A\'s reserve key (kanban #1093)');
  const resOf = (fid) => w.paid.filter((x) => x.carrier === A[0].hex).flatMap((x) => x.list).filter((y) => y.key === toHex(reserveKey(fid))).reduce((a, y) => a + y.msat, 0n);
  const values = went.outputs.filter((o) => o.pays === 'reserves').map((o) => o.value * 1000n).sort();
  // THE MARGIN PAST THE PAYOUT'S FEE HOLD WENT WITH THE PLAYERS' PAYOUT; WHAT THE FEE LEFT OF THE HOLD GOES ON TO A'S RESERVE KEY WITH THE CARRIER'S RESERVES' PART THERE; B's part pays its own hold only
  const back = [resOf(fedA) - (MARGIN - FEE_HOLD) - (FEE_HOLD - PAYOUT_FEE_MSAT) + FEE_HOLD, resOf(fedB) + FEE_HOLD].sort();
  assert.deepEqual(back, values, `A's reserves' part less its hold plus the players' margin past theirs, B's less its own hold: ${values} -> ${resOf(fedA)}, ${resOf(fedB)}`);
  console.log(`  RELEASE: unused fee hold ${FEE_HOLD - PAYOUT_FEE_MSAT} msat reached A's reserve key with A's reserves' part`);
  // ONCE: a second pass pays nothing again
  const before = w.paid.length;
  await w.run(A[0]).carry();
  assert.equal(w.paid.length, before);
});
