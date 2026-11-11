// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1391 (measured on live page979, 2026-11-11): a page waiting for a round's claim key asked all 14 seats every second, and the 8 seats
// outside the round's committee answered 409 "this node is not assigned to that round" 78 times each in 5 minutes. A URL whose kept identity
// is a node the round did not draw is not asked; a URL with no kept identity is still asked, so no signer node is ever left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attestedClaimKey, identityAt, forgetIdentities } from '../src/join.js';

const key = (b) => Uint8Array.from({ length: 32 }, () => b);
const hex = (u) => Buffer.from(u).toString('hex');

test('the claim key is asked only of URLs that are the round\'s signer nodes, or whose identity is not known (#1391)', async () => {
  forgetIdentities();
  const ids = { 'https://a': key(1), 'https://b': key(2), 'https://c': key(3) };   // c is a seat the round did not draw
  const asked = [];
  const fetcher = async (url) => {
    const u = String(url);
    const base = Object.keys(ids).find((b) => u.startsWith(b + '/identity'));
    if (base) return new Response(ids[base], { status: 200 });
    if (u.includes('/claim-key')) asked.push(u.split('/claim-key')[0]);
    return new Response('this node is not assigned to that round', { status: 409 });
  };
  for (const b of Object.keys(ids)) await identityAt(fetcher, b);
  const got = await attestedClaimKey({ round: { id: key(9), settlementSlots: 2 }, signerNodes: [key(1), key(2)],
    nodes: ['https://a', 'https://b', 'https://c', 'https://d'], curve: { verify: () => false }, fetcher, timeoutMs: 2000 });
  assert.equal(got.ok, false);
  assert.deepEqual(asked.sort(), ['https://a', 'https://b', 'https://d'], 'c is not asked; d, whose identity is not kept, is');
  assert.ok(!got.refused.some((w) => w.startsWith('https://c')));
  forgetIdentities();
});

test('with no kept identities every URL is asked once, and who each is is read beside it, so the next ask leaves out the seats not drawn (#1391)', async () => {
  forgetIdentities();
  const ids = { 'https://a': key(1), 'https://b': key(2), 'https://c': key(3) };
  let asked = [];
  const fetcher = async (url) => {
    const u = String(url);
    const base = Object.keys(ids).find((x) => u.startsWith(x + '/identity'));
    if (base) return new Response(ids[base], { status: 200 });
    if (u.includes('/claim-key')) asked.push(u.split('/claim-key')[0]); return new Response('no', { status: 409 });
  };
  const ask = () => attestedClaimKey({ round: { id: key(9), settlementSlots: 2 }, signerNodes: [key(1), key(2)], nodes: Object.keys(ids),
    curve: { verify: () => false }, fetcher, timeoutMs: 2000 });
  await ask();
  assert.deepEqual([...new Set(asked)].sort(), ['https://a', 'https://b', 'https://c'], 'the first ask goes to every URL: nobody is known yet');
  await new Promise((r) => setTimeout(r, 20));   // the identities, read beside the first ask
  asked = [];
  await ask();
  assert.deepEqual([...new Set(asked)].sort(), ['https://a', 'https://b'], 'the next ask leaves out c, which the round did not draw');
  forgetIdentities();
  void hex;
});
