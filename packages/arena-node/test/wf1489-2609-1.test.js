// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2609 (owner decision 2026-11-13 "löse alle"): A FEDERATION'S GUARDIAN KEYS FROM A SOURCE NO BONDED STRANGER CAN WRITE.
// The fedimint federation id is sha256 over the consensus encoding of the client config's api_endpoints (fedimint-core/src/config.rs:271).
// trustedGuardianKeys takes the endpoints from an answer that hashes to the id, asks every one of them, and takes broadcast_public_keys only when
// thresholdOf(n) answer the identical config. With those keys every seat (federation-records.js, via createGuardianKeysOf's trusted source) and
// the page (federationStatuses guardianKeysOf) judge a federation's records with keys - which ends the keyless sybil cases:
//   #045: eight bonded strangers' OPEN record (nominal 11) over a genuine 5 of 7 HALTED one - HALTED, with its halt effects
//   #044: three strangers' own HALTED record over a genuine 7 of 7 OPEN one - OPEN, nothing held
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFederationRecord, joinSignedRecord, splitSignedRecord, federationRecordId, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { trustedGuardianKeys, createTrustedGuardianKeys, federationIdOfConfig } from '../../arena-protocol/src/trusted-guardian-keys.js';
import { federationRecords } from '../src/federation-records.js';
import { createGuardianKeysOf } from '../src/federation-endpoints.js';
import { createLiquidations } from '../src/liquidations.js';
import { inviteForGuardians, readInvite } from '../src/invite.js';
import { federationStatuses, inviteFederationId } from '../../arena-client/src/federations.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const NET = new Uint8Array(32).fill(0x10);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const URLS = Array.from({ length: 7 }, (_, i) => `wss://g${i}.example/guardian`);
const configOf = (urls, keys) => ({ global: {
  api_endpoints: Object.fromEntries(urls.map((url, i) => [String(i), { url, name: `node-${i + 1}` }])),
  broadcast_public_keys: Object.fromEntries(keys.map((k, i) => [String(i), toHex(k)])),
  consensus_version: { major: 2, minor: 1 }, meta: {} }, modules: {} });
const KEYS = Array.from({ length: 7 }, (_, i) => Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]));
const CONFIG = configOf(URLS, KEYS);
const FID = federationIdOfConfig(CONFIG);
const FED = fromHex(FID);
const INVITE = inviteForGuardians(FED, URLS.map((url, peer) => ({ url, peer })));
/** A guardian API: `answers` url -> config (or nothing: it does not answer). */
const apiOf = (answers) => async (url) => { if (!(url in answers)) throw new Error(`${url}: down`); return structuredClone(answers[url]); };
const genuineApi = () => apiOf(Object.fromEntries(URLS.map((u) => [u, CONFIG])));

test('the id is what fedimint computes: the testnet4 and regtest federations\' client.json hash to their invites\' ids', () => {
  let n = 0;
  for (const d of ['/mnt/bitcoin/blwp-tn4-guardians/node-7.db.guardian', '/mnt/bitcoin/blwp-regtest-seats/g0']) {
    if (!existsSync(`${d}/client.json`)) continue;
    const id = federationIdOfConfig(JSON.parse(readFileSync(`${d}/client.json`, 'utf8')));
    assert.equal(id, readInvite(readFileSync(`${d}/invite-code`, 'utf8')).federationId);
    console.log(`#2609 ${d}: config hashes to ${id.slice(0, 16)}, the invite's id`); n++;
  }
  // a known vector (federation 337ae01a, testnet4) when the data dirs are not on this machine
  const tn4 = configOf(Array.from({ length: 7 }, (_, i) => `wss://beelink.tail1723e2.ts.net/guardian-${i + 1}/guardian`), KEYS);
  assert.equal(federationIdOfConfig(tn4), '337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e');
  console.log(`#2609 vector 337ae01a holds (${n} live data dirs checked too)`);
});

test('a config a threshold agrees on is taken; one guardian alone with another config is refused; a config not hashing to the id is refused', async () => {
  const ok = await trustedGuardianKeys(FID, INVITE, genuineApi(), { cache: new Map() });
  assert.equal(ok.ok, true); assert.equal(ok.agreed, 7); assert.equal(ok.threshold, 5);
  assert.deepEqual(ok.keys, KEYS.map(toHex));
  // guardian 0 answers its own keys under the genuine endpoints; the other six agree: the six's keys
  const liar = configOf(URLS, KEYS.map((k, i) => (i === 0 ? k : Uint8Array.from([3, ...new Uint8Array(32).fill(0xc0 + i)]))));
  const mixed = await trustedGuardianKeys(FID, INVITE, apiOf({ ...Object.fromEntries(URLS.map((u) => [u, CONFIG])), [URLS[0]]: liar }), { cache: new Map() });
  assert.equal(mixed.ok, true); assert.equal(mixed.agreed, 6); assert.deepEqual(mixed.keys, KEYS.map(toHex));
  // guardian 0 alone answers (the others down), with its own config: 1 of 7, 5 needed
  const alone = await trustedGuardianKeys(FID, INVITE, apiOf({ [URLS[0]]: liar }), { cache: new Map() });
  assert.equal(alone.ok, false); assert.match(alone.why, /1 of 7 guardians answered one config, 5 needed/);
  // four genuine answers: below the threshold
  const four = await trustedGuardianKeys(FID, INVITE, apiOf(Object.fromEntries(URLS.slice(0, 4).map((u) => [u, CONFIG]))), { cache: new Map() });
  assert.equal(four.ok, false);
  // strangers' own federation config (their endpoints, their keys), all agreeing, served at an invite that names the genuine id: refused
  const SY = Array.from({ length: 8 }, (_, i) => `wss://sybil-${i}.example/guardian`);
  const sybilCfg = configOf(SY, Array.from({ length: 8 }, (_, i) => Uint8Array.from([3, ...new Uint8Array(32).fill(0xc0 + i)])));
  const sybilInvite = inviteForGuardians(FED, SY.map((url, peer) => ({ url, peer })));
  const forged = await trustedGuardianKeys(FID, sybilInvite, apiOf(Object.fromEntries(SY.map((u) => [u, sybilCfg]))), { cache: new Map() });
  assert.equal(forged.ok, false); assert.match(forged.why, /hash to the federation id/);
  // and the genuine endpoints answering a config with one endpoint renamed (the id no longer matches): refused
  const renamed = structuredClone(CONFIG); renamed.global.api_endpoints['3'].name = 'evil';
  const bad = await trustedGuardianKeys(FID, INVITE, apiOf(Object.fromEntries(URLS.map((u) => [u, renamed]))), { cache: new Map() });
  assert.equal(bad.ok, false);
  // a stranger's invite beside the genuine one: the genuine one still finds the keys
  const both = await trustedGuardianKeys(FID, [sybilInvite, INVITE], apiOf({ ...Object.fromEntries(SY.map((u) => [u, sybilCfg])), ...Object.fromEntries(URLS.map((u) => [u, CONFIG])) }), { cache: new Map() });
  assert.equal(both.ok, true);
  console.log(`#2609 trusted fetch: 7/7 ok, 6/7 + one liar ok (${mixed.agreed}), liar alone refused (${alone.why}), 4/7 refused, strangers' config refused (${forged.why}), renamed endpoint refused`);
});

test('the fetch is cached per federation and bounded in time', async () => {
  let asked = 0;
  const api = async (url) => { asked++; return structuredClone(CONFIG); };
  const src = createTrustedGuardianKeys({ fetcher: api, timeoutMs: 300 });
  assert.equal(src.guardianKeysOf(FID), null, 'nothing before the fetch');
  assert.equal((await src.guardianKeysOf.wait(FID, [INVITE], 1000)).length, 7);
  const before = asked;
  await src.of(FID, [INVITE]);
  assert.equal(asked, before, 'a hit is not fetched again');
  const hang = createTrustedGuardianKeys({ fetcher: () => new Promise(() => {}), timeoutMs: 200 });
  const t = Date.now();
  assert.equal(await hang.guardianKeysOf.wait(FID, [INVITE], 100), null);
  assert.ok(Date.now() - t < 1000);
  assert.equal(await hang.of(FID, [INVITE]), null, 'a guardian that never answers is given up after timeoutMs');
});

async function world() {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = KEYS[i]; n.endpoint = `wss://seat-${i}.example`; }
  const strangers = Array.from({ length: 8 }, (_, i) => { const secret = new Uint8Array(32).fill(0x90 + i); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([3, ...new Uint8Array(32).fill(0xc0 + i)]), endpoint: `wss://sybil-${i}.example` }; });
  const all = [...nodes, ...strangers];
  const census = { ok: true, entries: all.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0x20 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  const seats = nodes.map((n) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, guardianKeysOf: async () => KEYS,
    fetcher: async (url) => {
      const i = nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0) return new Response('no', { status: 404 });
      const u = new URL(url);
      const body = await seats[i].mySignature(u.searchParams.get('federation'), null, u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  assert.equal((await seats[1].gather(FED, inviteFederationId)).ok, true);
  const genuine = splitSignedRecord(fromHex(seats[1].list()[0].record)).record;
  const sign = (body, by) => { const id = federationRecordId(body); return joinSignedRecord(encodeFederationRecord(body), by.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) }))); };
  // #045: the genuine HALTED record signed by 5 of its 7 (its threshold)
  const halted5 = sign({ ...genuine, status: FEDERATION_STATUS.HALTED, height: genuine.height + 6 }, nodes.slice(0, 5));
  const fake = Array.from({ length: 3 }, (_, i) => schnorr.getPublicKey(new Uint8Array(32).fill(0xe0 + i)));
  const rows = [...strangers.map((s) => ({ peerKey: s.guardianKey, nodePubkey: s.pubkey })), ...fake.map((k, i) => ({ peerKey: Uint8Array.from([3, ...new Uint8Array(32).fill(0xf0 + i)]), nodePubkey: k }))]
    .map((g) => ({ ...g, operatorId: '', bondTxid: new Uint8Array(32), bondVout: 0, endpoint: '' })).sort((a, b) => (toHex(a.nodePubkey) < toHex(b.nodePubkey) ? -1 : 1));
  const sybil = sign({ ...genuine, nominal: 11, threshold: 8, guardians: rows, gone: [], status: FEDERATION_STATUS.OPEN, successorId: new Uint8Array(32), height: genuine.height + 7 }, strangers);
  const own = (k, status, up) => {
    const by = strangers.slice(0, k);
    const r2 = by.map((s) => ({ peerKey: s.guardianKey, nodePubkey: s.pubkey, operatorId: '', bondTxid: new Uint8Array(32), bondVout: 0, endpoint: '' })).sort((a, b) => (toHex(a.nodePubkey) < toHex(b.nodePubkey) ? -1 : 1));
    return sign({ ...genuine, nominal: k, threshold: k - Math.floor((k - 1) / 3), guardians: r2, gone: [], status: FEDERATION_STATUS[status], successorId: new Uint8Array(32), height: genuine.height + up }, by);
  };
  const open7 = sign({ ...genuine, status: FEDERATION_STATUS.OPEN }, nodes);
  return { nodes, strangers, all, census, genuine, halted5, sybil, own, open7 };
}

/** A mirror seat that names no invite and holds no config: keys only through the trusted fetch (`api`), or none at all. */
function mirrorSeat(w, n, serve, api = null) {
  const me = { secret: new Uint8Array(32).fill(0x50 + n) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const guardianKeysOf = api ? createGuardianKeysOf({ dirs: () => [], trusted: createTrustedGuardianKeys({ fetcher: api, timeoutMs: 500 }) }) : null;
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => w.census }, inviteFor: () => null, networkId: NET, chainTip: async () => w.genuine.height + 100,
    ...(guardianKeysOf ? { guardianKeysOf } : {}),
    fetcher: async (url) => {
      const i = w.all.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0 || !url.endsWith('/federations')) return new Response('no', { status: 404 });
      return new Response(JSON.stringify({ federations: serve(i).map((b) => ({ federation: FID, record: toHex(b) })) }), { status: 200 });
    },
    censusAt: async () => w.census.entries });
  return { o, guardianKeysOf };
}

async function look(w, s, pageKeys) {
  const served = s.o.served().filter((x) => x.federation === FID);
  const liq = createLiquidations({ records: s.o, clocks: { abandonBlocks: 4320 }, verify }).list().filter((l) => l.federation === FID);
  const st = (await federationStatuses({ nodes: ['https://s0.example'], census: w.census.entries, verify, ...(pageKeys ? { guardianKeysOf: pageKeys } : {}),
    fetcher: async () => new Response(JSON.stringify({ federations: s.o.served() }), { status: 200 }) })).get(FID);
  const k = s.o.recordOf(FID);
  return { kept: k, served, halt: s.o.haltOf(FID), draining: s.o.draining(FID), liq, st,
    say: `keeps ${k && k.status}@${k && k.height}; serves ${served.map((x) => `${x.status}@${x.height}${x.held ? ' (held)' : x.beside ? ' (beside)' : ''}`).join(', ')}; haltOf ${s.o.haltOf(FID) ? s.o.haltOf(FID).height : 'null'}; draining ${s.o.draining(FID)}; liquidations ${liq.length}; page ${st.status} deposit=${st.allows.deposit} join=${st.allows.join}${st.heldBy ? ` heldBy ${st.heldBy}` : ''}` };
}

test('#045: eight strangers\' OPEN over the genuine 5 of 7 HALTED - with the trusted keys, HALTED with its halt effects (seat and page)', async () => {
  const w = await world();
  const serve = (i) => (i < 7 ? [w.halted5] : [w.sybil]);
  const keyless = mirrorSeat(w, 3, serve);
  await keyless.o.gatherAll(inviteFederationId);
  console.log(`#2609 #045 keyless seat (before): ${(await look(w, keyless)).say}`);
  const s = mirrorSeat(w, 4, serve, genuineApi());
  await s.o.gatherAll(inviteFederationId);
  const page = createTrustedGuardianKeys({ fetcher: genuineApi(), timeoutMs: 500 }).guardianKeysOf;
  const l = await look(w, s, page);
  console.log(`#2609 #045 seat + page with trusted keys: ${l.say}`);
  assert.equal(l.kept.status, 'HALTED');
  assert.equal(l.halt && l.halt.height, splitSignedRecord(w.halted5).record.height);
  assert.equal(l.draining, 'HALTED');
  assert.equal(l.liq.length, 1);
  assert.equal(l.served.some((x) => x.status === 'OPEN'), false, 'the strangers\' record is not served beside it');
  assert.equal(l.st.status, 'HALTED');
  assert.equal(l.st.allows.deposit, false);
  assert.equal(l.st.allows.join, false);
});

test('#044: three strangers\' own HALTED over the genuine 7 of 7 OPEN - with the trusted keys, OPEN and nothing held (seat and page)', async () => {
  const w = await world();
  const evil = w.own(3, 'HALTED', 1);
  const serve = (i) => (i < 7 ? [w.open7] : i < 10 ? [evil] : []);
  const s = mirrorSeat(w, 5, serve, genuineApi());
  await s.o.gatherAll(inviteFederationId);
  const page = createTrustedGuardianKeys({ fetcher: genuineApi(), timeoutMs: 500 }).guardianKeysOf;
  // the page is also asked with the strangers' record served beside (what a keyless seat would serve)
  const st2 = (await federationStatuses({ nodes: ['https://a.example', 'https://b.example'], census: w.census.entries, verify, guardianKeysOf: page,
    fetcher: async (u) => new Response(JSON.stringify({ federations: [{ federation: FID, record: toHex(u.startsWith('https://a.') ? w.open7 : evil) }] }), { status: 200 }) })).get(FID);
  const l = await look(w, s, page);
  console.log(`#2609 #044 seat + page with trusted keys: ${l.say}; page beside the strangers' record: ${st2.status} deposit=${st2.allows.deposit} join=${st2.allows.join}`);
  assert.equal(l.kept.status, 'OPEN');
  assert.deepEqual(l.served.map((x) => x.status), ['OPEN']);
  assert.equal(l.served.some((x) => x.held), false);
  assert.equal(l.halt, null);
  assert.equal(l.draining, null);
  assert.equal(l.liq.length, 0);
  assert.equal(l.st.status, 'OPEN'); assert.equal(l.st.allows.deposit, true); assert.equal(l.st.allows.join, true);
  assert.equal(st2.status, 'OPEN'); assert.equal(st2.allows.deposit, true); assert.equal(st2.allows.join, true); assert.equal(st2.heldBy, undefined);
});

test('no trusted keys (no guardian answers): the keyless rules still decide, as before', async () => {
  const w = await world();
  const evil = w.own(3, 'HALTED', 1);
  const s = mirrorSeat(w, 6, (i) => (i < 7 ? [w.open7] : i < 10 ? [evil] : []), apiOf({}));
  await s.o.gatherAll(inviteFederationId);
  const l = await look(w, s, createTrustedGuardianKeys({ fetcher: apiOf({}), timeoutMs: 200 }).guardianKeysOf);
  console.log(`#2609 keyless fallback: ${l.say}`);
  assert.equal(l.kept.status, 'OPEN');
  assert.equal(l.served.find((x) => x.status === 'HALTED').held, true, 'the #2615 hold, as before');
  assert.equal(l.halt, null);
  assert.equal(l.st.allows.deposit, false);
});
