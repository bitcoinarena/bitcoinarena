// THE STAKE-LOCK PORT'S GUARDIANS, SEND AND SETTLE: what the node hands the fork's blwp-stake-lock and how it reads it back
// (kanban #149 step 2, plan comment 249, Go 2026-10-05). A stand-in tool logs its argv and prints, per mode, what the real
// one prints (tools/stake-lock/src/main.rs: one JSON line on stdout, exit 0; a hard error on stderr, exit 1, no JSON).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { toHex } from '../../protocol/src/hash.js';

const b = (n, len = 32) => new Uint8Array(len).fill(n);
// `answer[mode]` is printed as JSON; `exit[mode]` exits with that code after; `stderr[mode]` is said on stderr; `hang[mode]`
// never exits (the port's own timeout kills it), before (`'before'`) or after (`'after'`) it prints
function fakeTool({ answer = {}, exit = {}, stderr = {}, raw = {}, hang = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stake-lock-modes-'));
  const log = join(dir, 'argv.jsonl');
  const bin = join(dir, 'blwp-stake-lock');
  writeFileSync(bin, `#!${process.execPath}
const a = process.argv.slice(2); require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const mode = a[a.indexOf('--mode') + 1];
const answer = ${JSON.stringify(answer)}, exit = ${JSON.stringify(exit)}, stderr = ${JSON.stringify(stderr)}, raw = ${JSON.stringify(raw)}, hang = ${JSON.stringify(hang)};
if (hang[mode] === 'before') setInterval(() => {}, 1000);
else {
console.log('2026-10-05T11:00:00Z INFO fedimint_client: a log line first');
if (raw[mode] !== undefined) console.log(raw[mode]);
if (answer[mode]) console.log(JSON.stringify(answer[mode]));
if (stderr[mode]) console.error(stderr[mode]);
if (hang[mode] === 'after') setInterval(() => {}, 1000); else process.exit(exit[mode] || 0);
}
`);
  chmodSync(bin, 0o755);
  return { bin, argv: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}
const KEYS = ['02' + '11'.repeat(32), '03' + '22'.repeat(32), '02' + '33'.repeat(32)];

test('guardians: asked of the READ client dir; the federation id, count, threshold and 33-byte keys read back; not asked again within 60 s', async () => {
  const t = fakeTool({ answer: { guardians: { mode: 'guardians', federation_id: 'ab'.repeat(32), guardians: 3, threshold: 3,
    keys: KEYS.map((key, peer) => ({ peer, key })) } } });
  let clock = 1_000_000;
  const port = stakeLockPort({ bin: t.bin, dataDir: '/shared', readDataDir: '/read-only', now: () => clock });
  const g = await port.guardians();
  assert.deepEqual(t.argv(), [['--mode', 'guardians', '--data-dir', '/read-only']]);
  assert.equal(toHex(g.federationId), 'ab'.repeat(32));
  assert.equal(g.federationId.length, 32);
  assert.equal(g.guardians, 3);
  assert.equal(g.threshold, 3);
  assert.deepEqual(g.keys.map((k) => [k.length, toHex(k)]), KEYS.map((k) => [33, k]));
  clock += 59_999;
  assert.deepEqual(await port.guardians(), g);
  assert.equal(t.argv().length, 1, 'within 60 s the tool is not asked again');
  clock += 2;
  await port.guardians();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(t.argv().length, 2, 'past 60 s it is read again');
});

const SEND = { gateway: 'https://gw.example', paymentHash: 'cd'.repeat(32), amountMsat: 21000n, expiration: 700,
  claimPk: '02' + '44'.repeat(32), refundPk: Uint8Array.from([2, ...b(0x55)]), invoice: 'lntbs1fakeinvoice' };
const BASE = ['--mode', 'send', '--data-dir', '/shared', '--hash', SEND.paymentHash, '--amount-msat', '21000', '--expiration', '700',
  '--claim-pk', SEND.claimPk, '--refund-pk', '02' + '55'.repeat(32), '--invoice', SEND.invoice];

test('send without authorisation: only the six base fields, against the SHARED client dir; the contract id and the message read back', async () => {
  const t = fakeTool({ answer: { send: { mode: 'send', contract_id: 'c1'.repeat(32), auth_message_hex: 'ee'.repeat(32) } } });
  const port = stakeLockPort({ bin: t.bin, dataDir: '/shared', readDataDir: '/read-only' });
  const s = await port.send(SEND);
  assert.deepEqual(t.argv(), [BASE]);
  assert.equal(s.contractId, 'c1'.repeat(32));
  assert.equal(toHex(s.message), 'ee'.repeat(32));
  assert.equal(s.sent, false);
  assert.equal(s.preimage, null);
});

test('send with authorisation adds --auth, --outpoint and --gateway, and reads sent and the preimage', async () => {
  const t = fakeTool({ answer: { send: { mode: 'send', contract_id: 'c1'.repeat(32), auth_message_hex: 'ee'.repeat(32), sent: true,
    preimage: '99'.repeat(32), gateway: SEND.gateway } } });
  const port = stakeLockPort({ bin: t.bin, dataDir: '/shared', readDataDir: '/read-only' });
  const s = await port.send({ ...SEND, auth: b(0x66, 64), outpoint: { txid: b(0x77), outIdx: 3n } });
  assert.deepEqual(t.argv(), [[...BASE, '--auth', '66'.repeat(64), '--outpoint', `${'77'.repeat(32)}:3`, '--gateway', SEND.gateway]]);
  assert.equal(s.sent, true);
  assert.equal(toHex(s.preimage), '99'.repeat(32));
  const why = fakeTool({ answer: { send: { mode: 'send', contract_id: 'c1'.repeat(32), auth_message_hex: 'ee'.repeat(32), sent: false,
    why: 'the gateway cancelled: it forfeits its claim' } } });
  const no = await stakeLockPort({ bin: why.bin, dataDir: '/shared' }).send({ ...SEND, auth: b(0x66, 64), outpoint: { txid: b(0x77), outIdx: 3n } });
  assert.deepEqual([no.sent, no.preimage, no.why], [false, null, 'the gateway cancelled: it forfeits its claim']);
});

test('settle builds --locks, --payouts, --refunds and --signature - refunds and signature only when given - and reads the answer', async () => {
  const answer = { settle: { mode: 'settle', txid: 'f0'.repeat(32), message_hex: 'a5'.repeat(32), accepted: true, error: null,
    payouts: [{ out_idx: 0 }], payouts_stored: [{ ok: true }], locks_after: [], unspent_msat: 0 } };
  const t = fakeTool({ answer });
  const port = stakeLockPort({ bin: t.bin, dataDir: '/shared', readDataDir: '/read-only' });
  const claims = [{ outpoint: { txid: b(0x01), outIdx: 0n }, preimage: b(0x0a), amountMsat: 98000n },
    { outpoint: { txid: b(0x02), outIdx: 1n }, preimage: b(0x0b), amountMsat: 2000n }];
  const payouts = [{ payoutPk: b(0x0c, 33), msat: 60000n },
    { payoutPk: b(0x0d, 33), msat: 40000n, sent: { paymentHash: 'ab'.repeat(32), gatewayPk: '02' + 'cc'.repeat(32), expiration: 800 } }];
  const plain = await port.settle({ claimPk: b(0x0e, 33), claims, payouts, nonce: b(0x0f) });
  const locks = `${'01'.repeat(32)}:0:${'0a'.repeat(32)}:98000,${'02'.repeat(32)}:1:${'0b'.repeat(32)}:2000`;
  const pays = `${'0c'.repeat(33)}:60000,invoice:${'ab'.repeat(32)}:02${'cc'.repeat(32)}:${'0d'.repeat(33)}:800:40000`;
  assert.deepEqual(t.argv()[0], ['--mode', 'settle', '--data-dir', '/shared', '--claim-pk', '0e'.repeat(33), '--locks', locks,
    '--payouts', pays, '--nonce', '0f'.repeat(32)], 'no --refunds, no --signature');
  assert.deepEqual([plain.txid, plain.message, plain.accepted, plain.error, plain.unspentMsat], ['f0'.repeat(32), 'a5'.repeat(32), true, null, 0n]);
  assert.deepEqual(plain.payoutsStored, [{ ok: true }]);
  await port.settle({ claimPk: b(0x0e, 33), claims, payouts, nonce: b(0x0f), signature: b(0x5a, 64),
    refunds: [{ outpoint: { txid: b(0x03), outIdx: 2n }, amountMsat: 500n }] });
  assert.deepEqual(t.argv()[1], ['--mode', 'settle', '--data-dir', '/shared', '--claim-pk', '0e'.repeat(33), '--locks', locks,
    '--refunds', `${'03'.repeat(32)}:2:500`, '--payouts', pays, '--nonce', '0f'.repeat(32), '--signature', '5a'.repeat(64)]);
  const none = fakeTool({ answer: { settle: { mode: 'settle', txid: 'f0'.repeat(32), message_hex: 'a5'.repeat(32) } } });
  const read = await stakeLockPort({ bin: none.bin, dataDir: '/shared' }).settle({ claimPk: b(0x0e, 33), claims, payouts, nonce: b(0x0f) });
  assert.deepEqual([read.accepted, read.error, read.unspentMsat, read.locksAfter], [false, null, null, null], 'fields the tool left out');
});

test('a tool that fails before it answers, or prints no JSON, is an error - never an answer', async () => {
  const hard = fakeTool({ stderr: { guardians: 'Error: no mode wrong' }, exit: { guardians: 1 } });
  await assert.rejects(stakeLockPort({ bin: hard.bin, dataDir: '/d' }).guardiansRead(), /^Error: blwp-stake-lock: Error: no mode wrong$/);
  const silent = fakeTool({ raw: { fees: 'not json at all' } });
  await assert.rejects(stakeLockPort({ bin: silent.bin, dataDir: '/d' }).feesRead(), /blwp-stake-lock answered no JSON/);
  const broken = fakeTool({ raw: { fees: '{"fee_ppm": 0, ' } });
  await assert.rejects(stakeLockPort({ bin: broken.bin, dataDir: '/d' }).feesRead(), /blwp-stake-lock answered no JSON/);
  await assert.rejects(stakeLockPort({ bin: join(tmpdir(), 'no-such-blwp-stake-lock'), dataDir: '/d' }).feesRead(), /blwp-stake-lock: /);
});

// THE SPLIT (the owner 2026-10-05, decision (b) on comment 251): the live tool prints one JSON line and exits clean, or fails
// with no JSON; JSON followed by death is a kill after the print - the port's 60 s timeout while the client shuts down. A
// JSON line printed before the process died is its answer: a settle that printed accepted true and was then killed was
// submitted, and the seat must not settle that stake again. A tool killed before it answered is an error.
test('killed after it printed: its JSON is the answer (a settle killed after "accepted": true reads accepted); killed before: an error', async () => {
  const settled = { mode: 'settle', txid: 'f0'.repeat(32), message_hex: 'a5'.repeat(32), accepted: true, error: null, unspent_msat: 0 };
  const after = fakeTool({ answer: { settle: settled }, hang: { settle: 'after' } });
  const t0 = Date.now();
  const s = await stakeLockPort({ bin: after.bin, dataDir: '/d', timeoutMs: 1500 }).settle({ claimPk: b(1, 33), claims: [], payouts: [], nonce: b(2) });
  assert.ok(Date.now() - t0 >= 1400, 'the port waited for its own timeout, which killed the tool');
  assert.deepEqual([s.accepted, s.txid, s.error], [true, 'f0'.repeat(32), null], 'accepted, as printed before the kill');
  const before = fakeTool({ answer: { settle: settled }, hang: { settle: 'before' } });
  await assert.rejects(stakeLockPort({ bin: before.bin, dataDir: '/d', timeoutMs: 1500 }).settle({ claimPk: b(1, 33), claims: [], payouts: [], nonce: b(2) }),
    /^Error: blwp-stake-lock: /, 'killed before any JSON: an error, never read as accepted');
});
