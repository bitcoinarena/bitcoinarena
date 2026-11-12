// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM2 FEDERATION 2 (state-machine audit, crash-restart): a seat's federation records are on disk (federation_records), but a
// restarted seat reads them back only 20 s after start (server.js restoreSoon) - and until then every federation it held HALTED,
// CRITICAL or DRAINING is, at this seat, a federation with no record: drainingRefusal names no record, liquidations.haltOf() is null
// (so POST /exchange's liquidation guard, kanban #1244, lets an exchange out of or into a liquidated federation through), GET
// /liquidations lists nothing and GET /federations lists nothing. The record says HALTED on disk; the seat acts as if it never was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, GONE } from '../../arena-protocol/src/federation-record.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { readInvite } from '../src/invite.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';

const STOCK = 'fed11qgqzc2nhwden5te0wdjkzapwv4uxzmtsd3jjucm0d5hkwatpwfjxjctw95cj7em4v9exg6tpdcqqzgpn0tsp450fhv6m2c504tf52lnz66wsxmh73g6telpqevcmg2ahtcr2fwl5';
const FED = readInvite(STOCK).federationId;
const FID = typeof FED === 'string' ? FED.toLowerCase() : toHex(FED);
const FEDB = Uint8Array.from(Buffer.from(FID, 'hex'));
const NET = new Uint8Array(32).fill(0x10);

const nodes = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret),
  guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });

function haltedRecord(height) {
  const guardians = nodes.map((n, i) => ({ peerKey: n.guardianKey, nodePubkey: n.pubkey, operatorId: `op${i}`, bondTxid: new Uint8Array(32).fill(0xa0 + i), bondVout: 0, endpoint: '', bondSats: 50000n }));
  const gone = [4, 5, 6].map((i) => ({ peerKey: nodes[i].guardianKey, sinceHeight: height - 10, kind: GONE.ABANDONED, proofRef: new Uint8Array(32).fill(i) }));
  const r = buildFederationRecord({ federationId: FEDB, networkId: NET, invite: STOCK, nominal: 7, guardians, gone, height });
  const id = federationRecordId(r);
  return joinSignedRecord(encodeFederationRecord(r), nodes.slice(0, 5).map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })));
}

test('wf1489-sm2-federation-2: a seat restarted while it holds a federation HALTED treats it as HALTED from its first answer', { timeout: 120000 }, async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wf1489-sm2-fed2-')), 'node.db');
  // the seat before the crash: it held the federation's signed HALTED record (what keep() wrote through recordStore.save)
  const s1 = await serve(openStore(path), { plugins: [], port: 0 });
  await s1.close();
  const db = openStore(path);
  db.prepare('INSERT INTO federation_records (federation, record) VALUES (?, ?) ON CONFLICT(federation) DO UPDATE SET record = excluded.record').run(FID, toHex(haltedRecord(1000)));
  db.close();
  // THE RESTART
  const s2 = await serve(openStore(path), { plugins: [], port: 0 });
  try {
    const S = `http://127.0.0.1:${s2.port}`;
    await new Promise((r) => setTimeout(r, 1000));
    const fedsNow = (await (await fetch(`${S}/federations`)).json()).federations;
    const liqNow = (await (await fetch(`${S}/liquidations`)).json()).liquidations;
    console.log(`  MEASURED 1 s after the restart: GET /federations ${JSON.stringify(fedsNow.map((f) => [f.federation.slice(0, 8), f.status]))}, GET /liquidations ${liqNow.length} listed`);
    // the record on disk is good: 20 s later the seat reads it back as HALTED (shown, not asserted, so the test says what is late)
    await new Promise((r) => setTimeout(r, 21000));
    const fedsLater = (await (await fetch(`${S}/federations`)).json()).federations;
    const liqLater = (await (await fetch(`${S}/liquidations`)).json()).liquidations;
    console.log(`  MEASURED 22 s after the restart: GET /federations ${JSON.stringify(fedsLater.map((f) => [f.federation.slice(0, 8), f.status]))}, GET /liquidations ${liqLater.length} listed`);
    assert.deepEqual(fedsNow.map((f) => [f.federation, f.status]), [[FID, 'HALTED']], 'right after the restart the seat holds no record of a federation it held HALTED');
    assert.equal(liqNow.length, 1, 'right after the restart the liquidation of a HALTED federation is not listed (haltOf null: exchanges and entries pass its guards)');
  } finally { await s2.close(); }
});
