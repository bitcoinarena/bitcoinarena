// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A SEAT READS BEFORE A FOUNDING DRAW (§23A.3a, kanban #993/#1023), over real signed records: the trigger's point, records at trigger_height
// - 12 from this seat and the seats it reaches, verified at threshold, the highest kept; no record there, no draw yet; and the value in the id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { toHex, taggedHash } from '../../arena-protocol/src/hash.js';
import { foundingPressureReader, highestVerified } from '../src/founding-pressure.js';
import { guardiansOf } from '../src/federation-records.js';
import { createFoundingSeat } from '../src/founding-seat.js';

const NET = new Uint8Array(32).fill(0x10);
const inviteFederationId = (inv) => Uint8Array.from(Buffer.from(String(inv).split(':')[1], 'hex'));
const nodes = (seedByte, n = 4) => Array.from({ length: n }, (_, i) => { const secret = new Uint8Array(32).fill(seedByte + i); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(seedByte + i)]) }; });
// two federations of 4 (f = 1, f + 1 = 2), each guardian at 50,000 sat, so a cap of 100,000
const A = { fid: new Uint8Array(32).fill(0xa1), nodes: nodes(0x11) }, B = { fid: new Uint8Array(32).fill(0xb2), nodes: nodes(0x31) };
const fidHex = (f) => toHex(f.fid);
const entryOf = (f) => f.nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(f.fid[0] + i), vout: 0, bondSats: 50000n,
  advert: { operatorId: `op${f.fid[0]}-${i}`, endpoint: `wss://s${i}.example`, guardianEndpoint: `wss://g${i}.example`, guardianCapable: true, guardianOf: [{ federationId: f.fid, guardianKey: n.guardianKey }] } }));
const census = [...entryOf(A), ...entryOf(B)];

function signed(f, { height, reserveSats, signers = f.nodes, closed = false }) {
  const b = buildFederationRecord({ federationId: f.fid, networkId: NET, invite: `fed:${fidHex(f)}`, nominal: 4, guardians: guardiansOf({ entries: census }, f.fid), height, reserveSats, closed });
  const id = federationRecordId(b), bytes = encodeFederationRecord(b);
  return toHex(joinSignedRecord(bytes, signers.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) }))));
}

/** A seat: `held` what it holds itself, `peers` { url: { fid hex: record hex } } what the others answer. */
function reader({ point = 0, held = {}, peers = {}, bondMinGuardian = 50000n, censusAt = async () => census }) {
  const asked = [];
  const r = foundingPressureReader({ point, bondMinGuardian, inviteFederationId, networkId: NET, censusAt, seats: () => Object.keys(peers),
    held: (f, h) => { asked.push(['held', f.slice(0, 2), h]); return held[f] || null; },
    fetcher: async (url) => { asked.push(['ask', url]);
      const base = Object.keys(peers).find((p) => url.startsWith(p));
      if (peers[base] === 'down') throw new Error('unreachable');
      const records = Object.entries(peers[base]).filter(([f]) => url.includes(f)).map(([federation, record]) => ({ federation, record }));
      return new Response(JSON.stringify({ records })); } });
  return { r, asked };
}
const under = (extra = {}) => ({ [fidHex(A)]: signed(A, { height: 180, reserveSats: 80000n }), [fidHex(B)]: signed(B, { height: 180, reserveSats: 90000n }), ...extra });

test('before the point, with no point, or under 12 blocks no record is read and nothing is under pressure', async () => {
  for (const [point, height] of [[1000, 999], [null, 2000], [0, 11]]) {
    const { r, asked } = reader({ point, held: under() });
    assert.equal(await r({ height, entries: census }), null);
    assert.deepEqual(asked, []);
  }
});

test('it reads records at trigger_height - 12 and answers B*_net by the lowest-load OPEN record', async () => {
  const { r, asked } = reader({ held: under() });
  assert.equal(await r({ height: 200, entries: census }), 85000n, '170,000 over 0.5 x (2 + 2): load 0.8 is PRESSURE');
  assert.deepEqual(asked.filter((x) => x[0] === 'held').map((x) => x[2]), [188, 188]);
  const calm = reader({ held: under({ [fidHex(A)]: signed(A, { height: 180, reserveSats: 69999n }) }) });
  assert.equal(await calm.r({ height: 200, entries: census }), null, 'A at 69.99 % has room, whatever B holds');
});

test('the highest verified record wins, from any seat: another seat holds a newer one than this seat', async () => {
  const held = under({ [fidHex(A)]: signed(A, { height: 174, reserveSats: 10000n }) });   // this seat's is older and calm
  const { r } = reader({ held, peers: { 'https://x': { [fidHex(A)]: signed(A, { height: 186, reserveSats: 80000n }) }, 'https://down': 'down' } });
  assert.notEqual(await r({ height: 200, entries: census }), null, 'A at 186 is under pressure, one seat out of reach or not');
});

test('a record above the height, short of its threshold, or signed by others is not believed', async () => {
  const stale = under({ [fidHex(A)]: signed(A, { height: 180, reserveSats: 10000n }) });
  for (const bad of [signed(A, { height: 192, reserveSats: 90000n }), signed(A, { height: 186, reserveSats: 90000n, signers: A.nodes.slice(0, 2) }), signed(A, { height: 186, reserveSats: 90000n, signers: B.nodes })]) {
    const { r } = reader({ held: stale, peers: { 'https://x': { [fidHex(A)]: bad } } });
    assert.equal(await r({ height: 200, entries: census }), null, 'the record that verifies is calm');
  }
});

test('only a record counts: a federation with none at that height is left out and holds nothing back, on every seat (ruling #1025)', async () => {
  // B has no record: a made-up id, or a federation under 12 blocks old. A alone decides, and its amount is A's alone
  const { r } = reader({ held: { [fidHex(A)]: signed(A, { height: 180, reserveSats: 80000n }) } });
  assert.equal(await r({ height: 200, entries: census }), 80000n);
  const calm = reader({ held: { [fidHex(A)]: signed(A, { height: 180, reserveSats: 10000n }) } });
  assert.equal(await calm.r({ height: 200, entries: census }), null, 'and A with room is no pressure, whoever else is named');
  const none = reader({});
  assert.equal(await none.r({ height: 200, entries: census }), null, 'no record of any federation: no pressure');
  const forged = reader({ peers: { 'https://x': { [fidHex(A)]: signed(A, { height: 180, reserveSats: 90000n, signers: B.nodes }), [fidHex(B)]: 'zz' } } });
  assert.equal(await forged.r({ height: 200, entries: census }), null, 'a record that does not verify is no record');
});

test('only this seat\'s unread chain is "not yet": a record it was given and cannot check is not left out, and a read census answers', async () => {
  let read = false;
  const { r } = reader({ held: under(), censusAt: async () => (read ? census : null) });
  await assert.rejects(r({ height: 200, entries: census }), /the census at 180 is not read yet, so a record of federation .* cannot be checked: no draw yet/);
  read = true;
  assert.equal(await r({ height: 200, entries: census }), 85000n, 'a refusal is not kept');
  const thrown = reader({ held: under(), censusAt: async () => { throw new Error('still reading'); } });
  await assert.rejects(thrown.r({ height: 200, entries: census }), /not read yet/);
  const noRecords = reader({ censusAt: async () => null });
  assert.equal(await noRecords.r({ height: 200, entries: census }), null, 'nothing to check holds nothing back');
});

test('a network no census names a federation of is not under pressure; an answer is kept for its trigger', async () => {
  const none = reader({});
  assert.equal(await none.r({ height: 200, entries: census.map((e) => ({ ...e, advert: { ...e.advert, guardianOf: [] } })) }), null);
  const { r, asked } = reader({ peers: { 'https://x': under() } });
  const first = await r({ height: 200, entries: census }), n = asked.length;
  assert.equal(await r({ height: 200, entries: census }), first);
  assert.equal(asked.length, n, 'not asked again: a seat that starts the founding again names the same one');
});

test('a federation that is not OPEN is not the lowest, its record is still required', async () => {
  const closed = signed(B, { height: 180, reserveSats: 0n, closed: true });
  const { r } = reader({ held: { [fidHex(A)]: signed(A, { height: 180, reserveSats: 80000n }), [fidHex(B)]: closed } });
  assert.equal(await r({ height: 200, entries: census }), 80000n, 'A alone: 80,000 over 2 x 2 at 0.5, above the floor');
});

test('two records at one height: a CLOSED one first, then the lowest id, whatever the order they came in', () => {
  const x = { status: 'OPEN', record: buildFederationRecord({ federationId: A.fid, networkId: NET, invite: 'i', nominal: 4, guardians: guardiansOf({ entries: census }, A.fid), height: 180, reserveSats: 1n }) };
  const y = { status: 'OPEN', record: buildFederationRecord({ federationId: A.fid, networkId: NET, invite: 'i', nominal: 4, guardians: guardiansOf({ entries: census }, A.fid), height: 180, reserveSats: 2n }) };
  assert.equal(highestVerified([x, y]), highestVerified([y, x]));
  const closed = { ...y, status: 'CLOSED' };
  assert.equal(highestVerified([x, closed]), closed); assert.equal(highestVerified([closed, x]), closed);
  const higher = { ...x, record: { ...x.record, height: 186 } };
  assert.equal(highestVerified([closed, higher]), higher);
  assert.equal(highestVerified([]), null);
});

test('the reader feeds a seat: under pressure the operator at B*_net sits first and the founding names the amount; seats that read another amount name another founding', async () => {
  const rich = census.map((e, i) => (i === 5 ? { ...e, bondSats: 200000n } : e));
  const seat = (peerRecords) => { const w = { tip: 201 }; const { r } = reader({ peers: { 'https://x': peerRecords } });
    return createFoundingSeat({ records: () => [{ federation: 'aa'.repeat(32), status: 'DRAINING', height: 200 }], entriesAt: async (h) => (h === 200 ? rich : null),
      beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip, guardianInSetup: async () => true,
      setup: { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null }, nominal: 4, bondMinGuardian: 50000n, clocks: { abandonBlocks: 10, foundingWindow: 10 },
      ownKey: rich[0].pubkey, sign: () => new Uint8Array(64), verify: () => true, pressureBondAt: r, guardingOpen: () => new Set() }); };
  const a = seat(under()); const t = await a.tick();
  assert.equal(t.ok, true, t.why);
  assert.equal(a.state().seated[0].node, toHex(rich[5].pubkey));
  const same = seat(under()); await same.tick();
  assert.equal(same.state().id, a.state().id);
  const other = seat(under({ [fidHex(B)]: signed(B, { height: 180, reserveSats: 100000n }) })); await other.tick();
  assert.notEqual(other.state().id, a.state().id, 'another record, another B*_net, another founding: they cannot meet in one ceremony');
  const partial = seat({ [fidHex(A)]: under()[fidHex(A)] }); const p = await partial.tick();
  assert.equal(p.ok, true, 'a federation with no record stops nothing');
  assert.notEqual(partial.state().id, a.state().id, 'a seat that missed B reads another amount, another founding: the residual, void and drawn again');
});

test('a real seat with ARENA_FOUNDING=1 builds its founding with the reader, and no point on regtest changes nothing', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = mkdtempSync(join(tmpdir(), 'founding-pressure-'));
  writeFileSync(join(dataDir, 'admin-password'), 'test');
  const was = process.env.ARENA_FOUNDING;
  process.env.ARENA_FOUNDING = '1';
  const seat = await serve(openStore(), { plugins: [], port: 0, chain: 'bitcoin-regtest', chainTip: async () => 300, guardian: { apiPort: 1, dataDir } });
  try {
    const b = await (await fetch(`http://127.0.0.1:${seat.port}/founding`)).json();
    assert.equal(b.off, undefined, 'the seat runs its foundings');
  } finally {
    if (was === undefined) delete process.env.ARENA_FOUNDING; else process.env.ARENA_FOUNDING = was;
    await seat.close();
  }
});
