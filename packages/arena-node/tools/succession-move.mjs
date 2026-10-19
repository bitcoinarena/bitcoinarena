#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE NOTES FOLLOW THE SUCCESSOR, MEASURED (kanban #325, §23A.6 step 3) - the page's own path, without a browser: a player
 * wallet (one seed) gets a deposit in the old federation A from the payer lnd; then A's record, as the seats sign it, is
 * checked the way the page checks it (federationStatus against the round's census), and the page's migratePlayerWallet
 * moves what the A wallet can send into the player's wallet in B. Balances read before and after in both.
 *
 *   ROUND=<a round of A held by NODES> NODES=<A seat ports> INVITE_A=<file> INVITE_B=<file> WASM_PKG=<dir> LNCLI=<lncli>
 *   PAYER_DIR=<lnddir> PAYER_RPC=<host:port> [NETWORK=regtest] [DEPOSIT_MSAT=200000] node tools/succession-move.mjs
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { readInvite } from '../src/invite.js';
import { clientCommittee, checkedCensusFor } from '../../arena-client/src/committee.js';
import { federationStatus } from '../../arena-client/src/federations.js';
import { splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { playerWallet, migratePlayerWallet } from '../../arena-client/src/page-lock.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';

const env = process.env;
for (const k of ['ROUND', 'NODES', 'INVITE_A', 'INVITE_B', 'WASM_PKG', 'LNCLI', 'PAYER_DIR', 'PAYER_RPC']) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 }, (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, `--network=${env.NETWORK || 'regtest'}`, ...a]);
const nodes = env.NODES.split(',').map((p) => `http://127.0.0.1:${p.trim()}`);
const inviteA = readFileSync(env.INVITE_A, 'utf8').trim(), inviteB = readFileSync(env.INVITE_B, 'utf8').trim();
const fedA = readInvite(inviteA).federationId, fedB = readInvite(inviteB).federationId;
let code = 0;
try {
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `blwp-lock-client-${process.pid}.mjs`);
  copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
  const wasm = await import(esm);
  await wasm.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
  const kept = new Map();
  const storage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k),
    get length() { return kept.size; }, key: (i) => [...kept.keys()][i] ?? null };
  const c = decodeRoundContract(new Uint8Array(await (await fetch(`${nodes[0]}/round?id=${env.ROUND}`)).arrayBuffer()));
  const round = { ...c, id: fromHex(env.ROUND) };
  if (toHex(round.federationId) !== fedA) throw new Error(`round ${env.ROUND.slice(0, 16)} names ${toHex(round.federationId).slice(0, 16)}, not A ${fedA.slice(0, 16)}`);
  const seed = new Uint8Array(randomBytes(32));
  const LockClient = wasm.LockClient;
  // 1. A DEPOSIT INTO THE PLAYER'S WALLET IN A
  const a = await playerWallet({ round, invite: inviteA, seed, LockClient, storage });
  const amount = BigInt(env.DEPOSIT_MSAT || 200000);
  const rcv = JSON.parse(await a.receive(String(amount), ''));
  const paid = await payer('payinvoice', '--force', '--timeout', '90s', rcv.invoice);
  const final = await a.awaitReceive(rcv.operation);
  const aBefore = BigInt(await a.balanceMsat());
  log({ step: 'deposit into A', msat: amount, paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 120)])[0], final, balanceA: aBefore });
  if (final !== 'Claimed') throw new Error('the deposit into A was not claimed');
  // 2. A's RECORD, AS THE PAGE CHECKS IT: against the census this client checked for the round (clientCommittee)
  // A TEST CHAIN'S ANCHOR (a page takes the network's compiled-in one): the first header the seats serve - genesis at height 0,
  // or that block's height as the stack's bitcoind says (seating-regtest.mjs does the same with its headers.bin)
  const hb = new Uint8Array(await (await fetch(`${nodes[0]}/headers`)).arrayBuffer());
  const first = hb.subarray(0, 80);
  let height = 0;
  if (!first.subarray(4, 36).every((x) => x === 0)) {
    const hashHex = toHex(blockHashOf(first).slice().reverse());
    const cookie = readFileSync(env.ARENA_BITCOIND_COOKIE, 'utf8').trim();
    const r = await fetch(env.ARENA_BITCOIND_URL, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(cookie).toString('base64') },
      body: JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'getblockheader', params: [hashHex] }) });
    height = (await r.json()).result.height;
  }
  const anchorAt = { hash: blockHashOf(first), height };
  const committee = await clientCommittee(env.ROUND, round, nodes, { curve: pageCurve, compare: false, anchorAt });
  const census = checkedCensusFor(round);
  let status;
  if (census) status = await federationStatus({ federationIdHex: fedA, nodes, census, verify: pageCurve.verify });
  else if (env.SEAT_RECORD === '1') {
    // SEAT_RECORD=1 (said in the reading): the harness seats serve a header chain fixed at their start, short of the bonds,
    // so this client cannot check the census here; A's record is read as the seats sign it, not verified - the record's
    // verification against a census is #321's (federation-record.test, page-federation.test)
    const j = await (await fetch(`${nodes[0]}/federations`)).json();
    const f = (j.federations || []).find((x) => String(x.federation).toLowerCase() === fedA);
    if (!f) throw new Error(`no record of A at ${nodes[0]}`);
    const rec = splitSignedRecord(fromHex(f.record)).record;
    status = { status: f.status, signers: f.signers, nominal: rec.nominal, unverified: true,
      successorId: rec.successorId && rec.successorId.some((x) => x) ? toHex(rec.successorId) : null };
    log({ step: 'A record read from the seats (not census-checked)', why: committee && committee.why });
  } else throw new Error(`no checked census for the round: ${committee && committee.why}`);
  log({ step: 'A record', status: status.status, signers: status.signers, nominal: status.nominal, successor: status.successorId, why: status.why });
  // THE SUCCESSOR'S OWN RECORD: B's seats hold no round yet, so it signs none here - B is taken OPEN with its invite (stated)
  const successor = { status: 'OPEN', invite: inviteB, successorId: null };
  // 3. THE PAGE'S MOVE
  const b = await playerWallet({ round: { ...round, federationId: fromHex(fedB) }, invite: inviteB, seed, LockClient, storage });
  const bBefore = BigInt(await b.balanceMsat());
  const t0 = Date.now();
  const states = [];
  const moved = await migratePlayerWallet({ round, invite: inviteA, seed, LockClient, storage, status, successor, onState: (s) => states.push(s.state) });
  const aAfter = BigInt(await a.balanceMsat()), bAfter = BigInt(await b.balanceMsat());
  log({ step: 'moved', state: moved.state, why: moved.why, chunks: moved.chunks, movedMsat: moved.moved, ms: Date.now() - t0, states: [...new Set(states)],
    balanceA: { before: aBefore, after: aAfter }, balanceB: { before: bBefore, after: bAfter }, feesMsat: aBefore - aAfter - (bAfter - bBefore) });
  if (moved.state !== 'moved' || bAfter <= bBefore) code = 1;
} catch (e) { code = 1; log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 600) }); }
process.exit(code);
