#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// GUARDIAN BONDS PAY A LIQUIDATION'S CLAIMS, ASKED OF BITCOIND (kanban #1093 part 2, ruling #1111). A private regtest, bitcoind only, never testnet4, never a live bond.
//
// Four census-key holders run the node's own slash-release-run.js (its roundless fallback and liquidation-escrow-run.js) against this bitcoind; the census key is a FROST key
// (degree 3, five shares over four holders) and every census-key signature is gathered by the node's census-sign.js. Three cases:
//   A  an ABANDONED guardian's template-3 bond: start, census-key fallback to the roundless table, census-key escrow, the liquidation spend to a carrier's peg-in, the claims paid at face
//   B  a theft's two template-3 bonds of one federation: both escrows, spent one at a time, the second paying what the first could not
//   C  one template-2 bond in the mix: path B into the arbitration set's escrow (the rehearsal-17 code), the claims ledger (liquidation-claims.js) paying from it first, the
//      census-key escrow of a template-3 bond paying only what is left
// Without FEDS: no Fedimint federation. The carriers' "safe federation" clients are stand-ins - a peg-in address is a wallet address of this bitcoind and a claim is what
// that address received, a payout is recorded, not collected; the claims are the ledger's, not real notes; the holders' own bonds are census entries, not outputs.
// WITH FEDS=<dir>/feds.json (tools/liquidation-fedimint-e2e.mjs up, then halt): two real federations on this bitcoind. Case A's federation is R, halted, and its
// claims are the player's real notes of R, presented to the claims ledger (liquidation-claims.js, note-validate.js against a client of R joined while it was OPEN);
// the safe federation is S, every carrier a real client of it (stake-lock-port.js: pegin-address, pegin-claim, pay), and the player collects each payout to its key
// in its own client of S (arena-stake-lock --mode redeem --witness refund). Cases B and C pay through the same real carriers. The holders' bonds stay census entries.
//
//   bitcoind -regtest -datadir=DIR -port=P -rpcport=R -listen=0 -fallbackfee=0.0001 -txindex=1 -daemon
//   RT=DIR RPCPORT=R BITCOIN_CLI=.../bitcoin-cli node tools/liquidation-regtest.mjs          (from packages/arena-node)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { SLASH_CLOCKS, genesisFor } from '../../arena-protocol/src/genesis.js';
import { CARRIER_PAYOUT_MARGIN_MSAT } from '../../arena-protocol/src/genesis.js';
import { bond3OutputKey, bondInternalKey, bondOutputKey, controlBlockFor, holdOutputKey, tapLeafHash, tapTweak, HOLD_INTERNAL_KEY, TAPLEAF_VERSION } from '../../arena-protocol/src/bond-script.js';
import { scriptPathWitness, tapSighash } from '../../arena-protocol/src/bond-spend.js';
import { buildSlashStart, signedSlashStart, slashStartDigest } from '../../arena-protocol/src/slash-start.js';
import { slashPresigDigest } from '../../arena-protocol/src/slash-presig.js';
import { encodeAbandonedProof, abandonedProofId } from '../../arena-protocol/src/abandoned-slash.js';
import { encodeTheftProof } from '../../arena-protocol/src/theft-slash.js';
import { decodeSlashPayoutTable } from '../../arena-protocol/src/slash.js';
import { escrowOutput } from '../../arena-protocol/src/arbitration-tx.js';
import { decodeLiquidationClaims, decodeLiquidationEscrowOutputs, isRoundless, liquidationSlices } from '../../arena-protocol/src/liquidation-escrow.js';
import { REGTEST_CLOCKS } from '../../arena-protocol/src/federation-slash.js';
import { buildFederationRecord, encodeFederationRecord, joinSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint, combine } from '../src/curve.js';
import { createCensusSigner, gatherCensusSignature } from '../src/census-sign.js';
import { censusKeyWork } from '../src/census-key-work.js';
import { createSlashRelease } from '../src/slash-release-run.js';
import { createProofJudge } from '../src/proof-judge.js';
import { createLiquidationClaims } from '../src/liquidation-claims.js';
import { arbitrationMembers, buildAbandonedSlash, assemble, memberSign } from '../src/arbiter.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { fedimintNoteValidator } from '../src/note-validate.js';

const E2E = process.env.FEDS ? JSON.parse(readFileSync(process.env.FEDS, 'utf8')) : null;
const RT = E2E ? E2E.btcDir : process.env.RT, PORT = E2E ? String(E2E.rpcPort) : (process.env.RPCPORT || '29932'), B = E2E ? E2E.bitcoinCli : (process.env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli');
if (!RT) throw new Error('RT=<the private regtest datadir>');
const cli = (...a) => execFileSync(B, ['-regtest', `-datadir=${RT}`, `-rpcport=${PORT}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try { cli('loadwallet', 'liq'); } catch { try { cli('createwallet', 'liq'); } catch { /* loaded */ } }
const mine = (n) => { if (n > 0) cli('generatetoaddress', String(n), cli('getnewaddress')); };
if (Number(cli('getblockcount')) < 101) mine(101);
const tip = () => Number(cli('getblockcount'));
let wrong = 0, asked = 0;
const say = (ok, line) => { asked++; if (!ok) wrong++; console.log(`#1093 ${ok ? 'as expected' : 'WRONG      '} ${line}`); };
const display = (internal) => toHex([...internal].reverse());

const CL = SLASH_CLOCKS.mainnet;
const clocks = { holdBlocks: CL.slashHoldBlocks, returnBlocks: CL.slashReturnBlocks, fallbackBlocks: CL.slashFallbackBlocks };
const MARGIN = CARRIER_PAYOUT_MARGIN_MSAT.regtest;
// ---- THE CENSUS KEY: degree 3, five shares, four holders (the first holds two) ----
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const tag = (s) => taggedHash('ARENA/regtest/Liquidation', new TextEncoder().encode(s));
const sc = (b) => BigInt(`0x${toHex(b)}`) % N;
const dealt = (() => {
  let a0 = sc(tag('a0'));
  if (secp256k1.getPublicKey(tag('a0'), true)[0] === 3) a0 = N - a0;
  const co = [a0, sc(tag('a1')), sc(tag('a2')), sc(tag('a3'))];
  return { publicKey: schnorr.getPublicKey(tag('a0')), share: (x) => co.reduce((sum, c, i) => (sum + c * BigInt(x) ** BigInt(i)) % N, 0n) };
})();
const censusKey = dealt.publicKey, censusHex = toHex(censusKey);
const person = (s) => { const secret = tag(s); return { secret, key: schnorr.getPublicKey(secret), hex: toHex(schnorr.getPublicKey(secret)) }; };
const holders = [[person('h1'), [1, 2]], [person('h2'), [3]], [person('h3'), [4]], [person('h4'), [5]]];
const holderList = holders.map(([p, xs]) => ({ key: p.hex, shares: xs.length }));
const fedSafe = E2E ? E2E.safe.id : 'fa'.repeat(32), fedOther = 'fb'.repeat(32);
// a reserve key and a claim's payout key are real points: a real federation's payout contract takes nothing else
const reserveKey = (fid) => secp256k1.getPublicKey(tag(`reserve-${fid}`), true);
const knownFeds = () => (E2E ? [fed(fedSafe, 1000)] : [fed(fedSafe, 1000), fed(fedOther, 50_000_000)]);
const fed = (id, reserve) => ({ federation: id, status: 'OPEN', reserveKey: toHex(reserveKey(id)), reserveSats: String(reserve), exposureCapSats: '100000000' });

// ---- THE CHAIN, AS A SEAT READS IT ----
const chain = {
  txOut: async (txid, vout) => { const o = JSON.parse(cli('gettxout', txid, String(vout), 'false') || 'null'); return o ? { sats: BigInt(Math.round(o.value * 1e8)), script: o.scriptPubKey.hex, confirmations: o.confirmations } : null; },
  rawTx: async (txid) => { try { return fromHex(cli('getrawtransaction', txid)); } catch { return null; } },
  send: async (hex) => { const r = JSON.parse(cli('testmempoolaccept', JSON.stringify([hex])))[0]; if (!r.allowed) throw new Error(r['reject-reason']); return cli('sendrawtransaction', hex); },
};
const fundScript = (script, btc) => {
  const txid = cli('sendtoaddress', JSON.parse(cli('decodescript', toHex(script))).address, btc);
  mine(1);
  const vout = JSON.parse(cli('gettransaction', txid, 'true', 'true')).decoded.vout.find((o) => o.scriptPubKey.hex === toHex(script)).n;
  return { txid: fromHex(txid).reverse(), vout, value: BigInt(Math.round(Number(btc) * 1e8)), script, height: tip() };
};

// ---- THE WORLD: four seats on this chain ----
const ledgers = new Map();                          // liquidating federation -> () => ledger
const census = { entries: [] };
const paid = [];
const lockEnv = E2E ? { ...process.env, HOME: E2E.home } : process.env;
const lockRun = (...a) => JSON.parse(execFileSync(E2E.lockBin, a, { encoding: 'utf8', env: lockEnv, timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter((l) => l.startsWith('{')).pop());
// A MINER WHILE THE CARRIERS CLAIM (FEDS only): a real federation credits a peg-in only once it is deep enough, and the claim waits on that
const carryMined = async (fn) => { if (!E2E) return fn(); const t = setInterval(() => { try { mine(1); } catch { /* next */ } }, 3000); try { return await fn(); } finally { clearInterval(t); } };
const urlOf = (k) => `http://seat-${k}`;
const seats = new Map();
const harnessStarts = new Map();                    // digest hex of a start the harness files -> true (the start is slash-start-run.js's job, measured in theft-regtest.mjs)
const answer = (body, status = 200) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
const fetchFn = async (url, init = {}) => {
  const u = new URL(url), s = seats.get(u.host.slice(5));
  if (!s) return answer({ why: 'no such seat' }, 404);
  if (u.pathname === '/census-sign/commit') return answer(await s.signer.takeCommit(JSON.parse(init.body)));
  if (u.pathname === '/census-sign/share') return answer(await s.signer.takeShare(JSON.parse(init.body)));
  if (u.pathname === '/slash-release') return answer(s.run.served(u.searchParams.get('start')));
  const carriers = /^\/slash\/([0-9a-f]{64})\/carriers$/.exec(u.pathname);
  if (carriers && init.method === 'POST') { const t = await s.run.takeCarrierPegIn(carriers[1], JSON.parse(init.body)); return answer(t, t.ok ? 200 : t.status); }
  if (carriers) return answer(s.run.servedCarriers(carriers[1]));
  return answer({}, 404);
};
const proofs = new Map();                           // proof id hex -> bytes
const judge = createProofJudge({ committeeOf: () => ({ ok: false }), censusOf: () => ({ ok: false }), coreOf: () => null, beaconOf: () => ({ ok: false }), replayRunOf: () => undefined,
  abandoned: async () => ({ verdict: true, why: 'stand-in: the abandonment judge is measured in guardian-bond-spent-regtest.mjs' }),
  theft: async () => ({ verdict: true, why: 'stand-in: the theft judge is measured in theft-regtest.mjs' }) });
for (const [hi, [p, xs]] of holders.entries()) {
  const shares = { shares: new Map(xs.map((x) => [x, dealt.share(x)])) };
  const clients = new Map();
  const portOf = (fid) => {
    if (E2E) {
      if (fid !== fedSafe) return null;
      if (!clients.has(fid)) {
        const real = stakeLockPort({ bin: E2E.lockBin, dataDir: E2E.safe.carriers[hi], serve: false, timeoutMs: 120000 });
        // THE CLAIM OF ONE DEPOSIT, BY ITS OUTPOINT (kanban #1093): the run's own { outpoint, sats } passed on, with 600 s to wait. Measured 11-05 on the main test host: this
        // wrapper passed 600 in their place, so case B's second escrow was claimed by "the balance grew" and read the first one's deposit (701,593,600 msat against 900,000,000)
        clients.set(fid, { peginAddress: () => real.peginAddress(), peginClaim: (a, opts) => real.peginClaim(a, { ...(opts && typeof opts === 'object' ? opts : {}), waitS: 600 }),
          payouts: async (list) => { const r = await real.payouts(list); paid.push({ carrier: p.hex, federation: fid, list, txid: r.txid, payouts: r.payouts }); return r; } });
      }
      return clients.get(fid);
    }
    if (!clients.has(fid)) clients.set(fid, {
      // STAND-INS FOR A SAFE FEDERATION'S CLIENT: a wallet address of this bitcoind, what it received, a recorded payout
      peginAddress: async () => cli('getnewaddress'),
      peginClaim: async (address) => ({ claimedMsat: BigInt(Math.round(Number(cli('getreceivedbyaddress', address, '1')) * 1e8)) * 1000n }),
      payouts: async (list) => { paid.push({ carrier: p.hex, federation: fid, list }); return { txid: `payout-${paid.length}`, payouts: list.map((x, i) => ({ refundPk: x.key, outIdx: i })) }; } });
    return clients.get(fid);
  };
  const s = {};
  s.run = createSlashRelease({ key: p.key, secret: p.secret, networkId: NETWORK_ID_REGTEST, clocks, db: new DatabaseSync(':memory:'), tweakPoint,
    tipHeight: async () => tip(), entriesAtTip: async () => census.entries, rawTx: chain.rawTx, unspent: async (t, v) => !!(await chain.txOut(t, v)), txOut: chain.txOut,
    fetchProof: async (id) => proofs.get(toHex(id)) || null, judge, panelsOf: () => ({ ok: false }), seatsOf: async () => [], lossesFor: async () => ({ ok: false, why: 'no round' }),
    federations: async () => knownFeds(), federationsAt: async () => knownFeds(),
    portFor: async (fid) => portOf(fid), scriptOf: (address) => fromHex(JSON.parse(cli('getaddressinfo', address)).scriptPubKey), reserveKeyOf: (fid) => reserveKey(fid), urlOf,
    heldKey: (k) => (toHex(k) === censusHex ? shares : null), thresholdOf: (k) => (k === censusHex ? 4 : null), holdersOf: async (k) => (k === censusHex ? holderList : []),
    signer: () => s.signer, send: chain.send, stepMs: 0, fetchFn, log: (l) => { if (process.env.VERBOSE) console.log(`   ${p.hex.slice(0, 8)} ${l}`); },
    claimsOf: async (fid) => (ledgers.has(fid) ? ledgers.get(fid)() : null) });
  s.signer = createCensusSigner({ key: p.key, work: censusKeyWork, held: (k) => (toHex(k) === censusHex ? shares : null),
    check: (request) => (request.kind === 'harness-start' && harnessStarts.has(request.digest) ? { ok: true, digest: fromHex(request.digest), publicKey: censusKey } : s.run.checkOther(request)) });
  seats.set(p.hex, s);
}
const holderEntries = holders.map(([p], i) => ({ pubkey: p.key, txid: new Uint8Array(32).fill(0x10 + i), vout: 0, bondSats: '2000000', advert: { bondScriptTemplateVersion: 3, censusKey } }));
census.entries = [...holderEntries];
const passAll = async () => { const out = []; for (const [p] of holders) out.push(...(await seats.get(p.hex).run.pass())); return out; };
// a seat carries every 15 s (server.js carryTimer); with real federations a peg-in can still be short of its depth at one pass, so up to three passes here
const carryAll = () => carryMined(async () => {
  const out = [];
  for (let n = 0; n < (E2E ? 3 : 1); n++) {
    const before = paid.length;
    for (const [p] of holders) out.push(...(await seats.get(p.hex).run.carry()));
    const waiting = out.filter((x) => x.why);
    if (E2E && waiting.length) console.log(`#1093    carry pass ${n + 1}: ${waiting.map((x) => `${String(x.escrow).slice(0, 12)}:${x.index} ${x.why}`).join('; ')}`);
    if (E2E && n > 0 && paid.length === before && !waiting.length) break;
  }
  return out;
});

// ---- A GUARDIAN'S TEMPLATE-3 BOND, ITS BONDING PRESIG AND ITS START (by the census key, FROST) ----
async function startedGuardian(name, proofOf, btc = '0.01') {
  const node = person(`g-${name}`), owner = person(`o-${name}`), maturity = tip() + 2000;
  const built = bond3OutputKey({ nodeKey: node.key, ownerKey: owner.key, censusKey, bondMaturity: maturity }, { tweakPoint });
  const bond = fundScript(fromHex(`5120${toHex(built.outputKey)}`), btc);
  const hold = holdOutputKey({ ownerKey: owner.key, censusKey, panelA: [], panelB: [], bondMaturity: maturity, ...clocks }, { tweakPoint });
  const presig = Uint8Array.from([...schnorr.sign(slashPresigDigest({ bond, nodeKey: node.key, censusKey, holdScript: hold.script }), node.secret), 0x83]);
  const proof = proofOf({ node, bond }), proofId = taggedHash('ARENA/v1/SlashProof', proof);
  proofs.set(toHex(proofId), proof);
  const payer = person(`fee-${name}`), leafScript = new Uint8Array([0x20, ...payer.key, 0xac]), leaf = tapLeafHash(leafScript);
  const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, leaf));
  const fee = { ...fundScript(fromHex(`5120${toHex(q.outputKey)}`), '0.00002'), leafHash: leaf };
  const { tx, prevouts } = buildSlashStart({ bond, holdScript: hold.script, proofId, slashHeight: tip(), hint: new TextEncoder().encode('arena'), fee });
  const digest = slashStartDigest({ tx, prevouts, nodeKey: node.key, censusKey });
  harnessStarts.set(toHex(digest), true);
  const [h0] = holders[0];
  const got = await gatherCensusSignature({ request: { kind: 'harness-start', digest: toHex(digest) }, digest, publicKey: censusKey, threshold: 4, urls: holders.slice(1).map(([p]) => urlOf(p.hex)), own: seats.get(h0.hex).signer, fetchFn });
  if (!got.ok) throw new Error(`the census key did not sign the start: ${got.why}`);
  const feeWitness = scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 1, leafHash: leaf }), payer.secret)], script: leafScript, controlBlock: new Uint8Array([TAPLEAF_VERSION | q.parity, ...HOLD_INTERNAL_KEY]) });
  const raw = signedSlashStart({ tx, nodeKey: node.key, censusKey, censusSignature: got.signature, presig, control: controlBlockFor('slash', built).controlBlock, feeWitness });
  const txid = await chain.send(toHex(raw));
  mine(1);
  census.entries.push({ pubkey: node.key, txid: bond.txid, vout: bond.vout, bondSats: String(bond.value), script: bond.script, hold: { txid: toHex(parseTransaction(raw).txid), vout: 0, height: tip() },
    advert: { bondScriptTemplateVersion: 3, censusKey, ownerPubkey: owner.key, bondMaturityHeight: maturity } });
  return { name, node, bond, start: txid, startHeight: tip(), proofId };
}
// the proofs' record: one of that federation, unsigned - the judge here is a stand-in (see the head of this file); it only has to read
const recordOf = (fid) => joinSignedRecord(encodeFederationRecord(buildFederationRecord({ federationId: fromHex(fid), networkId: NETWORK_ID_REGTEST, invite: `fed:${fid}`, nominal: 4, height: tip(),
  reserveSats: 0n, gone: [], guardians: holders.map(([p], i) => ({ nodePubkey: p.key, peerKey: Uint8Array.from([2, ...p.key]), operatorId: `op${i}`, bondTxid: new Uint8Array(32).fill(0x10 + i), bondVout: 0, bondSats: 2000000n, endpoint: `wss://g${i}.example` })) })), []);
const abandonedProofOf = (fid) => ({ node, bond }) => encodeAbandonedProof({ federationId: fromHex(fid), nodePubkey: node.key, proofRef: new Uint8Array(32).fill(7), txid: bond.txid, vout: bond.vout, record: recordOf(fid) });
const theftProofOf = (fid) => ({ node, bond }) => encodeTheftProof({ federationId: fromHex(fid), nodePubkey: node.key, txid: bond.txid, vout: bond.vout, mark: { kind: 'inflation', height: tip(), session: 1 },
  record: recordOf(fid), config: Uint8Array.of(9), firstSession: 0, sessions: [Uint8Array.of(1), Uint8Array.of(2)] });
const claim = (n, sats, height) => ({ nonce: toHex(taggedHash('ARENA/regtest/Note', Uint8Array.of(n))), amountMsat: String(BigInt(sats) * 1000n), payoutPk: toHex(secp256k1.getPublicKey(taggedHash('ARENA/regtest/Key', Uint8Array.of(n)), true)), height });

/** Release every started guardian of `gs` by the census key, then spend its escrow to the claims; answers each escrow spend's claims and outputs, read from the seats. */
async function releaseAndPay(gs, label) {
  // THE FALLBACK at its clock
  mine(Math.max(...gs.map((g) => g.startHeight)) + clocks.fallbackBlocks - 1 - tip());
  await passAll();
  const sent = JSON.parse(cli('getrawmempool'));
  mine(1);
  const started = new Set(gs.map((g) => `${toHex(g.bond.txid)}:${g.bond.vout}`));
  census.entries = census.entries.filter((e) => !(e.hold && started.has(`${toHex(e.txid)}:${e.vout}`)));
  const fallbacks = [];
  for (const g of gs) {
    const s = [...seats.values()].map((x) => x.run.served(g.start)).find((x) => x && x.fallback && x.fallback.sent) || [...seats.values()].map((x) => x.run.served(g.start)).find((x) => x && x.fallback);
    const table = decodeSlashPayoutTable(fromHex(s.fallback.table));
    const conf = JSON.parse(cli('getrawtransaction', s.fallback.sent || s.fallback.txid, 'true')).confirmations;
    say(isRoundless(table.roundId) && table.entries.length === 0 && table.outputs.map((o) => o.pays).join(',') === 'filer,escrow' && conf === 1,
      `${label} ${g.name}: census-key fallback ${String(s.fallback.sent || s.fallback.txid).slice(0, 16)} mined, ${s.fallback.feeSats} sat fee; table round_id zero, ${table.entries.length} entries, outputs ${table.outputs.map((o) => `${o.pays} ${o.value}`).join(', ')}`);
    fallbacks.push({ g, table, txid: s.fallback.sent || s.fallback.txid });
  }
  say(sent.length === gs.length, `${label}: ${sent.length} fallback(s) in the mempool for ${gs.length} started bond(s)`);
  // THE CARRIERS PUBLISH, THEN THE ESCROWS ARE SPENT ONE AT A TIME
  await passAll();
  mine(clocks.fallbackBlocks);
  const spends = [];
  for (let round = 0; round < gs.length + 1; round++) {
    await passAll();
    const pool = JSON.parse(cli('getrawmempool'));
    if (!pool.length) break;
    mine(1);
    for (const txid of pool) {
      const prop = [...seats.values()].flatMap((x) => gs.map((g) => x.run.served(g.start)).filter(Boolean).map((v) => v.liquidation).filter(Boolean)).flatMap((l) => l.proposals).find((p) => p.txid === txid);
      if (!prop) continue;
      const d = decodeLiquidationEscrowOutputs(fromHex(prop.outputs)), claims = decodeLiquidationClaims(fromHex(prop.claims));
      const tx = JSON.parse(cli('getrawtransaction', txid, 'true'));
      spends.push({ txid, d, claims, conf: tx.confirmations, vsize: tx.vsize, slices: liquidationSlices(d, claims) });
    }
    if (round < gs.length) mine(clocks.fallbackBlocks);
  }
  return { fallbacks, spends };
}

// ---- A: an ABANDONED guardian's template-3 bond ----
const fedA = E2E ? E2E.robbed.id : 'a1'.repeat(32);
const ga = await startedGuardian('A', abandonedProofOf(fedA));
const hA = tip();
const player = person('player');
const playerPk = toHex(secp256k1.getPublicKey(player.secret, true));
let wantA = ['250000000', '400000000'];
if (E2E) {
  // THE PLAYER'S CLAIM: every note it held in R, handed over while R is halted, checked against the client of R joined while it was OPEN (note-validate.js),
  // into the one claims ledger of R (liquidation-claims.js) - which the seats read as GET /liquidation-claims answers it (server.js liquidationLedger)
  const book = createLiquidationClaims({ validate: fedimintNoteValidator({ cli: E2E.fedimintCli, dataDirFor: (f) => (f === fedA ? E2E.robbed.validator : null), home: E2E.home }),
    liquidationOf: async (f) => (f === fedA ? { federation: fedA, haltHeight: hA - 10, liquidatesAt: hA - 5, claimWindowCloses: hA + 100000, lateClaimsUntil: hA + 100000, spentNonces: [] } : null),
    height: async () => tip(), escrowMsatOf: async () => 0n, clocks: REGTEST_CLOCKS });
  const ecash = readFileSync(`${E2E.dir}/player.ecash`, 'utf8').trim();
  const t = Date.now();
  const offered = await book.offer({ federation: fedA, ecash, payoutPk: playerPk });
  const again = await book.offer({ federation: fedA, ecash, payoutPk: playerPk });
  const sum = (offered.accepted || []).reduce((a, x) => a + BigInt(x.amountMsat), 0n);
  say(offered.ok && sum === BigInt(E2E.playerPegIn.msat) && again.status === 409,
    `A (real R ${fedA.slice(0, 8)}): the player's notes claimed: ${(offered.accepted || []).length} notes, ${sum} msat of the ${E2E.playerPegIn.msat} it held, in ${Date.now() - t} ms; the same notes again: ${again.status} (${[...new Set((again.refused || []).map((x) => x.why))].join('; ')})`);
  const ledgerOf = async () => { const p = await book.plan(fedA); if (!p.ok) throw new Error(`the ledger of R does not plan: ${p.why}`); return { accepted: p.accepted.map((c) => ({ ...c, height: Number(c.height) })), coveredMsat: new Map(p.paidNotes.map((n) => [n.nonce, BigInt(n.msat)])), afterWindow: !!p.split }; };
  const first = await ledgerOf();
  ledgers.set(fedA, () => first);
  wantA = first.accepted.map((c) => String(c.amountMsat)).sort();
} else ledgers.set(fedA, () => ({ accepted: [claim(1, 250_000, hA), claim(2, 400_000, hA)], coveredMsat: new Map(), afterWindow: false }));
const A = await releaseAndPay([ga], 'A abandoned');
const a0 = A.spends[0];
say(A.spends.length === 1 && a0.conf === 1 && a0.claims.map((c) => String(c.msat)).sort().join(',') === wantA.join(','),
  `A: liquidation escrow spend ${a0 && a0.txid.slice(0, 16)} mined (${a0 && a0.vsize} vB), claims_id over ${a0 && a0.claims.length} claims at face: ${a0 && a0.d.outputs.map((o) => `${o.pays} ${o.value}${o.claims ? ` (${o.claims} claims)` : ''}`).join(', ')}`);
const paidBefore = paid.length;
await carryAll();
const aPaid = paid.slice(paidBefore).flatMap((x) => x.list.map((y) => ({ ...y, federation: x.federation, carrier: x.carrier })));
say(aPaid.filter((x) => x.key !== toHex(reserveKey(fedSafe))).map((x) => String(x.msat)).sort().join(',') === wantA.join(',') && aPaid.every((x) => x.federation === fedSafe),
  `A: the carrier claimed its peg-in (${a0 && a0.slices.map((s) => s.value).join(', ')} sat on the chain) and paid each claim at face in the safest federation ${fedSafe.slice(0, 8)}: ${aPaid.map((x) => `${x.key.slice(0, 10)} ${x.msat}`).join(', ')}`);
if (E2E) {
  // WHAT THE CARRIERS' CLIENTS CLAIMED, AND THE PLAYER COLLECTING IN S: each payout contract to its key, refunded by that key into its own client of S
  const carried = [...seats.values()].flatMap((x) => (x.run.served(ga.start) || { carried: [] }).carried || []).filter((c, i, all) => all.findIndex((d) => d.escrow === c.escrow && d.index === c.index) === i);
  for (const c of carried) say(!!c.paidTxid && BigInt(c.claimedMsat || 0) >= (c.claims || []).reduce((a, x) => a + BigInt(x.msat), 0n),
    `A: carrier output ${c.index} of ${String(c.escrow).slice(0, 16)}: the peg-in into S credited ${c.claimedMsat} msat, ${(c.claims || []).length} claim(s) paid in S transaction ${String(c.paidTxid).slice(0, 16)}${c.reserves ? `, ${c.reserves.msat} msat to S's reserve key` : ''}`);
  // the client's notes as `fedimint-cli info` counts them (the stake-lock tool's balance lagged the redeemed notes by 16 384 msat when read 3 s after: measured)
  const balance = () => BigInt(JSON.parse(execFileSync(E2E.fedimintCli, ['--data-dir', E2E.safe.player, 'info'], { encoding: 'utf8', env: lockEnv, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })).total_amount_msat);
  const before = balance();
  const mineDuring = setInterval(() => { try { mine(1); } catch { /* next */ } }, 5000);
  let collected = 0n, redeemed = 0, failed = [];
  const t = Date.now();
  try {
    for (const x of paid.slice(paidBefore)) for (const [i, y] of x.list.entries()) {
      if (y.key !== playerPk) continue;
      const at = (x.payouts || []).filter((o) => o.refundPk === playerPk)[x.list.slice(0, i).filter((z) => z.key === playerPk).length];
      if (!at) { failed.push(`no outpoint for payout ${i} of ${x.txid}`); continue; }
      const r = lockRun('--mode', 'redeem', '--witness', 'refund', '--data-dir', E2E.safe.player, '--outpoint', `${x.txid}:${at.outIdx}`, '--expiration', '0',
        '--signer-secret', toHex(player.secret), '--hash', '00'.repeat(32), '--claim-pk', playerPk, '--refund-pk', playerPk, '--amount-msat', String(y.msat));
      if (r.accepted) { redeemed++; collected += BigInt(y.msat); } else failed.push(`${x.txid.slice(0, 12)}:${at.outIdx} ${r.error}`);
    }
  } finally { clearInterval(mineDuring); }
  const face = wantA.reduce((a, v) => a + BigInt(v), 0n);
  let after = balance();
  for (let i = 0; i < 30 && after - before < face; i++) { await new Promise((r) => setTimeout(r, 2000)); after = balance(); }
  say(failed.length === 0 && after - before === BigInt(wantA.reduce((a, v) => a + BigInt(v), 0n)),
    `A: the player collected in S: ${redeemed} payout(s) refunded to its key, ${collected} msat; its client of S went ${before} -> ${after} msat (${after - before} msat, the claims at face ${wantA.reduce((a, v) => a + BigInt(v), 0n)}) in ${Date.now() - t} ms${failed.length ? `; FAILED: ${failed.join('; ')}` : ''}`);
}

// ---- B: a theft's two template-3 bonds of one federation ----
const fedT = 'b2'.repeat(32);
const gb1 = await startedGuardian('B1', theftProofOf(fedT)), gb2 = await startedGuardian('B2', theftProofOf(fedT));
const hT = tip();
ledgers.set(fedT, () => ({ accepted: [claim(11, 600_000, hT), claim(12, 700_000, hT), claim(13, 300_000, hT)], coveredMsat: new Map(), afterWindow: false }));
const Bt = await releaseAndPay([gb1, gb2], 'B theft');
const bClaims = Bt.spends.map((s) => s.claims.map((c) => c.msat));
say(Bt.spends.length === 2 && Bt.spends.every((s) => s.conf >= 1) && bClaims.flat().map(String).sort().join(',') === ['600000000', '700000000', '300000000'].sort().join(','),
  `B: two escrows spent one at a time, every claim once: ${bClaims.map((c, i) => `spend ${i + 1} ${c.join(' + ')} msat`).join('; ')}`);
const pb = paid.length; await carryAll();
say(paid.slice(pb).flatMap((x) => x.list).filter((y) => y.key !== toHex(reserveKey(fedSafe))).length === 3, `B: the carriers paid ${paid.slice(pb).flatMap((x) => x.list).length} payouts, the three claims at face: ${paid.slice(pb).map((x) => `${String(x.txid).slice(0, 12)} [${x.list.map((y) => `${y.key === toHex(reserveKey(fedSafe)) ? 'reserves' : y.key.slice(0, 10)} ${y.msat}`).join(', ')}]`).join('; ')}`);

// ---- C: one template-2 bond in the mix, paying first ----
const fedC = 'c3'.repeat(32);
const set = arbitrationMembers('regtest');
const t2node = person('t2-node'), t2maturity = tip() + 3000;
const t2tree = bondOutputKey({ nodeKey: t2node.key, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: t2maturity, internalKey: bondInternalKey({ nodeKey: t2node.key, arbitrationKeys: set.keys }, { combine }).internalKey }, { tweakPoint, combine });
const t2bond = fundScript(fromHex(`5120${toHex(t2tree.outputKey)}`), '0.003');
const t2proof = encodeAbandonedProof({ federationId: fromHex(fedC), nodePubkey: t2node.key, proofRef: new Uint8Array(32).fill(8), txid: t2bond.txid, vout: t2bond.vout, record: recordOf(fedC) });
const t2slash = buildAbandonedSlash({ verdict: { output: { advert: { nodePubkey: t2node.key, bondScriptTemplateVersion: 2, bondMaturityHeight: t2maturity } }, proofId: abandonedProofId(t2proof), federation: toHex(fromHex(fedC)) },
  bond: t2bond, slashHeight: tip(), tipHeight: tip(), recordHeight: tip() - 1, set, feeSats: 2000n });
if (!t2slash.ok) throw new Error(t2slash.why);
const t2signed = assemble({ slash: t2slash, signatures: set.members.slice(0, set.k).map((m) => ({ key: m.key, sig: memberSign(m, t2slash.sighash) })), set });
const t2txid = await chain.send(t2signed.hex);
mine(1);
const arbEscrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
const t2out = JSON.parse(cli('getrawtransaction', t2txid, 'true')).vout.find((o) => o.scriptPubKey.hex === toHex(arbEscrow.script));
say(!!t2out, `C: the template-2 bond's path B ${t2txid.slice(0, 16)} mined into the arbitration set's escrow: ${t2out && Math.round(t2out.value * 1e8)} sat (${set.k} of ${set.keys.length})`);
// THE ONE LEDGER: the arbitration set's claims book (liquidation-claims.js) over that escrow, as its door answers it
const accepted = [claim(21, 150_000, tip()), claim(22, 500_000, tip())];
let liqTip = tip();
const book = createLiquidationClaims({ validate: async () => ({ ok: false }), liquidationOf: async () => ({ federation: fedC, haltHeight: liqTip - 10, liquidatesAt: liqTip - 5, claimWindowCloses: liqTip + 100000, lateClaimsUntil: liqTip + 100000, spentNonces: [] }),
  height: async () => tip(), escrowMsatOf: async () => BigInt(Math.round(t2out.value * 1e8)) * 1000n, clocks: REGTEST_CLOCKS,
  load: () => accepted.map((c) => ({ federation: fedC, nonce: c.nonce, amountMsat: c.amountMsat, height: c.height, payoutPk: c.payoutPk })) });
const plan = await book.plan(fedC);
say(plan.ok && plan.accepted.length === 2, `C: the ledger's plan pays from the template-2 escrow first: ${plan.paidNotes.map((n) => `${n.nonce.slice(0, 8)} ${n.msat} of ${accepted.find((c) => c.nonce === n.nonce).amountMsat}`).join(', ')}`);
ledgers.set(fedC, () => ({ accepted: plan.accepted.map((c) => ({ ...c, height: Number(c.height) })), coveredMsat: new Map(plan.paidNotes.map((n) => [n.nonce, BigInt(n.msat)])), afterWindow: false }));
const gc = await startedGuardian('C', abandonedProofOf(fedC));
const Cr = await releaseAndPay([gc], 'C mixed');
const c0 = Cr.spends[0];
const owedC = accepted.map((c) => BigInt(c.amountMsat) - BigInt((plan.paidNotes.find((n) => n.nonce === c.nonce) || { msat: '0' }).msat)).filter((x) => x > 0n);
say(c0 && c0.claims.map((c) => String(c.msat)).sort().join(',') === owedC.map(String).sort().join(','), `C: the census-key escrow pays only what the template-2 escrow leaves: ${c0 && c0.claims.map((c) => `${c.nonce.slice(0, 8)} ${c.msat}`).join(', ')}`);
const pc = paid.length; await carryAll();
say(paid.slice(pc).flatMap((x) => x.list).filter((y) => y.key !== toHex(reserveKey(fedSafe))).map((y) => String(y.msat)).sort().join(',') === owedC.map(String).sort().join(','), `C: carried and paid: ${paid.slice(pc).flatMap((x) => x.list).map((y) => `${y.key.slice(0, 10)} ${y.msat}`).join(', ')}`);

console.log(`#1093 ${asked - wrong} of ${asked} as expected; tip ${tip()}; ${E2E ? `real federations: R ${E2E.robbed.id.slice(0, 8)} (halted), S ${E2E.safe.id.slice(0, 8)} (safe)` : 'Fedimint not in this run (stand-in safe-federation clients: see the head of this file)'}`);
process.exit(wrong ? 1 : 0);
