#!/usr/bin/env node
// FEDERATION.md REHEARSAL 14, ABANDONMENT TO SLASH (§23A.4-5, kanban #326), on a private regtest - never testnet4, never a
// live bond. Two federations of 4 guardians (3 of 4), no guardian in both (#320), in a census of 8 bonded nodes:
//
//   A  guardian A4 stops. A1-A3 sign absence attestations for abandon_blocks; they make the abandonment proof (absence.js);
//      the arbitration keys, k of m, commit it in a slashing transaction (OP_RETURN = H(proof) || slash_height) that moves
//      A4's bond into the liquidation escrow; the federation goes CLOSED with nothing lost, and the escrow is paid out:
//      75 % evenly to the census nodes active at the slash height less A's four guardians, 25 % to the donation set.
//   B  guardian B3 posts a departure notice (leave_after >= posted + departure_notice), serves to leave_after and stops;
//      B1, B2, B4 attest the absence from leave_after: the proof stands, and the slash is refused - DEPARTED, his bond
//      unspent, so he stays a bonded census node. The same absence begun one block before leave_after is abandonment.
//
// One JSON line per question; it decides nothing.
//
//   bitcoind -regtest -datadir=DIR -port=29444 -rpcport=29443 -fallbackfee=0.0001 -daemon
//   RT=DIR RPCPORT=29443 BITCOIN_CLI=.../bitcoin-cli node tools/rehearsal-14.mjs     (from packages/arena-node)
import { execFileSync } from 'node:child_process';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { bondOutputKey, bondInternalKey, slashLeaf, tapLeafHash, controlBlockFor, maturityHeightFor } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import {
  escrowOutput, arbitrationSpend, arbitrationSighash, arbitrationWitness, arbitrationTransaction, arbitrationCommitmentIn, escrowSplitSpend,
} from '../../arena-protocol/src/arbitration-tx.js';
import { signAbsence, abandonmentProof, signDeparture, departureStands } from '../../arena-protocol/src/absence.js';
import { guardianSlashStands, guardianSlashPayees, clocksFor } from '../../arena-protocol/src/federation-slash.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';

const RT = process.env.RT, PORT = process.env.RPCPORT || '29443', B = process.env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';
if (!RT) throw new Error('RT=<the private regtest datadir>');
const cli = (...a) => execFileSync(B, ['-regtest', `-datadir=${RT}`, `-rpcport=${PORT}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const out = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
const big = (b) => BigInt('0x' + toHex(b));
const tweakPoint = (P, t) => {
  const Q = schnorr.utils.lift_x(big(P)).add(secp256k1.Point.BASE.multiply(big(t)));
  return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) };
};
const combine = (terms) => {
  let sum = null;
  for (const { key, coefficient } of terms) {
    const p = schnorr.utils.lift_x(big(key)).multiply(big(coefficient));
    sum = sum === null ? p : sum.add(p);
  }
  return schnorr.utils.pointToBytes(sum);
};
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
try { cli('loadwallet', 'rehearse14'); } catch { try { cli('createwallet', 'rehearse14'); } catch { /* loaded */ } }
const mine = (n) => JSON.parse(cli('generatetoaddress', String(n), cli('getnewaddress')));
if (Number(cli('getblockcount')) < 101) mine(101);
const height = () => Number(cli('getblockcount'));
const { clocks } = clocksFor('regtest');

// ---- the arbitration set, as arbitration-regtest.mjs keys it
const g = genesisFor('regtest');
const K = g.arbitrationK;
const secrets = new Map();
for (let i = 0; i < g.arbitrationM; i++) {
  const secret = taggedHash('BLWP/v1/TestArbitration', new TextEncoder().encode(`bitcoin-regtest:${i}`));
  secrets.set(toHex(schnorr.getPublicKey(secret)), secret);
}
const sorted = [...g.arbitrationKeys].sort((a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });
const signBy = (count) => (h) => new Map(sorted.slice(0, count).map((k) => [toHex(k), schnorr.sign(h, secrets.get(toHex(k)))]));
const accepts = (hex) => { const r = JSON.parse(cli('testmempoolaccept', JSON.stringify([hex])))[0]; return { allowed: r.allowed, why: r['reject-reason'] || null }; };

// ---- eight bonded census nodes; federations A and B of four guardians each
const node = (name) => { const secret = taggedHash('ARENA/v1/Rehearsal14', new TextEncoder().encode(name)); return { name, secret, key: schnorr.getPublicKey(secret) }; };
const nodes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'].map(node);
const peerKey = (n) => Uint8Array.from([2, ...taggedHash('ARENA/v1/Rehearsal14Peer', n.key)]);
const recordOf = (name, members) => ({ federationId: taggedHash('ARENA/v1/Rehearsal14Fed', new TextEncoder().encode(name)), threshold: 3,
  guardians: members.map((n) => ({ nodePubkey: n.key, peerKey: peerKey(n), node: n })) });
const A = recordOf('A', nodes.slice(0, 4));
const Bf = recordOf('B', nodes.slice(4, 8));
out({ step: 'census', nodes: nodes.map((n) => `${n.name} ${toHex(n.key).slice(0, 8)}`), A: A.guardians.map((x) => x.node.name), B: Bf.guardians.map((x) => x.node.name),
  threshold: '3 of 4', clocks });

const bondOf = (n) => {
  const bondMaturity = maturityHeightFor(height(), 'regtest', { slackBlocks: 0 });
  const built = bondOutputKey({ nodeKey: n.key, arbitrationKeys: g.arbitrationKeys, arbitrationK: K, bondMaturity,
    internalKey: bondInternalKey({ nodeKey: n.key, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
  const spk = fromHex('5120' + toHex(built.outputKey));
  const txid = cli('sendtoaddress', JSON.parse(cli('decodescript', toHex(spk))).address, '1.0');
  return { n, built, spk, txid };
};
const bonds = new Map(nodes.map((n) => [n.name, bondOf(n)]));
mine(1);
for (const b of bonds.values()) {
  b.vout = JSON.parse(cli('gettransaction', b.txid, 'true', 'true')).decoded.vout.find((o) => o.scriptPubKey.hex === toHex(b.spk)).n;
  b.bond = { txid: fromHex(b.txid).reverse(), vout: b.vout, value: 100000000n, script: b.spk };
}
const unspent = (b) => JSON.parse(cli('gettxout', b.txid, String(b.vout)) || 'null') !== null;
out({ step: 'bonds funded', sats: 100000000, unspent: [...bonds.values()].filter(unspent).length, of: bonds.size, height: height() });

// ---- A: guardian A4 (n4) stops; A1-A3 attest for abandon_blocks
const a4 = A.guardians[3];
const lastSeen = height();
mine(clocks.abandonBlocks);
const attest = (rec, attester, peer, from, at) => signAbsence({ federationId: rec.federationId, peerKey: peer.peerKey, lastSeenHeight: from, height: at, attester: attester.nodePubkey },
  (h) => schnorr.sign(h, attester.node.secret));
const atts = A.guardians.slice(0, 3).map((x) => attest(A, x, a4, lastSeen, height()));
const two = abandonmentProof(atts.slice(0, 2), { record: A, peerKey: a4.peerKey, abandonBlocks: clocks.abandonBlocks, verify });
const short = abandonmentProof([attest(A, A.guardians[0], a4, lastSeen, height() - 1), ...atts.slice(1)], { record: A, peerKey: a4.peerKey, abandonBlocks: clocks.abandonBlocks, verify });
const proof = abandonmentProof(atts, { record: A, peerKey: a4.peerKey, abandonBlocks: clocks.abandonBlocks, verify });
out({ step: 'A: abandonment proof', twoAttest: two.ok ? 'stands' : two.why, oneSpanShort: short.ok ? 'stands' : short.why,
  threeAttest: proof.ok ? 'stands' : proof.why, signers: proof.signers, since: proof.sinceHeight, id: proof.ok ? toHex(proof.id).slice(0, 16) : null });
const decide = guardianSlashStands({ proof });
out({ step: 'A: slash decision', slash: decide.slash, kind: decide.kind, why: decide.why });

// ---- the slashing transaction: A4's bond into the liquidation escrow, the proof committed
const b4 = bonds.get('n4');
const escrow = escrowOutput({ arbitrationKeys: g.arbitrationKeys, k: K }, { tweakPoint, combine });
const feeSats = 3000n;
// the whole bond waits in the escrow (§23A.5: "a slashed bond never goes straight to anybody"); the fee is the nodes' part
// arbitrationSpend takes it from - here exactly the fee, so no nodes' output is made
const distribution = { playerShares: new Map([['escrow', b4.bond.value - feeSats]]), nodeShares: new Map(), pool: { nodes: feeSats, developers: 0n }, toDevelopers: 0n };
const leaf = tapLeafHash(slashLeaf(g.arbitrationKeys, K));
const control = controlBlockFor('slash', b4.built).controlBlock;
const slashTx = (signers) => {
  const built = arbitrationSpend({ bond: b4.bond, proofId: proof.id, slashHeight: height(), hint: new TextEncoder().encode('r14'), distribution,
    escrowScript: escrow.script, nodesScript: null, developersScript: null, feeSats });
  if (!built.ok) return { why: built.why };
  const h = arbitrationSighash(built, leaf);
  const w = arbitrationWitness({ arbitrationKeys: g.arbitrationKeys, k: K, signatures: signBy(signers)(h), controlBlock: control });
  if (!w.ok) return { why: w.why };
  return { built, hex: toHex(arbitrationTransaction(built, w.witness)) };
};
const st = slashTx(K);
if (!st.hex) { out({ step: 'A: slashing transaction NOT built', why: st.why }); process.exit(1); }
out({ step: `A: slashing transaction, ${K} of ${g.arbitrationM}`, outputs: st.built.tx.outputs.map((o) => ({ pays: o.pays || 'commitment', sats: o.value })),
  under: slashTx(K - 1).why || 'built', ...accepts(st.hex) });
const slashTxid = cli('sendrawtransaction', st.hex);
const slashBlock = mine(1)[0];
const dec = JSON.parse(cli('getrawtransaction', slashTxid, 'true', slashBlock));
const read = arbitrationCommitmentIn(dec.vout.map((o) => ({ script: fromHex(o.scriptPubKey.hex) })));
out({ step: 'A: slash mined', txid: slashTxid, locktime: dec.locktime, committedHeight: read && read.slashHeight,
  committedProof: !!read && toHex(read.proofId) === toHex(proof.id), a4BondSpent: !unspent(b4) });

// ---- A CLOSED, nothing lost: the escrow pays the census less A's guardians, 75 %, and the donation set, 25 %
const escrowVout = dec.vout.findIndex((o) => o.scriptPubKey.hex === toHex(escrow.script));
const esc = { txid: fromHex(slashTxid).reverse(), vout: escrowVout, value: b4.bond.value - feeSats, script: escrow.script };
const payFee = 2000n;
const payees = guardianSlashPayees({ amountSats: esc.value - payFee, censusNodes: nodes.map((n) => n.key), record: A });
const donationSecret = taggedHash('ARENA/v1/Rehearsal14Donation', new Uint8Array(1));
const donationScript = fromHex('5120' + toHex(schnorr.getPublicKey(donationSecret)));
const nodeScript = (keyHex) => fromHex('5120' + keyHex);
const split = escrowSplitSpend({ escrow: esc, feeSats: payFee,
  payees: [...payees.nodes.map((p) => ({ script: nodeScript(p.key), sats: p.sats, pays: nodes.find((n) => toHex(n.key) === p.key).name })), { script: donationScript, sats: payees.developers, pays: 'donation set' }] });
const signEscrow = (signers) => {
  const h = tapSighash({ ...split.tx, prevouts: split.prevouts, inputIndex: 0, leafHash: escrow.leaf });
  const sigs = signBy(signers)(h);
  const stack = sorted.map((k) => sigs.get(toHex(k)) || new Uint8Array(0)).reverse();
  return toHex(serializeSpend({ ...split.tx, witnesses: [scriptPathWitness({ stack, script: escrow.leafScript, controlBlock: escrow.controlBlock })] }));
};
out({ step: 'A: escrow paid out on CLOSED', escrowSats: esc.value, guardiansLeftOut: payees.guardiansLeftOut,
  outputs: split.tx.outputs.map((o) => ({ pays: o.pays, sats: o.value })), nodesShare: payees.nodes.reduce((a, p) => a + p.sats, 0n), donationShare: payees.developers,
  [`by ${K - 1} of ${g.arbitrationM}`]: accepts(signEscrow(K - 1)), [`by ${K} of ${g.arbitrationM}`]: accepts(signEscrow(K)) });
const payTxid = cli('sendrawtransaction', signEscrow(K));
const payBlock = mine(1)[0];
const paid = JSON.parse(cli('getrawtransaction', payTxid, 'true', payBlock));
out({ step: 'A: payout mined', txid: payTxid, confirmations: paid.confirmations,
  received: paid.vout.map((o) => ({ to: split.tx.outputs[o.n].pays, sats: Math.round(o.value * 1e8) })),
  total: Math.round(paid.vout.reduce((a, o) => a + o.value, 0) * 1e8), fees: Number(feeSats + payFee), bond: 100000000 });

// ---- B: guardian B3 (n6) gives notice, serves to leave_after, stops
const b3 = Bf.guardians[2];
const postedAt = height();
const notice = signDeparture({ federationId: Bf.federationId, peerKey: b3.peerKey, leaveAfterHeight: postedAt + clocks.departureNotice, postedAt, nodePubkey: b3.nodePubkey },
  (h) => schnorr.sign(h, b3.node.secret));
const tooShort = departureStands(signDeparture({ ...notice, leaveAfterHeight: postedAt + clocks.departureNotice - 1, signature: undefined }, (h) => schnorr.sign(h, b3.node.secret)),
  { record: Bf, departureNotice: clocks.departureNotice, verify });
const stands = departureStands(notice, { record: Bf, departureNotice: clocks.departureNotice, verify });
out({ step: 'B: departure notice', postedAt, leaveAfter: notice.leaveAfterHeight, stands: stands.ok, oneBlockShort: tooShort.ok ? 'stands' : tooShort.why });
mine(clocks.departureNotice);
const leftAt = height();
mine(clocks.abandonBlocks);
const others = Bf.guardians.filter((x) => x !== b3);
const bProof = abandonmentProof(others.map((x) => attest(Bf, x, b3, leftAt, height())), { record: Bf, peerKey: b3.peerKey, abandonBlocks: clocks.abandonBlocks, verify });
const bDecide = guardianSlashStands({ proof: bProof, departure: stands });
const early = abandonmentProof(others.map((x) => attest(Bf, x, b3, notice.leaveAfterHeight - 1, height())), { record: Bf, peerKey: b3.peerKey, abandonBlocks: clocks.abandonBlocks, verify });
const earlyDecide = guardianSlashStands({ proof: early, departure: stands });
const b6 = bonds.get(b3.node.name);
out({ step: 'B: gone after leave_after', attested: bProof.ok, since: bProof.sinceHeight, slash: bDecide.slash, kind: bDecide.kind, why: bDecide.why });
out({ step: 'B: the same absence one block before leave_after', slash: earlyDecide.slash, kind: earlyDecide.kind });
out({ step: `B: the departed guardian's bond (${b3.node.name})`, bondUnspent: unspent(b6), sats: 100000000,
  censusSeat: unspent(b6) ? 'kept: its bond is unspent, and the census counts unspent bonds (§5A.2)' : 'lost', otherBondsUnspent: [...bonds.values()].filter((b) => b !== b4 && unspent(b)).length, of: bonds.size - 1, height: height() });
