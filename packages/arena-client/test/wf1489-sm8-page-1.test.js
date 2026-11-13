// kanban #1489 sm8-page-1: A SOCKET THAT connectFirst GAVE UP ON STILL OPENS LATER AND TAKES THE CLIENT'S PLACE.
// SM-T4 (the play socket): connectFirst races each connect() against `attemptMs` and, on the timeout, closes only `this.sock` -
// which is still the old socket or null, because a socket that has not opened yet is not `this.sock`. The timed-out socket is
// left connecting. When it opens late (a seat whose upgrade took longer than the attempt, as on a loaded host) its 'open'
// handler sets `this.sock = sock` - AFTER the next attempt's socket has opened and connectFirst has already answered with it.
// From then on sends go out on the late socket while answers to what was sent on the first still come back on the other one,
// and both feed the one `said` FIFO: an answer is handed to the wrong request.
// Invariant: after connectFirst answers, the client's socket is the one it answered with, and every send is answered with its
// own reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Client } from '../src/client.js';

function slowFirst(holdMs) {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  const conns = [];
  http.on('upgrade', (req, sock, head) => {
    const n = ++upgrades;
    const take = () => wss.handleUpgrade(req, sock, head, (ws) => {
      conns.push(ws);
      // the first connection answers at once; the second answers each message after 1 s (a busy seat)
      ws.on('message', (m) => { const reply = () => ws.send(`echo ${String(m)}`); if (n === 1) reply(); else setTimeout(reply, 1000); });
    });
    if (n === 1) setTimeout(take, holdMs); else take();
  });
  return new Promise((r) => http.listen(0, '127.0.0.1', () => r({ port: http.address().port, upgrades: () => upgrades, conns,
    close: () => { for (const c of wss.clients) c.terminate(); return new Promise((d) => http.close(d)); } })));
}

test('a timed-out first socket that opens after the second does not replace it, and answers stay with their sends', async () => {
  const s = await slowFirst(400);
  try {
    const c = new Client({ base: `http://127.0.0.1:${s.port}`, core: {}, sign: () => null, verify: () => true });
    c.sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50)));
    await c.connectFirst({ untilMs: Date.now() + 30000, attemptMs: 150 });
    const answered = c.sock;
    const first = c.send('m1');                                   // on the socket connectFirst answered with
    await new Promise((r) => setTimeout(r, 450));                 // the timed-out socket's upgrade completes now
    const swapped = c.sock !== answered;
    const second = c.send('m2');
    const [a1, a2] = await Promise.all([first, second]);
    console.log('  FACTS:', JSON.stringify({ tries: c.firstTries, upgrades: s.upgrades(), serverConns: s.conns.length, swapped, a1, a2 }));
    c.ended = true;
    try { answered.close(); } catch { /* gone */ }
    try { c.sock && c.sock.close(); } catch { /* gone */ }
    assert.equal(swapped, false, 'a socket connectFirst gave up on took the place of the one it answered with');
    assert.equal(a1, 'echo m1', 'the first send got another send\'s answer');
    assert.equal(a2, 'echo m2', 'the second send got another send\'s answer');
  } finally { await s.close(); }
});
