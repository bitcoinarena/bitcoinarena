// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 3: ONE SEAT'S UNVERIFIED FEDERATION RECORD POISONS THE GUARDIAN FALLBACK. federationStatuses notes every record's
// invite (noteRecordInvite) BEFORE the record is verified, and guardian-invites keeps the FIRST url named for each peer. A seat that answers
// GET /federations first with an unsigned record whose invite names the player's federation id and peers 0..6 at its own hosts takes every
// peer slot: the real urls, from the honest seats' records and from the round's own invite, are dropped, and wholeInvite - the retry a
// join makes when its guardian is down ("Failed to download client config") - names only the attacker's hosts, so the retry fails too.
// Safe: an invite from a record that does not verify never replaces (or pre-empts) a guardian url the client was given by a verified source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteForGuardians, readInvite } from '../../arena-node/src/invite.js';
import { wholeInvite, forgetGuardianInvites } from '../src/guardian-invites.js';
import { federationStatuses } from '../src/federations.js';
import { encodeFederationRecord, joinSignedRecord, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const FID = '4dc88be70830d3619fd8742eaf639ab297774850cc68a203aad5b10a21e1fe98';
const id = Uint8Array.from(FID.match(/../g).map((x) => parseInt(x, 16)));
const real = (n) => `wss://seat.example.com/fed2-${n}/guardian`;
const evil = (n) => `wss://evil.example.net/g${n}`;
const ONE = inviteForGuardians(id, [{ peer: 6, url: real(8) }]);
const ALL = inviteForGuardians(id, [0, 1, 2, 3, 4, 5, 6].map((p) => ({ peer: p, url: real(p + 1) })));
const EVIL = inviteForGuardians(id, [0, 1, 2, 3, 4, 5, 6].map((p) => ({ peer: p, url: evil(p) })));
const recordHex = (invite) => toHex(joinSignedRecord(encodeFederationRecord({ federationId: id, networkId: new Uint8Array(32), invite, nominal: 7, threshold: 5,
  guardians: [], status: FEDERATION_STATUS.OPEN, successorId: new Uint8Array(32), gone: [], exposureCapSats: 0n, reserveSats: 0n, height: 1 }), []));

test('a seat\'s unsigned record does not decide which hosts the guardian fallback joins through', async () => {
  forgetGuardianInvites();
  const fetcher = async (u) => {
    if (u.startsWith('https://bad.example')) return new Response(JSON.stringify({ federations: [{ federation: FID, record: recordHex(EVIL) }] }), { status: 200 });
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ federations: [{ federation: FID, record: recordHex(ALL) }] }), { status: 200 });
  };
  const st = await federationStatuses({ nodes: ['https://bad.example', 'https://a.example', 'https://b.example'], census: [], verify: () => false, fetcher });
  assert.equal(st.get(FID).status, 'unverified', 'the bad seat\'s record does not verify');
  const w = wholeInvite(ONE);
  const urls = w ? readInvite(w).guardians.map((g) => g.url) : [];
  console.log(`  the fallback invite names: ${urls.join(', ') || '(none)'}`);
  assert.ok(!urls.some((u) => u.includes('evil.example')), 'no guardian url of an unverified record is joined through');
  assert.ok(!w || urls.includes(real(8)), 'the round\'s own guardian url is kept');
});
