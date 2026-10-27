// The auditors' VRF (spec §13A.1, kanban #725): RFC 9381's own vectors for ECVRF-P256-SHA256-TAI (appendix B.1,
// examples 10-12) reproduced byte for byte, then the same construction on secp256k1: a proof verifies under its key and
// input only, and one key has one output per input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVrf, SUITE_P256_TAI, SUITE_SECP256K1_TAI } from '../src/vrf.js';

const hex = (s) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'));
const toHex = (b) => Buffer.from(b).toString('hex');

const VECTORS = [
  { sk: 'c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721', pk: '0360fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6',
    alpha: '73616d706c65', h: '0272a877532e9ac193aff4401234266f59900a4a9e3fc3cfc6a4b7e467a15d06d4',
    pi: '035b5c726e8c0e2c488a107c600578ee75cb702343c153cb1eb8dec77f4b5071b4a53f0a46f018bc2c56e58d383f2305e0975972c26feea0eb122fe7893c15af376b33edf7de17c6ea056d4d82de6bc02f',
    beta: 'a3ad7b0ef73d8fc6655053ea22f9bede8c743f08bbed3d38821f0e16474b505e' },
  { sk: 'c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721', pk: '0360fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6',
    alpha: '74657374', h: '02173119b4fff5e6f8afed4868a29fe8920f1b54c2cf89cc7b301d0d473de6b974',
    pi: '034dac60aba508ba0c01aa9be80377ebd7562c4a52d74722e0abae7dc3080ddb56c19e067b15a8a8174905b13617804534214f935b94c2287f797e393eb0816969d864f37625b443f30f1a5a33f2b3c854',
    beta: 'a284f94ceec2ff4b3794629da7cbafa49121972671b466cab4ce170aa365f26d' },
  { sk: '2ca1411a41b17b24cc8c3b089cfd033f1920202a6c0de8abb97df1498d50d2c8', pk: '03596375e6ce57e0f20294fc46bdfcfd19a39f8161b58695b3ec5b3d16427c274d',
    alpha: '4578616d706c65207573696e67204543445341206b65792066726f6d20417070656e646978204c2e342e32206f6620414e53492e58392d36322d32303035',
    h: '0258055c26c4b01d01c00fb57567955f7d39cd6f6e85fd37c58f696cc6b7aa761d',
    pi: '03d03398bf53aa23831d7d1b2937e005fb0062cbefa06796579f2a1fc7e7b8c667d091c00b0f5c3619d10ecea44363b5a599cadc5b2957e223fec62e81f7b4825fc799a771a3d7334b9186bdbee87316b1',
    beta: '90871e06da5caa39a3c61578ebb844de8635e27ac0b13e829997d0d95dd98c19' },
];

test('RFC 9381 B.1: ECVRF-P256-SHA256-TAI examples 10, 11 and 12, byte for byte', async () => {
  const { p256 } = await import('@noble/curves/nist.js');
  const vrf = makeVrf({ Point: p256.Point, suite: SUITE_P256_TAI });
  for (const v of VECTORS) {
    assert.equal(toHex(vrf.encodeToCurve(hex(v.pk), hex(v.alpha)).toBytes(true)), v.h, 'H');
    const pi = vrf.prove(hex(v.sk), hex(v.alpha));
    assert.equal(toHex(pi), v.pi, 'pi');
    assert.equal(toHex(vrf.proofToHash(pi)), v.beta, 'beta');
    assert.equal(toHex(vrf.verify(hex(v.pk), hex(v.alpha), pi)), v.beta, 'verifies');
  }
});

test('secp256k1: a proof verifies under its own key and input only; one output per key and input', async () => {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const vrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
  const sk = hex('11'.repeat(32)), other = hex('22'.repeat(32));
  const pk = secp256k1.Point.BASE.multiply(BigInt('0x' + '11'.repeat(32))).toBytes(true);
  const pkOther = secp256k1.Point.BASE.multiply(BigInt('0x' + '22'.repeat(32))).toBytes(true);
  const alpha = hex('ab'.repeat(32));
  const pi = vrf.prove(sk, alpha);
  assert.equal(pi.length, 81);
  const beta = vrf.verify(pk, alpha, pi);
  assert.ok(beta && beta.length === 32);
  assert.deepEqual(vrf.prove(sk, alpha), pi, 'deterministic: the same proof again, so no second draw');
  assert.equal(vrf.verify(pkOther, alpha, pi), null, 'another key');
  assert.equal(vrf.verify(pk, hex('cd'.repeat(32)), pi), null, 'another input');
  const bent = Uint8Array.from(pi); bent[40] ^= 1;
  assert.equal(vrf.verify(pk, alpha, bent), null, 'a changed proof');
  assert.equal(vrf.verify(pk, alpha, pi.subarray(0, 80)), null, 'a short proof');
  assert.notDeepEqual(vrf.verify(pkOther, alpha, vrf.prove(other, alpha)), beta, 'another key, another output');
});
