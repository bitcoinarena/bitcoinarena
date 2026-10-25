#!/usr/bin/env node
// THE LIVE SLASH ON TESTNET4 (FEDERATION.md rehearsal 14 live, kanban #326, 2026-10-15 17:39: "liquidations and slashing must be
// tested on testnet. Regtest is not enough"; option 1: the throwaway federation T2, never A or B). rehearsal-14.mjs builds the same
// transaction on a private regtest; this reads everything from the live network instead:
//
//   1. the federation's record, as its seats hold it (GET /federations) - the guardian named by NODE and its peer key;
//   2. the absence attestations the seats hold for that peer (GET /absences), made into the abandonment proof at testnet4's
//      abandon_blocks (12); the slash decision (guardianSlashStands: ABANDONED, not DEPARTED);
//   3. the guardian's bond on chain (gettxout BOND), rebuilt from its node key and MATURITY and checked to be that output;
//   4. the slashing transaction: the bond through its slash leaf, k of m testnet4 arbitration keys (the derivable test set),
//      OP_RETURN = H(proof) || slash_height, the whole bond less the fee into the liquidation escrow.
//
// Without --publish it builds and checks the transaction (testmempoolaccept) and broadcasts nothing.
//
//   SEATS=<url,...> FED=<federation hex> NODE=<guardian node key hex> BOND=<txid:vout> MATURITY=<height> [FEE_SATS=3000]
//   [BITCOIN_CLI=...] [BTC_DATADIR=/mnt/bitcoin/tn4] node tools/slash-testnet4.mjs [--publish]
import { execFileSync } from 'node:child_process';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { bondOutputKey, bondInternalKey, slashLeaf, tapLeafHash, controlBlockFor } from '../../arena-protocol/src/bond-script.js';
import { escrowOutput, arbitrationSpend, arbitrationSighash, arbitrationWitness, arbitrationTransaction } from '../../arena-protocol/src/arbitration-tx.js';
import { abandonmentProof } from '../../arena-protocol/src/absence.js';
import { guardianSlashStands, clocksFor } from '../../arena-protocol/src/federation-slash.js';
import { splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { readAbsenceHex } from '../src/absences.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';

const env = process.env;
for (const k of ['SEATS', 'FED', 'NODE', 'BOND', 'MATURITY']) if (!env[k]) throw new Error(`${k} is needed`);
const publish = process.argv.includes('--publish');
const B = env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli', DIR = env.BTC_DATADIR || '/mnt/bitcoin/tn4';
const cli = (...a) => execFileSync(B, [`-datadir=${DIR}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const out = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
const big = (b) => BigInt('0x' + toHex(b));
const tweakPoint = (P, t) => { const Q = schnorr.utils.lift_x(big(P)).add(secp256k1.Point.BASE.multiply(big(t))); return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) }; };
const combine = (terms) => { let sum = null; for (const { key, coefficient } of terms) { const p = schnorr.utils.lift_x(big(key)).multiply(big(coefficient)); sum = sum === null ? p : sum.add(p); } return schnorr.utils.pointToBytes(sum); };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const seats = env.SEATS.split(',').map((s) => s.replace(/\/+$/, ''));
const FED = env.FED.toLowerCase(), NODE = env.NODE.toLowerCase();
const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); };

if (cli('getblockchaininfo').includes('"chain": "testnet4"') === false) throw new Error('this bitcoind is not testnet4: nothing is built');
const height = Number(cli('getblockcount'));
const g = genesisFor('testnet4');
const { clocks } = clocksFor('testnet4');

// 1. THE RECORD
let record = null;
// A SEAT SERVES ITS RECORD SIGNED (body ‖ count ‖ signatures): measured 2026-10-21 on T2's seats, a bare decode threw "trailing bytes"
// on every seat and the tool said no seat held a record
for (const s of seats) {
  try { const f = (await get(`${s}/federations`)).federations.find((x) => x.federation === FED && x.record); if (f) { record = splitSignedRecord(fromHex(f.record)).record; break; } } catch { /* the next seat */ }
}
if (!record) { out({ step: 'refused', why: `no seat of ${seats.length} holds a record of ${FED.slice(0, 8)}` }); process.exit(2); }
const guardian = record.guardians.find((x) => toHex(x.nodePubkey) === NODE);
if (!guardian) { out({ step: 'refused', why: `node ${NODE.slice(0, 8)} is no guardian of ${FED.slice(0, 8)}` }); process.exit(2); }
out({ step: 'record', federation: FED.slice(0, 16), status: record.status, threshold: record.threshold, guardians: record.guardians.length, peer: toHex(guardian.peerKey).slice(0, 18), recordHeight: record.height });

// 2. THE ABSENCES AND THE PROOF
const held = new Map();
for (const s of seats) {
  try { for (const h of (await get(`${s}/absences?federation=${FED}`)).absences) { const a = readAbsenceHex(h); if (toHex(a.peerKey) === toHex(guardian.peerKey)) held.set(`${toHex(a.attester)}:${a.height}`, a); } } catch { /* the next seat */ }
}
// the latest attestation per attester
const latest = new Map(); for (const a of held.values()) { const k = toHex(a.attester); if (!latest.has(k) || latest.get(k).height < a.height) latest.set(k, a); }
const atts = [...latest.values()];
const proof = abandonmentProof(atts, { record, peerKey: guardian.peerKey, abandonBlocks: clocks.abandonBlocks, verify });
out({ step: 'abandonment proof', attestations: atts.map((a) => ({ by: toHex(a.attester).slice(0, 8), lastSeen: a.lastSeenHeight, at: a.height })), abandonBlocks: clocks.abandonBlocks,
  stands: proof.ok, why: proof.ok ? null : proof.why, signers: proof.signers, since: proof.sinceHeight, id: proof.ok ? toHex(proof.id) : null });
if (!proof.ok) process.exit(2);
const decide = guardianSlashStands({ proof });
out({ step: 'slash decision', slash: decide.slash, kind: decide.kind, why: decide.why });
if (!decide.slash) process.exit(2);

// 3. THE BOND
const [btxid, bvoutS] = env.BOND.split(':'); const bvout = Number(bvoutS);
const txo = JSON.parse(cli('gettxout', btxid, String(bvout)) || 'null');
if (!txo) { out({ step: 'refused', why: `${env.BOND} is spent or unknown` }); process.exit(2); }
const nodeKey = fromHex(NODE), maturity = Number(env.MATURITY);
const built = bondOutputKey({ nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: maturity,
  internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
const spk = '5120' + toHex(built.outputKey);
const value = BigInt(Math.round(Number(txo.value) * 1e8));
out({ step: 'bond', outpoint: env.BOND, sats: value, confirmations: txo.confirmations, maturity, rebuilt: spk === txo.scriptPubKey.hex });
if (spk !== txo.scriptPubKey.hex) { out({ step: 'refused', why: 'the bond rebuilt from the node key and maturity is not that output' }); process.exit(2); }

// 4. THE SLASHING TRANSACTION, k of m test arbitration keys
const K = g.arbitrationK;
const secrets = new Map();
for (let i = 0; i < g.arbitrationM; i++) { const s = taggedHash('BLWP/v1/TestArbitration', new TextEncoder().encode(`bitcoin-testnet4:${i}`)); secrets.set(toHex(schnorr.getPublicKey(s)), s); }
const known = g.arbitrationKeys.filter((k) => secrets.has(toHex(k)));
if (known.length < K) { out({ step: 'refused', why: `only ${known.length} of the genesis arbitration keys are the derivable test keys, ${K} sign` }); process.exit(2); }
const feeSats = BigInt(env.FEE_SATS || 3000);
const escrow = escrowOutput({ arbitrationKeys: g.arbitrationKeys, k: K }, { tweakPoint, combine });
const bond = { txid: fromHex(btxid).reverse(), vout: bvout, value, script: fromHex(spk) };
const distribution = { playerShares: new Map([['escrow', value - feeSats]]), nodeShares: new Map(), pool: { nodes: feeSats, developers: 0n }, toDevelopers: 0n };
const spend = arbitrationSpend({ bond, proofId: proof.id, slashHeight: height, hint: new TextEncoder().encode('326'), distribution, escrowScript: escrow.script, nodesScript: null, developersScript: null, feeSats });
if (!spend.ok) { out({ step: 'refused', why: spend.why }); process.exit(2); }
const sighash = arbitrationSighash(spend, tapLeafHash(slashLeaf(g.arbitrationKeys, K)));
const signatures = new Map(known.slice(0, K).map((k) => [toHex(k), schnorr.sign(sighash, secrets.get(toHex(k)))]));
const w = arbitrationWitness({ arbitrationKeys: g.arbitrationKeys, k: K, signatures, controlBlock: controlBlockFor('slash', built).controlBlock });
if (!w.ok) { out({ step: 'refused', why: w.why }); process.exit(2); }
const hex = toHex(arbitrationTransaction(spend, w.witness));
const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([hex])))[0];
out({ step: `slashing transaction, ${K} of ${g.arbitrationM}`, slashHeight: height, escrowSats: value - feeSats, feeSats, escrowScript: toHex(escrow.script).slice(0, 20),
  mempoolAccept: accept.allowed, why: accept['reject-reason'] || null, txid: accept.txid });
if (!accept.allowed || !publish) { out({ published: false, why: publish ? 'refused by the mempool' : 'no --publish: built and checked, nothing broadcast' }); process.exit(accept.allowed ? 0 : 1); }
out({ published: true, txid: cli('sendrawtransaction', hex), at: new Date().toISOString() });
