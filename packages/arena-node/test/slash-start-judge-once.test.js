// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PROOF IS JUDGED ONCE PER judgeAgainMs (kanban #1044 B1 phase 4, measured 2026-11-05 on the devnet: four named-claim proofs this seat's judge could not say
// about were judged again on every 500 ms pass at seven seats, each judgement a stake-lock tool run - the MacBook load went to 160). A false verdict is not
// asked again; an undefined one only after judgeAgainMs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSlashStarter } from '../src/slash-start-run.js';
import { BOND_TEMPLATE_V3 } from '../../arena-protocol/src/bond-script.js';

const b32 = (n) => new Uint8Array(32).fill(n);

function seat(verdict, clock) {
  const asked = [];
  const bond = { txid: b32(0x71), vout: 1 };
  const entry = { txid: bond.txid, vout: 1, pubkey: b32(0x22), hold: null, advert: { bondScriptTemplateVersion: BOND_TEMPLATE_V3 } };
  const judge = Object.assign(async (bytes) => { asked.push(bytes[0]); return verdict(bytes[0]); }, { read: () => ({ ok: true, bond }) });
  const starter = createSlashStarter({ key: b32(0x11), network: 'regtest', db: new DatabaseSync(':memory:'), store: { held: () => null }, thresholdOf: () => null,
    tipHeight: async () => 500, entriesAtTip: async () => [entry], heldProofs: async () => [{ proofId: b32(1), bytes: Uint8Array.of(1), seenMs: 0 }, { proofId: b32(2), bytes: Uint8Array.of(2), seenMs: 0 }],
    bytesOf: () => null, judge, holdsFor: () => ({ holds: [] }), feeCoin: async () => ({ ok: false }), urlsOf: () => [], stepMs: 0, judgeAgainMs: 60000, now: () => clock.ms, send: async () => 'x' });
  return { starter, asked };
}

test('a proof the judge cannot say about is judged again only after judgeAgainMs; a false one never', async () => {
  const clock = { ms: 1000 };
  const { starter, asked } = seat((b) => ({ verdict: b === 1 ? undefined : false, why: 'cannot say' }), clock);
  await starter.pass();
  assert.deepEqual(asked, [1, 2]);
  for (let i = 0; i < 20; i++) { clock.ms += 500; await starter.pass(); }
  assert.deepEqual(asked, [1, 2], 'twenty passes 500 ms apart judge nothing again');
  clock.ms += 60000;
  await starter.pass();
  assert.deepEqual(asked, [1, 2, 1], 'the undefined one again after a minute, the false one never');
});
