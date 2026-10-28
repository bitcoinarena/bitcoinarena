// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #705: the seat's guardian_of check runs bitcoin-cli in a worker - the seat's loop keeps turning while a slow wallet answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { advertSelfInWorker, createAdvertSelf, firstCheckDelayMs, READ_AGAIN_MS } from '../src/advert-self.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { bondOutputKey, bondInternalKey } from '../../arena-protocol/src/bond-script.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint, combine } from '../src/curve.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { FAKE_CLI } from './tn4-tool-harness.js';

test('a slow bond wallet does not hold the seat loop (#705)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advert705-'));
  const cli = join(dir, 'slow-cli');
  writeFileSync(cli, '#!/bin/sh\nsleep 1\necho "[]"\n');      // every call takes a second, as scantxoutset did for minutes
  chmodSync(cli, 0o755);
  const before = process.env.ARENA_BOND_CLI;
  process.env.ARENA_BOND_CLI = `${cli} -rpcwallet=test`;
  try {
    let ticks = 0, worst = 0, at = Date.now();
    const t = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - at); at = n; ticks++; }, 20);
    const t0 = Date.now();
    const r = await advertSelfInWorker({ mine: [{ federationId: new Uint8Array(32), guardianKey: new Uint8Array(33) }], secret: new Uint8Array(32).fill(1), last: null });
    clearInterval(t);
    assert.equal(r, null);                                      // no bond in the wallet: nothing to do
    assert.ok(Date.now() - t0 >= 1000, 'the wallet was asked');
    assert.ok(ticks >= 30, `the loop turned ${ticks} times`);
    assert.ok(worst < 300, `longest loop gap ${worst} ms`);
  } finally {
    if (before === undefined) delete process.env.ARENA_BOND_CLI; else process.env.ARENA_BOND_CLI = before;
  }
});

test('no bond wallet named: nothing to do', async () => {
  const before = process.env.ARENA_BOND_CLI;
  delete process.env.ARENA_BOND_CLI;
  try { assert.equal(await advertSelfInWorker({ mine: [], secret: new Uint8Array(32), last: null }), null); }
  finally { if (before !== undefined) process.env.ARENA_BOND_CLI = before; }
});

// KANBAN #741 (measured on the test host 2026-10-28 ~00:40-01:05Z): seven seats on one testnet4 bitcoind each scanned the whole UTXO set every
// 10 min - a scantxoutset running in 6 of 6 getrpcinfo samples, "Scan already in progress" 357-1,277 times per seat - and their own chain
// reads timed out. The check now reads the wallet only when the seat's census entry lacks a guardian or game, scans once per read, never
// waits on a busy scan, and takes a lock so seats on one machine never scan together.
const g4 = genesisFor('testnet4');
const b32 = (n) => new Uint8Array(32).fill(n);
const FED = b32(0x33), GKEY = Uint8Array.from([0x02, ...b32(0x71)]), GAME2 = b32(0x5a);
const FUND = { txid: 'ab'.repeat(32), vout: 1 };
const bondKey = (nodeKey) => bondOutputKey({ nodeKey, arbitrationKeys: g4.arbitrationKeys, arbitrationK: g4.arbitrationK, bondMaturity: g4.bondMaturity,
  internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g4.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine }).outputKey;
const advertOf = (nodePubkey, guardianOf, n) => ({
  nodePubkey, operatorId: '2of2', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify', 'settlement'],
  endpoint: `wss://node-${n}.example/`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0,
  bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf, guardianCapable: true, guardianEndpoint: `wss://node-${n}.example/guardian`,
  timestamp: 1788700000000n,
});

// `n` seats, each with a real testnet4 bond on the fake chain whose advertisement names no guardian; `named`: those whose census entry
// already names the guardian and both games
function chain(n, { named = [], spec = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'advert741-'));
  const s = { wallets: ['test'], scan: {}, raw: {}, send: true, utxos: [{ txid: FUND.txid, vout: FUND.vout, amount: 0.001 }],
    txout: { [`${FUND.txid}:${FUND.vout}`]: { value: 0.001, confirmations: 3 } }, ...spec };
  const seats = [];
  for (let i = 1; i <= n; i++) {
    const secret = schnorr.utils.randomSecretKey(), pubkey = schnorr.getPublicKey(secret);
    const a = advertOf(pubkey, [], i);
    const tx = bondTransaction(a, { value: 50000, signature: schnorr.sign(advertId(a), secret), outputKey: bondKey(pubkey), previousTxid: b32(0x90 + i), network: 'testnet4' });
    const txid = toHex(Uint8Array.from(parseTransaction(tx).txid).reverse());
    s.scan[`raw(5120${toHex(bondKey(pubkey))})`] = [{ txid, vout: 0, height: 125000 + i, amount: 0.0005 }];
    s.raw[txid] = toHex(tx);
    const entry = { pubkey, advert: named.includes(i) ? { ...a, guardianOf: [{ federationId: FED, guardianKey: GKEY }], hostedGames: [NEXTBLOCK_GAME_ID, GAME2] } : a };
    seats.push({ i, secret, pubkey, entry, bond: txid });
  }
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(s));
  return { dir, seats, census: seats.map((x) => x.entry) };
}
async function withFake(c, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, { ARENA_BOND_CLI: `${process.execPath} ${FAKE_CLI} -rpcwallet=test`, FAKE_CLI_SPEC: join(c.dir, 'spec.json'), FAKE_CLI_LOG: join(c.dir, 'calls.jsonl') });
  try { return await fn(); } finally { for (const k of ['ARENA_BOND_CLI', 'FAKE_CLI_SPEC', 'FAKE_CLI_LOG']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const calls = (c) => (existsSync(join(c.dir, 'calls.jsonl')) ? readFileSync(join(c.dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const seatCheck = (c, seat, extra = {}) => {
  const lines = [];
  const check = createAdvertSelf({ census: () => c.census, pubkey: seat.pubkey, secret: seat.secret,
    mine: () => [{ federationId: FED, guardianKey: GKEY }], hostedGames: () => [toHex(NEXTBLOCK_GAME_ID), toHex(GAME2)],
    selfFile: join(c.dir, `seat-${seat.i}.advert-self.json`), lockDir: c.dir, network: 'testnet4', log: (l) => lines.push(l), ...extra });
  return { ...check, lines };
};

test('(a) a seat whose advertisement names its guardians and games already reads no wallet at all: no scantxoutset (#741)', async () => {
  const c = chain(1, { named: [1] });
  await withFake(c, async () => {
    const s = seatCheck(c, c.seats[0]);
    for (let k = 0; k < 3; k++) assert.equal(await s.check(Date.now() + k * 600000), 'current');
    assert.deepEqual(calls(c).map((x) => x.method), [], 'not one bitcoin-cli call, so no scantxoutset');
    assert.equal(s.lines.length, 1, 'said once, not every 10 min');
    assert.match(s.lines[0], /\[advert\] own advertisement current: no wallet read/);
  });
});

test('(b) a seat whose census entry lacks its guardian and a game reads once, posts the update, and then reads no more (#741)', async () => {
  const c = chain(2, { named: [2] });
  await withFake(c, async () => {
    const s = seatCheck(c, c.seats[0]);
    const t0 = Date.now();
    assert.equal(await s.check(t0), 'read');
    const scans = calls(c).filter((x) => x.method === 'scantxoutset');
    assert.equal(scans.length, 1, 'one UTXO scan for the whole read');
    assert.equal(JSON.parse(scans[0].params[1]).length, 2, 'the bond key and the marker in the one scan');
    const sent = calls(c).filter((x) => x.method === 'sendrawtransaction');
    assert.equal(sent.length, 2, 'the carrier funding and the update');
    const read = readAdvertUpdate(fromHex(sent[1].params[0]), { network: 'testnet4' });
    assert.ok(read.ok, read.why);
    assert.equal(toHex(Uint8Array.from(read.bondTxid).reverse()), c.seats[0].bond, 'an update of this seat\'s bond');
    assert.equal(toHex(read.advert.guardianOf[0].federationId), toHex(FED));
    assert.deepEqual(read.advert.hostedGames.map(toHex).sort(), [toHex(NEXTBLOCK_GAME_ID), toHex(GAME2)].sort());
    assert.ok(s.lines.some((l) => /own advertisement due \(it lacks guardian 33333333, game 5a5a5a5a\): reading the bond wallet/.test(l)), s.lines.join('\n'));
    assert.ok(s.lines.some((l) => /own advertisement posted: guardian_of 33333333/.test(l)), s.lines.join('\n'));
    // the census has not taken it yet: the next checks read nothing (a seat started again reads the posted update from its file)
    const before = calls(c).length;
    assert.equal(await s.check(t0 + 600000), 'current');
    assert.equal(await seatCheck(c, c.seats[0]).check(t0 + 1200000), 'current');
    assert.equal(calls(c).length, before, 'no call after the update was posted');
    assert.equal(await seatCheck(c, c.seats[0]).check(t0 + READ_AGAIN_MS + 1), 'read', 'read again only once the census has not taken it for 6 h');
  });
});

test('ARENA_ADVERT_SELF=dry reads once, sends nothing, and does not read again every 10 min (#741)', async () => {
  const c = chain(1);
  await withFake(c, async () => {
    const s = seatCheck(c, c.seats[0], { dry: true });
    const t0 = Date.now();
    assert.equal(await s.check(t0), 'read');
    assert.equal(await s.check(t0 + 600000), 'current');
    assert.equal(calls(c).filter((x) => x.method === 'scantxoutset').length, 1);
    assert.equal(calls(c).filter((x) => x.method === 'sendrawtransaction').length, 0, 'dry sends nothing');
    assert.ok(s.lines.some((l) => /would be/.test(l)), s.lines.join('\n'));
  });
});

test('(c) "Scan already in progress" is not waited on: one call, the check gives up until the next one (#741)', async () => {
  const c = chain(1, { spec: { fail: { scantxoutset: 'Scan already in progress, use action "abort" or "status"' } } });
  await withFake(c, async () => {
    const s = seatCheck(c, c.seats[0]);
    const t0 = Date.now();
    assert.equal(await s.check(), 'busy');
    assert.ok(Date.now() - t0 < 2000, `answered in ${Date.now() - t0} ms, no 2 s waits`);
    assert.equal(calls(c).filter((x) => x.method === 'scantxoutset').length, 1, 'asked once, not again');
    assert.ok(s.lines.some((l) => /not read: bitcoind is running another UTXO scan; next check in 10 min/.test(l)), s.lines.join('\n'));
    assert.equal(await s.check(), 'busy', 'a busy answer is no read: the next check asks again');
    assert.equal(calls(c).filter((x) => x.method === 'scantxoutset').length, 2);
  });
});

test('(d) seven seats checking together never run two scans at once (#741)', async () => {
  const c = chain(7, { spec: { scanMs: 400 } });
  await withFake(c, async () => {
    const got = await Promise.all(c.seats.map((seat) => seatCheck(c, seat).check()));
    const log = calls(c);
    const spans = [];
    for (const [k, x] of log.entries()) if (x.method === 'scantxoutset') spans.push([x.t, log.slice(k + 1).find((y) => y.method === 'scantxoutset-end').t]);
    console.log('  outcomes:', got.join(' '), '- scans', spans.length);
    assert.ok(spans.length >= 1, 'at least one seat read');
    spans.sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < spans.length; k++) assert.ok(spans[k][0] >= spans[k - 1][1], `scan ${k} started before scan ${k - 1} ended`);
    assert.equal(got.filter((x) => x === 'read').length, spans.length, 'each read scanned once');
    assert.equal(got.filter((x) => x === 'busy').length + spans.length, 7);
    assert.equal(readdirSync(c.dir).filter((f) => f.endsWith('.lock')).length, 0, 'the lock is let go');
  });
});

test('the first check is 5-15 min after the start, spread by the seat key (#741)', () => {
  const at = Array.from({ length: 7 }, () => firstCheckDelayMs(schnorr.getPublicKey(schnorr.utils.randomSecretKey())));
  for (const ms of at) assert.ok(ms >= 300000 && ms < 900000, `${ms}`);
  assert.ok(new Set(at).size > 1, 'not all at once');
});
