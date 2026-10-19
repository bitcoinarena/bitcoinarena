#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEDERATION.md REHEARSAL 14B, ABSENCE FROM THE GUARDIANS THEMSELVES (§23A.4): rehearsal 14 signed the
// attestations in the script; here each guardian's node signs them from what its own fedimintd says (src/absence-producer.js,
// the admin `status` over the guardian's API socket) - the code every seat runs. tools/rehearsal-14b-regtest.sh stands up the
// federation of 4 (3 of 4) and calls this one step at a time, the producers' views kept in $P/r14b.json. Never testnet4.
//
//   pass            one pass of every running guardian's producer: who it sees, who is absent since when, what it signed
//   proof           the abandonment proof the signed attestations make for peer PEER (absence.js), against a record whose
//                   guardians are the federation's broadcast keys and these nodes' keys, threshold 3
//   halt            g2 and g3 stopped, the federation halted (2 of 4): five census seats (src/halts.js, the code every seat runs)
//                   ask all four guardians' session_count over their sockets, abandon_blocks are mined, they observe again, sign
//                   and hand their observations to each other; the halt proof each seat then makes (halt-proof.js)
//
// One JSON line per question; it decides nothing.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { abandonmentProof } from '../../arena-protocol/src/absence.js';
import { clocksFor } from '../../arena-protocol/src/federation-slash.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';
import { createAbsenceProducer, guardianConfigOf, wsAdminStatus } from '../src/absence-producer.js';
import { createHalts, wsSessionCount } from '../src/halts.js';
import { readAbsenceHex, absenceHex } from '../src/absences.js';

const P = process.env.P, B = process.env.BITCOIN_CLI, ARGS = (process.env.BTC_ARGS || '').split(' ').filter(Boolean);
const FED = process.env.FED, RUNNING = (process.env.RUNNING || '0,1,2,3').split(',').map(Number);
if (!P || !B || !FED) throw new Error('P=<run dir> BITCOIN_CLI=<bitcoin-cli> BTC_ARGS=<its args> FED=<federation id> [RUNNING=0,1,2]');
const out = (o) => console.log(JSON.stringify(o));
const height = () => Number(execFileSync(B, [...ARGS, 'getblockcount'], { encoding: 'utf8' }).trim());
const STATE = join(P, 'r14b.json');
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { views: {}, signed: [] };
const keep = () => writeFileSync(STATE, JSON.stringify(state, null, 1));
const { clocks } = clocksFor('regtest');
const node = (g) => { const secret = taggedHash('BLWP/v1/Rehearsal14b', new TextEncoder().encode(`node${g}`)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const apiPort = (g) => 30121 + g * 10;

const step = process.argv[2];
if (step === 'pass') {
  const tip = height();
  for (const g of RUNNING) {
    const dir = join(P, `g${g}`);
    const cfg = guardianConfigOf(dir, (f) => readFileSync(f, 'utf8'));
    const n = node(g);
    // every = abandon_blocks: a regtest day is that long here, so the second attestation spans the clock
    const p = createAbsenceProducer({ federationId: FED, ...cfg, attester: n.pub, every: clocks.abandonBlocks,
      status: () => wsAdminStatus(apiPort(g), readFileSync(join(dir, 'admin-password'), 'utf8').trim()), height: async () => tip,
      sign: (h) => schnorr.sign(h, n.secret), load: () => state.views[g], save: (v) => { state.views[g] = v; } });
    let r; try { r = await p.pass(); } catch (e) { out({ step: 'pass', guardian: g, ok: false, why: e.message }); continue; }
    for (const a of r.signed) state.signed.push(absenceHex(a));
    out({ step: 'pass', guardian: g, ok: r.ok, why: r.why, session: r.session, height: tip, seen: r.seen, absent: r.absent,
      signed: (r.signed || []).map((a) => ({ peer: toHex(a.peerKey).slice(0, 16), lastSeenHeight: a.lastSeenHeight, height: a.height })) });
  }
  keep();
} else if (step === 'proof') {
  const peerId = Number(process.env.PEER);
  const cfg = guardianConfigOf(join(P, 'g0'), (f) => readFileSync(f, 'utf8'));
  const record = { federationId: fromHex(FED), threshold: 3, guardians: [0, 1, 2, 3].map((g) => ({ peerKey: cfg.peerKeyOf(g), nodePubkey: node(g).pub })) };
  const all = state.signed.map(readAbsenceHex);
  const verify = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };
  const p = abandonmentProof(all, { record, peerKey: cfg.peerKeyOf(peerId), abandonBlocks: clocks.abandonBlocks, verify });
  out({ step: 'proof', peer: peerId, held: all.length, abandonBlocks: clocks.abandonBlocks, ok: p.ok, why: p.why || null, signers: p.signers || 0,
    sinceHeight: p.sinceHeight ?? null, id: p.id ? toHex(p.id).slice(0, 16) : null,
    spans: all.filter((a) => toHex(a.peerKey) === toHex(cfg.peerKeyOf(peerId))).map((a) => a.height - a.lastSeenHeight) });
} else if (step === 'halt') {
  const cfg = guardianConfigOf(join(P, 'g0'), (f) => readFileSync(f, 'utf8'));
  const record = { federationId: fromHex(FED), threshold: 3,
    guardians: [0, 1, 2, 3].map((g) => ({ peerKey: cfg.peerKeyOf(g), nodePubkey: node(g).pub, endpoint: `ws://127.0.0.1:${apiPort(g)}` })) };
  const records = { list: () => [{ federation: FED }], recordOf: (f) => (f === FED ? { record, status: 'OPEN', height: 1 } : null) };
  const seatKeys = [0, 1, 2, 3, 4].map((i) => node(`seat${i}`));
  const verify = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };
  const seats = [];
  for (const k of seatKeys) {
    seats.push(createHalts({ records, censusSeats: () => seatKeys.map((x) => x.pub), clocks, verify, sign: (h) => schnorr.sign(h, k.secret),
      ownKey: k.pub, height: async () => height(), ask: (e) => wsSessionCount(e, { timeoutMs: 3000 }),
      post: async (o) => { for (const other of seats) other.take(o); } }));
  }
  const t0 = Date.now();
  const first = await Promise.all(seats.map((x) => x.observe()));
  out({ step: 'halt observed', at: 'first', height: height(), rows: first.map((r) => r[0]), ms: Date.now() - t0 });
  execFileSync(B, [...ARGS, 'generatetoaddress', String(clocks.abandonBlocks), execFileSync(B, [...ARGS, 'getnewaddress'], { encoding: 'utf8' }).trim()]);
  const t1 = Date.now();
  const later = await Promise.all(seats.map((x) => x.observe()));
  out({ step: 'halt observed', at: `after ${clocks.abandonBlocks} blocks`, height: height(), rows: later.map((r) => r[0]), ms: Date.now() - t1 });
  const proofs = seats.map((x) => x.proofOf(FED));
  const p = proofs[0];
  const name = (k) => [0, 1, 2, 3].find((g) => toHex(cfg.peerKeyOf(g)) === toHex(k));
  out({ step: 'halt proof', seatsProving: proofs.filter(Boolean).length, of: seats.length, ok: !!p, session: p ? p.session : null, haltHeight: p ? p.haltHeight : null,
    observers: p ? p.observers : 0, abandoned: p ? p.abandoned.map(name) : null, answered: p ? p.answered.map(name) : null, id: p ? toHex(p.id).slice(0, 16) : null });
} else throw new Error(`no step ${step}`);
