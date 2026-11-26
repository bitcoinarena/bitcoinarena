// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3801 (RULED 2026-11-26 on PR #95's open point 1 of #3743): the federation record body the guardians sign took a guardian's row
// from the first census entry under its node key, in census order. A stranger's own bond to that key, under another operator id, stands in
// the census with a body the node did not sign (census.js `nodeSigned` false), so it could set the row's bondTxid/vout, operatorId and
// guardianEndpoint - and, with no config keys, add a second row for the node and lift the record's nominal. From the network's protocol-34
// height (listsSignedGuardians, one census height per network) the body lists only entries the node signed; below it the body is today's,
// byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { splitSignedRecord, listsSignedGuardians, setSignedGuardianHeightsForTests, SIGNED_GUARDIAN_HEIGHT } from '../../arena-protocol/src/federation-record.js';
import { federationRecords, guardiansOf } from '../src/federation-records.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = NETWORK_ID_REGTEST;
const HEIGHT = 156036;
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

/** Seven guardian seats on one census; `stranger`: a bond to node 0's key under another operator id, unsigned, sorting first. */
function seven({ stranger = false } = {}) {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const entries = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n, nodeSigned: true,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } }));
  if (stranger) {
    entries.unshift({ pubkey: nodes[0].pubkey, txid: new Uint8Array(32).fill(0x01), vout: 3, bondSats: 900000n, nodeSigned: false,
      advert: { operatorId: 'stranger', endpoint: 'wss://stranger.example', guardianEndpoint: 'wss://stranger-guardian.example',
        guardianOf: [{ federationId: FED, guardianKey: nodes[0].guardianKey }] } });
  }
  const census = { ok: true, entries };
  const seats = nodes.map((n) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: HEIGHT, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, leavingAtMs: () => null,
    fetcher: async (url) => {
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      const u = new URL(url);
      const body = await j.mySignature(u.searchParams.get('federation'), null, u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  return { nodes, census, seats };
}

/** The body the seven seats gather and keep: its bytes (hex) and its guardian rows. */
async function gathered(s) {
  const got = await s.seats[0].gather(FED, inviteFederationId);
  assert.equal(got.ok, true, got.why);
  const kept = s.seats[0].list();
  assert.equal(kept.length, 1);
  const { record, body } = splitSignedRecord(fromHex(kept[0].record));
  return { body: toHex(body), record };
}

const rowOf = (record, pubkey) => record.guardians.filter((g) => toHex(g.nodePubkey) === toHex(pubkey));

test('#3801 from the protocol-34 height a stranger\'s unsigned bond to a guardian\'s key sets nothing in the record body', async (t) => {
  const was = setSignedGuardianHeightsForTests({ regtest: HEIGHT });
  t.after(() => setSignedGuardianHeightsForTests(was));
  const s = seven({ stranger: true });
  const { record } = await gathered(s);
  const rows = rowOf(record, s.nodes[0].pubkey);
  assert.equal(rows.length, 1, 'one row for node 0, its own');
  assert.deepEqual([toHex(rows[0].bondTxid), rows[0].bondVout, rows[0].operatorId, rows[0].endpoint],
    [toHex(new Uint8Array(32).fill(0xa0)), 0, 'op0', 'wss://g0.example']);
  assert.equal(record.nominal, 7, 'the stranger adds no guardian to the nominal');
  assert.equal(record.guardians.length, 7);
});

test('#3801 below the height (and with no height named) the body is today\'s, byte for byte, stranger row and all', async (t) => {
  const was = setSignedGuardianHeightsForTests(undefined);
  t.after(() => setSignedGuardianHeightsForTests(was));
  const s = seven({ stranger: true });
  const today = await gathered(s);
  // today's body: the stranger's bond is a row of its own for node 0 (no config keys here), nominal 8
  assert.equal(today.record.nominal, 8);
  assert.equal(rowOf(today.record, s.nodes[0].pubkey).length, 2);
  assert.ok(today.record.guardians.some((g) => g.operatorId === 'stranger' && g.endpoint === 'wss://stranger-guardian.example'));
  setSignedGuardianHeightsForTests({ regtest: HEIGHT + 1 });
  assert.equal((await gathered(seven({ stranger: true }))).body, today.body, 'one block below the height: the same bytes');
  setSignedGuardianHeightsForTests({ regtest: null });
  assert.equal((await gathered(seven({ stranger: true }))).body, today.body, 'no height named: the same bytes');
});

test('#3801 with no stranger bond the body is the same bytes on both sides of the height', async (t) => {
  const was = setSignedGuardianHeightsForTests({ regtest: HEIGHT + 1 });
  t.after(() => setSignedGuardianHeightsForTests(was));
  const before = await gathered(seven());
  setSignedGuardianHeightsForTests({ regtest: HEIGHT });
  const after = await gathered(seven());
  assert.equal(after.body, before.body);
});

test('#3801 guardiansOf with the federation\'s config keys: the signed entry holds the key, not the stranger\'s', () => {
  const s = seven({ stranger: true });
  const keys = s.nodes.map((n) => n.guardianKey);
  const off = guardiansOf(s.census, FED, keys);
  assert.equal(rowOf({ guardians: off }, s.nodes[0].pubkey)[0].operatorId, 'stranger', 'today: the first entry in census order');
  const on = guardiansOf(s.census, FED, keys, null, true);
  assert.deepEqual(rowOf({ guardians: on }, s.nodes[0].pubkey).map((g) => [g.operatorId, g.endpoint, g.bondVout]), [['op0', 'wss://g0.example', 0]]);
  assert.equal(on.length, 7);
  // an entry without the mark counts as signed (as dialEntryOf reads it)
  const unmarked = { ok: true, entries: s.census.entries.map(({ nodeSigned, ...e }) => (nodeSigned === false ? { ...e, nodeSigned } : e)) };
  assert.equal(guardiansOf(unmarked, FED, keys, null, true).length, 7);
});

test('#3801 listsSignedGuardians: one census height per network, none named yet', () => {
  assert.deepEqual(SIGNED_GUARDIAN_HEIGHT, { mainnet: null, testnet4: null, regtest: null }, 'no network switches before a release names its height');
  const was = setSignedGuardianHeightsForTests({ regtest: 100, testnet4: null });
  try {
    assert.equal(listsSignedGuardians(NETWORK_ID_REGTEST, 99), false);
    assert.equal(listsSignedGuardians(NETWORK_ID_REGTEST, 100), true);
    assert.equal(listsSignedGuardians(NETWORK_ID_TESTNET4, 1e9), false, 'a network with no height named');
    assert.equal(listsSignedGuardians(new Uint8Array(32).fill(0x10), 1e9), false, 'a network this build does not know');
    assert.equal(listsSignedGuardians(NETWORK_ID_REGTEST, undefined), false);
  } finally { setSignedGuardianHeightsForTests(was); }
  assert.equal(listsSignedGuardians(NETWORK_ID_REGTEST, 1e9), false);
});
