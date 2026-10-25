// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BLWP/v1 -> ARENA/v1 SWITCH (kanban #525, protocol 18): with no point named nothing changes - every ticket and id is the bytes
// a protocol-17 seat computes; with a point (height H, its block's time T) the tags move exactly there, a signature dated before it is
// accepted under both, and from it only under the new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { tagAt, tagsAccepted, TAG_PAIRS, TAG_SWITCH, setTagSwitchForTests, setTagNetwork, tagSwitch } from '../src/tag-switch.js';
import { taggedHash, toHex, bytesToBigInt, fromHex } from '../src/hash.js';
import { Writer } from '../src/encode.js';
import { dutyTicket } from '../src/duty.js';
import { guardianTicket } from '../src/guardian-founding.js';
import { gatewayTicket } from '../src/gateway-seats.js';
import { signGatewayClaim, checkGatewayClaim, gatewayClaimHash } from '../src/gateway-claim.js';
import { signGatewaySeating, standingSeating } from '../src/gateway-seating.js';
import { liquidityTicket, signLiquidityClaim, checkLiquidityClaim, liquidityClaimHash, fundsMessage, signedMessageDigest, provenFreeSats } from '../src/liquidity.js';
import { signLiquiditySeating, standingLiquiditySeating } from '../src/liquidity-seating.js';
import { addressScript, HRP_OF } from '../src/address.js';
import { bech32Encode, convertBits } from '../src/bech32.js';
import { messageCurve } from '../../arena-node/src/curve.js';
import { foundingId, setupDigest } from '../../arena-node/src/founding.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const H = 160000, T = 1_800_000_000_000;
const POINT = { height: H, timeMs: T };
const key = (n) => { const secret = b32(0x40 + n); return { secret, node: toHex(schnorr.getPublicKey(secret)), sign: (m) => schnorr.sign(m, secret) }; };
const old = (name) => TAG_PAIRS[name][0], neu = (name) => TAG_PAIRS[name][1];
// the point a test asks for, and the one before it back afterwards (an async body restores once it has run)
const withPoint = (sw, fn) => { const was = setTagSwitchForTests(sw); let r; try { r = fn(); } catch (e) { setTagSwitchForTests(was); throw e; }
  if (r && typeof r.then === 'function') return r.finally(() => setTagSwitchForTests(was));
  setTagSwitchForTests(was); return r; };

test('the point: before it the old tag, from it the new one; heights, epochs and times each compare with theirs', () => {
  assert.equal(tagAt('duty', { height: H - 1 }, POINT), old('duty'));
  assert.equal(tagAt('duty', { height: H }, POINT), neu('duty'));
  assert.equal(tagAt('gatewaySeating', { epoch: Math.floor(H / 144) }, POINT), old('gatewaySeating'), 'an epoch that starts before H');
  assert.equal(tagAt('gatewaySeating', { epoch: Math.ceil(H / 144) }, POINT), neu('gatewaySeating'), 'the first epoch that starts at or after H');
  assert.equal(tagAt('liquidityClaim', { ms: T - 1 }, POINT), old('liquidityClaim'));
  assert.equal(tagAt('liquidityClaim', { ms: T }, POINT), neu('liquidityClaim'));
  assert.deepEqual(tagsAccepted('gatewayClaim', { ms: T - 1 }, POINT), [old('gatewayClaim'), neu('gatewayClaim')], 'both during the switch');
  assert.deepEqual(tagsAccepted('gatewayClaim', { ms: T }, POINT), [neu('gatewayClaim')], 'the new one only from the point');
  assert.deepEqual(tagsAccepted('gatewayClaim', { ms: T }, null), [old('gatewayClaim')], 'no point named: the old one only');
  assert.equal(tagAt('duty', undefined, POINT), old('duty'), 'nothing to compare: the old tag');
  assert.equal(Object.keys(TAG_PAIRS).length, 11);
  for (const [o, n] of Object.values(TAG_PAIRS)) { assert.match(o, /^BLWP\/v1\//); assert.equal(n, o.replace('BLWP/', 'ARENA/')); }
});

test('mainnet and regtest name no point; testnet4 names H 157,064 and T 2026-10-20 01:00Z', () => {
  for (const net of ['mainnet', 'regtest']) { assert.equal(TAG_SWITCH[net], null, net); setTagNetwork(net); assert.equal(tagSwitch(), null); }
  // testnet4's point (2026-10-19 ~20:45Z): H 157,064, T 2026-10-20 01:00:00Z
  setTagNetwork('testnet4');
  assert.deepEqual(tagSwitch(), { height: 157064, timeMs: Date.parse('2026-10-20T01:00:00Z') });
  assert.equal(tagAt('duty', { height: 157063 }), 'BLWP/v1/DUTY');
  assert.equal(tagAt('duty', { height: 157064 }), 'ARENA/v1/DUTY');
  assert.equal(tagAt('liquidityClaim', { ms: Date.parse('2026-10-20T00:59:59.999Z') }), 'BLWP/v1/LIQUIDITY_CLAIM');
  assert.equal(tagAt('liquidityClaim', { ms: Date.parse('2026-10-20T01:00:00Z') }), 'ARENA/v1/LIQUIDITY_CLAIM');
  assert.equal(tagAt('gatewaySeating', { epoch: 1090 }), 'BLWP/v1/GATEWAY_SEATING', 'epoch 1090 starts at 156,960');
  assert.equal(tagAt('gatewaySeating', { epoch: 1091 }), 'ARENA/v1/GATEWAY_SEATING', 'epoch 1091 starts at 157,104');
  setTagNetwork('testnet4');
  assert.throws(() => setTagNetwork('signet'), /no tag switch for network signet/);
});

test('with no point, every ticket and id is the bytes a protocol-17 seat computes', () => withPoint(null, () => {
  const w = (parts) => { const x = new Writer(); parts(x); return x.finish(); };
  const ticket = (tag, parts) => bytesToBigInt(taggedHash(tag, w(parts)));
  assert.equal(dutyTicket(b32(1), 500000, b32(2)), ticket('BLWP/v1/DUTY', (x) => { x.bytes32(b32(1)); x.u32(500000); x.bytes32(b32(2)); }));
  const entry = { txid: b32(3), vout: 1 };
  assert.equal(guardianTicket(b32(4), entry, H + 10), ticket('BLWP/v1/GUARDIAN', (x) => { x.bytes32(b32(4)); x.bytes32(entry.txid); x.u32(1); }));
  assert.equal(gatewayTicket(b32(5), b32(6), 2000), ticket('BLWP/v1/GATEWAY', (x) => { x.bytes32(b32(5)); x.bytes32(b32(6)); }));
  assert.equal(liquidityTicket(toHex(b32(7)), toHex(b32(8)), T + 1), ticket('BLWP/v1/LIQUIDITY', (x) => { x.bytes32(b32(7)); x.bytes32(b32(8)); }));
  assert.equal(toHex(foundingId(b32(9), H + 5)), toHex(taggedHash('BLWP/v1/FOUNDING', w((x) => { x.bytes32(b32(9)); x.u32(H + 5); }))));
}));

test('with a point, each ticket and id moves exactly there - and every node computes the same', () => withPoint(POINT, () => {
  const slotAt = Math.ceil(T / 3_600_000);
  const before = dutyTicket(b32(1), slotAt - 1, b32(2)), after = dutyTicket(b32(1), slotAt, b32(2));
  assert.equal(before, withPoint(null, () => dutyTicket(b32(1), slotAt - 1, b32(2))), 'the slot before T keeps the old rank');
  assert.notEqual(after, withPoint(null, () => dutyTicket(b32(1), slotAt, b32(2))), 'the slot from T ranks under ARENA/v1/DUTY');
  assert.equal(after, bytesToBigInt(taggedHash('ARENA/v1/DUTY', (() => { const x = new Writer(); x.bytes32(b32(1)); x.u32(slotAt); x.bytes32(b32(2)); return x.finish(); })())));
  const entry = { txid: b32(3), vout: 1 };
  assert.equal(guardianTicket(b32(4), entry, H - 1), withPoint(null, () => guardianTicket(b32(4), entry, H - 1)));
  assert.notEqual(guardianTicket(b32(4), entry, H), withPoint(null, () => guardianTicket(b32(4), entry, H)));
  const e0 = Math.ceil(H / 144);
  assert.notEqual(gatewayTicket(b32(5), b32(6), e0), gatewayTicket(b32(5), b32(6), e0 - 1));
  assert.notEqual(liquidityTicket(toHex(b32(7)), toHex(b32(8)), T), liquidityTicket(toHex(b32(7)), toHex(b32(8)), T - 1));
  assert.notEqual(toHex(foundingId(b32(9), H)), toHex(foundingId(b32(9), H - 1)) );
}));

test('claims: dated before the point both tags stand, from it only the new; a seat with no point takes the old only', () => withPoint(POINT, () => {
  const P = key(1);
  const gw = (atMs) => ({ node: P.node, federationId: toHex(b32(2)), gatewayUrl: 'https://gw.example/', lightningPubkey: '02' + '11'.repeat(32), lightningAddr: '',
    capacitySats: '1', pegInSats: '1', atMs: String(atMs), inboundSats: '1', outboundSats: '1', outsideInboundSats: '0' });
  const signedUnder = (c, tag, hashOf) => ({ ...c, signature: toHex(P.sign(hashOf(c, tag))) });
  for (const [kind, check, hashOf, body] of [['gatewayClaim', checkGatewayClaim, gatewayClaimHash, gw],
    ['liquidityClaim', checkLiquidityClaim, liquidityClaimHash, (atMs) => ({ node: P.node, lightningPubkey: '02' + '22'.repeat(32), lightningAddr: '', freeSats: '1', atMs: String(atMs), depositAddress: '', channels: [], funds: [] })]]) {
    const early = body(T - 1), late = body(T);
    assert.equal(check(signedUnder(early, old(kind), hashOf), verify).ok, true, `${kind}: old tag before the point`);
    assert.equal(check(signedUnder(early, neu(kind), hashOf), verify).ok, true, `${kind}: new tag before the point (the switch)`);
    assert.equal(check(signedUnder(late, old(kind), hashOf), verify).ok, false, `${kind}: old tag from the point is refused`);
    assert.equal(check(signedUnder(late, neu(kind), hashOf), verify).ok, true, `${kind}: new tag from the point`);
    assert.equal(withPoint(null, () => check(signedUnder(late, neu(kind), hashOf), verify).ok), false, `${kind}: a seat with no point does not take the new tag`);
  }
  // the signer signs under the tag of the claim's own time
  const g = signGatewayClaim(gw(T + 5), P.sign);
  assert.equal(verify(fromHex(g.signature), gatewayClaimHash(g, neu('gatewayClaim')), fromHex(P.node)), true);
  const l = signLiquidityClaim({ node: P.node, lightningPubkey: '02' + '22'.repeat(32), freeSats: '1', atMs: String(T - 5), channels: [] }, P.sign);
  assert.equal(verify(fromHex(l.signature), liquidityClaimHash(l, old('liquidityClaim')), fromHex(P.node)), true);
}));

test('seatings: an epoch that starts before the point is signed and taken under the old tag; from it under the new only', () => withPoint(POINT, () => {
  const G = [key(1), key(2), key(3)], seated = G.map((g) => g.node), fid = toHex(b32(2));
  for (const e of [Math.floor(H / 144), Math.ceil(H / 144)]) {
    const gs = G.map((g) => signGatewaySeating({ federationId: fid, epoch: e, seats: [toHex(b32(5))] }, g.node, g.sign));
    assert.equal(standingSeating({ signed: gs, federationId: fid, epoch: e, seated, threshold: 2, verify }).ok, true, `gateway seating, epoch ${e}`);
    const ls = G.map((g) => signLiquiditySeating({ federationId: fid, epoch: e, providers: [{ node: toHex(b32(6)), weight: '100000' }] }, g.node, g.sign));
    assert.equal(standingLiquiditySeating({ signed: ls, federationId: fid, epoch: e, seated, threshold: 2, verify }).ok, true, `liquidity seating, epoch ${e}`);
    // a seat with no point named takes the first, refuses the second (its tag is ARENA's)
    const noPoint = withPoint(null, () => standingSeating({ signed: gs, federationId: fid, epoch: e, seated, threshold: 2, verify }).ok);
    assert.equal(noPoint, e * 144 < H, `epoch ${e} at a seat with no point`);
  }
}));

test('coin proofs: the message under the claim time\'s tag; before the point both stand, from it only the new', async () => withPoint(POINT, async () => {
  const P = key(1), secret = b32(0x55), pub = secp256k1.getPublicKey(secret, true);
  const address = bech32Encode('tb', [0, ...convertBits(messageCurve.hash160(pub), 8, 5, true)]);
  const sig = (tag) => { const r = secp256k1.sign(signedMessageDigest(fundsMessage(P.node, 'ab'.repeat(32), 0, tag)), secret, { prehash: false, format: 'recovered' }); return Buffer.from([31 + r[0], ...r.slice(1)]).toString('base64'); };
  const txOut = async () => ({ sats: 5000n, script: toHex(addressScript(address, HRP_OF.testnet4)) });
  const proven = (atMs, tag) => provenFreeSats({ claim: { node: P.node, atMs: String(atMs), funds: [{ txid: 'ab'.repeat(32), vout: 0, address, sats: '5000', signature: sig(tag) }] }, curve: messageCurve, txOut });
  assert.equal(await proven(T - 1, old('liquidityFunds')), 5000n);
  assert.equal(await proven(T - 1, neu('liquidityFunds')), 5000n);
  assert.equal(await proven(T, old('liquidityFunds')), 0n, 'an old proof from the point counts nothing');
  assert.equal(await proven(T, neu('liquidityFunds')), 5000n);
  assert.equal(fundsMessage(P.node, 'ab'.repeat(32), 0), `BLWP/v1/LIQUIDITY_FUNDS:${P.node}:${'ab'.repeat(32)}:0`, 'the default message is the old one, byte for byte');
}));

test('a founding\'s setup code: under the trigger height\'s tag', () => {
  assert.notEqual(toHex(setupDigest(b32(1), b32(2), 'code', old('foundingSetup'))), toHex(setupDigest(b32(1), b32(2), 'code', neu('foundingSetup'))));
  assert.equal(toHex(setupDigest(b32(1), b32(2), 'code')), toHex(setupDigest(b32(1), b32(2), 'code', 'BLWP/v1/FOUNDING_SETUP')), 'the default is the old tag');
});
