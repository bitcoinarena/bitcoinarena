#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARK OF THEFT STARTS EVERY SEATED GUARDIAN'S BOND, ASKED OF BITCOIND (kanban #1093 part 2, rulings #1106, #1109). A private regtest, bitcoind only, never testnet4, never a live bond.
// Four guardians of one federation, each with a template-3 bond and its bonding slash_presig (a hold with no release leaf, #1053); the record seats three, the fourth DEPARTED by notice.
// For each seated guardian: the TheftProof (the signed record, the config and the session history as bytes), the start built by the production builder, checked by a holder as
// slash-start-run.js checks it, signed by a weighted FROST census key, accepted and mined. The departed guardian's proof is refused by the judge. The node's own pass at the return clock keeps
// it in its hold while the judge holds the proof, and waits where the judge cannot say. There is no Fedimint federation here: the sessions are stand-in bytes and the session verifier is a
// stand-in answering as the stake-lock tool's theft-verify must; everything on the chain side is the real code.
//
//   bitcoind -regtest -datadir=DIR -port=P -rpcport=R -listen=0 -fallbackfee=0.0001 -daemon
//   RT=DIR RPCPORT=R BITCOIN_CLI=.../bitcoin-cli node tools/theft-regtest.mjs          (from packages/arena-node)
import { execFileSync } from 'node:child_process';
import { schnorr } from '@noble/curves/secp256k1.js';
import { SLASH_CLOCKS } from '../../arena-protocol/src/genesis.js';
import { bond3OutputKey, holdOutputKey, controlBlockFor, tapLeafHash, tapTweak, HOLD_INTERNAL_KEY, TAPLEAF_VERSION } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness } from '../../arena-protocol/src/bond-spend.js';
import { buildSlashStart, checkSlashStart, signedSlashStart } from '../../arena-protocol/src/slash-start.js';
import { slashPresigDigest } from '../../arena-protocol/src/slash-presig.js';
import { arbitrationCommitmentIn } from '../../arena-protocol/src/arbitration-tx.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, GONE } from '../../arena-protocol/src/federation-record.js';
import { encodeTheftProof, theftProofId } from '../../arena-protocol/src/theft-slash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint } from '../src/curve.js';
import { federationRecords } from '../src/federation-records.js';
import { createProofJudge } from '../src/proof-judge.js';
import { readSlashStart, decideReturn } from '../src/hold-return.js';
import { weightedKeygen, weightsFor, signersFor, signByNode } from './census-key-measure.mjs';

const RT = process.env.RT, PORT = process.env.RPCPORT || '29143', B = process.env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';
if (!RT) throw new Error('RT=<the private regtest datadir>');
const cli = (...a) => execFileSync(B, ['-regtest', `-datadir=${RT}`, `-rpcport=${PORT}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try { cli('loadwallet', 'theft'); } catch { try { cli('createwallet', 'theft'); } catch { /* loaded */ } }
const mine = (n) => { if (n > 0) cli('generatetoaddress', String(n), cli('getnewaddress')); };
if (Number(cli('getblockcount')) < 101) mine(101);
const tip = () => Number(cli('getblockcount'));
let wrong = 0, asked = 0;
const say = (ok, line) => { asked++; if (!ok) wrong++; console.log(`#1093 ${ok ? 'as expected' : 'WRONG      '} ${line}`); };
const accept = (hex) => JSON.parse(cli('testmempoolaccept', JSON.stringify([hex])))[0];

const CLOCKS = SLASH_CLOCKS.mainnet;
const clocks = { holdBlocks: CLOCKS.slashHoldBlocks, returnBlocks: CLOCKS.slashReturnBlocks, fallbackBlocks: CLOCKS.slashFallbackBlocks };
const census = await weightedKeygen({ weights: weightsFor(15, 10) });
const censusKey = census.groupPublicKey.subarray(1);
const censusSign = (digest) => signByNode(census, digest, signersFor(census)).sig.signature;
console.log(`#1093 census key ${toHex(censusKey).slice(0, 16)}: 15 nodes, ${census.total} shares, threshold ${census.needed}`);

// ---- four guardians, a template-3 bond each, funded here, and the bonding presig to a hold with no panels
const FED = new Uint8Array(32).fill(0x37), INVITE = `fed:${toHex(FED)}`, inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);
const person = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, key: schnorr.getPublicKey(secret) }; };
const MATURITY = tip() + 160;                  // not mature at the start; the return opens at the later of the start + slash_return_blocks and maturity
const guardians = Array.from({ length: 4 }, (_, i) => {
  const node = person(), owner = person(), guardianKey = Uint8Array.from([2, ...schnorr.getPublicKey(schnorr.utils.randomSecretKey())]);
  const built = bond3OutputKey({ nodeKey: node.key, ownerKey: owner.key, censusKey, bondMaturity: MATURITY }, { tweakPoint });
  if (!built.ok) throw new Error(built.why);
  const script = fromHex(`5120${toHex(built.outputKey)}`);
  const txid = cli('sendtoaddress', JSON.parse(cli('decodescript', toHex(script))).address, '0.5');
  mine(1);
  const vout = JSON.parse(cli('gettransaction', txid, 'true', 'true')).decoded.vout.find((o) => o.scriptPubKey.hex === toHex(script)).n;
  const bond = { txid: fromHex(txid).reverse(), vout, value: 50000000n, script, height: tip() };
  const hold = holdOutputKey({ ownerKey: owner.key, censusKey, panelA: [], panelB: [], bondMaturity: MATURITY, ...clocks }, { tweakPoint });
  if (!hold.ok) throw new Error(hold.why);
  const presig = Uint8Array.from([...schnorr.sign(slashPresigDigest({ bond, nodeKey: node.key, censusKey, holdScript: hold.script }), node.secret), 0x83]);
  return { i, node, owner, guardianKey, built, bond, hold, presig };
});
console.log(`#1093 four guardian bonds, template 3, 0.5 BTC each; bonding presig to a hold with leaves ${Object.keys(guardians[0].hold.leaves).sort().join(', ')}`);

// ---- the census the record stands on, and the record: three seated, the fourth DEPARTED by notice
const advertOf = (g) => ({ nodePubkey: g.node.key, operatorId: `op${g.i}`, bondScriptTemplateVersion: 3, bondMaturityHeight: MATURITY, censusKey, endpoint: `wss://seat-${g.i}.example`,
  guardianEndpoint: `wss://g${g.i}.example`, guardianOf: [{ federationId: FED, guardianKey: g.guardianKey }] });
const entries = guardians.map((g) => ({ pubkey: g.node.key, txid: g.bond.txid, vout: g.bond.vout, bondSats: g.bond.value, height: g.bond.height, advert: advertOf(g) }));
const RECORD_HEIGHT = tip();
const record = buildFederationRecord({ federationId: FED, networkId: NETWORK_ID_REGTEST, invite: INVITE, nominal: 4, height: RECORD_HEIGHT, reserveSats: 0n,
  guardians: guardians.map((g) => ({ nodePubkey: g.node.key, peerKey: g.guardianKey, operatorId: `op${g.i}`, bondTxid: g.bond.txid, bondVout: g.bond.vout, bondSats: g.bond.value, endpoint: `wss://g${g.i}.example` })),
  gone: [{ peerKey: guardians[3].guardianKey, sinceHeight: RECORD_HEIGHT - 1, kind: GONE.DEPARTED, proofRef: new Uint8Array(32) }] });
const signedRecord = joinSignedRecord(encodeFederationRecord(record), guardians.slice(0, 3).map((g) => ({ nodePubkey: g.node.key, signature: schnorr.sign(federationRecordId(record), g.node.secret) })));

// ---- the mark: inflation at session 2, the whole history 0-2 in the proof (stand-in session bytes; see the head of this file)
const evidence = { mark: { kind: 'inflation', height: tip(), session: 2 }, config: Uint8Array.of(0xc0, 0xf1, 0x6), firstSession: 0, sessions: [0, 1, 2].map((i) => Uint8Array.of(0x5e, i, 0xaa)) };
const verifier = async (input) => ({ mode: 'theft-verify', federationMatches: input.federationId === toHex(FED), sessions: input.sessions.length, verified: input.sessions.length, unverified: [],
  firstSession: input.firstSession, lastSession: input.firstSession + input.sessions.length - 1, firstInflationSession: 2, cumulativeIssuedMsat: 5000000, cumulativeRedeemedMsat: 7000000, signedPegOutTxids: [] });
// a checker's seat: its census from the record's height, its bonds off this chain (every guardian output that is not started), its verifier
// (a stand-in for the chain's census read at a height: an output started at or below it is out, as census.js reads a hold)
const started = new Map();                           // outpoint -> the start's height
const bondsAt = async (h) => entries.filter((e) => !(started.get(`${toHex(e.txid)}:${e.vout}`) <= h));
const checker = (verifySessions = verifier) => federationRecords({ round: { pubkey: guardians[0].node.key, identity: { secret: guardians[0].node.secret }, db: { prepare: () => ({ all: () => [], get: () => ({ m: 0 }) }) } },
  roster: { censusFor: () => ({ ok: false, why: 'none' }) }, inviteFor: () => null, networkId: NETWORK_ID_REGTEST, censusAt: async () => entries, chainTip: async () => tip(), bondsAt,
  store: { load: () => [{ federation: toHex(FED), record: toHex(signedRecord) }], save: () => {} }, alarmOf: (fid) => (fid === toHex(FED) ? { federation: fid, kind: 'inflation', height: evidence.mark.height, session: 2 } : null),
  theftEvidenceOf: async () => evidence, verifySessions });
// the seats list from a census CHAIN_BASIS_LAG below the tip, at a multiple of CHAIN_BASIS_STEP: the bonds are 12 blocks deep before any seat lists them
mine(12);
const seat = checker();
await seat.restore(inviteFederationId);
const listed = await seat.theftSlashes();
say(listed.length === 3 && !listed.some((r) => r.node === toHex(guardians[3].node.key)), `the seat with the alarm lists ${listed.length} theft proofs: guardians ${listed.map((r) => guardians.findIndex((g) => toHex(g.node.key) === r.node)).sort().join(', ')} (3 seated; 3 DEPARTED is not taken), ${seat.theftProof(listed[0].proof).length} bytes each`);
const judge = (s) => createProofJudge({ committeeOf: () => ({ ok: false }), censusOf: () => ({ ok: false }), coreOf: () => null, beaconOf: () => ({ ok: false }), replayRunOf: () => undefined,
  theft: (bytes, before) => s.theftVerdict(bytes, inviteFederationId, before) });
const holder = judge(seat);
const departedProof = encodeTheftProof({ federationId: FED, nodePubkey: guardians[3].node.key, txid: guardians[3].bond.txid, vout: guardians[3].bond.vout, record: signedRecord, ...evidence });
const dv = await holder(departedProof);
say(dv.verdict === false, `a proof against the DEPARTED guardian: ${dv.verdict}, ${dv.why}`);

// ---- each seated guardian's bond started with its presig and the FROST census key, committing to H(TheftProof)
const fundFee = () => {
  const payer = person(), leafScript = new Uint8Array([0x20, ...payer.key, 0xac]), leaf = tapLeafHash(leafScript);
  const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, leaf)), script = fromHex(`5120${toHex(q.outputKey)}`);
  const txid = cli('sendtoaddress', JSON.parse(cli('decodescript', toHex(script))).address, '0.00002');
  mine(1);
  const vout = JSON.parse(cli('gettransaction', txid, 'true', 'true')).decoded.vout.find((o) => o.scriptPubKey.hex === toHex(script)).n;
  return { payer, leafScript, leafHash: leaf, control: new Uint8Array([TAPLEAF_VERSION | q.parity, ...HOLD_INTERNAL_KEY]), txid: fromHex(txid).reverse(), vout, value: 2000n, script };
};
const starts = [];
const fees = listed.map(() => fundFee());           // every filer's fee coin first, so the starts go into one block
for (const [k, row] of listed.entries()) {
  const g = guardians.find((x) => toHex(x.node.key) === row.node), bytes = seat.theftProof(row.proof), proofId = theftProofId(bytes);
  const fee = fees[k];
  const { tx, prevouts } = buildSlashStart({ bond: g.bond, holdScript: g.hold.script, proofId, slashHeight: tip(), hint: new TextEncoder().encode('arena'), fee });
  // A HOLDER'S CHECK, as slash-start-run.js makes it: the start, then the proof on its own judge (a holder that never audited that federation: the bytes alone)
  const c = checkSlashStart({ tx, prevouts, bond: g.bond, nodeKey: g.node.key, censusKey, holds: [{ script: g.hold.script }], presig: g.presig, proofId, verify: (s, m, k) => schnorr.verify(s, m, k) });
  const other = checker(); await other.restore(inviteFederationId);
  const j = await judge(other)(bytes);
  if (!c.ok || j.verdict !== true) { say(false, `guardian ${g.i}: the holder refuses: ${c.why || j.why}`); continue; }
  const feeWitness = scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 1, leafHash: fee.leafHash }), fee.payer.secret)], script: fee.leafScript, controlBlock: fee.control });
  const raw = toHex(signedSlashStart({ tx, nodeKey: g.node.key, censusKey, censusSignature: censusSign(c.digest), presig: g.presig, control: controlBlockFor('slash', g.built).controlBlock, feeWitness }));
  const r = accept(raw);
  say(r.allowed === true, `guardian ${g.i}: start ${r.allowed ? 'accepted' : `refused ${r['reject-reason']}`}, ${r.vsize} vB, the holder's judge: ${j.why.slice(0, 80)}`);
  cli('sendrawtransaction', raw);
  starts.push({ g, raw, bytes, proofId });
}
mine(1);
const startHeight = tip();
for (const s of starts) {
  const txid = JSON.parse(cli('decoderawtransaction', s.raw)).txid, conf = JSON.parse(cli('getrawtransaction', txid, 'true')).confirmations;
  const said = arbitrationCommitmentIn(parseTransaction(fromHex(s.raw)).outputs);
  started.set(`${toHex(s.g.bond.txid)}:${s.g.bond.vout}`, startHeight);
  say(conf === 1 && toHex(said.proofId) === toHex(s.proofId) && !(JSON.parse(cli('gettxout', toHex(Uint8Array.from(s.g.bond.txid).reverse()), String(s.g.bond.vout)) || 'null')),
    `guardian ${s.g.i}: start ${txid.slice(0, 16)} mined (${conf} conf), OP_RETURN names H(TheftProof) ${toHex(said.proofId).slice(0, 16)}, the bond output spent into its hold`);
}

// ---- the node's own pass at its return clock: kept while the proof holds, a wait where its seat cannot verify, never a return on a guess
mine(clocks.returnBlocks);
const g0 = starts[0];
const seen = readSlashStart(fromHex(g0.raw), g0.g.bond, new Map([[toHex(g0.g.hold.script), g0.g.hold]]));
const pass = async (s) => decideReturn({ start: seen, startHeight, bondMaturity: MATURITY, returnBlocks: clocks.returnBlocks, tip: tip(), fetchProof: async () => g0.bytes,
  proofChecks: async (bytes, { startHeight: at }) => (await judge(s)(bytes, { startHeight: at })).verdict });
const keep = await pass(seat);
say(keep.action === 'keep', `guardian ${g0.g.i}'s node at the return clock (${clocks.returnBlocks} blocks), its seat verifies the proof: ${keep.action}`);
const blind = checker(async () => undefined); await blind.restore(inviteFederationId);
const wait = await pass(blind);
say(wait.action === 'wait', `the same with no session verifier on its seat: ${wait.action}, ${wait.why}`);
const nomark = checker(async (input) => ({ ...(await verifier(input)), firstInflationSession: null })); await nomark.restore(inviteFederationId);
const back = await pass(nomark);
say(back.action === 'return', `the same where the sessions show no inflation: ${back.action} (the start was false)`);

console.log(`#1093 ${asked - wrong} of ${asked} as expected; tip ${tip()}; ${starts.length} guardian bonds started on one mark; the release to the liquidation escrow is not built (see kanban #1093)`);
process.exit(wrong ? 1 : 0);
