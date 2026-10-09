// A GHOST SENT TO A NODE IS TOLD WHAT IT IS, not what it is not.
//
// 0.10: "Ghost snapshots are never inputs to this calculation."
//
// Measured before this: the play socket read the first byte, sent checkpoints
// and receipts to their handlers, and passed EVERYTHING ELSE to `round.batch`.
// A ghost was refused there, because `decodeInputBatch` checks its own type
// byte - so the door's answer was "error not an input batch". That is the
// decoder noticing, not the door deciding, and it says what the frame is not.
// The frame is a picture, and a rule that only knows what a frame is not will
// pass the next non-input the moment somebody adds one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeGhost } from '../../arena-protocol/src/ghost.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };

const talk = (port) => new Promise((resolve) => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/play`);
  sock.binaryType = 'arraybuffer';
  const said = [];
  sock.addEventListener('message', (e) => {
    const v = said.shift();
    if (v) v(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  });
  sock.addEventListener('open', () => resolve({
    say: (m) => new Promise((r) => { said.push(r); sock.send(m); }),
    shut: () => sock.close(),
  }));
});

test('a ghost offered to the play socket is refused as a picture, by name', async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  try {
    const play = await talk(node.port);
    const said = await play.say(encodeGhost({
      roundId: b32(1), entryId: b32(2), playerPubkey: b32(7), tick: 4,
      inputChainHash: b32(3), x: 1, z: 2, heading: 3,
    }));

    assert.equal(typeof said, 'string');
    assert.equal(said, 'error a Ghost is a picture and carries no authority, '
      + 'so it cannot be an input');
    assert.equal(/not an input batch/.test(said), false,
      'the door still answers with what the frame is not');

    // AND A BYTE THIS PROTOCOL DOES NOT USE IS NOT ASSUMED TO BE AN INPUT
    // either: it is refused by number rather than handed to the batch reader.
    const strange = await play.say(new Uint8Array([0x7f, 0, 1, 2]));
    assert.match(strange, /no frame of this protocol begins with 0x7f/);

    // an InputBatch still reaches the handler - the door decides by type, it
    // does not simply refuse everything that is not a mark
    const batch = await play.say(encodeInputBatch({
      roundId: b32(1), entryId: b32(2), previousHash: GENESIS, firstTick: 0,
      ticks: [[65536, 0, 0, 0, 0]], liquidations: [],
    }));
    assert.match(batch, /no such round/, 'the batch was not read as a batch');

    play.shut();
  } finally { await node.close(); }
});
