// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN UPDATE'S PROGRESS, 0 TO 100 % (kanban #706: the macOS app showed "Updating your node..." over a bar that meant nothing): the line
// the terminal, the service's log and the desktop apps read; the download counted in its real bytes; each step said in order; Done at 100 %;
// a failure said at the step it failed at, with why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { progressLine, progressOf, progressBar, within, mbOf } from '../src/update-progress.js';
import { checkOnce, assetNameFor } from '../src/auto-update.js';

test('the line: a bar of ten, the percent, the step and what it is at; a failure names its step and why; read back as the apps read it', () => {
  assert.equal(progressLine({ pct: 45, step: 'Unpacking 2026.1.9.9' }), '[#####-----]  45 %  Unpacking 2026.1.9.9');
  assert.equal(progressLine({ pct: 0, step: 'Downloading 2026.1.9.9', detail: '0 of 48 MB' }), '[----------]   0 %  Downloading 2026.1.9.9 (0 of 48 MB)');
  assert.equal(progressLine({ pct: 100, step: 'Done' }), '[##########] 100 %  Done');
  assert.equal(progressLine({ pct: 37.9, failed: true, step: 'Stopping your node', why: 'the node did not stop' }), '[####------]  37 %  Failed at "Stopping your node": the node did not stop');
  assert.deepEqual(progressOf('[####------]  45 %  Unpacking 2026.1.9.9'), { pct: 45, text: 'Unpacking 2026.1.9.9' });
  assert.deepEqual(progressOf('\r[##########] 100 %  Done'), { pct: 100, text: 'Done' });
  assert.equal(progressOf('Updated: 2026.1.9.8 -> 2026.1.9.9'), null);
  assert.equal(mbOf(12_400_000, 48_200_000), '12 of 48 MB');
});

test('in a terminal one line redrawn in place, a plain line printed above it; elsewhere a line per step and per 5 %, never backwards', () => {
  const raw = [];
  const t = progressBar({ tty: true, write: (s) => raw.push(s), line: () => assert.fail('a terminal gets no lines') });
  t.report({ pct: 10, step: 'Downloading 1.1', detail: '5 of 50 MB' });
  t.line('release 1.1 is out');
  t.report({ pct: 60, step: 'Starting your node' });
  t.report({ done: true });
  assert.deepEqual(raw, ['\r\x1b[K[#---------]  10 %  Downloading 1.1 (5 of 50 MB)', '\r\x1b[Krelease 1.1 is out\n[#---------]  10 %  Downloading 1.1 (5 of 50 MB)',
    '\r\x1b[K[######----]  60 %  Starting your node', '\r\x1b[K[##########] 100 %  Done\n']);

  const lines = [];
  const p = progressBar({ line: (l) => lines.push(l) });
  for (let i = 0; i <= 50; i++) p.report({ pct: i, step: 'Downloading 1.1', detail: `${i} of 50 MB` });
  p.report({ pct: 30, step: 'Checking the signature' });
  p.report({ pct: 51, step: 'Checking the signature', detail: 'again' });
  p.report({ failed: true, pct: 52, step: 'Unpacking', why: 'tar: not a gzip file' });
  assert.deepEqual(lines.map((l) => progressOf(l).pct), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 50, 52]);
  assert.equal(lines.at(-2), '[#####-----]  50 %  Checking the signature', 'a report below the last percent stays at it');
  assert.equal(lines.at(-1), '[#####-----]  52 %  Failed at "Unpacking": tar: not a gzip file');

  const parts = [];
  within((x) => parts.push(x), 60, 100)({ pct: 50, step: 'Stopping your node' });
  assert.deepEqual(parts, [{ pct: 80, step: 'Stopping your node' }], 'the node\'s move is laid onto 60-100 %');
});

// a node at 0.1.0 and a release 0.1.1 of about 3 MB in 3 pieces, each answering HEAD with its size and GET as a stream
function served({ heads = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'update-progress-'));
  const home = join(root, 'home'); const rel = join(home, 'releases', 'arena-node-0.1.0-linux-x64');
  mkdirSync(rel, { recursive: true });
  writeFileSync(join(rel, 'VERSION'), '0.1.0\n');
  writeFileSync(join(home, 'arena.conf'), 'port=8470\n');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ release: { path: rel } }));
  const bytes = Buffer.alloc(3_000_000, 7);
  const name = assetNameFor('0.1.1', 'linux', 'x64');
  const files = new Map([[`${name}.part00`, bytes.subarray(0, 1_200_000)], [`${name}.part01`, bytes.subarray(1_200_000, 2_400_000)], [`${name}.part02`, bytes.subarray(2_400_000)],
    ['SHA256SUMS', Buffer.from(`${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`)], ['SHA256SUMS.sig', Buffer.from('sig')]]);
  const base = 'https://testnet.bitcoin-arena.io/release/u/f/v0.1.1/';
  const fetcher = async (url, o = {}) => {
    const f = files.get(url.slice(base.length));
    if (!f) return new Response('', { status: 404 });
    if (o.method === 'HEAD') return heads ? new Response(null, { status: 200, headers: { 'content-length': String(f.length) } }) : new Response(null, { status: 200 });
    // the body in 100 kB chunks, as a network delivers it
    let at = 0;
    return new Response(new ReadableStream({ pull(c) { if (at >= f.length) return c.close(); c.enqueue(new Uint8Array(f.subarray(at, at + 100_000))); at += 100_000; } }), { status: 200 });
  };
  const latest = async () => ({ newer: true, latest: { version: '0.1.1', assets: { [name]: createHash('sha256').update(bytes).digest('hex') },
    download: { base, parts: { [name]: [...files.keys()].filter((k) => k.includes('.part')) } } } });
  const unpack = (archive, dir) => mkdirSync(join(dir, name.replace(/\.tar\.gz$/, '')), { recursive: true });
  return { root, home, fetcher, latest, unpack };
}

test('an update from the release list: the download by its bytes, then the signature, unpacking and the node\'s move, Done at 100 %', async () => {
  const s = served();
  try {
    const told = [];
    const r = await checkOnce({ home: s.home, latest: s.latest, fetcher: s.fetcher, platform: 'linux', arch: 'x64', verifyAsset: () => ({ ok: true }), unpack: s.unpack, progress: (p) => told.push(p),
      apply: async (o) => { o.progress({ pct: 0, step: 'Checking the new release' }); o.progress({ pct: 24, step: 'Stopping your node' }); o.progress({ pct: 45, step: "Waiting for your node's first answer" }); return { ok: true }; } });
    assert.equal(r.ok, true, r.why);
    const dl = told.filter((p) => p.step === 'Downloading 0.1.1' && p.detail);
    assert.ok(dl.length >= 30, `the download said chunk by chunk (${dl.length})`);
    assert.equal(dl[0].detail, '0 of 3 MB');
    assert.deepEqual([dl.at(-1).detail, dl.at(-1).pct], ['3 of 3 MB', 50], 'all its bytes are half the bar');
    const half = dl.find((p) => p.detail === '1 of 3 MB');
    assert.ok(half.pct > 16 && half.pct < 34, `1 of 3 MB is a third of the download's half (${half.pct})`);
    const order = [...new Set(told.map((p) => p.step).filter(Boolean))];
    assert.deepEqual(order, ['Downloading 0.1.1', 'Checking the signature', 'Unpacking 0.1.1', 'Updating your node to 0.1.1', 'Checking the new release', 'Stopping your node',
      "Waiting for your node's first answer"]);
    assert.equal(told.find((p) => p.step === 'Stopping your node').pct, 60 + 0.24 * 40, 'the node\'s move is 60-100 %');
    assert.ok(told.every((p, i) => i === 0 || p.done || p.pct >= told[i - 1].pct), 'never backwards');
    assert.deepEqual(told.at(-1), { done: true, pct: 100 });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('a server that says no sizes: the bar counts pieces; a refused signature is said at its step; a failed move once, at the node\'s step', async () => {
  const s = served({ heads: false });
  try {
    const told = [];
    const r = await checkOnce({ home: s.home, latest: s.latest, fetcher: s.fetcher, platform: 'linux', arch: 'x64', unpack: s.unpack, progress: (p) => told.push(p),
      verifyAsset: () => ({ ok: false, why: 'SHA256SUMS is not signed by the Arena release key' }), apply: async () => assert.fail('nothing is moved') });
    assert.equal(r.ok, false);
    const pieces = told.filter((p) => /^piece /.test(p.detail || ''));
    assert.deepEqual([pieces[0].detail, pieces.at(-1).detail, Math.round(pieces.at(-1).pct)], ['piece 1 of 3', 'piece 3 of 3', 50]);
    assert.deepEqual(told.at(-1), { failed: true, pct: 50, step: 'Checking the signature', why: 'refused: SHA256SUMS is not signed by the Arena release key' });

    // the move fails and says so itself (update.js): told once, at its own step, laid onto 60-100 %
    const moved = [];
    const r2 = await checkOnce({ home: s.home, latest: s.latest, fetcher: s.fetcher, platform: 'linux', arch: 'x64', unpack: s.unpack, verifyAsset: () => ({ ok: true }), progress: (p) => moved.push(p),
      apply: async (o) => { o.progress({ pct: 24, step: 'Stopping your node' }); o.progress({ failed: true, pct: 24, step: 'Stopping your node', why: 'the node did not stop' }); return { ok: false, why: 'the node did not stop' }; } });
    assert.equal(r2.ok, false);
    assert.equal(moved.filter((p) => p.failed).length, 1);
    assert.deepEqual(moved.at(-1), { failed: true, pct: 60 + 0.24 * 40, step: 'Stopping your node', why: 'the node did not stop' });
    assert.ok(moved.some((p) => p.detail === 'downloaded before'), 'the asset from the first try is used, not fetched again');

    // nothing to do: nothing reported (the service's log stays quiet every half hour)
    const quiet = [];
    await checkOnce({ home: s.home, latest: async () => ({ newer: false, latest: { version: '0.1.0' } }), progress: (p) => quiet.push(p) });
    assert.deepEqual(quiet, []);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
