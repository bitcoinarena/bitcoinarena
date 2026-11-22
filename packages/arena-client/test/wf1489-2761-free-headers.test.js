// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 r8 client 1: ONE header source extends the real chain with free headers (claimed target 0x207fffff, any hash
// meets it) and agreedChain takes them as the tip. Its chain holds every honest block, so it is not a fork, and its work
// is the honest work plus ~2 per junk header - "most work" with no pow limit. The forged tip is what the page's beacon,
// bond proofs and census are then read from (committee.js chainFor -> committeeFromChain, directory.js reach).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { hash256 } from '../../arena-protocol/src/tx.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { agreedChain } from '../src/headers.js';

const MAINNET = [
  '00000020c61dd21dd5f1c3d2e556d83f74ece599a256f658947434000000000000000000'
  + 'c11119defe5057e0b57a56e02ed4249746085414f4111daeeb7838a079aaf843bf09385a'
  + '45960018151b5421',
  '00000020ecf348128755dbeea5deb8eddf64566d9d4e59bc65d485000000000000000000'
  + '901f0d92a66ee7dcefd02fa282ca63ce85288bab628253da31ef259b24abe8a0470a385a'
  + '45960018e8d672f8',
  '000000201929eb850a74427d0440cf6b518308837566cd6d0662790000000000000000001f'
  + '6231ed3de07345b607ec2a39b2d01bec2fe10dfb7f516ba4958a42691c95316d0a385a45'
  + '9600185599fc5c',
].map(fromHex);

test('one source cannot put free-mined headers on top of the agreed chain', async () => {
  // the attacker's tip: a block whose merkle root (= any fake bond tx) and hash (= the beacon) he chooses, mined in a few tries
  let prev = blockHashOf(MAINNET[2]);
  const forged = [];
  for (let i = 0; i < 3; i++) {
    const { header } = blockOf(hash256, [new Uint8Array(32).fill(0xa0 + i)], { previous: prev, time: 0x5a390000 + i * 600 });
    forged.push(header); prev = blockHashOf(header);
  }
  const honest = async () => MAINNET;
  const liar = async () => [...MAINNET, ...forged];
  honest.tag = 'https://seat-a'; const honest2 = async () => MAINNET; honest2.tag = 'https://seat-b'; liar.tag = 'https://seat-evil';
  const got = await agreedChain([honest, honest2, liar], { anchor: blockHashOf(MAINNET[0]) });
  const answered = got.ok ? got.headers.map((h) => toHex(blockHashOf(h))) : [];
  const fake = forged.map((h) => toHex(blockHashOf(h)));
  assert.ok(!answered.some((h) => fake.includes(h)),
    `the answered chain (from provider ${got.from}, ${answered.length} headers) ends in ${fake.filter((h) => answered.includes(h)).length} free-mined headers of one source; tip ${answered[answered.length - 1]}`);
});
