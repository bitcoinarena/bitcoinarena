// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 5 (client): ONE SEAT'S GET /federations ANSWER IS BOUNDED. federationStatuses (every order's federation read, the
// Move offer's loads, the wallet's federation chip) takes each seat's `federations` list whole and runs verifyFederationRecord on every row:
// up to 32 BIP-340 verifies per row, against the guardians the public census bonds. One seat that lists the federation's record thousands of
// times, each copy carrying 32 fresh made-up signatures under the bonded guardians' public keys (nothing secret: the census is public), makes
// the page run tens of thousands of schnorr verifies on its main thread on every read - the page freezes for minutes, and the order that
// waited on the read with it. Safe: what one seat's answer can cost is bounded, and the honest record still stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationStatuses } from '../src/federations.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';

test('wf1489-r5-client-1: one seat padding GET /federations with 2000 forged copies does not cost the page 64,000 signature checks', async () => {
  const FED = new Uint8Array(32).fill(0x37);
  const fidHex = Buffer.from(FED).toString('hex');
  const invite = inviteForGuardians(FED, [{ url: 'wss://g.example/', peer: 0 }]);
  const nodes = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });
  const census = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(i), vout: 0, bondSats: 50000n, advert: { guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } }));
  const r = buildFederationRecord({ federationId: FED, networkId: new Uint8Array(32).fill(0x10), invite, nominal: 7, height: 156036,
    guardians: census.map((e) => ({ peerKey: e.advert.guardianOf[0].guardianKey, nodePubkey: e.pubkey, operatorId: '', bondTxid: e.txid, bondVout: 0, endpoint: '', bondSats: 50000n })) });
  const body = encodeFederationRecord(r);
  const id = federationRecordId(r);
  const honestSigs = nodes.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) }));
  const honest = Buffer.from(joinSignedRecord(body, honestSigs)).toString('hex');
  // the liar's rows: the same public body, 32 made-up signatures each under the bonded guardians' public keys (repeated keys are allowed)
  let ctr = 0;
  const forged = () => {
    const sigs = Array.from({ length: 32 }, (_, j) => { const s = new Uint8Array(64); new DataView(s.buffer).setUint32(0, ++ctr); s[63] = 0xee; return { nodePubkey: nodes[j % 7].pubkey, signature: s }; });
    // joinSignedRecord sorts by key; keep the 32
    return Buffer.from(joinSignedRecord(body, sigs)).toString('hex');
  };
  const padded = { federations: [...Array.from({ length: 2000 }, () => ({ federation: fidHex, record: forged() })), { federation: fidHex, record: honest }] };
  const good = new Set(honestSigs.map((s) => Buffer.from(s.signature).toString('hex')));
  let verifies = 0;
  const verify = (sig) => { verifies++; return good.has(Buffer.from(sig).toString('hex')); };   // counts; the real check would cost ~1 ms each
  const fetcher = async (u) => new Response(JSON.stringify(String(u).startsWith('https://liar') ? padded : { federations: [{ federation: fidHex, record: honest }] }), { status: 200 });
  const all = await federationStatuses({ nodes: ['https://honest.example', 'https://liar.example'], census, verify, fetcher });
  console.log(`FACTS: signature checks for one read = ${verifies}; status = ${all.get(fidHex) && all.get(fidHex).status}`);
  assert.equal(all.get(fidHex).status, 'OPEN', 'the honest record still stands');
  assert.ok(verifies <= 1000, `one seat's answer cost the page ${verifies} signature checks (64,000+ with 2000 padded rows); it must be bounded`);
});
