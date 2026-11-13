// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2618 (feedback #047, against #2609): STRANGERS' JUNK INVITES KEPT A SEAT, THE PAGE AND THE ARBITER FROM THE TRUSTED GUARDIAN KEYS.
// #2609 kept the first 8 invites of any mirrored record for a federation, never evicting; the trusted fetch asked only those invites' URLs for
// the endpoint list. Eight bonded strangers serving the #045 forgery each with its own junk invite (naming the federation id, their own URLs),
// noted before the genuine record's invite: the genuine endpoints were asked 0 times (the junk ones 56), the seat stayed keyless and kept OPEN.
// Safe: an invite that fails the id check is evicted at once and remembered failed; a record's invite is charged to the node keys whose
// signatures over the record verify (TGK_PER_SIGNER each); trusted invites and one that led to agreed keys are asked first; once keys are
// agreed nothing more is asked until the hit expires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFederationRecord, joinSignedRecord, splitSignedRecord, federationRecordId, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { trustedGuardianKeys, createTrustedGuardianKeys, federationIdOfConfig, recordInviteSource, TGK_PER_SIGNER } from '../../arena-protocol/src/trusted-guardian-keys.js';
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
function mirrorSeat(w, n, serve, api = null, state = { pass: 1 }) {
  const me = { secret: new Uint8Array(32).fill(0x50 + n) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const guardianKeysOf = api ? createGuardianKeysOf({ dirs: () => [], trusted: createTrustedGuardianKeys({ fetcher: api, timeoutMs: 500 }) }) : null;
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => w.census }, inviteFor: () => null, networkId: NET, chainTip: async () => w.genuine.height + 100,
    ...(guardianKeysOf ? { guardianKeysOf } : {}),
    fetcher: async (url) => {
      const i = w.all.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
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

test('#047 seat: eight strangers\' junk invites noted first (an earlier pass) - the genuine endpoints are reached, HALTED with halt and liquidation', async () => {
  const w = await world();
  // pass 1: only the strangers serve, each its own copy of the forgery with its own junk invite; pass 2+: the genuine 5 of 7 HALTED too, and the
  // strangers bring 8 new junk invites every pass
  const serve = (i, pass) => (i < 7 ? (pass >= 2 ? [w.halted5] : []) : [forged(w, pass * 100 + (i - 7))]);
  const { api, counts } = countingApi();
  const s = mirrorSeat(w, 7, serve, api);
  await s.o.gatherAll(inviteFederationId);
  const afterJunk = { ...counts };
  s.state.pass = 2;
  await s.o.gatherAll(inviteFederationId);
  const l = await look(w, s);
  console.log(`#2618 #047 seat: pass 1 asked junk ${afterJunk.junk}, genuine ${afterJunk.genuine}; after pass 2 junk ${counts.junk}, genuine ${counts.genuine}; ${l.say}`);
  assert.ok(counts.genuine > 0, 'the genuine endpoints were never asked');
  assert.equal(l.kept.status, 'HALTED');
  assert.equal(l.halt && l.halt.height, splitSignedRecord(w.halted5).record.height);
  assert.equal(l.liq.length, 1);
  // a third pass: keys agreed - nothing more is asked, however many new junk invites come
  const before = { ...counts };
  s.state.pass = 3;
  await s.o.gatherAll(inviteFederationId);
  assert.deepEqual(counts, before, 'asked again although the keys are agreed');
});

test('#047 seat, one pass: the forgery under eight junk invites and sixteen single-signer junk invites beside the genuine record - still reached', async () => {
  const w = await world();
  // each stranger: the full forgery (all eight signing) with its own junk invite, and two junk invites under its own signature alone
  const serve = (i) => (i < 7 ? [] : [forged(w, 50 + i), forged(w, 2 * (i - 7), [w.strangers[i - 7]]), forged(w, 2 * (i - 7) + 1, [w.strangers[i - 7]])]);
  const { api, counts } = countingApi();
  // all in one pass: the eight strangers' sixteen junk invites and the genuine record's, the keys asked once before the pass is judged
  const s = mirrorSeat(w, 8, (i) => (i < 7 ? [w.halted5] : serve(i)), api);
  await s.o.gatherAll(inviteFederationId);
  const l = await look(w, s);
  console.log(`#2618 one pass: junk asked ${counts.junk}, genuine ${counts.genuine}; ${l.say}`);
  assert.ok(counts.genuine > 0);
  assert.equal(l.kept.status, 'HALTED');
  assert.equal(l.liq.length, 1);
});

test('the book: per-signer bound, failed invites evicted and not retried, trusted invites first, nothing asked once agreed', async () => {
  const w = await world();
  const { api, counts } = countingApi();
  const src = createTrustedGuardianKeys({ fetcher: api, timeoutMs: 200 });
  const verifyS = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };
  // one stranger offers five invites: TGK_PER_SIGNER are taken
  const five = [0, 1, 2, 3, 4].map((k) => recordInviteSource(forged(w, 500 + k, [w.strangers[0]]), verifyS));
  assert.equal(await src.of(FID, five), null);
  const b1 = src.book(FID);
  console.log(`#2618 book after one stranger's 5: ${b1.book.length} held, ${b1.failed.length} failed; junk asked ${counts.junk}`);
  assert.equal(b1.book.length, 0, 'a failed invite stays in the book');
  assert.equal(b1.failed.length, TGK_PER_SIGNER);
  // the same invites again: not asked again
  const j = counts.junk;
  await src.of(FID, five);
  assert.equal(counts.junk, j, 'a failed invite was asked again');
  // an unsigned (forged-signature) record's invite is not taken at all
  const bad = forged(w, 600, [w.strangers[1]]); bad[bad.length - 1] ^= 1;
  assert.equal(recordInviteSource(bad, verifyS), null);
  // the trusted (plain string) invite: asked first, keys agreed, the record invites behind it not asked
  const fresh = countingApi();
  const t = createTrustedGuardianKeys({ fetcher: fresh.api, timeoutMs: 200 });
  const keys = await t.of(FID, [INVITE, ...[1, 2, 3].map((k) => recordInviteSource(forged(w, 700 + k, [w.strangers[k]]), verifyS))]);
  assert.equal(keys.length, 7);
  assert.equal(fresh.counts.junk, 0, 'record invites were asked although the trusted one found the endpoints');
  await t.of(FID, [recordInviteSource(forged(w, 800, [w.strangers[5]]), verifyS)]);
  assert.equal(fresh.counts.junk, 0, 'asked after the keys were agreed');
});

test('#047 page: sixteen junk invites beside the genuine HALTED record - the page reaches the keys and reads HALTED', async () => {
  const w = await world();
  const { api, counts } = countingApi();
  const page = createTrustedGuardianKeys({ fetcher: api, timeoutMs: 300 }).guardianKeysOf;
  const nodes = Array.from({ length: 9 }, (_, i) => `https://s${i}.example`);
  const rowsOf = (i) => (i < 8 ? [forged(w, 900 + 2 * i, [w.strangers[i]]), forged(w, 901 + 2 * i, [w.strangers[i]])] : [w.halted5]);
  const st = (await federationStatuses({ nodes, census: w.census.entries, verify, guardianKeysOf: page,
    fetcher: async (u) => { const i = nodes.indexOf(u.replace(/\/federations$/, '')); return new Response(JSON.stringify({ federations: rowsOf(i).map((b) => ({ federation: FID, record: toHex(b) })) }), { status: 200 }); } })).get(FID);
  console.log(`#2618 page: junk asked ${counts.junk}, genuine ${counts.genuine}; ${st.status} deposit=${st.allows.deposit} join=${st.allows.join}`);
  assert.ok(counts.genuine > 0);
  assert.equal(st.status, 'HALTED');
  assert.equal(st.allows.deposit, false);
});

test('#047 arbiter: learning keys from the seats\' listings as arbiter.mjs does (record sources) reaches the keys; the halt record checks', async () => {
  const w = await world();
  const { api, counts } = countingApi();
  const trustedKeys = createTrustedGuardianKeys({ fetcher: api, timeoutMs: 300 });
  const verifyS = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };
  // eight seats list a junk-invite forgery each, one lists the genuine HALTED record: the listings in seat order
  const listings = [...w.strangers.map((s, i) => forged(w, 1000 + i, [s])), w.halted5];
  const invites = new Map();
  for (const b of listings) { const src = recordInviteSource(b, verifyS); if (src && !invites.has(src.invite)) invites.set(src.invite, src); }
  const hex = await trustedKeys.of(FID, [...invites.values()]);
  assert.equal(hex && hex.length, 7);
  const v = verifyHaltRecord(w.halted5, { fid: FID, keys: hex.map(fromHex), census: w.census.entries, tip: w.genuine.height + 100, inviteFederationId });
  console.log(`#2618 arbiter: junk asked ${counts.junk}, genuine ${counts.genuine}; halt record ${v.ok ? 'checks' : v.why}`);
  assert.equal(v.ok, true);
});
