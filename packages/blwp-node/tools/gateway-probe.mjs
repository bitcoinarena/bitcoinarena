#!/usr/bin/env node
/**
 * THE TWO-GATEWAY GATE, ON A REAL FEDERATION (§23.6; RULED the owner 2026-09-23).
 *
 *   PROBE=<federation-hold-probe dir, SECOND_GATEWAY=1 SETUP_ONLY=1> LOCK_BIN=<blwp-stake-lock with --mode gateways> \
 *   WASM_PKG=<dir with blwp_lock_client.js> INVITE=<invite> GW_A=<url> GW_B=<url> \
 *   ALICE_RPC=<host:port of the payer's lnd> BOB_RPC=<gateway A's lnd> CAROL_RPC=<gateway B's lnd> \
 *   FEDIMINT_BIN=<dir> FEDIMINT_HOME=<dir> LND_BIN=<dir> \
 *     node packages/blwp-node/tools/gateway-probe.mjs
 *
 * Two parts, the ruled pass for this slice, printed as measured and never decided here:
 *
 *   THE DOOR. Gateway B is taken off all four guardians' lists, and two signer nodes on this federation's own
 *   lock port are asked to open a paying round: the refusal must name the count, nothing is stored, the round
 *   is 404. B is put back, and the same code opens a paying round, which the lobby lists.
 *
 *   INBOUND, WHICH THE DOOR DOES NOT READ. One gateway at a time is stopped, and the page's own lock client
 *   deposits with no gateway named - the client picks among the vetted ones and falls back. The invoice's payee
 *   says which gateway the deposit went through; the deposit is paid from the payer's lnd, claimed, locked to
 *   the attested claim key, and handed to both signer nodes, which must commit it. A deposit that commits
 *   through a gateway is that gateway receiving: it has inbound.
 */
import { readFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { TRUCK_CONFIG_HASH } from '../src/cores.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { assumeAssigned } from '../test/assignment.js';
import { attestedClaimKey } from '../../blwp-client/src/join.js';
import { lockFromClient } from '../../blwp-client/src/lock-result.js';
import { pageCurve } from '../../blwp-client/src/page-curve.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { feeLockPays } from '../../protocol/src/lock-settlement.js';
import { federationGatewayCount } from '../../protocol/src/gateways.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { CORE_HASH } from './core-hash.mjs';
// THE RUN LENGTH IS THE CORE'S: a contract naming another is refused at the door as a second clock.
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';

const env = process.env;
const P = env.PROBE;
for (const k of ['PROBE', 'LOCK_BIN', 'WASM_PKG', 'INVITE', 'GW_A', 'GW_B', 'ALICE_RPC', 'BOB_RPC', 'CAROL_RPC', 'FEDIMINT_BIN', 'FEDIMINT_HOME', 'LND_BIN'])
  if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (bin, args, extraEnv = {}) => new Promise((done) => execFile(bin, args,
  { timeout: 180000, env: { ...process.env, ...extraEnv } }, (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
const lncli = (lnddir, rpc, ...a) => run(`${env.LND_BIN}/lncli`, [`--lnddir=${lnddir}`, `--rpcserver=${rpc}`, '--network=regtest', ...a]);
const fc = (...a) => run(`${env.FEDIMINT_BIN}/fedimint-cli`, ['--data-dir', `${P}/client`, ...a], { HOME: env.FEDIMINT_HOME });
const scalar = () => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } };
const evenPlayer = () => { let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02); return schnorr.getPublicKey(k); };

// THE GATEWAYS' OWN PROCESSES. The harness's pids file holds the self-extracting wrapper's shell, not the
// gatewayd it unpacks and runs - killing that stops nothing (measured: the wrapper dead, the gateway still
// answering on its port). So a gateway is found by the port it listens on, stopped there, and started again
// from its own command line and environment, read back off /proc.
const listenerOn = async (url) => {
  const want = `:${new URL(url).port}`;
  const ss = await run('ss', ['-ltnpH']);
  for (const line of ss.out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[3] && cols[3].endsWith(want)) { const m = line.match(/pid=(\d+)/); if (m) return Number(m[1]); }
  }
  return null;
};
const saved = {};
const stopGateway = async (url) => {
  const pid = await listenerOn(url);
  if (!pid) throw new Error(`nothing listens for the gateway at ${url}`);
  const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  const envv = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
    .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  saved[url] = { cmd, env: envv };
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 60; i++) { try { process.kill(pid, 0); await wait(500); } catch { return pid; } }
  process.kill(pid, 'SIGKILL');
  return pid;
};
// STARTED AGAIN THROUGH THE BUNDLE'S OWN WRAPPER: the running gatewayd lives inside the bundle's chroot, so
// its /nix/store path does not exist out here (measured: spawn ENOENT). The wrapper takes the same arguments and
// environment, with an ordinary PATH for its own shell (it needs date, tr and hexdump).
const startGateway = async (url) => {
  const s = saved[url];
  const child = spawn(`${env.FEDIMINT_BIN}/gatewayd`, s.cmd.slice(1),
    { env: { ...s.env, PATH: '/usr/local/bin:/usr/bin:/bin' }, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  child.unref();
  appendFileSync(`${P}/pids`, `${child.pid} gateway-${new URL(url).port}\n`);
  return child.pid;
};

const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
const listed = async () => { const g = await port.gateways(); return { ...federationGatewayCount(g.gateways), gateways: g.gateways }; };
const untilLive = async (want, label) => {
  for (let i = 0; i < 90; i++) { const n = await listed(); if (n.distinctLive === want) return n; await wait(2000); }
  throw new Error(`${label}: the federation never showed ${want} distinct live gateway(s)`);
};
const guardians = async (verb, url) => {
  const said = [];
  for (const g of [0, 1, 2, 3]) {
    const r = await fc('--our-id', String(g), '--password', 'probe', 'module', 'lnv2', 'gateways', verb, url);
    said.push(r.ok ? 'ok' : r.err.split('\n')[0].slice(0, 80));
  }
  return said;
};

// THE LND KEYS, so a deposit invoice's payee names its gateway.
const keyOf = async (lnddir, rpc) => JSON.parse((await lncli(lnddir, rpc, 'getinfo')).out).identity_pubkey;
const KEYS = { A: await keyOf(`${P}/bob`, env.BOB_RPC), B: await keyOf(`${P}/carol`, env.CAROL_RPC) };
say({ step: 'gateway lnds', A: `${env.GW_A} on ${KEYS.A.slice(0, 16)}`, B: `${env.GW_B} on ${KEYS.B.slice(0, 16)}` });

const claimSecret = secp256k1.utils.randomSecretKey();
const claimPk = secp256k1.getPublicKey(claimSecret, true);
const signerNodes = [];
for (let i = 0; i < 2; i++)
  signerNodes.push(await serve(openStore(':memory:'), { port: 0, funded: () => true, stakeLocks: port, claimKeyFor: () => claimPk }));
const nodes = signerNodes.map((d) => `http://127.0.0.1:${d.port}`);
const STAKE = 1000000n;
let seq = 0;
const contract = () => {
  const now = BigInt(Date.now());
  return { networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
    simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS, entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n,
    objectionWindowMs: 3000n, custody: 'FEDERATION', slashMinimumServed: 20 + (seq++), slashRemainder: 'SPLIT',
    stakeExpiryBlocks: 144, publicationRelays: nodes,
    donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
    committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
    rankNumerator: 3, rankDenominator: 4, nodes: signerNodes.map((d) => d.round.pubkey) };
};
const post = async (c) => {
  const said = [];
  for (const d of signerNodes) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    said.push({ status: r.status, why: (await r.text()).trim().slice(0, 170) });
  }
  const id = toHex(roundId(c));
  const held = await Promise.all(signerNodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/round?id=${id}`)).status));
  const stored = signerNodes.map((d) => d.round.db.prepare('SELECT COUNT(*) AS n FROM rounds WHERE round_id = ?').get(roundId(c)).n);
  return { id, said, held, stored };
};

let code = 0;
try {
  const fedId = (await port.gateways()).federationId;
  const base = () => ({ ...contract(), federationId: fedId });

  // THE DOOR, UNDER TWO: B off every guardian's list.
  say({ step: 'B off the lists', guardians: await guardians('remove', env.GW_B) });
  const one = await untilLive(1, 'one registered');
  say({ step: 'federation, one gateway', distinctLive: one.distinctLive, registered: one.registered });
  const refused = await post(base());
  say({ step: 'door, one gateway', ...refused });

  // AND AT TWO: B back on, the same code.
  say({ step: 'B back on the lists', guardians: await guardians('add', env.GW_B) });
  const two = await untilLive(2, 'two registered');
  say({ step: 'federation, two gateways', distinctLive: two.distinctLive, registered: two.registered,
    keys: two.keys.map((k) => k.slice(0, 16)) });
  const c = base();
  const opened = await post(c);
  say({ step: 'door, two gateways', ...opened });
  const lobby = await (await fetch(`${nodes[0]}/rounds`)).json();
  const row = (lobby.rounds || []).find((r) => r.id === opened.id);
  say({ step: 'lobby', listed: !!row, wallet: row && row.wallet, stakeMsat: row && row.stakeMsat });
  if (opened.said.some((s) => s.status !== 201)) throw new Error('the round did not open at two gateways');
  const rid = roundId(c);
  for (const d of signerNodes) assumeAssigned(d.round, rid, c.nodes);

  // INBOUND: a deposit through each gateway, the other one down.
  const round = { ...c, id: rid };
  const att = await attestedClaimKey({ round, signerNodes: c.nodes, nodes, curve: pageCurve });
  if (!att.ok) throw new Error(`claim key: ${att.why}`);
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  // THE PAGE'S OWN BUILD of the lock client (the WebGL template's copy, the bytes a player is served): an ES
  // module whose wasm is handed to its init, as the page does, rather than a second Node-only build.
  const esm = join(tmpdir(), `blwp-lock-client-${process.pid}.mjs`);
  copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
  const wasmMod = await import(esm);
  await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
  const { LockClient } = wasmMod;
  const held = new Map();
  const memStore = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
  const lc = await LockClient.join(env.INVITE, LockClient.federationIdOf(env.INVITE), toHex(rand(32)), memStore);
  const rule = JSON.parse(await lc.feeRule());
  const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) } });
  const net = netStakeMsat({ stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n });

  for (const [down, downUrl] of [['B', env.GW_B], ['A', env.GW_A]]) {
    const stopped = await stopGateway(downUrl);
    say({ step: `${down} stopped`, pid: stopped });
    const n = await untilLive(1, `${down} down`);
    const t = Date.now();
    const rcv = JSON.parse(await lc.receive('1200000', ''));
    const payee = JSON.parse((await lncli(`${P}/alice`, env.ALICE_RPC, 'decodepayreq', rcv.invoice)).out).destination;
    const paid = await lncli(`${P}/alice`, env.ALICE_RPC, 'payinvoice', '--force', rcv.invoice);
    const final = await lc.awaitReceive(rcv.operation);
    const via = payee === KEYS.A ? 'A' : payee === KEYS.B ? 'B' : `neither (${payee.slice(0, 16)})`;
    say({ step: `deposit, ${down} down`, liveBefore: n.distinctLive, through: via,
      paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 80)])[0], final, ms: Date.now() - t,
      balanceMsat: await lc.balanceMsat() });

    // LOCKED AND HANDED OVER: the signer nodes verify it in the federation and commit it, or they do not.
    const s = { p: scalar(), player: evenPlayer() };
    s.point = feldmanGroup.pointFromScalar(scalarFrom32(s.p) % FIELD);
    const lk = lockFromClient(await lc.lock(toHex(s.point), String(net), toHex(att.claimPk), toHex(refundKeyOf(s.player)), 150),
      { point: s.point, claimPk: att.claimPk, refundPk: refundKeyOf(s.player) });
    let fee = null, hand = null;
    if (gate.pays) {
      const F = rand(32);
      const got = lockFromClient(await lc.lockHash(toHex(sha256(F)), String(entryFeeMsat(STAKE)), toHex(att.claimPk), toHex(refundKeyOf(s.player)), 150),
        { hash: sha256(F), claimPk: att.claimPk, refundPk: refundKeyOf(s.player) });
      fee = { preimage: F, outpoint: got.outpoint }; hand = got.fields;
    }
    const e = rand(32);
    const dealt = await dealHandout({ preimage: s.p, signerNodes: c.nodes, roundId: rid, playerPubkey: s.player,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
    const entry = { roundId: rid, playerPubkey: s.player, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: sha256(s.p), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n, joinTick: 0,
      worldSecret: rand(32), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
      feePreimage: fee ? fee.preimage : new Uint8Array(32), stakeLockOutpoint: lk.outpoint,
      feeLockOutpoint: fee ? fee.outpoint : { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: att.ref };
    const eid = entryId(entry);
    const committed = [];
    for (const d of signerNodes) {
      await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
      const r = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      if (r.status !== 201) throw new Error(`entry: ${r.status} ${await r.text()}`);
      if (hand) await fetch(`http://127.0.0.1:${d.port}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(hand)) });
      const l = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(lk.fields)) });
      const seen = d.round.stakeSeen(eid);
      committed.push({ status: l.status, committedMsat: seen ? String(seen.paidMsat) : null, why: (await l.text()).trim().slice(0, 100) });
    }
    say({ step: `lock, ${down} down`, through: via, outpoint: `${toHex(lk.outpoint.txid).slice(0, 16)}:${lk.outpoint.outIdx}`, signerNodes: committed });

    await startGateway(downUrl);
    await untilLive(2, `${down} back`);
    say({ step: `${down} back up`, distinctLive: 2 });
  }
} catch (e) {
  code = 1;
  say({ step: 'stopped', why: String(e.stack || e.message).slice(0, 500) });
} finally {
  for (const d of signerNodes) await d.close();
}
process.exit(code);
