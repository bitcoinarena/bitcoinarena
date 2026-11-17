// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NIGHTLY COMPATIBILITY RUN (kanban #2950): compat-check's real NIP-46 and NIP-47 calls against a fake bunker and a fake NWC wallet on a
// local relay, the version read from a Chrome Web Store package, and one night's decisions: a working product gets its row, a failing
// one keeps its old row and is reported, a manual product with a newer version is a reminder, nothing is written twice for the same result.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkSigner, checkNwc } from '../tools/compat-check.mjs';
import { run, plan, worthWriting, manifestFromCrx, reportMarkdown, secretsFrom, latestVersion } from '../tools/compat-run.mjs';

// --- a relay: EVENT, REQ (ids, kinds, authors, #e, #p), CLOSE ---
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((ok) => wss.once('listening', ok));
const RELAY = `ws://127.0.0.1:${wss.address().port}`;
const stored = [], subs = new Set();
const matches = (f, e) => (!f.ids || f.ids.includes(e.id)) && (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey))
  && ['e', 'p'].every((t) => !f[`#${t}`] || e.tags.some((x) => x[0] === t && f[`#${t}`].includes(x[1])));
const listeners = [];
function deliver(e) {
  stored.push(e);
  for (const s of subs) if (s.filters.some((f) => matches(f, e))) s.ws.send(JSON.stringify(['EVENT', s.id, e]));
  for (const l of listeners) l(e);
}
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m[0] === 'EVENT') { ws.send(JSON.stringify(['OK', m[1].id, true, ''])); deliver(m[1]); }
    else if (m[0] === 'REQ') {
      const s = { ws, id: m[1], filters: m.slice(2) };
      for (const e of stored) if (s.filters.some((f) => matches(f, e))) ws.send(JSON.stringify(['EVENT', s.id, e]));
      ws.send(JSON.stringify(['EOSE', s.id]));
      subs.add(s);
    } else if (m[0] === 'CLOSE') for (const s of subs) if (s.ws === ws && s.id === m[1]) subs.delete(s);
  });
  ws.on('close', () => { for (const s of subs) if (s.ws === ws) subs.delete(s); });
});
after(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
const conv = (sk, pk) => nip44.getConversationKey(sk, pk);

// --- a bunker (NIP-46): the remote signer's key answers for the user's key ---
function fakeBunker({ refuse = [] } = {}) {
  const bk = generateSecretKey(), uk = generateSecretKey(), bkPub = getPublicKey(bk), ukPub = getPublicKey(uk);
  listeners.push((e) => {
    if (e.kind !== 24133 || !e.tags.some((t) => t[0] === 'p' && t[1] === bkPub)) return;
    const { id, method, params } = JSON.parse(nip44.decrypt(e.content, conv(bk, e.pubkey)));
    let answer;
    if (refuse.includes(method)) answer = { id, result: '', error: `${method} is not allowed` };
    else if (method === 'connect') answer = { id, result: 'ack' };
    else if (method === 'get_public_key') answer = { id, result: ukPub };
    else if (method === 'sign_event') answer = { id, result: JSON.stringify(finalizeEvent(JSON.parse(params[0]), uk)) };
    else if (method === 'nip44_encrypt') answer = { id, result: nip44.encrypt(params[1], conv(uk, params[0])) };
    else if (method === 'nip44_decrypt') answer = { id, result: nip44.decrypt(params[1], conv(uk, params[0])) };
    else answer = { id, result: '', error: 'unknown method' };
    deliver(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', e.pubkey]], content: nip44.encrypt(JSON.stringify(answer), conv(bk, e.pubkey)) }, bk));
  });
  return `bunker://${bkPub}?relay=${encodeURIComponent(RELAY)}&secret=s3cret`;
}

// --- an NWC wallet (NIP-47, NIP-44): its info event, then answers to 23194 ---
function fakeWallet({ fail = {} } = {}) {
  const wk = generateSecretKey(), wPub = getPublicKey(wk), client = generateSecretKey();
  const paid = [];
  deliver(finalizeEvent({ kind: 13194, created_at: Math.floor(Date.now() / 1000), tags: [['encryption', 'nip44_v2']], content: 'get_info get_balance make_invoice pay_invoice' }, wk));
  listeners.push((e) => {
    if (e.kind !== 23194 || !e.tags.some((t) => t[0] === 'p' && t[1] === wPub)) return;
    const { method, params } = JSON.parse(nip44.decrypt(e.content, conv(wk, e.pubkey)));
    let a;
    if (fail[method]) a = { result_type: method, error: { code: fail[method], message: 'no' } };
    else if (method === 'get_info') a = { result_type: method, result: { alias: 'fake wallet', methods: ['pay_invoice'] } };
    else if (method === 'get_balance') a = { result_type: method, result: { balance: 5000000 } };
    else if (method === 'make_invoice') a = { result_type: method, result: { invoice: `lnbc10n1fake${wPub.slice(0, 8)}` } };
    else if (method === 'pay_invoice') { paid.push(params.invoice); a = { result_type: method, result: { preimage: 'ab'.repeat(32) } }; }
    deliver(finalizeEvent({ kind: 23195, created_at: Math.floor(Date.now() / 1000), tags: [['p', e.pubkey], ['e', e.id]], content: nip44.encrypt(JSON.stringify(a), conv(wk, e.pubkey)) }, wk));
  });
  return { link: `nostr+walletconnect://${wPub}?relay=${encodeURIComponent(RELAY)}&secret=${bytesToHex(client)}`, paid };
}

test('a bunker that answers every call: connect, key, both kinds signed, NIP-44 to self - all ok', async () => {
  const checks = await checkSigner(fakeBunker(), { ms: 8000 });
  assert.deepEqual(checks, { connect: 'ok', get_public_key: 'ok', 'sign_event 27235': 'ok', 'sign_event 30078': 'ok', 'nip44 to self': 'ok' });
});

test('a bunker that refuses NIP-44: that check names the refusal, the rest pass', async () => {
  const checks = await checkSigner(fakeBunker({ refuse: ['nip44_encrypt'] }), { ms: 8000 });
  assert.equal(checks.connect, 'ok');
  assert.match(checks['nip44 to self'], /nip44_encrypt is not allowed/);
});

test('an NWC wallet: info, balance, invoice and a payment; its own invoice is kept for the payment back', async () => {
  const w = fakeWallet(), kept = {};
  const checks = await checkNwc(w.link, { pay: 'lnbc10n1ours', kept, ms: 8000 });
  assert.deepEqual(checks, { get_info: 'ok', get_balance: 'ok', make_invoice: 'ok', pay_invoice: 'ok' });
  assert.match(kept.invoice, /^lnbc10n1fake/);
  assert.deepEqual(w.paid, ['lnbc10n1ours']);
});

test('an NWC wallet that cannot make invoices: withdrawals would fail, and the check says so', async () => {
  const checks = await checkNwc(fakeWallet({ fail: { make_invoice: 'NOT_IMPLEMENTED' } }).link, { ms: 8000 });
  assert.equal(checks.get_balance, 'ok');
  assert.match(checks.make_invoice, /^NOT_IMPLEMENTED: no/);
});

// --- the version, from a Chrome Web Store package (CRX3 whose zip puts the sizes after the data, as the store's do) ---
function crx(files) {
  const locals = [], central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(n.length, 26);
    const dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(data.length, 8); dd.writeUInt32LE(raw.length, 12);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data, dd); central.push(ch, n);
    off += 30 + n.length + data.length + 16;
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  const head = Buffer.alloc(12); head.write('Cr24', 0, 'latin1'); head.writeUInt32LE(3, 4); head.writeUInt32LE(5, 8);
  return Buffer.concat([head, Buffer.from('hdr!!'), ...locals, cd, eocd]);
}

test('the version of an extension is its store package\'s manifest; a page that is not a package is refused', async () => {
  const pkg = crx({ 'background.js': 'x'.repeat(500), 'manifest.json': '{"name":"nos2x","version":"2.5.2"}' });
  assert.equal(manifestFromCrx(pkg).version, '2.5.2');
  assert.throws(() => manifestFromCrx(Buffer.from('<html>')), /not a Chrome extension package/);
  const fetcher = async (u) => ({ ok: true, arrayBuffer: async () => pkg, url: u });
  assert.equal(await latestVersion({ versionFrom: { chrome: 'kpgefcfmnafjgpblomihpgmejjdanjjp' } }, { fetcher }), '2.5.2');
  const gh = async () => ({ ok: true, json: async () => ({ tag_name: 'v6.6.9' }) });
  assert.equal(await latestVersion({ versionFrom: { github: 'greenart7c3/Amber' } }, { fetcher: gh }), '6.6.9');
  assert.equal(await latestVersion({ version: 'hosted' }), 'hosted');
  await assert.rejects(latestVersion({ versionFrom: { github: 'a/b' } }, { fetcher: async () => ({ ok: false, status: 403 }) }), /api\.github\.com answered 403/);
});

test('what a night does with each kind of product', () => {
  const secrets = { COMPAT_X: 'bunker://...' };
  assert.equal(plan({ check: 'signer', secret: 'COMPAT_X' }, null, '1', { secrets }).act, 'run');
  assert.match(plan({ check: 'nwc', secret: 'COMPAT_Y' }, null, null, { secrets }).why, /COMPAT_Y is not set/);
  assert.match(plan({ check: 'manual' }, { version: '6.6.9', date: '2026-11-17' }, '6.7.0', { secrets }).why, /6\.7\.0 is out; 6\.6\.9 was tested by hand/);
  assert.equal(plan({ check: 'manual' }, { version: '6.6.9', date: '2026-11-17' }, '6.6.9', { secrets }).act, 'skip');
  assert.equal(plan({ check: 'extension', adapter: 'nos2x' }, null, '2.5.2', { secrets }).act, 'skip');
  assert.equal(plan({ check: 'extension', adapter: 'nos2x' }, null, '2.5.2', { secrets, extension: true }).act, 'run');
});

test('a working row is written once, not every night: again after a version change, a manual or failing row, or 30 days', () => {
  const old = { result: 'works', how: 'automatic', version: '1', date: '2026-11-01', checks: { a: 'ok' } };
  const row = { result: 'works', how: 'automatic', version: '1', date: '2026-11-17', checks: { a: 'ok' } };
  assert.equal(worthWriting(old, row, '2026-11-17'), false);
  assert.equal(worthWriting({ ...old, version: '0.9' }, row, '2026-11-17'), true);
  assert.equal(worthWriting({ ...old, how: 'manual' }, row, '2026-11-17'), true);
  assert.equal(worthWriting({ ...old, result: 'problems' }, row, '2026-11-17'), true);
  assert.equal(worthWriting(old, row, '2026-12-01'), true);
  assert.equal(worthWriting(null, row, '2026-11-17'), true);
});

test('one night, end to end: a signer and a wallet that work get rows, a wallet that fails keeps its old row, a manual product with a newer version is a reminder, the 1 sat is paid back', async () => {
  const good = fakeWallet(), bad = fakeWallet({ fail: { pay_invoice: 'INSUFFICIENT_BALANCE' } });
  const products = [
    { name: 'Bunk', kind: 'Remote signer', check: 'signer', secret: 'COMPAT_BUNK', url: 'https://bunk.example/', platform: 'Server', version: 'self-hosted' },
    { name: 'GoodW', kind: 'NWC wallet', check: 'nwc', secret: 'COMPAT_GOOD', version: 'hosted' },
    { name: 'BadW', kind: 'NWC wallet', check: 'nwc', secret: 'COMPAT_BAD', version: 'hosted' },
    { name: 'Amber', kind: 'Remote signer', check: 'manual', versionFrom: { github: 'greenart7c3/Amber' } },
    { name: 'NoPair', kind: 'NWC wallet', check: 'nwc', secret: 'COMPAT_NONE', version: 'hosted' },
    { name: 'nos2x', kind: 'Browser extension', check: 'extension', versionFrom: { chrome: 'x' } },
  ];
  const results = [
    { name: 'BadW', kind: 'NWC wallet', version: 'hosted', date: '2026-10-01', how: 'automatic', checks: { get_info: 'ok' }, result: 'works' },
    { name: 'Amber', kind: 'Remote signer', version: '6.6.9', date: '2026-11-17', how: 'manual', checks: { login: 'ok' }, result: 'works' },
  ];
  const secrets = { COMPAT_BUNK: fakeBunker(), COMPAT_GOOD: good.link, COMPAT_BAD: bad.link };
  const payBacks = [];
  const night = () => run({
    products, results: nightResults, secrets, today: '2026-11-18', pay: true,
    checkers: { signer: (l) => checkSigner(l, { ms: 8000 }), nwc: (l, o) => checkNwc(l, { ...o, ms: 8000 }) },
    versionOf: async (p) => (p.versionFrom && p.versionFrom.github ? '6.7.0' : p.versionFrom ? '2.5.2' : p.version),
    payWallet: async () => ({ invoice: 'lnbc10n1ours', payBack: async (inv) => { payBacks.push(inv); } }),
  });
  let nightResults = results;
  const { results: out, report } = await night();
  assert.deepEqual(report.works.map((w) => [w.name, w.written]), [['Bunk', true], ['GoodW', true]]);
  assert.deepEqual(report.failed.map((f) => [f.name, Object.keys(f.failing), f.keptRow]), [['BadW', ['pay_invoice'], true]]);
  assert.deepEqual(report.reminders.map((r) => [r.name, r.latest, r.tested]), [['Amber', '6.7.0', '6.6.9']]);
  assert.deepEqual(report.skipped.map((s) => s.name), ['NoPair', 'nos2x']);
  const bunk = out.find((r) => r.name === 'Bunk');
  assert.deepEqual([bunk.how, bunk.version, bunk.date, bunk.result, bunk.url, bunk.platform], ['automatic', 'self-hosted', '2026-11-18', 'works', 'https://bunk.example/', 'Server']);
  assert.deepEqual(out.find((r) => r.name === 'BadW'), results[0], 'a failing product keeps its old row');
  assert.deepEqual(out.find((r) => r.name === 'Amber'), results[1], 'a manual row is not touched');
  assert.deepEqual(payBacks, [`lnbc10n1fake${new URL(good.link).hostname.slice(0, 8)}`], 'our wallet pays the working wallet\'s own invoice back');
  // the next night, the same results: nothing new to write
  nightResults = out;
  const again = await night();
  assert.deepEqual(again.report.works.map((w) => w.written), [false, false]);
  assert.deepEqual(again.results, out);
  // the report: failures first, pipes in an answer do not break the table, no secret in it
  const md = reportMarkdown(report);
  assert.ok(md.indexOf('### Fails') < md.indexOf('### Re-test by hand') && md.indexOf('### Re-test by hand') < md.indexOf('### Works'));
  assert.match(md, /\| BadW \| NWC wallet \| hosted \| pay_invoice: INSUFFICIENT_BALANCE: no \|/);
  for (const s of Object.values(secrets)) assert.ok(!md.includes(s) && !JSON.stringify(report).includes(s));
});

test('the secrets: the workflow\'s JSON and COMPAT_* variables, nothing else', () => {
  const s = secretsFrom({ COMPAT_SECRETS: JSON.stringify({ COMPAT_A: 'a', GITHUB_TOKEN: 'no', COMPAT_EMPTY: '' }), COMPAT_B: 'b', HOME: '/x' });
  assert.deepEqual(s, { COMPAT_A: 'a', COMPAT_B: 'b' });
  assert.deepEqual(secretsFrom({ COMPAT_SECRETS: 'not json' }), {});
});

test('remote versions describe the paired installation, not the newest downloadable release', async () => {
  const product = { name: 'Hub', kind: 'NWC wallet', check: 'nwc', secret: 'COMPAT_HUB', versionFrom: { github: 'a/b' } };
  const opts = { products: [product], results: [], secrets: { COMPAT_HUB: 'pairing', COMPAT_HUB_VERSION: '1' }, versionOf: async () => '2', checkers: { nwc: async () => ({ get_info: 'ok' }) } };
  assert.equal((await run(opts)).results[0].version, '1');
  assert.equal((await run({ ...opts, secrets: { COMPAT_HUB: 'pairing' } })).results[0].version, 'unknown');
});

test('a failed return payment or missing receiving wallet is reported, and secrets in errors are removed', async () => {
  const opts = { products: [{ name: 'W', kind: 'NWC wallet', check: 'nwc', secret: 'COMPAT_W' }], results: [], secrets: { COMPAT_W: 'private-pairing' }, pay: true,
    versionOf: async () => null, checkers: { nwc: async (link, { kept }) => { kept.invoice = 'invoice'; return { pay_invoice: 'ok' }; } } };
  const missing = await run(opts);
  assert.match(missing.report.failed[0].failing.run, /COMPAT_PAY_WALLET/);
  const refund = await run({ ...opts, payWallet: async () => ({ invoice: 'ours', payBack: async () => { throw 'failed private-pairing'; } }) });
  assert.deepEqual(refund.results, []);
  assert.equal(refund.report.failed[0].failing.pay_back, 'failed [redacted]');
});
