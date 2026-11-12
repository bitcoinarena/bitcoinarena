// kanban #1489 refute #1625 skeptic 2 (role: the app/launcher side, not the seat). #1625 framed the node's tree hash
// (arena-node/src/core-hash.js, re-exported as arena-sdk/core-hash) but Next Block's tools/hash-core.js - which the seats'
// apps tree runs for truck-cores.js's frozen-core guard, the manifest/known-games hash and archive-replay-cores - still hashes
// `rel \0 bytes \0` unframed. A one-file tree carrying "\0b.js\0" passes the app's guard under the honest two-file hash, and an
// honest core holding a NUL gets a manifest hash from the app that the node's sandbox refuses: the app and node no longer
// keep one rule (sdk.test.js says hash-core "now takes arena-sdk/core-hash"; it does not).
// Safe behaviour: the app's hasher answers what the node's does, on every tree.
// Fixed (kanban #2311): the app at its apps.lock pin (b9c9aa35) takes coreTreeHashHex from arena-sdk/core-hash, and its
// archive-replay-cores.mjs frames a NUL tree the same way (app commit 2e90ef2); the stale placed copy in the live apps tree fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreTreeHashHex } from '../src/core-hash.js';
import { coreHashHex } from '../../nextblock/tools/hash-core.js';

const tree = (files) => { const d = mkdtempSync(join(tmpdir(), 'a44r26s2-')); for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v); return d; };

test("Next Block's hash-core.js hashes a NUL tree by the node's rule", () => {
  const forged = tree({ 'a.js': 'export const A = 1;\0b.js\0export const B = 2;' });
  assert.equal(coreHashHex(forged), coreTreeHashHex(forged), 'the app names a hash the node refuses for the same files');
});

test("the app's frozen-core guard tells a one-file NUL forgery from the honest two-file core", () => {
  const honest = tree({ 'a.js': 'export const A = 1;', 'b.js': 'export const B = 2;' });
  const forged = tree({ 'a.js': 'export const A = 1;\0b.js\0export const B = 2;' });
  assert.notEqual(coreHashHex(forged), coreHashHex(honest), 'the forged tree passes the app guard under the honest hash');
});
