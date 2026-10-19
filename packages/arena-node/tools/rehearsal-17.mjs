#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEDERATION.md REHEARSAL 17, LIQUIDATION (§23A.5), the chain half; tools/rehearsal-17-regtest.sh runs the
// federation half and calls this one step at a time, the state kept in $P/r17.json. Never testnet4, never a live bond.
//
//   bonds            the 4 guardians' node keys and bonds on the federation's own regtest; the exposure cap they make
//   abandon G ALIVE  guardian G has stopped: abandon_blocks mined, the ALIVE guardians attest; the proof, and if it stands the
//                    slashing transaction (k of m) that moves G's bond into the liquidation escrow; the record the ALIVE
//                    guardians can sign, verified as a client verifies it
//   spentset ALIVE   each ALIVE guardian's own copy of the spent set, from its guardian (the fork's blwp_spent_nonces, through
//                    src/spent-set-producer.js), signed with its node key; the copy that counts (newestSpentSet)
//   claims           every wallet's notes presented (src/liquidation-claims.js, src/note-validate.js against a client joined
//                    while the federation was OPEN), a spent note among them; the table at the window, after drain_blocks the
//                    remainder 75 / 25; then the same with no spent set published
//
// One JSON line per question; it decides nothing.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { bondOutputKey, bondInternalKey, slashLeaf, tapLeafHash, controlBlockFor, maturityHeightFor } from '../../arena-protocol/src/bond-script.js';
import { escrowOutput, arbitrationSpend, arbitrationSighash, arbitrationWitness, arbitrationTransaction } from '../../arena-protocol/src/arbitration-tx.js';
import { signAbsence, abandonmentProof } from '../../arena-protocol/src/absence.js';
import { guardianSlashStands, guardianSlashPayees, clocksFor, exposureCap, liquidationSchedule } from '../../arena-protocol/src/federation-slash.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, verifyFederationRecord, GONE } from '../../arena-protocol/src/federation-record.js';
import { decodeSpentSet, newestSpentSet, spentNonceSet } from '../../arena-protocol/src/spent-set.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';
import { produceSpentSet } from '../src/spent-set-producer.js';
import { createLiquidationClaims } from '../src/liquidation-claims.js';
import { fedimintNoteValidator, fedimintPendingChecker } from '../src/note-validate.js';

const P = process.env.P, B = process.env.BITCOIN_CLI, ARGS = (process.env.BTC_ARGS || '').split(' ').filter(Boolean);
if (!P || !B) throw new Error('P=<the run dir> BITCOIN_CLI=<bitcoin-cli> BTC_ARGS=<its -datadir/-rpc args>');
const cli = (...a) => execFileSync(B, [...ARGS, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const out = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
const STATE = join(P, 'r17.json');
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const keep = () => writeFileSync(STATE, JSON.stringify(state, null, 1));
const height = () => Number(cli('getblockcount'));
const mine = (n) => JSON.parse(cli('generatetoaddress', String(n), cli('getnewaddress')));
const { clocks } = clocksFor('regtest');
const BOND_SATS = BigInt(process.env.BOND_SATS || 500000);
const big = (b) => BigInt('0x' + toHex(b));
const tweakPoint = (Pk, t) => {
  const Q = schnorr.utils.lift_x(big(Pk)).add(secp256k1.Point.BASE.multiply(big(t)));
  return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) };
};
const combine = (terms) => {
  let sum = null;
  for (const { key, coefficient } of terms) { const p = schnorr.utils.lift_x(big(key)).multiply(big(coefficient)); sum = sum === null ? p : sum.add(p); }
  return schnorr.utils.pointToBytes(sum);
};
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };

// the arbitration set, as arbitration-regtest.mjs keys it
const g = genesisFor('regtest');
const K = g.arbitrationK;
const secrets = new Map();
for (let i = 0; i < g.arbitrationM; i++) {
  const secret = taggedHash('BLWP/v1/TestArbitration', new TextEncoder().encode(`bitcoin-regtest:${i}`));
  secrets.set(toHex(schnorr.getPublicKey(secret)), secret);
}
const sorted = [...g.arbitrationKeys].sort((a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });
const signBy = (count) => (h) => new Map(sorted.slice(0, count).map((k) => [toHex(k), schnorr.sign(h, secrets.get(toHex(k)))]));

// the 4 guardians' node keys (one node is one guardian, §23A.2) and 4 census nodes outside the federation
const nodeOf = (name) => { const secret = taggedHash('ARENA/v1/Rehearsal17', new TextEncoder().encode(name)); return { name, secret, key: schnorr.getPublicKey(secret) }; };
const guardians = [0, 1, 2, 3].map((i) => nodeOf(`g${i}`));
const outside = ['n5', 'n6', 'n7', 'n8'].map(nodeOf);
const peerKeyOf = (n) => Uint8Array.from([2, ...taggedHash('ARENA/v1/Rehearsal17Peer', n.key)]);
const fid = () => fromHex(state.federation);
const recordGuardians = () => guardians.map((n, i) => ({ peerKey: peerKeyOf(n), nodePubkey: n.key, operatorId: n.name, bondTxid: fromHex(state.bonds[i].txid).reverse(),
  bondVout: state.bonds[i].vout, endpoint: `ws://127.0.0.1:${30121 + i * 10}`, bondSats: BOND_SATS }));
const census = () => guardians.map((n) => ({ pubkey: n.key, advert: { guardianOf: [{ federationId: fid(), guardianKey: peerKeyOf(n) }] } }));
const plainRecord = () => ({ federationId: fid(), guardians: recordGuardians() });

const step = process.argv[2];
if (step === 'bonds') {
  state.federation = String(process.env.FED || '').toLowerCase();
  state.invite = process.env.INVITE || '';
  if (!/^[0-9a-f]{64}$/.test(state.federation)) throw new Error('FED=<the federation id hex>');
  try { cli('loadwallet', 'r17'); } catch { try { cli('createwallet', 'r17'); } catch { /* loaded */ } }
  state.bonds = guardians.map((n) => {
    const bondMaturity = maturityHeightFor(height(), 'regtest', { slackBlocks: 0 });
    const built = bondOutputKey({ nodeKey: n.key, arbitrationKeys: g.arbitrationKeys, arbitrationK: K, bondMaturity,
      internalKey: bondInternalKey({ nodeKey: n.key, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
    const spk = '5120' + toHex(built.outputKey);
    const txid = cli('sendtoaddress', JSON.parse(cli('decodescript', spk)).address, (Number(BOND_SATS) / 1e8).toFixed(8));
    return { name: n.name, txid, spk, bondMaturity };
  });
  mine(1);
  for (const b of state.bonds) b.vout = JSON.parse(cli('gettransaction', b.txid, 'true', 'true')).decoded.vout.find((o) => o.scriptPubKey.hex === b.spk).n;
  const cap = exposureCap({ bonds: state.bonds.map(() => BOND_SATS * 1000n), f: 1 });
  state.capMsat = String(cap.cap); state.gone = []; state.escrows = []; keep();
  out({ step: 'bonds', guardians: guardians.map((n) => `${n.name} ${toHex(n.key).slice(0, 8)}`), bondSats: BOND_SATS, funded: state.bonds.length,
    capSats: cap.cap / 1000n, rule: `(f + 1) x the smallest bond, f = 1 at 4 guardians`, height: height(), clocks });
} else if (step === 'abandon') {
  const G = Number(process.argv[3]); const alive = process.argv[4].split(',').map(Number);
  const lastSeen = height();
  mine(clocks.abandonBlocks);
  const record = { federationId: fid(), threshold: 3, guardians: recordGuardians() };
  const absent = record.guardians[G];
  const atts = alive.map((a) => signAbsence({ federationId: fid(), peerKey: absent.peerKey, lastSeenHeight: lastSeen, height: height(), attester: guardians[a].key },
    (h) => schnorr.sign(h, guardians[a].secret)));
  const proof = abandonmentProof(atts, { record, peerKey: absent.peerKey, abandonBlocks: clocks.abandonBlocks, verify });
  const decide = proof.ok ? guardianSlashStands({ proof }) : { slash: false, why: proof.why };
  out({ step: `g${G} abandoned: the proof`, attesters: alive.map((a) => `g${a}`), stands: proof.ok, why: proof.ok ? null : proof.why, slash: decide.slash, kind: decide.kind || null, height: height() });
  let slashTxid = null;
  if (decide.slash) {
    const bond = state.bonds[G];
    const built = bondOutputKey({ nodeKey: guardians[G].key, arbitrationKeys: g.arbitrationKeys, arbitrationK: K, bondMaturity: bond.bondMaturity,
      internalKey: bondInternalKey({ nodeKey: guardians[G].key, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
    const escrow = escrowOutput({ arbitrationKeys: g.arbitrationKeys, k: K }, { tweakPoint, combine });
    const feeSats = 3000n;
    const tx = arbitrationSpend({ bond: { txid: fromHex(bond.txid).reverse(), vout: bond.vout, value: BOND_SATS, script: fromHex(bond.spk) }, proofId: proof.id, slashHeight: height(),
      hint: new TextEncoder().encode('r17'), distribution: { playerShares: new Map([['escrow', BOND_SATS - feeSats]]), nodeShares: new Map(), pool: { nodes: feeSats, developers: 0n }, toDevelopers: 0n },
      escrowScript: escrow.script, nodesScript: null, developersScript: null, feeSats });
    if (!tx.ok) { out({ step: `g${G}: slashing transaction NOT built`, why: tx.why }); process.exit(1); }
    const h = arbitrationSighash(tx, tapLeafHash(slashLeaf(g.arbitrationKeys, K)));
    const w = arbitrationWitness({ arbitrationKeys: g.arbitrationKeys, k: K, signatures: signBy(K)(h), controlBlock: controlBlockFor('slash', built).controlBlock });
    if (!w.ok) { out({ step: `g${G}: slashing witness NOT built`, why: w.why }); process.exit(1); }
    slashTxid = cli('sendrawtransaction', toHex(arbitrationTransaction(tx, w.witness)));
    const blk = mine(1)[0];
    const dec = JSON.parse(cli('getrawtransaction', slashTxid, 'true', blk));
    const vout = dec.vout.findIndex((o) => o.scriptPubKey.hex === toHex(escrow.script));
    state.escrows.push({ guardian: G, txid: slashTxid, vout, sats: String(BOND_SATS - feeSats) });
    state.gone.push({ guardian: G, sinceHeight: proof.sinceHeight, proofRef: toHex(proof.id) });
    out({ step: `g${G}: bond slashed into the liquidation escrow, ${K} of ${g.arbitrationM}`, txid: slashTxid, escrowSats: BOND_SATS - feeSats, confirmations: dec.confirmations,
      escrowTotalSats: state.escrows.reduce((a, e) => a + BigInt(e.sats), 0n) });
  }
  // THE RECORD THE SEATED CAN SIGN: the abandonment as proven (gone[]), and - for a halt - every guardian that is down, signed by
  // the ALIVE guardians only, verified as a client verifies one
  const signed = (gone) => {
    const r = buildFederationRecord({ federationId: fid(), networkId: new Uint8Array(32), invite: state.invite, nominal: 4, guardians: recordGuardians(),
      gone: gone.map((x) => ({ peerKey: peerKeyOf(guardians[x.guardian]), sinceHeight: x.sinceHeight, kind: GONE.ABANDONED, proofRef: x.proofRef ? fromHex(x.proofRef) : new Uint8Array(32) })), height: height() });
    const id = federationRecordId(r);
    const bytes = joinSignedRecord(encodeFederationRecord(r), alive.map((a) => ({ nodePubkey: guardians[a].key, signature: schnorr.sign(id, guardians[a].secret) })));
    const v = verifyFederationRecord(bytes, { census: census(), verify, inviteFederationId: () => fid() });
    return { status: Object.keys({ OPEN: 1, DRAINING: 2, CRITICAL: 3, CLOSED: 4, HALTED: 5 })[r.status - 1], seated: r.seated, signers: alive.length, verifies: v.ok, why: v.ok ? null : v.why };
  };
  const down = [...new Set([...state.gone.map((x) => x.guardian), G])].map((x) => state.gone.find((y) => y.guardian === x) || { guardian: x, sinceHeight: lastSeen });
  out({ step: `g${G} gone: the record the seated guardians sign`, asProven: signed(state.gone), asItIs: signed(down) });
  if (alive.length < 3 && state.haltHeight === undefined) { state.haltHeight = lastSeen; out({ step: 'HALTED', seated: alive.length, haltHeight: lastSeen, below: '2f + 1 = 3' }); }
  keep();
} else if (step === 'spentset') {
  const alive = process.argv[3].split(',').map(Number);
  const copies = [];
  for (const a of alive) {
    const t = Date.now();
    const r = await produceSpentSet({ guardianDir: join(P, `g${a}`), clientDir: join(P, 'client'), cli: process.env.FEDIMINT_CLI, federationId: state.federation,
      nodeSecret: guardians[a].secret, env: { ...process.env, HOME: process.env.FEDIMINT_HOME } });
    out({ step: `g${a}'s copy of the spent set`, ok: r.ok, why: r.ok ? null : r.why, session: r.session, nonces: r.nonces, ms: Date.now() - t });
    if (r.ok) copies.push({ ...decodeSpentSet(fromHex(r.copy.spentSet)), signature: fromHex(r.copy.signature) });
  }
  const best = newestSpentSet(copies, { record: plainRecord(), verify });
  state.spent = best.copy ? spentNonceSet(best.copy) : null; keep();
  out({ step: 'the copy that counts', session: best.session ?? null, signers: best.signers ?? null, disagree: best.disagree ?? null, nonces: state.spent ? state.spent.length : null, why: best.why || null });
} else if (step === 'claims') {
  const dir = join(P, 'claims');
  const wallets = (process.env.WALLETS || 'p1,p2,p3').split(',');
  const validate = fedimintNoteValidator({ cli: process.env.FEDIMINT_CLI, dataDirFor: () => join(P, 'client'), home: process.env.FEDIMINT_HOME });
  const when = liquidationSchedule({ haltHeight: state.haltHeight, clocks });
  const escrowSats = state.escrows.reduce((a, e) => a + BigInt(e.sats), 0n);
  const payKey = (w) => toHex(Uint8Array.from([2, ...taggedHash('ARENA/v1/Rehearsal17Payout', new TextEncoder().encode(w))]));
  // THE ISSUED SET (§23A.5 "Notes still in issuance at the halt"): every Output recovery item's nonce_hash, as g0 served them
  const issuedHashes = [];
  try {
    const walk = (x, inOutput) => { if (Array.isArray(x)) { for (const y of x) walk(y, inOutput); return; } if (!x || typeof x !== 'object') return;
      for (const [k, v] of Object.entries(x)) { if (k === 'nonce_hash' && inOutput && typeof v === 'string') issuedHashes.push(v.toLowerCase()); else walk(v, inOutput || k === 'Output' || k === 'output'); } };
    walk(JSON.parse(readFileSync(join(dir, 'issued.json'), 'utf8')), false);
  } catch (e) { out({ step: 'issued set unread', why: e.message }); }
  let pending = [];
  try { pending = (JSON.parse(readFileSync(join(dir, 'p2-pending.json'), 'utf8')).pending || []).map((x) => x.request); } catch (e) { out({ step: 'p2 pending unread', why: e.message }); }
  const checkPending = fedimintPendingChecker({ cli: process.env.FEDIMINT_CLI, dataDirFor: () => join(P, 'client'), home: process.env.FEDIMINT_HOME });
  const book = (spentNonces) => createLiquidationClaims({ validate, checkPending, height: async () => height(), escrowMsatOf: async () => escrowSats * 1000n, clocks,
    liquidationOf: async (f) => (f === state.federation ? { haltHeight: state.haltHeight, liquidatesAt: when.claimWindowOpens, claimWindowCloses: when.claimWindowCloses,
      lateClaimsUntil: when.lateClaimsUntil, spentNonces, issuedHashes } : null) });
  const present = async (claims, label) => {
    const rows = [];
    for (const w of [...wallets, 'p3-spent']) {
      const f = join(dir, `${w}.ecash`);
      if (!existsSync(f)) continue;
      const t = Date.now();
      const r = await claims.offer({ federation: state.federation, ecash: readFileSync(f, 'utf8').trim(), payoutPk: payKey(w.replace('-spent', '')) });
      rows.push({ wallet: w, status: r.status, accepted: (r.accepted || []).length, acceptedMsat: (r.accepted || []).reduce((a, x) => a + BigInt(x.amountMsat), 0n),
        refused: (r.refused || []).map((x) => x.why).filter((v, i, s) => s.indexOf(v) === i), refusedNotes: (r.refused || []).length, why: r.why || null, ms: Date.now() - t });
    }
    out({ step: `${label}: the notes presented`, at: height(), rows });
  };
  const table = (p, label) => out({ step: label, ok: p.ok, why: p.ok ? null : p.why, escrowMsat: p.escrowMsat, notes: p.notes, proRata: p.proRata, rate: p.rate,
    spentSetPublished: p.spentSetPublished, payouts: p.payouts, refused: p.refused, remainderMsat: p.remainderMsat, split: p.split, remainderSplitsAt: p.remainderSplitsAt });
  if (height() < when.claimWindowOpens) mine(when.claimWindowOpens - height());
  out({ step: 'the claim window', haltHeight: state.haltHeight, opens: when.claimWindowOpens, closes: when.claimWindowCloses, lateUntil: when.lateClaimsUntil, at: height(),
    escrowSats, capSats: BigInt(state.capMsat) / 1000n, spentSetNonces: state.spent ? state.spent.length : null });
  const early = await book(state.spent).offer({ federation: state.federation, ecash: 'x', payoutPk: payKey('p1') });
  out({ step: 'a claim with notes that are no notes', status: early.status, why: early.why });
  // both books take the same notes inside the window: one holds the spent set, the other was given none
  const withSet = book(state.spent); const noSet = book(null);
  await present(withSet, 'with the spent set');
  await present(noSet, 'no spent set published');
  // p2'S OUTPUTS STILL IN ISSUANCE AT THE HALT, claimed by their secrets - then once more, to be refused as claimed before
  out({ step: 'issued set and p2 pending outputs', issued: issuedHashes.length, pending: pending.length });
  for (const [label, b] of [['with the spent set', withSet], ['no spent set published', noSet]]) {
    if (!pending.length) break;
    const t = Date.now();
    const r = await b.offerPending({ federation: state.federation, pending, payoutPk: payKey('p2') });
    const again = await b.offerPending({ federation: state.federation, pending, payoutPk: payKey('p2') });
    out({ step: `${label}: p2's pending outputs claimed`, status: r.status, accepted: (r.accepted || []).length,
      acceptedMsat: (r.accepted || []).reduce((a, x) => a + BigInt(x.amountMsat), 0n), refused: (r.refused || []).map((x) => x.why), ms: Date.now() - t,
      again: { status: again.status, refused: [...new Set((again.refused || []).map((x) => x.why))] } });
  }
  const both = BigInt(state.capMsat) - 6000n * 1000n;   // had both bonds been slashed: 2 x bond - 2 x fee
  table(await withSet.plan(state.federation), 'with the spent set: the table, from the escrow the slashes made');
  table(await withSet.plan(state.federation, { escrowMsat: both }), 'with the spent set: the table, had both bonds been slashed');
  table(await noSet.plan(state.federation), 'no spent set published: the table, from the escrow the slashes made');
  table(await noSet.plan(state.federation, { escrowMsat: both }), 'no spent set published: the table, had both bonds been slashed');
  // after drain_blocks: the remainder splits 75 / 25 (the census less the federation's guardians, and the donation set)
  if (height() < when.remainderSplitsAt) mine(when.remainderSplitsAt - height());
  const late = await withSet.plan(state.federation, { escrowMsat: both });
  table(late, `with the spent set, after drain_blocks (${when.remainderSplitsAt}), had both bonds been slashed`);
  if (late.ok && BigInt(late.remainderMsat) > 0n) {
    const payees = guardianSlashPayees({ amountSats: BigInt(late.remainderMsat) / 1000n, censusNodes: [...guardians, ...outside].map((n) => n.key), record: plainRecord() });
    out({ step: 'the remainder\'s payees', ok: payees.ok, nodes: payees.nodes, donationSet: payees.developers, guardiansLeftOut: payees.guardiansLeftOut });
  }
} else throw new Error(`step ${step}?`);
