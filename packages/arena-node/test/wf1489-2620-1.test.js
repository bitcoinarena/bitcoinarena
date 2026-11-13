// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2620 (feedback #049, against #2618): THE SEAT'S INVITE WAIT WAS STILL FIRST COME.
// federation-records.js noteInvite kept at most 64 record invites a federation (MIRROR_INVITES), first come, until keysFor handed them to the
// book; cand() noted every record of a peer's answer. Eight strangers (the #045 forgery, each with its own junk invite) plus one of them
// answering with 64 single-signer OPEN fillers, each with its own junk invite, resolved before the genuine HALTED record: the wait was full,
// the genuine invite never reached the book, genuine endpoints asked 0, the seat kept the forgery (haltOf null, 0 liquidations).
// Safe: the wait is the book's own buffer (createInviteBuffer: per signer, bounded, the most crowded signers' entry given up) and one peer's
// answer brings at most MIRROR_ROWS_PER_ANSWER records of a federation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFederationRecord, joinSignedRecord, splitSignedRecord, federationRecordId, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { trustedGuardianKeys, createTrustedGuardianKeys, federationIdOfConfig, recordInviteSource, TGK_PER_SIGNER, createInviteBuffer } from '../../arena-protocol/src/trusted-guardian-keys.js';
import { verifyHaltRecord } from '../src/arbiter.js';
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
function mirrorSeat(w, n, serve, api = null, state = { pass: 1 }, delay = null) {
  const me = { secret: new Uint8Array(32).fill(0x50 + n) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const guardianKeysOf = api ? createGuardianKeysOf({ dirs: () => [], trusted: createTrustedGuardianKeys({ fetcher: api, timeoutMs: 500 }) }) : null;
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => w.census }, inviteFor: () => null, networkId: NET, chainTip: async () => w.genuine.height + 100,
    ...(guardianKeysOf ? { guardianKeysOf } : {}),
    fetcher: async (url) => {
      const i = w.all.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (delay) await new Promise((ok) => setTimeout(ok, delay(i)));
      if (i < 0 || !url.endsWith('/federations')) return new Response('no', { status: 404 });
      return new Response(JSON.stringify({ federations: serve(i, state.pass).map((b) => ({ federation: FID, record: toHex(b) })) }), { status: 200 });
    },
    censusAt: async () => w.census.entries });
  return { o, guardianKeysOf, state };
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


const SY_URLS = (k) => Array.from({ length: 7 }, (_, j) => `wss://junk-${k}-${j}.example/guardian`);
const junkInvite = (k) => inviteForGuardians(FED, SY_URLS(k).map((url, peer) => ({ url, peer })));
/** The #045 forgery (eight strangers' OPEN, nominal 11) re-signed by `by` with junk invite `k`. */
function forged(w, k, by = w.strangers) {
  const body = { ...splitSignedRecord(w.sybil).record, invite: junkInvite(k) };
  const id = federationRecordId(body);
  return joinSignedRecord(encodeFederationRecord(body), by.map((s) => ({ nodePubkey: s.pubkey, signature: schnorr.sign(id, s.secret) })));
}
/** The genuine guardian API, counting asks; every junk URL answers the strangers' own config (it never hashes to the id), half of them nothing. */
function countingApi() {
  const counts = { genuine: 0, junk: 0 };
  const sybilCfg = configOf(SY_URLS(99), Array.from({ length: 7 }, (_, i) => Uint8Array.from([3, ...new Uint8Array(32).fill(0xc0 + i)])));
  const api = async (url) => {
    if (URLS.includes(url)) { counts.genuine++; return structuredClone(CONFIG); }
    counts.junk++;
    if (/junk-\d+-[0-3]\./.test(url)) return structuredClone(sybilCfg);
    throw new Error('down');
  };
  return { api, counts };
}


/** R39-1: eight strangers serve the forgery, each with its own junk invite; stranger 0 also answers 64 single-signer OPEN fillers; all of them
 * answer at once, the guardians' seats 60 ms later - so every junk invite is noted before the genuine one. */
function r39(w, genuineFirst = false) {
  const serve = (i) => (i < 7 ? [w.halted5]
    : i === 7 ? [forged(w, 3000), ...Array.from({ length: 64 }, (_, k) => forged(w, 3100 + k, [w.strangers[0]]))] : [forged(w, 3000 + (i - 7))]);
  const delay = (i) => (genuineFirst ? (i < 7 ? 0 : 60) : (i < 7 ? 60 : 0));
  return { serve, delay };
}

test('#049 R39-1: 8 sybils + 64 fillers noted first, then the genuine record - the seat reaches the genuine endpoints, HALTED with halt and liquidation', async () => {
  const w = await world();
  const { serve, delay } = r39(w);
  const { api, counts } = countingApi();
  const s = mirrorSeat(w, 9, serve, api, { pass: 1 }, delay);
  await s.o.gatherAll(inviteFederationId);
  const l = await look(w, s);
  console.log(`#2620 R39-1 attack: junk asked ${counts.junk}, genuine ${counts.genuine}; ${l.say}`);
  assert.ok(counts.genuine > 0, 'the genuine endpoints were never asked');
  assert.equal(l.kept.status, 'HALTED');
  assert.equal(l.halt && l.halt.height, splitSignedRecord(w.halted5).record.height);
  assert.equal(l.liq.length, 1);
});

test('#049 control: the genuine record noted first - HALTED, keys found', async () => {
  const w = await world();
  const { serve, delay } = r39(w, true);
  const { api, counts } = countingApi();
  const s = mirrorSeat(w, 10, serve, api, { pass: 1 }, delay);
  await s.o.gatherAll(inviteFederationId);
  const l = await look(w, s);
  console.log(`#2620 control: junk asked ${counts.junk}, genuine ${counts.genuine}; ${l.say}`);
  assert.ok(counts.genuine > 0);
  assert.equal(l.kept.status, 'HALTED');
  assert.equal(l.liq.length, 1);
});

test('the buffer: 64 fillers of one signer and the eight strangers\' forgeries before the genuine invite - it is still taken', () => {
  const verifyS = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };
  return world().then((w) => {
    const b = createInviteBuffer();
    for (let k = 0; k < 64; k++) b.admit(recordInviteSource(forged(w, 4000 + k, [w.strangers[0]]), verifyS));
    for (let k = 0; k < 8; k++) b.admit(recordInviteSource(forged(w, 4100 + k), verifyS));
    b.admit(recordInviteSource(w.halted5, verifyS));
    const out = b.take();
    console.log(`#2620 buffer: ${out.length} held of 73 offered; genuine held: ${out.some((x) => x.invite === INVITE)}`);
    assert.ok(out.some((x) => x.invite === INVITE), 'the genuine invite was crowded out');
    assert.ok(out.length <= 16);
    assert.equal(b.take().length, 0, 'take() empties it');
  });
});
