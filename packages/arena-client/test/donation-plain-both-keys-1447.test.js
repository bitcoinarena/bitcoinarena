// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1447: a donation set served WITHOUT approvals (the plain path) stands on the page only if the authority key could make it alone -
// the network's first serial or a pinned set (authority.js DONATION_SETS_AUTHORITY_ALONE); any other serial needs its recipients' approvals
// (#1337 both keys) and is refused. Run against the BUILT page bundle (bundle-shim-1447.mjs: src/arena-ui/arena-client.js, or BUNDLE=<path>).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { fetchDonationSet } from './bundle-shim-1447.mjs';
import { encodeDonationSetBody, decodeDonationSetBody, donationSetBodyId } from '../../arena-protocol/src/authority.js';
import { donationSetId, encodeDonationSet } from '../../arena-protocol/src/donation.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { NEXTBLOCK_GAME_ID, NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const authSk = ed25519.utils.randomSecretKey();
const keys = { authority: ed25519.getPublicKey(authSk), recovery: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
const verifyEd25519 = (s, m, k) => ed25519.verify(s, m, k);
const nodes = ['http://127.0.0.1:1', 'http://127.0.0.1:2'];
const signed = (body) => { const s = { ...body }; s.signature = ed25519.sign(donationSetBodyId(s), authSk); return s; };
const serving = (set) => async (url) => {
  const u = new URL(url);
  if (u.pathname === '/donation-rotations') return new Response(JSON.stringify({ rotations: [] }), { status: 200 });
  if (u.pathname === '/game-donation-set') return new Response(encodeDonationSet(NEXTBLOCK.donationSet), { status: 200 });
  return new Response(new Uint8Array([...encodeDonationSetBody(set), ...set.signature]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
};
const ask = (set, plainPins, censusHeight = 1000) => fetchDonationSet({ round: { networkId: set.networkId, donationSetId: donationSetId(set.recipients), censusHeight, gameId: NEXTBLOCK_GAME_ID, id: new Uint8Array(32).fill(9) },
  nodes, verifyEd25519, keys, fetcher: serving(set), ...(plainPins ? { plainPins } : {}) });
const NET = new Uint8Array(32).fill(5), netHex = toHex(NET);
const rec = (n) => [{ recipientPk: new Uint8Array(33).fill(2).map((x, i) => (i === 0 ? 2 : (n * 7 + i) % 251)), shareBps: 10000, label: 'dev ' + n }];

test('#1447 plain path on a pinned network: the first serial and a pinned authority-alone set stand, a later serial without approvals does not', async () => {
  const s1 = signed({ networkId: NET, serial: 1n, validFrom: 10, recipients: rec(1) });
  const s3 = signed({ networkId: NET, serial: 3n, validFrom: 20, recipients: rec(3) });
  const s4 = signed({ networkId: NET, serial: 4n, validFrom: 30, recipients: rec(4) });
  const pins = { first: { [netHex]: 1n }, alone: { [netHex]: [toHex(donationSetBodyId(s3))] } };
  const [a, b, c] = [await ask(s1, pins), await ask(s3, pins), await ask(s4, pins)];
  const open = await ask(s4, { first: {}, alone: {} });
  console.log('  MEASURED #1447 plain path:', JSON.stringify({ first: a.ok, pinned: b.ok, serial4: [c.ok, c.why], unpinnedNetwork: open.ok }));
  assert.equal(a.ok, true, a.why); assert.equal(b.ok, true, b.why);
  assert.equal(c.ok, false); assert.match(c.why, /without its recipients' approvals.*authority key alone moves nothing/);
  assert.equal(open.ok, true, 'a network with no pinned first serial is judged as before');
});

test('#1447 the real testnet4 pin: the live key set (serial 3, a23bf8a3) stands plainly; a serial-4 change served plainly is refused', async () => {
  const live = decodeDonationSetBody(fromHex('1400011060078b1d4458b32c47aa68279f2260ad8e731ae365ce3f22260dbdc92d7a15000000000000000300025d5000591b0001000202baf4f243bce44aaab1a7ce12be3166b7e1587915e5cb9c102aa95c4f9f5ad0e41a0b0005646576206102ed57f5412a004bfc98b406ee6067efc2569eacfd6e6562ecd18a095f57b84c9d0d0500056465762062f27cb43fa908dc0ea2572f1d5e0cc8c32037a898521c0deaa61696cce3952659c706a3d2bc30697254218a052a507a95ce0a94773f4a79e62f24c5c032128107').slice(0, -64));
  assert.equal(toHex(live.networkId), toHex(NETWORK_ID_TESTNET4));
  const s3 = signed(live), s4 = signed({ ...live, serial: 4n, validFrom: live.validFrom + 1 });
  const h = live.validFrom + 100;   // the round's census height past both sets' validFrom
  const [ok3, no4] = [await ask(s3, null, h), await ask(s4, null, h)];
  console.log('  MEASURED #1447 testnet4 pin:', JSON.stringify({ serial3: ok3.ok, serial4: [no4.ok, no4.why] }));
  assert.equal(ok3.ok, true, ok3.why);
  assert.equal(no4.ok, false); assert.match(no4.why, /authority key alone moves nothing/);
});
