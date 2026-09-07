// The node's two doors.
//
// HTTP for the things that happen once - open a round, read it, take an entry
// - and a WebSocket for the thing that happens all round: input batches, and
// the close that ends them. That split is not decoration: a batch arrives
// sixty times a second and a round opens once, and putting both through the
// same door would mean a handshake per tick.
//
// Bodies are the protocol's own bytes, not JSON of them. The contract that
// crosses the wire is the contract that is hashed, so a node cannot
// accidentally store something that encodes differently from what it was
// given. `application/octet-stream` throughout.
//
// One process, one player, no verification. There is no bond here, no quota
// and no committee; those are M2.1 steps 4 and later, and each is refused
// rather than half-built.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { decodeRoundContract, decodeEntryContract } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';
import { TYPE_CHECKPOINT } from '../../protocol/src/constants.js';
import { MAX_INPUT_BATCH_BYTES } from '../../protocol/src/batch.js';
import { SIGNED_CHECKPOINT_BYTES } from '../../protocol/src/checkpoint.js';
import { TYPE_CHECKPOINT_RECEIPT } from '../../protocol/src/constants.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';

/**
 * The largest frame this socket will accept, and it is derived rather than
 * chosen: it is the longest message the protocol can encode at all. A batch's
 * tick and liquidation vectors carry u16 lengths, so 1835087 bytes is the
 * ceiling the encoder itself sets; a signed checkpoint is 231 and a signed
 * receipt 139. Anything longer is not a large protocol message, it is not one.
 *
 * `ws` defaults to 104857600 - a hundred megabytes any stranger could ask the
 * daemon to allocate before a single byte was parsed. This is fifty-seven
 * times smaller and needs no policy number to justify.
 *
 * It is NOT tight. An honest client at the spec's 10 Hz sends six ticks, 227
 * bytes; a whole 9000-tick round is 180107. Tightening it further means
 * naming a maximum ticks per batch, which is a protocol-visible limit and a
 * decision rather than a measurement, so it is not made here.
 */
export const MAX_FRAME_BYTES = Math.max(
  MAX_INPUT_BATCH_BYTES, SIGNED_CHECKPOINT_BYTES, SIGNED_RECEIPT_BYTES);
import { Round } from './round.js';

const read = (req) => new Promise((resolve, reject) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => resolve(new Uint8Array(Buffer.concat(parts))));
  req.on('error', reject);
});

// A BROWSER IS THE CLIENT, and a browser will never be on this origin.
//
// The daemon has no cookies and no session: every write is authorised by a
// signature over a tagged hash, and every read is of things a player already
// holds. There is nothing for an origin check to protect, and without these
// headers a page cannot read a single answer - measured: a round was opened
// and the response was unreadable, so the client's own `join` failed with
// "Failed to fetch" and the round existed with nobody in it.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  // The headers a client actually reads answers out of. Without this a page
  // sees the body and none of the counts.
  'access-control-expose-headers':
    'x-state, x-ticks, x-transcript-hash, x-checkpoints, x-receipts',
};

const bytes = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/octet-stream', ...CORS });
  res.end(Buffer.from(body));
};
const text = (res, code, msg) => {
  res.writeHead(code, { 'content-type': 'text/plain', ...CORS });
  res.end(msg + '\n');
};

export function serve(db, { port = 0 } = {}) {
  const round = new Round(db);

  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://node');

      // The preflight a browser sends before a POST it cannot classify as
      // simple. Answered and nothing else: there is no state to change here.
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

      if (req.method === 'POST' && url.pathname === '/round')
        return bytes(res, 201, round.open(decodeRoundContract(await read(req))));

      if (req.method === 'GET' && url.pathname === '/round') {
        const row = round.get(Buffer.from(url.searchParams.get('id') || '', 'hex'));
        if (!row) return text(res, 404, 'no such round');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-state': String(row.state), ...CORS });
        return res.end(Buffer.from(row.contract));
      }

      if (req.method === 'POST' && url.pathname === '/entry')
        return bytes(res, 201, round.enter(decodeEntryContract(await read(req))));

      if (req.method === 'GET' && url.pathname === '/transcript') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const t = round.handOver(rid, eid);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-transcript-hash': toHex(t.hash),
          'x-ticks': String(t.ticks),
          ...CORS,
        });
        return res.end(Buffer.from(t.bytes));
      }

      // The checkpoints as they arrived. Fixed-size records back to back, so
      // a reader cuts them apart without a framing rule to agree on first.
      if (req.method === 'GET' && url.pathname === '/checkpoints') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const c = round.checkpoints(rid, eid);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-checkpoints': String(c.count),
          ...CORS,
        });
        return res.end(Buffer.from(c.bytes));
      }

      // THE RECEIPTS, beside the marks and in the same shape.
      //
      // A client can recompute every mark it ever sent - it made them - but it
      // cannot rebuild a signature over one. So the receipts are the only part
      // of its own round it must be able to ASK for, and without this door a
      // client that reconnected had lost them.
      if (req.method === 'GET' && url.pathname === '/receipts') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const r = round.receipts(rid, eid);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-receipts': String(r.count),
          ...CORS,
        });
        return res.end(Buffer.from(r.bytes));
      }

      return text(res, 404, 'no such door');
    } catch (e) {
      // The message is the reason - "the round is closed", "no such entry" -
      // because a node that answers "400" to everything makes a client guess.
      return text(res, 400, e.message);
    }
  });

  // Batches in, and one word back: how many ticks were new. A repeat answers
  // `0` rather than an error, because re-sending is the right thing for a
  // client that never learned whether the first one landed.
  const wss = new WebSocketServer({
    server: http,
    path: '/play',
    maxPayload: MAX_FRAME_BYTES,
  });
  wss.on('connection', (sock) => {
    // A FRAME OVER THE CAP IS AN ERROR EVENT, not a message, and an
    // unhandled one takes the process down - measured: sending
    // MAX_FRAME_BYTES + 1 threw `RangeError: Max payload size exceeded` out
    // of the receiver with nothing listening. `ws` has already closed the
    // connection with 1009 by then; what this adds is that the daemon
    // survives it and says which connection it was.
    sock.on('error', (e) => {
      console.error(`[play] connection dropped: ${e.message}`);
      if (sock.readyState === sock.OPEN) sock.close(1009, 'frame too large');
    });

    sock.on('message', (data, isBinary) => {
      try {
        if (!isBinary) {
          const t = data.toString();
          if (t.startsWith('close ')) {
            const id = Buffer.from(t.slice(6).trim(), 'hex');
            return sock.send(round.close(id) ? 'closed' : 'already closed');
          }
          return sock.send('error unknown text message');
        }
        // ONE SOCKET, TWO KINDS. The first byte is the protocol's type, so
        // the message says what it is and the client needs no second
        // connection and no envelope around it.
        const bytes = new Uint8Array(data);
        if (bytes[0] === TYPE_CHECKPOINT) return sock.send(round.checkpoint(bytes));
        // A RECEIPT COMING IN is a peer offering one it issued - section 10's
        // gossip. The first byte says so, the same way it says a mark is a
        // mark, so gossip needs no second port and no envelope.
        if (bytes[0] === TYPE_CHECKPOINT_RECEIPT) return sock.send(round.takeReceipt(bytes));
        sock.send(String(round.batch(bytes)));
      } catch (e) {
        sock.send('error ' + e.message);
      }
    });
  });

  return new Promise((resolve) => {
    http.listen(port, '127.0.0.1', () => resolve({
      http, wss, round,
      port: http.address().port,
      // Closed so it actually closes. `http.close` waits for open connections
      // to end, and a play socket does not end on its own - a harness that
      // took the node away hung instead, and the page kept publishing to a
      // server that was supposed to be gone.
      close: () => new Promise((r) => {
        for (const sock of wss.clients) sock.terminate();
        wss.close();
        http.closeAllConnections();
        http.close(r);
      }),
    }));
  });
}
