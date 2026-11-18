// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2977 (feedback #325): a seat served a federation no current census names - a record restore() kept because it stood against the
// census at its own height. GET /federations (served) now lists only federations the last census read names; list() keeps the record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { inviteForGuardians } from '../src/invite.js';
import { inviteFederationId } from '../../arena-client/src/federations.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = inviteForGuardians(FED, Array.from({ length: 7 }, (_, i) => ({ peer: i, url: `wss://g${i}.example` })));

test('#2977: a kept federation the census stops naming is no longer served; while named it is', async () => {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const entry = (n, i, named) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0x20 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: named ? [{ federationId: FED, guardianKey: n.guardianKey }] : [] } });
  const census = { ok: true, entries: nodes.map((n, i) => entry(n, i, true)) };
  const keys = nodes.map((n) => n.guardianKey);
  const seats = nodes.map((n) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, guardianKeysOf: async () => keys,
    fetcher: async (url) => {
      const i = nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0) return new Response('no', { status: 404 });
      const u = new URL(url);
      const body = await seats[i].mySignature(u.searchParams.get('federation'), null, u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  const F = toHex(FED);
  await seats[1].gatherAll(inviteFederationId);
  assert.ok(seats[1].served().some((x) => x.federation === F), 'named by the census: served');
  census.entries = nodes.map((n, i) => entry(n, i, false));   // the census no longer names FED (its bonds advertise no guardian seat)
  await seats[1].gatherAll(inviteFederationId);
  assert.ok(!seats[1].served().some((x) => x.federation === F), 'no census names it: not served on GET /federations');
  assert.ok(seats[1].list().some((x) => x.federation === F), 'the kept record itself stays (halts, liquidations read it)');
  census.entries = nodes.map((n, i) => entry(n, i, true));
  await seats[1].gatherAll(inviteFederationId);
  assert.ok(seats[1].served().some((x) => x.federation === F), 'named again: served again');
});
