// kanban #1489 a45 refute-2-s2 failure 2 (#2236, honest path on the resume path): a LATE settlement's winnings sender (settlement.js
// lateWinningsFor) is rebuilt from the round's sender field by field and leaves out the new `localHosts`. So the operator's own local LNURL host
// (ARENA_LNURL_LOCAL_HOSTS, serve lnurlLocalHosts) that the round's sender asks is refused for the same winner once the entry settles late.
// Safe: the late sender asks the operator's local host exactly as the round's sender does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WinningsSend } from '../src/winnings-send.js';
import { LockSettlement } from '../src/settlement.js';

const payRequest = () => new Response(JSON.stringify({ tag: 'payRequest', callback: 'https://127.0.0.1:4433/cb', metadata: '[]', minSendable: 1, maxSendable: 1e12 }));

test('#1489 a45-refute-2-s2: a late settlement\'s sender keeps the operator\'s local LNURL hosts', async () => {
  const fetched = [];
  const lnurlFetch = async (u) => { fetched.push(String(u)); return payRequest(); };
  const ws = new WinningsSend({ round: {}, port: null, lnurlFetch, localHosts: ['127.0.0.1:4433'] });
  const own = await ws.payRequest('winner@127.0.0.1:4433', 1000n);
  const late = LockSettlement.prototype.lateWinningsFor.call({ winnings: ws, round: { lateSendScope: () => ({}) } }, new Uint8Array(32), new Uint8Array(32).fill(1));
  const lateSaid = await late.payRequest('winner@127.0.0.1:4433', 1000n);
  console.log('  MEASURED:', JSON.stringify({ own: own.ok, late: lateSaid.ok, lateWhy: lateSaid.why, lateHosts: late.localHosts, fetched }));
  assert.equal(own.ok, true, 'the round\'s sender asks the operator host');
  assert.deepEqual(late.localHosts, ws.localHosts, 'the late sender keeps the operator\'s local hosts');
  assert.equal(lateSaid.ok, true, 'the late sender asks it too');
});
