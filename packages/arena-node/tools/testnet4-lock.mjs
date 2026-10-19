#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE STAKE LOCK, MEASURED ON THE OPEN TESTNET4 ROUND (2026-09-27 07:51: "Open the paying round. Measure the
 * stake lock"). Nothing here stands a round or a signer node: the round is the one tools/run-testnet4-paid.mjs opened,
 * read back off its own signer nodes, and the lock is the page's own - the WebGL template's lock client, the bytes a
 * player is served - driven from Node:
 *
 *   the claim key, attested by the round's signer nodes (the page's attestedClaimKey);
 *   a deposit into the federation through one of its gateways, the invoice paid from a testnet4 lnd;
 *   Point(stake) locked to that claim key, the fee locked when the federation's fee rule asks for it;
 *   the handout, the entry and the lock handed to every signer node, each of which verifies the lock in the
 *   federation (stake-lock port) and commits it, or says why not.
 *
 *   ROUND=<round id hex> PORTS=<the seven signer node ports> INVITE_FILE=<federation invite> WASM_PKG=<dir with
 *   blwp_lock_client.js> LNCLI=<lncli> PAYER_DIR=<payer lnd dir> PAYER_RPC=<host:port> \
 *     node tools/testnet4-lock.mjs
 *
 * ARENA_TN4_NETWORK (default testnet4) is the payer lnd's chain; the regtest harness (tn4-tools-regtest.sh) names regtest.
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { feldmanGroup } from '../src/curve.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { attestedClaimKey } from '../../arena-client/src/join.js';
import { lockFromClient } from '../../arena-client/src/lock-result.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { worldIsShared } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

const env = process.env;
for (const k of ['ROUND', 'PORTS', 'INVITE_FILE', 'WASM_PKG', 'LNCLI', 'PAYER_DIR', 'PAYER_RPC'])
  if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const rand = (n) => new Uint8Array(randomBytes(n));
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 },
  (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, `--network=${env.ARENA_TN4_NETWORK || 'testnet4'}`, ...a]);
const scalar = () => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } };
const evenPlayer = () => { let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02); return schnorr.getPublicKey(k); };

const nodes = env.PORTS.split(',').map((p) => `http://127.0.0.1:${p.trim()}`);
const invite = readFileSync(env.INVITE_FILE, 'utf8').replace(/["\s]/g, '');
let code = 0;
try {
  // THE ROUND, AS ITS OWN SIGNER NODES HOLD IT
  const r = await fetch(`${nodes[0]}/round?id=${env.ROUND}`);
  if (!r.ok) throw new Error(`${nodes[0]} holds no round ${env.ROUND}: ${r.status}`);
  const c = decodeRoundContract(new Uint8Array(await r.arrayBuffer()));
  const rid = roundId(c);
  if (toHex(rid) !== env.ROUND) throw new Error('the node answered another round');
  const STAKE = BigInt(c.stakeMsat);
  say({ step: 'round', id: env.ROUND.slice(0, 16), stakeMsat: STAKE, custody: c.custody, federation: toHex(c.federationId).slice(0, 16),
    nodes: c.nodes.length, needed: receiptsNeeded(c.nodes.length), entryClose: new Date(Number(c.entryCloseMs)).toISOString() });

  const att = await attestedClaimKey({ round: { ...c, id: rid }, signerNodes: c.nodes, nodes, curve: pageCurve });
  if (!att.ok) throw new Error(`claim key: ${att.why}`);
  say({ step: 'claim key', claimPk: toHex(att.claimPk).slice(0, 16) });

  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `blwp-lock-client-${process.pid}.mjs`);
  copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
  const wasmMod = await import(esm);
  await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
  const { LockClient } = wasmMod;
  const held = new Map();
  const memStore = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
  const lc = await LockClient.join(invite, LockClient.federationIdOf(invite), toHex(rand(32)), memStore);
  const rule = JSON.parse(await lc.feeRule());
  const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) } });
  const net = netStakeMsat({ stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n });
  say({ step: 'joined', feeRule: rule, feeLock: gate.pays, netStakeMsat: net });

  // THE DEPOSIT: the stake plus the entry fee and what the federation takes, through whichever gateway the client picks
  const depositMsat = STAKE + entryFeeMsat(STAKE) + 200000n;
  const t = Date.now();
  const rcv = JSON.parse(await lc.receive(String(depositMsat), ''));
  const payee = JSON.parse((await payer('decodepayreq', rcv.invoice)).out).destination;
  const paid = await payer('payinvoice', '--force', rcv.invoice);
  const final = await lc.awaitReceive(rcv.operation);
  say({ step: 'deposit', msat: depositMsat, payee: payee.slice(0, 16),
    paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 120)])[0], final, ms: Date.now() - t,
    balanceMsat: await lc.balanceMsat() });

  // LOCKED TO THE ATTESTED CLAIM KEY, AND HANDED TO EVERY SIGNER NODE
  const s = { p: scalar(), player: evenPlayer() };
  s.point = feldmanGroup.pointFromScalar(scalarFrom32(s.p) % FIELD);
  const t2 = Date.now();
  const lk = lockFromClient(await lc.lock(toHex(s.point), String(net), toHex(att.claimPk), toHex(refundKeyOf(s.player)), 150),
    { point: s.point, claimPk: att.claimPk, refundPk: refundKeyOf(s.player) });
  say({ step: 'locked', outpoint: `${toHex(lk.outpoint.txid)}:${lk.outpoint.outIdx}`, msat: net, ms: Date.now() - t2 });
  let fee = null, hand = null;
  if (gate.pays) {
    const F = rand(32);
    const got = lockFromClient(await lc.lockHash(toHex(sha256(F)), String(entryFeeMsat(STAKE)), toHex(att.claimPk), toHex(refundKeyOf(s.player)), 150),
      { hash: sha256(F), claimPk: att.claimPk, refundPk: refundKeyOf(s.player) });
    fee = { preimage: F, outpoint: got.outpoint }; hand = got.fields;
    say({ step: 'fee locked', outpoint: `${toHex(got.outpoint.txid)}:${got.outpoint.outIdx}` });
  }
  const needed = receiptsNeeded(c.nodes.length);
  const e = rand(32);
  const dealt = await dealHandout({ preimage: s.p, signerNodes: c.nodes, roundId: rid, playerPubkey: s.player,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed, curve: feldmanGroup });
  const entry = { roundId: rid, playerPubkey: s.player, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    stakeCommitment: sha256(s.p), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n, joinTick: 0,
    // A SHARED-WORLD ROUND'S ENTRY NAMES NO WORLD SECRET, as the page's join writes it (join.js; found by the regtest run of
    //: every seat refused a random one, "an entry names no world secret (32 zero bytes)")
    worldSecret: worldIsShared(c, sharedWorldOf(c.gameId)) ? new Uint8Array(32) : rand(32), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: fee ? fee.preimage : new Uint8Array(32), stakeLockOutpoint: lk.outpoint,
    feeLockOutpoint: fee ? fee.outpoint : { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: att.ref };
  const eid = entryId(entry);
  const signerNodes = [];
  for (const n of nodes) {
    const h = await fetch(`${n}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const en = await fetch(`${n}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    const enWhy = (await en.text()).trim().slice(0, 140);
    if (hand) await fetch(`${n}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(hand)) });
    const l = await fetch(`${n}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(lk.fields)) });
    signerNodes.push({ node: n, handout: h.status, entry: en.status, ...(en.status >= 300 ? { entryWhy: enWhy } : {}),
      lock: l.status, lockSaid: (await l.text()).trim().slice(0, 160) });
  }
  say({ step: 'handed over', entry: toHex(eid).slice(0, 16), signerNodes });
  if (signerNodes.filter((x) => x.lock >= 200 && x.lock < 300).length < needed) code = 1;
} catch (e) {
  code = 1;
  say({ step: 'stopped', why: String(e.stack || e.message).slice(0, 600) });
}
process.exit(code);
