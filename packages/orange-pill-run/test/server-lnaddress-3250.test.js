// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3250 the player's Lightning address: syntax, public hosts only, the wallet's answer, the rate limit, POST /lnaddress and GET /me, the rows of
// the payout lists, and the owner's bounty rule (2026-11-22): the best placed player with a valid address saved by one hour after the round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, openRound, paidAttempt, keypair, logOf, signIn, MIN } from './server-helpers.mjs';
import { lnAddressSyntax, checkLnAddress, WHY, LN_CHECKS_PER_HOUR } from '../server/opr-lnaddress.mjs';
import { LN_CHECK_GAP_MS } from '../server/opr-service.mjs';
import { NO_LN_ADDRESS } from '../server/opr-payout.mjs';

const good = { tag: 'payRequest', callback: 'https://walletofsatoshi.com/lnurlp/x/callback', minSendable: 1000, maxSendable: 100000000000, metadata: '[]' };
const answer = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('#3250 syntax: user@domain, lower case user [a-z0-9-_.+], a public domain, no IP literal, localhost, private name or port', () => {
  for (const ok of ['alice@walletofsatoshi.com', 'Alice@WalletOfSatoshi.com', 'a.b-c_d+e@getalby.com', 'x@sub.domain.co.uk']) assert.equal(lnAddressSyntax(ok).ok, true, ok);
  assert.equal(lnAddressSyntax('Alice@WalletOfSatoshi.com').address, 'alice@walletofsatoshi.com');
  for (const bad of ['', 'alice', 'alice@', '@wos.com', 'a@b@c.com', 'al ice@wos.com', 'a!@wos.com', 'a@wos', 'a@wos.com:8443', 'a@-wos.com', 'a@wos..com', 'a@wos.123'])
    assert.equal(lnAddressSyntax(bad).why, WHY.syntax, bad);
  for (const priv of ['a@127.0.0.1', 'a@10.0.0.5', 'a@localhost', 'a@wallet.local', 'a@box.lan', 'a@node.ts.net', 'a@127.0.0.1.nip.io', 'a@x.onion', 'a@192-168-1-1.sslip.io'])
    assert.notEqual(lnAddressSyntax(priv).ok, true, priv);
  assert.equal(lnAddressSyntax('a@127.0.0.1.nip.io').why, WHY.private);
});

test('#3250 the wallet: a payRequest is ok; a bad answer, a 404, a timeout, a redirect to a private host are refused with a short reason', async () => {
  const asked = [];
  const ok = await checkLnAddress('Alice@WalletOfSatoshi.com', { fetchFn: async (u) => { asked.push(u); return answer(200, good); } });
  assert.deepEqual(ok, { ok: true, address: 'alice@walletofsatoshi.com' });
  assert.deepEqual(asked, ['https://walletofsatoshi.com/.well-known/lnurlp/alice']);
  const why = async (fetchFn, o = {}) => (await checkLnAddress('alice@walletofsatoshi.com', { fetchFn, ...o })).why;
  assert.equal(await why(async () => answer(200, 'not json')), WHY.answer);
  assert.equal(await why(async () => answer(200, { ...good, tag: 'withdrawRequest' })), WHY.answer);
  assert.equal(await why(async () => answer(200, { ...good, callback: 'http://walletofsatoshi.com/cb' })), WHY.callback);
  assert.equal(await why(async () => answer(200, { ...good, callback: 'https://10.1.2.3/cb' })), WHY.callback);
  assert.equal(await why(async () => answer(200, { ...good, maxSendable: 999 })), WHY.amount);
  assert.equal(await why(async () => answer(200, { ...good, minSendable: 5000, maxSendable: 4000 })), WHY.amount);
  assert.equal(await why(async () => answer(404, { status: 'ERROR' })), WHY.unknown);
  assert.equal(await why(async () => answer(500, '')), WHY.silent);
  assert.equal(await why(async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }), WHY.silent);
  // a wallet that never answers: refused after the timeout, the fetcher's own signal aborted
  let aborted = false; const t0 = Date.now();
  assert.equal(await why((u, o) => new Promise(() => { o.signal.addEventListener('abort', () => { aborted = true; }); }), { timeoutMs: 150 }), WHY.silent);
  assert.ok(aborted && Date.now() - t0 < 2000);
  // redirects: followed by hand to a public https host; to a private one or plain http never asked
  const hops = [];
  const redir = (to) => async (u) => { hops.push(u); return hops.length === 1 ? answer(302, '', { location: to }) : answer(200, good); };
  assert.equal((await checkLnAddress('alice@walletofsatoshi.com', { fetchFn: redir('https://getalby.com/.well-known/lnurlp/alice') })).ok, true);
  assert.equal(hops[1], 'https://getalby.com/.well-known/lnurlp/alice');
  for (const to of ['https://127.0.0.1/x', 'https://192.168.1.10/x', 'http://getalby.com/x', 'https://localhost/x', 'https://169.254.169.254/latest']) {
    hops.length = 0;
    assert.equal(await why(redir(to)), WHY.private, to); assert.equal(hops.length, 1, to);
  }
  // a private domain is refused before any ask
  let n = 0; assert.equal((await checkLnAddress('a@127.0.0.1.nip.io', { fetchFn: async () => { n++; return answer(200, good); } })).why, WHY.private); assert.equal(n, 0);
});

test('#3250 the default fetcher: a name that leads home (localtest.me) is refused by its spelling, no network', async () => {
  assert.equal((await checkLnAddress('a@localtest.me')).why, WHY.private);
});

test('#3250 save: kept only when the wallet answers; at most 10 wallet checks per player per hour; GET /me returns it', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z' });
  const p = keypair();
  w.wallets.set('bad@walletofsatoshi.com', { ok: false, why: WHY.answer });
  assert.deepEqual(await w.opr.saveLnAddress(p.pk, 'nope'), { ok: false, code: 400, why: WHY.syntax });
  assert.equal(w.lnAsked.length, 0);   // a typo asks no wallet and uses no check
  const gap = () => w.clock.add(LN_CHECK_GAP_MS);   // #3333: one wallet ask every 5 s per key
  assert.equal((await w.opr.saveLnAddress(p.pk, 'bad@walletofsatoshi.com')).why, WHY.answer);
  const fast = await w.opr.saveLnAddress(p.pk, 'Me@WalletOfSatoshi.com'); assert.equal(fast.code, 429); gap();
  assert.deepEqual(await w.opr.saveLnAddress(p.pk, 'Me@WalletOfSatoshi.com'), { ok: true, lnAddress: 'me@walletofsatoshi.com' });
  for (let i = 3; i <= LN_CHECKS_PER_HOUR; i++) { gap(); assert.equal((await w.opr.saveLnAddress(p.pk, `me${i}@walletofsatoshi.com`)).ok, true); }
  gap();
  const over = await w.opr.saveLnAddress(p.pk, 'late@walletofsatoshi.com');
  assert.equal(over.ok, false); assert.equal(over.code, 429); assert.match(over.why, /^Too many checks - try again in \d+ min$/);
  assert.equal(w.lnAsked.length, LN_CHECKS_PER_HOUR);
  const other = keypair(); assert.equal((await w.opr.saveLnAddress(other.pk, 'x@walletofsatoshi.com')).ok, true);   // per player
  w.clock.add(61 * MIN);
  assert.equal((await w.opr.saveLnAddress(p.pk, 'late@walletofsatoshi.com')).ok, true);
  // over HTTP: signed like /name; GET /me answers it
  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body) => { const raw = body === undefined ? '' : JSON.stringify(body);
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: signIn(p, { path, method, body: raw, createdAt: Math.floor(w.clock.now() / 1000) }) }, body: method === 'POST' ? raw : undefined });
    return { status: r.status, json: await r.json() }; };
  try {
    assert.equal((await fetch(base + '/lnaddress', { method: 'POST', body: '{}' })).status, 401);
    let r = await call('POST', '/lnaddress', { address: 'x' }); assert.equal(r.status, 400); assert.equal(r.json.why, WHY.syntax); assert.equal(r.json.code, undefined);
    gap();
    r = await call('POST', '/lnaddress', { address: 'final@walletofsatoshi.com' }); assert.equal(r.status, 200); assert.equal(r.json.lnAddress, 'final@walletofsatoshi.com');
    r = await call('GET', '/me'); assert.equal(r.json.lnAddress, 'final@walletofsatoshi.com');
  } finally { srv.close(); }
});

/** A round of players with the given press counts, every one placed (verified X); ends it and writes the lists one hour later unless told not to. */
async function round(counts, { write = true } = {}) {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w);
  const ps = counts.map(() => keypair());
  for (const [i, p] of ps.entries()) {
    w.link(p.pk);
    const a = await paidAttempt(w, p.pk, r.id); w.clock.add(60000);
    assert.equal(w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(counts[i], undefined, 37 + i) }).ok, true);
  }
  if (write) { w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick(); }
  return { w, r, ps };
}
const listOf = (w, r, kind) => w.opr.listsOf(r.id).find((l) => l.kind === kind);

test('#3250 owner rule: the top player has no address - rank 2 with one gets the bounty; the row says why rank 1 was passed over', async () => {
  const { w, r, ps } = await round([30, 20, 10], { write: false });
  await w.opr.saveLnAddress(ps[1].pk, 'second@walletofsatoshi.com');
  await w.opr.saveLnAddress(ps[2].pk, 'third@walletofsatoshi.com');
  w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick();
  const b = listOf(w, r, 'bounty');
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].player, ps[1].pk); assert.equal(b.rows[0].sats, 2500); assert.equal(b.rows[0].lnAddress, 'second@walletofsatoshi.com');
  assert.deepEqual(b.rows[0].skipped.map((x) => [x.player, x.rank, x.why]), [[ps[0].pk, 1, NO_LN_ADDRESS]]);
  // the pot is not touched by the rule; each row names the stored address (null when none)
  assert.deepEqual(listOf(w, r, 'pot').rows.map((x) => [x.player, x.lnAddress]), [[ps[0].pk, null], [ps[1].pk, 'second@walletofsatoshi.com'], [ps[2].pk, 'third@walletofsatoshi.com']]);
  // the bounty winner claims to the stored address; the passed-over player cannot
  assert.equal(w.opr.claimBounty(ps[1].pk, { round: r.id }).lnAddress, 'second@walletofsatoshi.com');
  assert.equal(w.opr.claimBounty(ps[0].pk, { round: r.id }).ok, false);
});

test('#3250 owner rule: an address saved within 1 hour after the round counts (the waiting list is rebuilt), one saved after it does not', async () => {
  const { w, r, ps } = await round([30, 20], { write: false });
  w.clock.set(r.end_ms); await w.opr.tick();
  w.clock.add(59 * MIN);
  await w.opr.saveLnAddress(ps[1].pk, 'second@walletofsatoshi.com');   // within the hour, before the lists
  w.clock.add(1 * MIN); await w.opr.tick();
  assert.equal(listOf(w, r, 'bounty').rows[0].player, ps[1].pk);
  w.clock.add(1);   // the grace is over: rank 1 saves now - too late for this round's bounty, the waiting list keeps rank 2
  await w.opr.saveLnAddress(ps[0].pk, 'first@walletofsatoshi.com');
  const b = listOf(w, r, 'bounty');
  assert.equal(b.state, 'waiting'); assert.equal(b.rows[0].player, ps[1].pk);
  assert.deepEqual(b.rows[0].skipped.map((x) => x.player), [ps[0].pk]);
  // the pot row of rank 1 now names the address it saved (the pot needs none by the rule)
  assert.equal(listOf(w, r, 'pot').rows[0].lnAddress, 'first@walletofsatoshi.com');
  // a player whose valid address was in time keeps counting after changing it later
  const later = await round([30, 20], { write: false });
  await later.w.opr.saveLnAddress(later.ps[0].pk, 'one@walletofsatoshi.com');
  later.w.clock.set(later.r.end_ms + 2 * 60 * MIN);
  await later.w.opr.saveLnAddress(later.ps[0].pk, 'two@walletofsatoshi.com');
  await later.w.opr.tick();
  const lb = listOf(later.w, later.r, 'bounty');
  assert.equal(lb.rows[0].player, later.ps[0].pk); assert.equal(lb.rows[0].lnAddress, 'two@walletofsatoshi.com');
});

test('#3250 owner rule: nobody with an address - no bounty row; the bounty lapses (it never carries), the pot list is as before', async () => {
  const { w, r, ps } = await round([30, 20]);
  const b = listOf(w, r, 'bounty');
  assert.deepEqual(b.rows, []);
  assert.equal(listOf(w, r, 'pot').rows.length, 2);
  assert.equal(listOf(w, r, 'pot').carrySats, 0);
  assert.equal(w.opr.claimBounty(ps[0].pk, { round: r.id }).ok, false);
  // the next round's bounty is the plain 2,500 again: nothing carried
  w.clock.set(Date.parse('2026-11-24T01:00:00Z')); const next = await openRound(w, '2026-11-24');
  assert.equal(w.opr.publicRound(next).bountySats, 2500);
});

test('#3250 payable: an approved list names each row\'s Lightning address', async () => {
  const { w, r, ps } = await round([30, 20], { write: false });
  await w.opr.saveLnAddress(ps[0].pk, 'first@walletofsatoshi.com');
  w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick();
  assert.equal(w.opr.decideList({ round: r.id, kind: 'bounty', action: 'approve', by: 'owner', version: (w.opr.listsOf(r.id).find((l) => l.kind === 'bounty') || {}).version }).ok, true);
  const pay = w.opr.payable();
  assert.equal(pay[0].kind, 'bounty'); assert.equal(pay[0].rows[0].lnAddress, 'first@walletofsatoshi.com');
});
