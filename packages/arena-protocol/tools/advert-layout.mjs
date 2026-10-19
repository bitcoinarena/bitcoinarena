#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * WHAT THE ADVERTISEMENT'S BYTES ARE, FIELD BY FIELD.
 *
 *   node packages/arena-protocol/tools/advert-layout.mjs
 *
 * §5A.2 carries the signed advertisement in the bond spend's witness, and Bitcoin Core's policy refuses a
 * tapscript witness stack item over 80 bytes ("bad-witness-nonstandard"). That is why the bond confirms on
 * regtest - `generateblock` puts it in a block without asking the mempool - and why it can never be
 * relayed on testnet4 or mainnet, where the blocks are somebody else's.
 *
 * Before anything is cut, this says where the bytes actually go: each field's own cost, measured by
 * encoding the prefix 1..n and diffing the lengths, not by reading the struct and adding up.
 *
 * Nothing is signed on chain, nothing is spent, no node is asked. The signature is the fixed 64 bytes a
 * BIP-340 signature always is.
 */
import { Writer } from '../src/encode.js';
import { encodeAdvert } from '../src/advert.js';
import { TYPE_ADVERT, PROTOCOL_VERSION, roleByte } from '../src/constants.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const SIGNATURE_BYTES = 64;
const POLICY_LIMIT = 80;              // MAX_STANDARD_TAPSCRIPT_STACK_ITEM_SIZE

/** The advertisement the Daily's own launcher posts (tools/regtest-bond.mjs), so the numbers are its. */
export const DAILY_ADVERT = {
  nodePubkey: new Uint8Array(32).fill(1), operatorId: '2of2', protocolVersions: [1],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify', 'settlement'], endpoint: 'ws://127.0.0.1:18080', region: 'eu-west',
  capacityClass: 1, softwareHash: new Uint8Array(32).fill(2), settlementCapabilities: 0,
  lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0,
  bondScriptTemplateVersion: 1, payoutPubkey: new Uint8Array(32).fill(3), guardianOf: [],
  timestamp: 1788700000000n,
};

/**
 * Each field, in the order `encodeAdvert` writes it, with why it is there. `keeps` is what §5A.1 and the
 * rulings since actually need on the chain; the rest is description a census could be told elsewhere.
 */
export const FIELDS = (a) => [
  ['type (u8)', (w) => w.u8(TYPE_ADVERT), true, 'what this object is'],
  ['protocol version (u16)', (w) => w.u16(PROTOCOL_VERSION), true, 'which wire format'],
  ['nodePubkey (32)', (w) => w.bytes32(a.nodePubkey), true, '5A.1: who the bond gives standing to'],
  ['operatorId (str)', (w) => w.str(a.operatorId), false, '5A.13: SELF-DECLARED, never proof of anything'],
  ['protocolVersions (vec u16)', (w) => w.vec([...a.protocolVersions], (v, ww) => ww.u16(v)), false, 'negotiation, not consensus'],
  ['roles (vec u8)', (w) => w.vec([...a.roles].sort(), (r, ww) => ww.u8(roleByte(r)),
    { sortedBy: (x, y) => (x < y ? -1 : x > y ? 1 : 0) }), true, 'opt-in roles: drawn only for what it declared'],
  ['endpoint (str)', (w) => w.str(a.endpoint), true, '25.1: fixed for the life of the bond'],
  ['region (str)', (w) => w.str(a.region), false, 'description'],
  ['capacityClass (u8)', (w) => w.u8(a.capacityClass), false, 'description'],
  ['softwareHash (32)', (w) => w.bytes32(a.softwareHash), false, 'description; nothing on chain checks it'],
  ['settlementCapabilities (u32)', (w) => w.u32(a.settlementCapabilities), false, 'description'],
  ['lightningCapabilities (u32)', (w) => w.u32(a.lightningCapabilities), false, 'description'],
  ['bondTxid (32)', (w) => w.bytes32(a.bondTxid), true, '5A.1 MANDATORY: the census entry itself'],
  ['bondVout (u32)', (w) => w.u32(a.bondVout), true, '5A.1 MANDATORY'],
  ['bondScriptTemplateVersion (u16)', (w) => w.u16(a.bondScriptTemplateVersion), true, '5A.1 MANDATORY'],
  ['payoutPubkey (32)', (w) => w.bytes32(a.payoutPubkey), true, '22A: where this node is paid'],
  ['guardianOf (vec)', (w) => w.vec(a.guardianOf, (g, ww) => { ww.bytes32(g.federationId); ww.bytes(g.guardianKey, 33); }),
    true, '23.6 P3: a federation is valid only if its guardians say so here'],
  ['timestamp (u64)', (w) => w.u64(a.timestamp), true, 'ordering and freshness'],
];

export function layoutOf(a) {
  const steps = FIELDS(a);
  const rows = [];
  let prev = 0;
  for (let n = 1; n <= steps.length; n++) {
    const w = new Writer();
    for (let i = 0; i < n; i++) steps[i][1](w);
    const len = w.finish().length;
    rows.push({ name: steps[n - 1][0], bytes: len - prev, running: len, keeps: steps[n - 1][2], why: steps[n - 1][3] });
    prev = len;
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = layoutOf(DAILY_ADVERT);
  console.log('field                             bytes  running  on-chain?  why');
  for (const r of rows)
    console.log(`${r.name.padEnd(33)}${String(r.bytes).padStart(5)}${String(r.running).padStart(9)}   ${(r.keeps ? 'needed' : 'no').padEnd(9)} ${r.why}`);
  const body = encodeAdvert(DAILY_ADVERT);
  const keeps = rows.filter((r) => r.keeps).reduce((a, r) => a + r.bytes, 0);
  const drops = rows.filter((r) => !r.keeps).reduce((a, r) => a + r.bytes, 0);
  console.log(`\nbody as encodeAdvert writes it      ${body.length}`);
  console.log(`  of which needed on chain          ${keeps}`);
  console.log(`  of which description              ${drops}`);
  console.log(`+ BIP-340 signature                  ${SIGNATURE_BYTES}`);
  console.log(`= one witness stack item            ${body.length + SIGNATURE_BYTES}   (policy refuses over ${POLICY_LIMIT})`);
  console.log(`\nsmallest this can be by dropping description alone: ${keeps + SIGNATURE_BYTES} bytes - still over ${POLICY_LIMIT}.`);
  console.log(`The signature alone is ${SIGNATURE_BYTES} of the ${POLICY_LIMIT}, so no field cut reaches it.`);
}
