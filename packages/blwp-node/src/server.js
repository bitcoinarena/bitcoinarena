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
import { Round } from './round.js';

const read = (req) => new Promise((resolve, reject) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => resolve(new Uint8Array(Buffer.concat(parts))));
  req.on('error', reject);
});

const bytes = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/octet-stream' });
  res.end(Buffer.from(body));
};
const text = (res, code, msg) => {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(msg + '\n');
};

export function serve(db, { port = 0 } = {}) {
  const round = new Round(db);

  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://node');
      if (req.method === 'POST' && url.pathname === '/round')
        return bytes(res, 201, round.open(decodeRoundContract(await read(req))));

      if (req.method === 'GET' && url.pathname === '/round') {
        const row = round.get(Buffer.from(url.searchParams.get('id') || '', 'hex'));
        if (!row) return text(res, 404, 'no such round');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-state': String(row.state) });
        return res.end(Buffer.from(row.contract));
      }

      if (req.method === 'POST' && url.pathname === '/entry')
        return bytes(res, 201, round.enter(decodeEntryContract(await read(req))));

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
  const wss = new WebSocketServer({ server: http, path: '/play' });
  wss.on('connection', (sock) => {
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
        sock.send(String(round.batch(new Uint8Array(data))));
      } catch (e) {
        sock.send('error ' + e.message);
      }
    });
  });

  return new Promise((resolve) => {
    http.listen(port, '127.0.0.1', () => resolve({
      http, wss, round,
      port: http.address().port,
      close: () => new Promise((r) => { wss.close(); http.close(r); }),
    }));
  });
}
