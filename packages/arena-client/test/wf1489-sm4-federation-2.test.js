// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm4-find-federation 2 (state machine audit, federation; order of answers): THE PAGE'S FEDERATION STATUS IS WHICHEVER SEAT
// ANSWERED FIRST WHEN TWO SEATS HOLD RECORDS OF ONE HEIGHT.
// A record's height is the census height it is built at, the same for hours, so a federation's guardians sign several records at one height
// over time: OPEN while all seven are seated, CRITICAL once two owners left. The seats keep them apart for a while: a seat that has not
// gathered since keeps its OPEN at h and refuses a mirrored CRITICAL of the same height (federation-records.js recordStep, "a mirror never
// worsens"). The page reads every seat's GET /federations and takes newestRecord (arena-protocol federation-record.js): sorted by height
// only - at equal heights the first in the list, i.e. the seat whose answer arrived first. So one page load sees CRITICAL (deposit and join
// refused, the notes evacuated - ARENA_EVACUATE), the next load, or a second tab, sees OPEN for the same signed facts: deposits go on into a
// federation two guardians short of a halt and nothing moves the player's notes out.
// Invariant: the status a page takes from verified records does not depend on the order the seats answered in, and a CRITICAL record its
// census' guardians signed at the newest height is not hidden by an OPEN one of that height.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationStatuses } from '../src/federations.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';

const FED = new Uint8Array(32).fill(0x37);
const FID = Buffer.from(FED).toString('hex');
const HEIGHT = 156036;
const invite = inviteForGuardians(FED, [{ url: 'wss://g.example/', peer: 0 }]);
const nodes = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });
const census = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(i), vout: 0, bondSats: 50000n, advert: { guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } }));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

function signed(gone, signers) {
  const r = buildFederationRecord({ federationId: FED, networkId: new Uint8Array(32).fill(0x10), invite, nominal: 7, height: HEIGHT,
    guardians: census.map((e) => ({ peerKey: e.advert.guardianOf[0].guardianKey, nodePubkey: e.pubkey, operatorId: '', bondTxid: e.txid, bondVout: 0, endpoint: '', bondSats: 50000n })),
    gone: gone.map((n) => ({ peerKey: n.guardianKey, sinceHeight: HEIGHT, kind: 1, proofRef: new Uint8Array(32) })) });
  const id = federationRecordId(r);
  return Buffer.from(joinSignedRecord(encodeFederationRecord(r), signers.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })))).toString('hex');
}

test('wf1489-sm4-federation-2: two records of one height - the page\'s status does not follow the faster seat', async () => {
  const OPEN = signed([], nodes);                                      // signed while all seven were seated
  const CRITICAL = signed([nodes[0], nodes[1]], nodes.slice(2));       // signed after two owners left: 5 of 7, the threshold
  // seat-old has not gathered since (it keeps OPEN at h and refuses the mirrored CRITICAL of the same height); seat-new gathered CRITICAL
  const fetcherWith = (fastFirst) => async (url) => {
    const isOld = String(url).includes('seat-old');
    await new Promise((r) => setTimeout(r, (isOld === (fastFirst === 'old')) ? 5 : 60));
    return new Response(JSON.stringify({ federations: [{ federation: FID, record: isOld ? OPEN : CRITICAL }] }), { status: 200 });
  };
  const nodesAsked = ['https://seat-new.example', 'https://seat-old.example'];
  const a = (await federationStatuses({ nodes: nodesAsked, census, verify, fetcher: fetcherWith('new') })).get(FID);
  const b = (await federationStatuses({ nodes: nodesAsked, census, verify, fetcher: fetcherWith('old') })).get(FID);
  console.log('  MEASURED:', JSON.stringify({ criticalSeatFirst: { status: a.status, height: a.height, signers: a.signers, deposit: a.allows.deposit, from: a.from },
    openSeatFirst: { status: b.status, height: b.height, signers: b.signers, deposit: b.allows.deposit, from: b.from } }));
  assert.equal(a.status, 'CRITICAL');
  assert.equal(b.status, a.status, `the same verified records read ${a.status} when one seat answers first and ${b.status} when the other does`);
  assert.equal(b.allows.deposit, false, 'a deposit is allowed into a federation its guardians signed CRITICAL at the newest height');
});
