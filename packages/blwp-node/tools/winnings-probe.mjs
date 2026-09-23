#!/usr/bin/env node
/**
 * WINNINGS ALWAYS SENT, ON A REAL FEDERATION (the owner 2026-09-21; ruled for FEDERATION 2026-09-23).
 *
 *   PROBE=<federation-hold-probe dir, SECOND_GATEWAY=1> LOCK_BIN=<blwp-stake-lock with gateways/send> WASM_PKG=<dir>
 *   INVITE=<invite> ALICE_RPC=<host:port> BOB_RPC=<host:port> CAROL_RPC=<host:port> LND_BIN=<dir> [PHASE=pass|fail|expiry]
 *   [BTC_RPCPORT=<the probe chain's rpc port> BTC_WALLET=<its wallet>]   (expiry only: blocks are mined past the contract)
 *     node packages/blwp-node/tools/winnings-probe.mjs
 *
 * PASS (the ruled order): a paying FEDERATION round on two signer nodes over the federation's own lock port, their
 * claim key their own DKG's. W and L deposit and lock through the page's own lock client; W names a Lightning address
 * once, signed with W's session key - an https LNURL address backed by the payer's lnd (alice) - and nothing of the
 * player's runs after that. W delivers, L does not. Close, the objection window, FINAL, and the settlement. Printed:
 * the owed msat; the invoice's hash and amount and its SETTLED time on alice; the gateway that paid (the channel
 * alice was paid over); the preimage's sha256 against the hash; the contract id; L's lock claimed; one payment row
 * on each signer node. Then both signer nodes are restarted on their stores and given time to re-gather: still one
 * SETTLED invoice, no new settlement, one row each.
 * FAIL: the same round with both runs under min_score and W's address named anyway - no payout contract, no invoice
 * asked of the address, and both stake locks still in the federation, to expire back.
 * EXPIRY (step 5): the lowest-key gateway is LIVE - it answers routing_info - but its node cannot carry the winning
 * (its outbound to the winner drained beforehand, by an ordinary payment), so it does not pay. Blocks are mined past the
 * contract's expiration; the signer nodes refund it to the committee and re-send it through the next live gateway to a
 * fresh invoice. Printed: both attempts, the first invoice never settled, the second SETTLED, one row each.
 * It prints what it measured and decides nothing.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { assumeAssigned } from '../test/assignment.js';
import { contractFor, opts, WINNER, LOSER, RANDOMNESS, GENESIS_HASH, wordsAt, say, secretScalar } from '../test/window-fixture.js';
import { lockFromClient } from '../../blwp-client/src/lock-result.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash, O_SCORE, S_STATE } from '../../core/src/state.js';
import { RUN_LIVE, RUN_DELIVERED, RUN_WRECKED } from '../../core/src/rules/gate.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { feeLockPays } from '../../protocol/src/lock-settlement.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';

const env = process.env;
const P = env.PROBE;
for (const k of ['PROBE', 'LOCK_BIN', 'WASM_PKG', 'INVITE', 'ALICE_RPC', 'BOB_RPC', 'CAROL_RPC', 'LND_BIN'])
  if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const PHASE = env.PHASE || 'pass';
const say_ = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => new Uint8Array(randomBytes(n));
const curve = { ...feldmanGroup, tweakPoint };
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 120000 }, (err, out, e) => done({ ok: !err, out: String(out), err: String(e || (err && err.message) || '') })));
const lncli = async (who, ...a) => {
  const rpc = { alice: env.ALICE_RPC, bob: env.BOB_RPC, carol: env.CAROL_RPC }[who];
  const r = await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/${who}`, `--rpcserver=${rpc}`, '--network=regtest', ...a]);
  if (!r.ok) throw new Error(`lncli ${who} ${a[0]}: ${r.err.slice(0, 200)}`);
  return JSON.parse(r.out);
};

// THE WINNER'S LIGHTNING ADDRESS: https on this machine, answering LUD-16/LUD-06 with alice's own invoices, each
// carrying the description hash of this metadata. The signer nodes fetch it trusting only this certificate.
const dir = mkdtempSync(join(tmpdir(), 'blwp-winnings-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
const cert = readFileSync(join(dir, 'cert.pem'));
const METADATA = JSON.stringify([['text/plain', 'a BLWP winning, sent']]);
const asked = [];
const lnurlServer = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, async (req, res) => {
  const u = new URL(req.url, 'https://127.0.0.1');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/lnurlp/winner')
    return json({ tag: 'payRequest', callback: `https://127.0.0.1:${lnurlServer.address().port}/cb`, metadata: METADATA,
      minSendable: 1000, maxSendable: 1000000000 });
  if (u.pathname === '/cb') {
    const amount = u.searchParams.get('amount');
    const inv = await lncli('alice', 'addinvoice', '--amt_msat', amount, '--description_hash', toHex(sha256(new TextEncoder().encode(METADATA))));
    asked.push({ amountMsat: amount, hash: inv.r_hash, at: Date.now() });
    return json({ pr: inv.payment_request, routes: [] });
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => lnurlServer.listen(0, '127.0.0.1', r));
const ADDRESS = `winner@127.0.0.1:${lnurlServer.address().port}`;
const lnurlFetch = (url) => new Promise((done, fail) => {
  const req = httpsRequest(url, { ca: cert }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => done({ json: async () => JSON.parse(b) })); });
  req.on('error', fail); req.end();
});

const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
const stores = [join(dir, 'a.db'), join(dir, 'b.db')];
const up = async () => {
  const nodes = [];
  for (const path of stores) nodes.push(await serve(openStore(path), { port: 0, ...opts, stakeLocks: port, poolCurve: curve,
    finality: { everyMs: 500 }, lnurlFetch, winningsEveryMs: 3000 }));
  for (const [d, o] of [[nodes[0], nodes[1]], [nodes[1], nodes[0]]]) {
    const there = [`http://127.0.0.1:${o.port}`];
    d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
  }
  return nodes;
};
let [a, b] = await up();

const esm = join(dir, 'blwp-lock-client.mjs');
copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
const wasmMod = await import(esm);
await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
const { LockClient } = wasmMod;

const STAKE = 1000000n;
const minScore = PHASE === 'fail' ? 1000000 : 1;
const fedId = (await port.gateways()).federationId;
const c = { ...contractFor([a.round.pubkey, b.round.pubkey], 20000n, [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
  custody: 'FEDERATION', federationId: fedId, minScore, stakeMsat: STAKE };
const rid = roundId(c);
for (const d of [a, b]) {
  const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
  if (r.status !== 201) throw new Error(`round: ${r.status} ${await r.text()}`);
  assumeAssigned(d.round, rid, c.nodes);
}
for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
const held = a.dkg.signerNodeFor(c.nodes);
if (!held.ok) throw new Error(`claim key: ${held.why}`);
const claimPk = held.pool.groupPublicKey;
say_({ step: 'round', phase: PHASE, round: toHex(rid).slice(0, 16), claimKey: toHex(claimPk).slice(0, 16), minScore, address: ADDRESS });

// THE PLAYERS' MONEY, through the page's lock client: one deposit that covers both players' stake and fee locks.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const mem = new Map();
const lc = await LockClient.join(env.INVITE, LockClient.federationIdOf(env.INVITE), toHex(rand(32)),
  { entries: () => JSON.stringify([...mem]), put: (k, v) => { mem.set(k, v); }, remove: (k) => { mem.delete(k); } });
const rcv = JSON.parse(await lc.receive('2300000', ''));
await lncli('alice', 'payinvoice', '--force', rcv.invoice).catch(() => null);
say_({ step: 'deposit', final: await lc.awaitReceive(rcv.operation), balanceMsat: await lc.balanceMsat() });
const rule = JSON.parse(await lc.feeRule());
const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) } });

async function lockAndPlay(who) {
  const session = ed25519.utils.randomSecretKey();
  const p = secretScalar();
  const point = feldmanGroup.pointFromScalar(scalarFrom32(p) % FIELD);
  const refundPk = refundKeyOf(who.key);
  const net = netStakeMsat({ stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n });
  const lk = lockFromClient(await lc.lock(toHex(point), String(net), toHex(claimPk), toHex(refundPk), 150), { point, claimPk, refundPk });
  let F = new Uint8Array(32), feeOut = { txid: new Uint8Array(32), outIdx: 0n }, feeFields = null;
  if (gate.pays) {
    F = rand(32);
    const fl = lockFromClient(await lc.lockHash(toHex(sha256(F)), String(entryFeeMsat(STAKE)), toHex(claimPk), toHex(refundPk), 150),
      { hash: sha256(F), claimPk, refundPk });
    feeOut = fl.outpoint; feeFields = fl.fields;
  }
  const e = rand(32);
  const dealt = await dealHandout({ preimage: p, signerNodes: c.nodes, roundId: rid, playerPubkey: who.key, ephemeralSecret: e,
    ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  const entry = { roundId: rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(p),
    stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n, joinTick: 0, worldSecret: who.worldSecret,
    vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0], feePreimage: F,
    stakeLockOutpoint: lk.outpoint, feeLockOutpoint: feeOut, claimKeyAttestationRef: new Uint8Array(32) };
  const eid = entryId(entry);
  const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: who.ticks }, (_, t) => wordsAt(t)), liquidations: [] };
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < who.ticks; t++) step(st, ...wordsAt(t));
  const mark = { roundId: rid, entryId: eid, tick: who.ticks, stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  const said = [];
  for (const d of [a, b]) {
    const base = `http://127.0.0.1:${d.port}`;
    await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const j = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    if (j.status !== 201) throw new Error(`entry: ${j.status} ${await j.text()}`);
    const l = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(lk.fields)) });
    if (feeFields) await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
    said.push(l.status);
    await say(d.port, encodeInputBatch(input));
    await say(d.port, signedMark);
  }
  return { eid, session, outpoint: lk.outpoint, locked: said };
}
// REAL PLAYER KEYS, AND RUNS CHOSEN THE WAY THE FIXTURE CHOSE ITS OWN: the seed is the player's key with the world
// secret, so for each real key the world secret's last byte is stepped until the core itself says the fixture's
// driver DELIVERS (W) or WRECKS (L) within its ticks. Measured, never assumed.
const runOf = (playerPubkey, worldSecret, ticks) => {
  const st = init(seedWordForEntry({ playerPubkey, worldSecret, joinTick: 0 }, RANDOMNESS));
  for (let t = 0; t < ticks; t++) { step(st, ...wordsAt(t)); if (st.i32[O_SCORE + S_STATE] !== RUN_LIVE) break; }
  return st.i32[O_SCORE + S_STATE];
};
const playerLike = (who, want) => {
  for (;;) {
    let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02);
    const key = schnorr.getPublicKey(k);
    for (let last = 0; last < 256; last++) {
      const worldSecret = Uint8Array.from(who.worldSecret); worldSecret[31] = last;
      if (runOf(key, worldSecret, who.ticks) === want) return { ...who, key, worldSecret };
    }
  }
};
const W = await lockAndPlay(playerLike(WINNER, RUN_DELIVERED));
const L = await lockAndPlay(playerLike(LOSER, RUN_WRECKED));
say_({ step: 'played', W: { entry: toHex(W.eid).slice(0, 16), lock: W.locked }, L: { entry: toHex(L.eid).slice(0, 16), lock: L.locked } });

// W NAMES THE ADDRESS ONCE, signed with W's session key - and nothing of the player's runs from here.
const signed = new TextEncoder().encode(ADDRESS);
const sig = ed25519.sign(signed, W.session);
for (const d of [a, b]) {
  const r = await fetch(`http://127.0.0.1:${d.port}/payout-address?entry=${toHex(W.eid)}`, { method: 'POST', body: Buffer.concat([Buffer.from(signed), Buffer.from(sig)]) });
  if (r.status !== 201) throw new Error(`address: ${r.status} ${await r.text()}`);
}
say_({ step: 'address named', address: ADDRESS });

// EXPIRY: GATEWAY A STAYS LIVE AND CANNOT CARRY THE WINNING. Drained here, after every deposit of this round (a deposit
// through A pays bob and refills his outbound - measured: it did, and A paid attempt 0), by an ordinary payment from bob
// to alice that leaves him less than the winning to send.
if (PHASE === 'expiry') {
  const chan = (await lncli('bob', 'listchannels')).channels[0];
  const spendable = Number(chan.local_balance) - Number(chan.local_constraints.chan_reserve_sat);
  let drained = null;
  for (let amt = spendable - 300; amt > spendable - 4000 && !drained; amt -= 250) {
    const pr = (await lncli('alice', 'addinvoice', '--amt', String(amt), '--memo', 'drain')).payment_request;
    const r = await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/bob`, `--rpcserver=${env.BOB_RPC}`, '--network=regtest', 'payinvoice', '--force', '--fee_limit', '50', pr]);
    if (/Payment status: SUCCEEDED/.test(r.out)) drained = amt;
  }
  const after = (await lncli('bob', 'listchannels')).channels[0];
  say_({ step: 'gateway A drained', paidToAlice: drained, bobLocal: after.local_balance, bobReserve: after.local_constraints.chan_reserve_sat });
}
await Promise.all([say(a.port, `close ${toHex(rid)}`), say(b.port, `close ${toHex(rid)}`)]);
const t0 = Date.now();
const standing = async (d) => (await fetch(`http://127.0.0.1:${d.port}/lock-settlement?round=${toHex(rid)}`)).json();
const winnings = async (d, eid) => (await fetch(`http://127.0.0.1:${d.port}/winnings?entry=${toHex(eid)}`)).json();
let settled = null;
for (const stop = Date.now() + 240000; Date.now() < stop; await wait(1000)) {
  const s = await standing(a);
  if (s.state === 'ACCEPTED') { settled = s; break; }
}
say_({ step: 'settlement', state: settled ? settled.state : (await standing(a)).state, ms: Date.now() - t0, txid: settled && settled.txid,
  moved: settled && settled.moved });

const invoiceOf = async (hash) => lncli('alice', 'lookupinvoice', hash);
const channelPeer = async (chanId) => {
  const chans = (await lncli('alice', 'listchannels')).channels || [];
  const ch = chans.find((x) => String(x.chan_id) === chanId || String(x.scid) === chanId);
  return ch ? ch.remote_pubkey : null;
};
const rowsOn = async (eid) => Promise.all([a, b].map((d) => winnings(d, eid)));

if (PHASE === 'pass') {
  let rows = null;
  for (const stop = Date.now() + 180000; Date.now() < stop; await wait(1000)) {
    rows = await rowsOn(W.eid);
    if (rows.every((r) => r.winnings && r.winnings.state === 'PAID')) break;
  }
  // THE PROPOSER'S ROW carries the contract (txid, output); both carry the preimage.
  const send = rows.map((r) => r.send).find((x) => x && x.txid) || rows[0].send;
  const inv = send ? await invoiceOf(send.paymentHash) : null;
  const htlc = inv && inv.htlcs && inv.htlcs[0];
  const via = htlc ? await channelPeer(String(htlc.chan_id)) : null;
  const contract = send ? await port.send({ paymentHash: send.paymentHash, amountMsat: BigInt(send.payoutMsat), expiration: BigInt(send.expiration),
    claimPk: send.gatewayPk, refundPk: claimPk, invoice: send.invoice }) : null;
  const contractAfter = send && send.txid ? await port.status({ txid: fromHex(send.txid), outIdx: BigInt(send.outIdx) }) : null;
  const gwKeys = { A: (await lncli('bob', 'getinfo')).identity_pubkey, B: (await lncli('carol', 'getinfo')).identity_pubkey };
  const lStatus = await port.status(L.outpoint);
  say_({ step: 'winnings', owedMsat: send && send.owedMsat, payoutMsat: send && send.payoutMsat,
    invoice: send && { hash: send.paymentHash, amountMsat: send.invoiceMsat, gatewayUrl: send.gatewayUrl, gatewayModuleKey: send.gatewayPk,
      expiration: send.expiration, txid: send.txid, outIdx: send.outIdx },
    alice: inv && { state: inv.state, amtPaidMsat: inv.amt_paid_msat, settleDate: inv.settle_date,
      paidOverChannelTo: via === gwKeys.A ? 'gateway A (bob)' : via === gwKeys.B ? 'gateway B (carol)' : via },
    preimageHashesToInvoice: send && send.preimage ? toHex(sha256(fromHex(send.preimage))) === send.paymentHash : false,
    contractId: contract && contract.contractId, contractInFederationAfter: contractAfter,
    htlcChannel: htlc ? String(htlc.chan_id) : null, gatewayLnds: gwKeys,
    rows: rows.map((r) => r.winnings && r.winnings.state), loserLockInFederationAfter: lStatus, addressAsked: asked.length });

  // RESTART both signer nodes on their stores; give them time to re-gather; nothing may be paid twice.
  const before = { asked: asked.length, settled: (await lncli('alice', 'listinvoices', '--max_invoices', '1000')).invoices.filter((i) => i.state === 'SETTLED').length };
  await a.close(); await b.close();
  [a, b] = await up();
  await wait(30000);
  const after = { asked: asked.length, settled: (await lncli('alice', 'listinvoices', '--max_invoices', '1000')).invoices.filter((i) => i.state === 'SETTLED').length };
  const rowsAfter = await rowsOn(W.eid);
  say_({ step: 'restart', before, after, settlement: (await standing(a)).state,
    rows: rowsAfter.map((r) => r.winnings && r.winnings.state), aliceInvoice: send ? (await invoiceOf(send.paymentHash)).state : null });
} else if (PHASE === 'expiry') {
  const attempts = () => a.round.sendAttemptsOf(rid).concat(b.round.sendAttemptsOf(rid));
  let first = null;
  for (const stop = Date.now() + 180000; Date.now() < stop; await wait(1000)) {
    first = attempts().find((r) => r.attempt === 0 && /did not pay/.test(r.why || ''));
    if (first) break;
  }
  say_({ step: 'attempt 0', gatewayUrl: first && first.gatewayUrl, why: first && first.why, expiration: first && first.expiration,
    invoiceOnAlice: first ? (await invoiceOf(first.paymentHash)).state : null });
  // PAST THE CONTRACT'S EXPIRATION, on this probe's own chain: mined, and waited for in the federation's own height.
  const cli = (...x) => execFileSync('/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli', ['-regtest', `-rpcport=${env.BTC_RPCPORT}`,
    '-rpcuser=blwp', '-rpcpassword=blwp', `-rpcwallet=${env.BTC_WALLET}`, ...x], { encoding: 'utf8' }).trim();
  const need = Number(first.expiration);
  let fedHeight = (await port.gateways()).height;
  const addr = cli('getnewaddress');
  while (fedHeight < need + 2) {
    cli('generatetoaddress', String(Math.min(200, need + 4 - fedHeight)), addr);
    await wait(3000);
    fedHeight = (await port.gateways()).height;
  }
  say_({ step: 'mined past expiration', federationHeight: fedHeight, expiration: need });
  let rows = null;
  for (const stop = Date.now() + 300000; Date.now() < stop; await wait(2000)) {
    rows = await rowsOn(W.eid);
    if (rows.every((r) => r.winnings && r.winnings.state === 'PAID')) break;
  }
  const all = a.round.sendAttemptsOf(rid);
  const second = all.find((r) => r.attempt === 1) || b.round.sendAttemptsOf(rid).find((r) => r.attempt === 1);
  const inv2 = second ? await invoiceOf(second.paymentHash) : null;
  say_({ step: 'expiry', attempts: all.map((r) => ({ attempt: r.attempt, gatewayUrl: r.gatewayUrl, hash: r.paymentHash.slice(0, 16),
      invoiceMsat: r.invoiceMsat, payoutMsat: r.payoutMsat, txid: r.txid, state: r.state, why: (r.why || '').slice(0, 120) })),
    firstInvoiceOnAlice: first ? (await invoiceOf(first.paymentHash)).state : null,
    secondInvoiceOnAlice: inv2 && { state: inv2.state, amtPaidMsat: inv2.amt_paid_msat, settleDate: inv2.settle_date },
    preimageHashesToSecondInvoice: rows && rows[0].send && rows[0].send.preimage ? toHex(sha256(fromHex(rows[0].send.preimage))) === second.paymentHash : null,
    rows: rows && rows.map((r) => r.winnings && r.winnings.state), addressAsked: asked.length });
} else {
  await wait(20000);
  const rows = await rowsOn(W.eid);
  const s = await standing(a);
  const stored = { W: await port.status(W.outpoint), L: await port.status(L.outpoint) };
  say_({ step: 'no qualifier', settlement: s.state, moved: s.moved, addressAsked: asked.length, rows: rows.map((r) => r.winnings),
    sends: rows.map((r) => r.send), stakeLocksStillStored: stored });
}
await a.close(); await b.close(); lnurlServer.close();
process.exit(0);
