#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * TWO GUARDIANS LEAVE, AND THE FEDERATION IS CRITICAL (kanban #321, §23A.1 / 23A.4) - on a regtest stack whose seats were
 * started with ARENA_TEST_OWNER_PUBKEY (round-2of2's test owner): each named seat's owner signs a leave as the owner page
 * signs it (signOwnerRequest, POST /owner/leave); then GET /federations at the first seat is read until the federation's
 * record says what two of seven leaving makes it - CRITICAL - or the time runs out.
 *
 *   NODES=<seat ports> LEAVE=<seat numbers, 1-based> OWNER_SECRET=<hex> [WAIT_S=600] node tools/critical-leave.mjs
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { signOwnerRequest } from '../src/owner.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const nodes = env.NODES.split(',').map((p) => `http://127.0.0.1:${p.trim()}`);
const secret = fromHex(env.OWNER_SECRET);
let code = 0;
try {
  for (const n of String(env.LEAVE || '6,7').split(',').map(Number)) {
    const base = nodes[n - 1];
    const node = toHex(new Uint8Array(await (await fetch(`${base}/identity`)).arrayBuffer()));   // GET /identity: the 32 key bytes
    const body = signOwnerRequest({ node, action: 'leave', secret, sign: (m, s) => schnorr.sign(m, s), pubkeyOf: (s) => schnorr.getPublicKey(s) });
    const r = await fetch(`${base}/owner/leave`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    log({ step: 'leave', seat: n, node: String(node).slice(0, 16), status: r.status, said: (await r.text()).slice(0, 200) });
  }
  const until = Date.now() + Number(env.WAIT_S || 600) * 1000;
  let last = null;
  for (;;) {
    try { last = (await (await fetch(`${nodes[0]}/federations`)).json()).federations || []; } catch { last = null; }
    const st = (last || []).map((f) => f.status);
    log({ step: 'record', statuses: st, signers: (last || []).map((f) => f.signers) });
    if (st.includes('CRITICAL') || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 15000));
  }
  if (!(last || []).some((f) => f.status === 'CRITICAL')) code = 1;
} catch (e) { code = 1; log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 400) }); }
process.exit(code);
