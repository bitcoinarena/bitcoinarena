// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ENDPOINT GAP (2026-10-15): a record's guardian endpoints come from the federation's OWN configuration, not
// from the one guardian_endpoint a node advertises. Federation B (s0..s3) and its successor S (s0..s2 seated first + s4, the 15th):
// s0..s2 run two guardians - B's at /guardian, S's at /guardian-next - and advertise one endpoint. B's record keeps /guardian; S's
// names /guardian-next for s0..s2 and /guardian for s4; the halt observer asks exactly those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeFederationRecord, splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { federationRecords } from '../src/federation-records.js';
import { configEndpoints, createEndpointsOf, federationOfDir } from '../src/federation-endpoints.js';
import { inviteForGuardians, readInvite } from '../src/invite.js';
import { createHalts } from '../src/halts.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x10);
const B = new Uint8Array(32).fill(0xb0), S = new Uint8Array(32).fill(0x5c);
const nodes = Array.from({ length: 5 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `https://seat-${i}.example` }; });
const peerKey = (fed, i) => Uint8Array.from([2, ...new Uint8Array(32).fill((fed === B ? 0x40 : 0x80) + i)]);
const inB = [0, 1, 2, 3], inS = [0, 1, 2, 4];
const guardianUrl = (i, next) => `wss://g${i}.example/${next ? 'guardian-next' : 'guardian'}`;
// each federation's client configuration, as its DKG wrote it: peer ids 0.., their API URLs and peer keys
const configOf = (fed) => { const who = fed === B ? inB : inS;
  return { api_endpoints: Object.fromEntries(who.map((i, p) => [String(p), { url: guardianUrl(i, fed === S && i < 3), name: `s${i}` }])),
    broadcast_public_keys: Object.fromEntries(who.map((i, p) => [String(p), toHex(peerKey(fed, i))])), consensus_version: {}, meta: {}, modules: {} }; };
const inviteOf = (fed) => { const who = fed === B ? inB : inS; return inviteForGuardians(fed, [{ url: guardianUrl(who[0], fed === S), peer: 0 }]); };
// one advert per node: ONE guardian endpoint (/guardian), guardian_of naming both federations for s0..s2
const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
  advert: { operatorId: i < 4 ? '2of2' : 'node15', endpoint: n.endpoint, guardianEndpoint: guardianUrl(i, false),
    guardianOf: [...(inB.includes(i) ? [{ federationId: B, guardianKey: peerKey(B, i) }] : []), ...(inS.includes(i) ? [{ federationId: S, guardianKey: peerKey(S, i) }] : [])] } })) };

function dirsFor(root, i) {
  const out = [];
  const write = (name, fed) => { const d = join(root, `s${i}.db${name}`); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'invite-code'), `"${inviteOf(fed)}"\n`); writeFileSync(join(d, 'client.json'), JSON.stringify(configOf(fed))); out.push(d); };
  if (inB.includes(i)) write('.guardian', B);
  if (i < 3) write('.guardian-next', S);
  if (i === 4) write('.guardian', S);           // the 15th: its own guardian, founded in the successor
  return out;
}

test('a guardian dir names its federation by its invite-code; the endpoints are its client configuration\'s, by peer key', () => {
  const root = mkdtempSync(join(tmpdir(), 'fed-eps-'));
  try {
    const [own, next] = dirsFor(root, 0);
    assert.deepEqual([federationOfDir(own), federationOfDir(next), federationOfDir(join(root, 'none'))], [toHex(B), toHex(S), null]);
    const m = configEndpoints(configOf(S));
    assert.deepEqual([...m.values()], ['wss://g0.example/guardian-next', 'wss://g1.example/guardian-next', 'wss://g2.example/guardian-next', 'wss://g4.example/guardian']);
    assert.equal(m.get(toHex(peerKey(S, 4))), 'wss://g4.example/guardian');
    assert.equal(configEndpoints({ global: configOf(B) }).size, 4, 'under `global` too (the client_config answer)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('endpointsOf: a node\'s own guardian dirs first (each federation its own), else the federation asked at its invite; nothing: null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fed-eps-'));
  try {
    const dirs = dirsFor(root, 0);
    const asked = [];
    const local = createEndpointsOf({ dirs: () => dirs, inviteOf: () => null, ask: async () => { throw new Error('not asked'); } });
    assert.equal((await local(toHex(B))).get(toHex(peerKey(B, 0))), 'wss://g0.example/guardian');
    assert.equal((await local(toHex(S))).get(toHex(peerKey(S, 0))), 'wss://g0.example/guardian-next');
    assert.match(local.from(toHex(S)), /^local .*s0\.db\.guardian-next$/);
    const remote = createEndpointsOf({ dirs: () => [], inviteOf: (f) => (f === toHex(S) ? inviteOf(S) : null), ask: async (u) => { asked.push(u); return configOf(S); } });
    assert.equal((await remote(toHex(S))).get(toHex(peerKey(S, 1))), 'wss://g1.example/guardian-next');
    assert.deepEqual(asked, ['wss://g0.example/guardian-next'], 'asked at the URL its invite names');
    assert.equal(await remote(toHex(B)), null, 'no dir and no invite: null (the advert\'s endpoint stays)');
    await remote(toHex(S)); assert.equal(asked.length, 1, 'kept');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function seats(root, { configs = true } = {}) {
  const invites = { [toHex(B)]: inviteOf(B), [toHex(S)]: inviteOf(S) };
  const list = nodes.map((n, i) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 1000, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: (fid) => invites[fid] || null, networkId: NET,
    ...(configs ? { endpointsOf: createEndpointsOf({ dirs: () => dirsFor(root, i), inviteOf: (fid) => invites[fid] || null, ask: async () => { throw new Error('local only'); } }) } : {}),
    fetcher: async (url) => {
      const j = list[nodes.findIndex((m) => url.startsWith(m.endpoint))];
      const u = new URL(url);
      const body = await j.mySignature(u.searchParams.get('federation'), null, u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    } }));
  return list;
}
const endpointsIn = (seat, fed) => { const x = seat.list().find((r) => r.federation === toHex(fed));
  return Object.fromEntries(decodeFederationRecord(splitSignedRecord(fromHex(x.record)).body).guardians.map((g) => [`s${nodes.findIndex((n) => toHex(n.pubkey) === toHex(g.nodePubkey))}`, g.endpoint])); };
const inviteFederationId = (inv) => fromHex(readInvite(inv).federationId);

test('a seated-first node running two guardians: B\'s record keeps /guardian, the successor\'s names /guardian-next - and the 15th\'s /guardian', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fed-eps-'));
  try {
    const s = seats(root);
    const gb = await s[0].gather(B, inviteFederationId);
    const gs = await s[0].gather(S, inviteFederationId);
    assert.deepEqual([gb.ok, gb.status, gb.signers, gs.ok, gs.status, gs.signers], [true, 'OPEN', 4, true, 'OPEN', 4], `${gb.why} ${gs.why}`);
    assert.deepEqual(endpointsIn(s[0], B), { s0: 'wss://g0.example/guardian', s1: 'wss://g1.example/guardian', s2: 'wss://g2.example/guardian', s3: 'wss://g3.example/guardian' });
    assert.deepEqual(endpointsIn(s[0], S), { s0: 'wss://g0.example/guardian-next', s1: 'wss://g1.example/guardian-next', s2: 'wss://g2.example/guardian-next', s4: 'wss://g4.example/guardian' });
    // THE HALT OBSERVER asks the endpoints each record lists
    const asked = [];
    const halts = createHalts({ records: s[0], censusSeats: () => [], clocks: { abandonBlocks: 10 }, verify, sign: (h) => schnorr.sign(h, nodes[0].secret),
      ownKey: nodes[0].pubkey, height: async () => 1000, ask: async (e) => { asked.push(e); return 5; } });
    await halts.observe();
    assert.deepEqual(asked.sort(), ['wss://g0.example/guardian', 'wss://g0.example/guardian-next', 'wss://g1.example/guardian', 'wss://g1.example/guardian-next',
      'wss://g2.example/guardian', 'wss://g2.example/guardian-next', 'wss://g3.example/guardian', 'wss://g4.example/guardian']);
    // WITHOUT THE CONFIGURATION (as before): the advert's one endpoint, and the successor's record names the old guardians
    const before = seats(root, { configs: false });
    await before[0].gather(S, inviteFederationId);
    assert.deepEqual(endpointsIn(before[0], S), { s0: 'wss://g0.example/guardian', s1: 'wss://g1.example/guardian', s2: 'wss://g2.example/guardian', s4: 'wss://g4.example/guardian' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('configInvite: every guardian in peer order from the federation\'s configuration - one invite, whichever guardian builds it (kanban #549)', async () => {
  const { configInvite } = await import('../src/federation-endpoints.js');
  const { readInvite } = await import('../src/invite.js');
  const F = '4d'.repeat(32);
  const a = { api_endpoints: { 2: { url: 'wss://g/2', name: 'c' }, 0: { url: 'wss://g/0', name: 'a' }, 1: { url: 'wss://g/1', name: 'b' } } };
  const b = { global: { api_endpoints: { 1: { url: 'wss://g/1' }, 0: 'wss://g/0', 2: { url: 'wss://g/2' } } } };
  const ia = configInvite(F, a);
  assert.equal(ia, configInvite(F, b), 'the same invite from either shape and order');
  const r = readInvite(ia);
  assert.deepEqual([r.federationId, r.guardians.map((g) => `${g.peer}:${g.url}`)], [F, ['0:wss://g/0', '1:wss://g/1', '2:wss://g/2']]);
  assert.equal(configInvite(F, {}), null);
  assert.equal(configInvite('xyz', a), null);
});
