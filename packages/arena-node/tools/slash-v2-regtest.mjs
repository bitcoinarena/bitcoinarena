#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * SLASHING RULE V2, END TO END ON A REGTEST CHAIN (§5A.3, §5A.3B step 5, §27A.9.2; RULED 2026-11-02, kanban #976, #978): "each affected player gets their
 * real loss, once, and nothing more. The rest of the bond goes to the protocol reserves." The service's own code on real bonds and a real federation:
 * buildSlash (who lost what, path B with one output), memberSign + assemble + post (5 of 7, testmempoolaccept, broadcast), payOutSlash as the service's pass
 * calls it (the escrow into the federation, claimed, each loss a payout contract, the rest a payout contract to the reserve key). Then every payout is redeemed
 * in a fresh client by the key it names, the reserve output is checked as a seat checks it (verifyPeerReserveRow over a real port) and read as GET /reserves
 * reads it (reserveFigures), and the sum is checked to the sat.
 *
 *   late       a late objection: the round settled on the false run (five FINAL signatures stand in `finalProven`)    -> the loss paid, the rest to the reserves
 *   second     the next proof of that round                                                                            -> nothing still owed, all to the reserves
 *   in time    the same bond and result, the false run corrected before it settled                                     -> nobody paid, all to the reserves
 *   two        one spend, two federations and a part that does not fit (testmempoolaccept on the signed spend)         -> the plan's outputs, what is left back to the escrow
 *
 * The judgement of a proof (the replay) is not here: tests/arbiter.test.js holds it on real signed results; the verdict below is the shape it answers.
 *
 *   BITCOIN_CLI="<bitcoin-cli> -datadir=<dir> -rpcwallet=<w>" STAKE_LOCK_BIN=<bin> CLIENT_DIR=<arbiter's client> FEDIMINT_CLI=<bin>
 *   INVITE_FILE=<file> WORK_DIR=<dir> [FORK_HOME=<home>] [PEGIN_FEE_SATS=n] node tools/slash-v2-regtest.mjs
 */
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { arbitrationMembers, buildSlash, memberSign, assemble, post, payOutSlash } from '../src/arbiter.js';
import { REMAINDER_FEE_MARGIN_MSAT } from '../src/liquidation-claims.js';
import { verifyPeerReserveRow, reserveFigures, slashReserveRows } from '../src/reserve-book.js';
import { slashEvent } from '../src/arbitration-events.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { escrowOutput, escrowSplitSpend, arbitrationSighash } from '../../arena-protocol/src/arbitration-tx.js';
import { planEscrowSpend } from '../../arena-protocol/src/slash-reserves.js';
import { bondOutputKey, bondInternalKey } from '../../arena-protocol/src/bond-script.js';
import { REPLAY_CONTRADICTS } from '../../arena-protocol/src/slash.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { tweakPoint, combine } from '../src/curve.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
for (const k of ['BITCOIN_CLI', 'STAKE_LOCK_BIN', 'CLIENT_DIR', 'FEDIMINT_CLI', 'INVITE_FILE', 'WORK_DIR']) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const [cli, ...cliArgs] = env.BITCOIN_CLI.split(' ').filter(Boolean);
const bc = (...a) => execFileSync(cli, [...cliArgs, ...a.map(String)], { encoding: 'utf8' }).trim();
const rpc = async (method, params = []) => { const out = bc(method, ...params.map((p) => (typeof p === 'object' ? JSON.stringify(p) : p))); try { return JSON.parse(out); } catch { return out; } };
const mine = (n = 1) => bc('generatetoaddress', n, bc('getnewaddress'));
if (env.FORK_HOME) process.env.HOME = env.FORK_HOME;   // the port spawns the tool as this process
const runEnv = process.env;
const sh = (bin, args, timeout = 300000) => { try { return execFileSync(bin, args, { encoding: 'utf8', env: runEnv, timeout, maxBuffer: 1 << 24 }); } catch (e) { return String(e.stdout || '') + String(e.message || ''); } };
const json = (out) => {
  const s = String(out).trim();
  try { return JSON.parse(s); } catch { /* not all JSON */ }
  for (const l of s.split('\n')) { if (!l.startsWith('{')) continue; try { return JSON.parse(l); } catch { /* a log line */ } }
  try { return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { return null; }
};
// a key whose compressed form is 02.. (a payout contract names the x-only key with even y)
const keyPair = () => { for (;;) { const sk = randomBytes(32); const pk = secp256k1.getPublicKey(sk, true); if (pk[0] === 2) return { sk: toHex(sk), x: toHex(schnorr.getPublicKey(sk)), rk: toHex(pk) }; } };
const fail = (why) => { throw new Error(why); };
const assertEq = (a, b, what) => { if (String(a) !== String(b)) fail(`${what}: ${a} where ${b} was due`); };

const set = arbitrationMembers('regtest');
const g = genesisFor('regtest');
const invite = readFileSync(env.INVITE_FILE, 'utf8').trim();
const info = json(sh(env.FEDIMINT_CLI, ['--data-dir', env.CLIENT_DIR, 'info'], 120000));
const FED = String(info.federation_id);
const escrowOut = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
const reserve = keyPair();
const federations = async () => [{ federation: FED, status: 'OPEN', reserveKey: reserve.rk, reserveSats: '0', exposureCapSats: '100000000' }];
const pegInFeeSats = BigInt(env.PEGIN_FEE_SATS || 1000);
const contract = (tip) => ({ censusHeight: tip - 1, slashRemainder: 'SPLIT', minScore: 0 });
const port = stakeLockPort({ bin: env.STAKE_LOCK_BIN, dataDir: env.CLIENT_DIR, serve: false });

const addressOf = async (outputKey) => (await rpc('deriveaddresses', [(await rpc('getdescriptorinfo', [`rawtr(${toHex(outputKey)})`])).descriptor]))[0];

/** A bond funded here, as a node's advertisement builds it. */
async function fundBond(sats) {
  const node = keyPair();
  const nodeKey = fromHex(node.x);
  const advert = { nodePubkey: nodeKey, bondScriptTemplateVersion: 1 };
  const internalKey = bondInternalKey({ nodeKey, arbitrationKeys: set.keys }, { combine }).internalKey;
  const tree = bondOutputKey({ nodeKey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: g.bondMaturity, internalKey }, { tweakPoint, combine });
  const txid = bc('sendtoaddress', await addressOf(tree.outputKey), (Number(sats) / 1e8).toFixed(8));
  mine(1);
  const script = `5120${toHex(tree.outputKey)}`;
  const vout = JSON.parse(bc('gettransaction', txid, 'true', 'true')).decoded.vout.find((o) => o.scriptPubKey.hex === script).n;
  return { advert, bond: { txid: fromHex(txid).reverse(), vout, value: sats, script: fromHex(script) } };
}

/** Path B for a judged proof: built, signed by 5 of 7 on their own, tested and posted, its one output confirmed. */
async function pathB({ sats, verdict, entries, paid, truth }) {
  const { advert, bond } = await fundBond(sats);
  const tip = Number(bc('getblockcount'));
  const c = contract(tip);
  const slash = buildSlash({ verdict: { ...verdict, proof: { nodePubkey: advert.nodePubkey } }, bond, advert, contract: c, roundId: ROUND, slashHeight: tip, tipHeight: tip, entries, paid, truth, set, feeSats: 2000n });
  if (!slash.ok) fail(`path B: ${slash.why}`);
  const signed = assemble({ slash, signatures: set.members.slice(0, set.k).map((m) => ({ key: m.key, sig: memberSign(m, slash.sighash) })), set });
  if (!signed.ok) fail(signed.why);
  const sent = await post(rpc, signed.hex);
  if (!sent.ok) fail(sent.why);
  mine(1);
  const tx = await rpc('getrawtransaction', [sent.txid, true]);
  const outs = tx.vout.filter((o) => o.value > 0);
  assertEq(outs.length, 1, 'outputs of path B with a value');
  assertEq(outs[0].scriptPubKey.hex, toHex(escrowOut.script), 'path B\'s one output is the escrow');
  return { slash, posted: sent.txid, bondSats: sats, escrowSats: slash.built.amounts.escrow };
}

/** Redeem a payout contract with its key, in a fresh client: the money is real only if this works. */
function redeem(name, pay, key) {
  const dir = `${env.WORK_DIR}/${name}`; mkdirSync(dir, { recursive: true });
  sh(env.FEDIMINT_CLI, ['--data-dir', dir, 'join-federation', invite], 120000);
  const r = json(sh(env.STAKE_LOCK_BIN, ['--mode', 'redeem', '--data-dir', dir, '--outpoint', `${pay.txid}:${pay.outIdx}`, '--amount-msat', pay.msat,
    '--hash', '00'.repeat(32), '--claim-pk', key.rk, '--refund-pk', key.rk, '--expiration', '0', '--witness', 'refund', '--signer-secret', key.sk]));
  sh(env.FEDIMINT_CLI, ['--data-dir', dir, 'dev', 'wait-complete'], 180000);
  const held = json(sh(env.FEDIMINT_CLI, ['--data-dir', dir, 'info'], 120000));
  return { msat: pay.msat, accepted: !!(r && r.accepted), error: (r && r.error) || null, balanceMsat: held && held.total_amount_msat };
}

/** One slash through the service's pass, read back to the sat. */
async function run(name, { sats, verdict, entries, paid = new Map(), truth = [], players: keys = {} }) {
  const b = await pathB({ sats, verdict, entries, paid, truth });
  const d = b.slash.distribution;
  const v = { posted: b.posted, round: toHex(ROUND), entry: 'cd'.repeat(32), bondSats: String(b.bondSats), escrowSats: String(b.escrowSats), node: 'ee'.repeat(32), slashHeight: 0, signers: set.k,
    players: [...d.players].map(([key, msat]) => ({ key, msat: String(msat), entry: 'cd'.repeat(32), federation: FED })),
    playersMsat: String(d.playersMsat), reservesMsat: String(d.reservesMsat), shortMsat: String(d.shortMsat), truth: b.slash.truth.map((t) => ({ key: toHex(t.pubkey), outcome: t.outcome, score: t.score })) };
  log({ step: 'path B', case: name, txid: b.posted, bondSats: b.bondSats, escrowSats: b.escrowSats, owedPlayersMsat: d.playersMsat, owedReservesMsat: d.reservesMsat });
  const t0 = Date.now(); const said = [];
  for (let i = 0; i < 80 && !v.settled; i++) {
    const r = await payOutSlash({ proof: 'regtest', v, set, rpc, bin: env.STAKE_LOCK_BIN, dirOf: () => env.CLIENT_DIR, federations, feeSats: 1000n, pegInFeeSats, env: runEnv, say: (o) => said.push(o) });
    if (r.why && !said.some((x) => x.why === r.why)) said.push({ why: r.why, s: Math.round((Date.now() - t0) / 1000) });
    if (!v.settled) await new Promise((r2) => setTimeout(r2, 8000));
  }
  if (!v.settled) fail(`${name}: payOutSlash did not finish: ${JSON.stringify(said).slice(-400)}`);
  const stage = v.stages[0]; const peg = stage.pegIns[0];
  const paidPlayers = (v.payouts || []).reduce((t, p) => t + BigInt(p.msat), 0n);
  const paidReserves = (v.reserves || []).reduce((t, r) => t + BigInt(r.msat), 0n);
  // THE SUM, TO THE SAT: path B's fee, the escrow spend's, what the federation kept of the peg-in, and what the client held back for the payout's own fee
  const pathFee = b.bondSats - b.escrowSats;
  const spendFee = b.escrowSats - BigInt(peg.sats);
  const pegInFeeMsat = BigInt(peg.sats) * 1000n - BigInt(peg.claimedMsat);
  const margin = BigInt(peg.claimedMsat) - paidPlayers - paidReserves;
  assertEq(paidPlayers + paidReserves + pathFee * 1000n + spendFee * 1000n + pegInFeeMsat + margin, b.bondSats * 1000n, `${name}: the bond`);
  // THE RESERVE OUTPUT, AS A SEAT TAKES IT: named by the set's event, checked over a real port, read as GET /reserves reads it
  const event = slashEvent({ network: 'regtest', proof: 'ab'.repeat(32), v });
  const rows = slashReserveRows([{ event }], FED);
  const kept = [];
  for (const row of rows) {
    const c = await verifyPeerReserveRow({ row, port, reserveKey: fromHex(reserve.rk), federationId: fromHex(FED) });
    if (!c.ok) fail(`${name}: the seat's check refused the reserve row: ${c.why}`);
    kept.push({ outpoint: row.outpoint, entryId: row.entryId, roundId: row.roundId, amountMsat: c.row.amountMsat, verifiedMs: Date.now(), item: c.row.item, federationId: FED });
  }
  const figures = reserveFigures(kept, { federationId: FED });
  const redeemed = [];
  for (const [i, p] of (v.payouts || []).entries()) {
    const key = keys[p.refundPk];
    if (!key) fail(`${name}: a payout to a key nobody here holds: ${p.refundPk}`);
    redeemed.push({ to: 'player', ...redeem(`${name}-player-${i}`, p, key) });
  }
  for (const [i, r] of (v.reserves || []).entries()) redeemed.push({ to: 'the reserve key', ...redeem(`${name}-reserve-${i}`, r, reserve) });
  if (!redeemed.every((x) => x.accepted)) fail(`${name}: a payout did not redeem: ${JSON.stringify(redeemed)}`);
  const answer = { case: name, seconds: Math.round((Date.now() - t0) / 1000), bondSats: b.bondSats, playersMsat: paidPlayers, reservesMsat: paidReserves,
    fees: { pathBSats: pathFee, escrowSpendSats: spendFee, pegInMsat: pegInFeeMsat, heldForPayoutFeeMsat: margin }, reserveRow: figures.paidIn, slashMsat: figures.slashMsat, nodes: 0, developers: 0, burned: 0, redeemed, escrowTx: stage.txid, payoutTx: peg.paidTxid };
  log({ step: 'case', ...answer });
  return { v, ...answer };
}

// A BLOCK EVERY 6 S, as the live stack's miner: pegin-claim waits for confirmations and the pass waits for pegin-claim
const minerAddress = bc('getnewaddress');
const miner = setInterval(() => execFile(cli, [...cliArgs, 'generatetoaddress', '1', minerAddress], () => {}), 6000);
const ROUND = randomBytes(32);
const row = (pubkey, outcome, score, over = {}) => ({ playerPubkey: pubkey, pubkey, stakeMsat: 100_000_000n, feeMsat: 0n, donationMsat: 0n, netStakeMsat: 100_000_000n, activated: true, outcome, score, ...over });
const FALSE_RUN = 'f0'.repeat(32), RE_RUN = 'a0'.repeat(32);
let code = 0;
try {
  const loser = keyPair(), winner = keyPair(), other = keyPair();
  const keys = { [loser.rk]: loser, [winner.rk]: winner, [other.rk]: other };
  // THE ROUND: three stakes of 100,000 sat. The false run says the named player failed; the replay says they delivered first.
  const verdict = { offence: REPLAY_CONTRADICTS, playerPubkey: fromHex(loser.x), proofId: randomBytes(32), signed: { outcome: 'FAILED', score: 0 }, replayed: { outcome: 'DELIVERED', score: 500 }, contradictedRunId: FALSE_RUN };
  const settled = (runId) => [row(fromHex(loser.x), 'FAILED', 0, { runId, finalProven: true }), row(fromHex(winner.x), 'DELIVERED', 100), row(fromHex(other.x), 'FAILED', 0)];
  const BOND = 1_000_000n;

  // LATE: the money moved on the false run. Should have had their 100,000 back and the pool of 100,000 the other loser leaves: 200,000 sat.
  const late = await run('late', { sats: BOND, verdict, entries: settled(FALSE_RUN), players: keys });
  assertEq(late.playersMsat, 200_000_000n, 'late: the real loss');
  assertEq(late.v.payouts.length, 1, 'late: one payout contract');
  assertEq(late.v.payouts[0].refundPk, loser.rk, 'late: paid to the entry\'s own key');

  // THE NEXT PROOF OF THE ROUND: the loss is paid, so nothing is owed: all of it to the reserves
  const paid = new Map(late.v.players.map((p) => [p.key, BigInt(p.paidMsat)]));
  const second = await run('second', { sats: BOND, verdict: { ...verdict, proofId: randomBytes(32) }, entries: settled(FALSE_RUN), paid, players: keys });
  assertEq(second.playersMsat, 0n, 'second: nothing is still owed');

  // IN TIME: the same bond and the same replay, and the round settled on the re-run: no money ever moved on the false result
  const inTime = await run('in time', { sats: BOND, verdict: { ...verdict, proofId: randomBytes(32) }, entries: settled(RE_RUN), players: keys });
  assertEq(inTime.playersMsat, 0n, 'in time: nobody has a loss');
  assertEq((inTime.v.payouts || []).length, 0, 'in time: no player is paid');

  // ONE SPEND, TWO PEG-INS AND WHAT DOES NOT FIT: a loss in the round's federation, the rest over both by load, the excess back to the same escrow
  const two = await pathB({ sats: BOND, verdict: { ...verdict, proofId: randomBytes(32) }, entries: settled(RE_RUN) });
  const a = 'aa'.repeat(32), z = 'bb'.repeat(32);
  const plan = planEscrowSpend({ escrowSats: two.escrowSats, feeSats: 1000n, pegInFeeSats,
    federations: [{ federation: a, status: 'OPEN', reserveKey: '02' + 'aa'.repeat(32), reserveSats: '60000', exposureCapSats: '100000' }, { federation: z, status: 'OPEN', reserveKey: '02' + 'bb'.repeat(32), reserveSats: '790000', exposureCapSats: '1000000' }] });
  if (!plan.ok) fail(plan.why);
  const spk = async () => fromHex((await rpc('getaddressinfo', [bc('getnewaddress')])).scriptPubKey);
  const payees = [];
  for (const p of plan.pegIns) payees.push({ script: await spk(), sats: p.sats, pays: p.federation.slice(0, 8) });
  payees.push({ script: escrowOut.script, sats: plan.keptSats, pays: 'the same escrow' });
  const built = escrowSplitSpend({ escrow: { txid: fromHex(two.posted).reverse(), vout: 1, value: two.escrowSats, script: escrowOut.script }, payees, feeSats: 1000n });
  if (!built.ok) fail(built.why);
  const spend = { built, sighash: arbitrationSighash(built, escrowOut.leaf), controlBlock: escrowOut.controlBlock };
  const signed = assemble({ slash: spend, signatures: set.members.slice(0, set.k).map((m) => ({ key: m.key, sig: memberSign(m, spend.sighash) })), set });
  if (!signed.ok) fail(signed.why);
  const [tested] = await rpc('testmempoolaccept', [[signed.hex]]);
  log({ step: 'two federations', outputs: payees.map((p) => ({ pays: p.pays, sats: p.sats })), allowed: tested.allowed, why: tested['reject-reason'] || null });
  if (!tested.allowed) fail(`the spend with two peg-ins: ${tested['reject-reason']}`);
  writeFileSync(`${env.WORK_DIR}/slash-v2-ok`, 'ok\n');
  log({ step: 'finished', cases: ['late', 'second', 'in time', 'two federations'], margin: String(REMAINDER_FEE_MARGIN_MSAT) });
} catch (e) { code = 1; log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 700) }); }
clearInterval(miner);
process.exit(code);
