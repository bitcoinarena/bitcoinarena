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
import { MAX_INPUT_BATCH_BYTES, decodeInputBatch } from '../../protocol/src/batch.js';
import { SIGNED_CHECKPOINT_BYTES } from '../../protocol/src/checkpoint.js';
import { TYPE_CHECKPOINT_RECEIPT } from '../../protocol/src/constants.js';
import { bearsAuthority } from '../../protocol/src/frames.js';
import {
  decodeHandout, encodeHandout, handoutId, acceptHandout,
} from '../../protocol/src/handout.js';
// THE GROUP THE HANDOUT CHECK NEEDS. The protocol package carries no curve on
// purpose, so the daemon brings one - the same secp256k1 it already brings to
// the census, and the same one the bonds and BIP-340 use.
import { feldmanGroup } from './curve.js';
import {
  SIGNED_RECEIPT_BYTES, decodeCheckpointReceipt, splitSignedReceipt,
} from '../../protocol/src/receipt.js';
import { SIGNED_RESULT_BYTES } from '../../protocol/src/result.js';

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
import { CLOSED } from './store.js';
import { Round } from './round.js';
import { Verifier } from './verify.js';
import { Ghosts } from './ghosts.js';
import { Roster } from './roster.js';

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
    'x-state, x-ticks, x-transcript-hash, x-checkpoints, x-receipts, '
    + 'x-marks, x-dropped, x-through-tick, x-equivocations, x-ticks-at, '
    + 'x-foreign-receipts',
};

const bytes = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/octet-stream', ...CORS });
  res.end(Buffer.from(body));
};
const text = (res, code, msg) => {
  res.writeHead(code, { 'content-type': 'text/plain', ...CORS });
  res.end(msg + '\n');
};

/**
 * WHO PAYS FOR THE DISK.
 *
 * `IMPLEMENTATION.md`: "A funded entry is required before the node stores one
 * byte of transcript. Disk is spent only on stakes that exist - the main
 * anti-DoS lever." Measured before this existed: a stranger who had funded
 * nothing opened 200 rounds and the node answered 201 to every one and wrote
 * 200 rows, then took an entry in one of them for nothing as well.
 *
 * The node cannot decide funding by itself. A stake is a hold invoice on
 * Lightning and there is no payment layer here yet, so what this daemon does
 * is REFUSE until something it trusts says otherwise - the operator supplies
 * that, and the default is no. A daemon that assumed funding would be the
 * flood lever rather than the guard against it, and a default of yes is the
 * kind of thing nobody notices until the disk is full.
 *
 * It is deliberately not a message on the wire: inventing a funding message
 * would be inventing the payment protocol, and that is not this step's to
 * write. What is this step's is that nothing is written until the answer is
 * yes.
 */
const hexOf = (b) => Buffer.from(b).toString('hex');

/**
 * HOW FAR BEHIND A SUBSCRIBER MAY BE BEFORE ITS PICTURES ARE DROPPED.
 *
 * A quarter of a megabyte, the same figure the client uses to decide it is too
 * far behind to publish - so both ends of one socket call "behind" the same
 * thing instead of each having a taste of its own.
 */
export const GHOST_BACKLOG_BYTES = 262144;

export const NOTHING_IS_FUNDED = () => false;

export function serve(db, { port = 0, host = '127.0.0.1', funded = NOTHING_IS_FUNDED,
  randomnessFor, chainFor, peers = [], headerBytes, bondProof } = {}) {
  const round = new Round(db);

  // WHO MAY HOLD A ROUND, from the chain. The census stopped being library
  // code here: this is the daemon's only caller of it, and `chainFor` is the
  // blocks - asked for, never invented, the same way the randomness is.
  const roster = new Roster(round, {
    ...(chainFor ? { chainFor } : {}),
    // The same beacon the verifier reads: one source, so a node cannot seat
    // one committee and sign results against another.
    ...(randomnessFor ? { randomnessFor } : {}),
  });

  // WHAT HEARS A ROUND CLOSING. Section 13 replays once the run is over, so
  // the close is the event and this is what listens for it. The world secret
  // is on the entry now, so the seed derives itself; what is still outside is
  // the round's randomness beacon - a future Bitcoin block hash this daemon
  // does not read yet - and a node given none runs the whole path and stops
  // there, with the refusal recorded rather than a world invented.
  // WHAT SHOWS OTHER PLAYERS' TRUCKS. Pictures only: 0.10 says a ghost is
  // never an input to anybody's simulation, and the frames it hands out came
  // out of `replay.js` like everything else that touches the core.
  const ghosts = new Ghosts(round, { ...(randomnessFor ? { randomnessFor } : {}) });

  const verifier = new Verifier(round, {
    ...(randomnessFor ? { randomnessFor } : {}),
    // THE SAME CHAIN THE SEAT WAS CHECKED AGAINST. A node that closes a round
    // on a beacon its own chain does not name computes a different world for
    // every player in it, so the check belongs on both doors.
    ...(chainFor ? { chainFor } : {}),
    // WHERE THE OTHER SEATS ANSWER. A contract names a committee by KEY, and a
    // key is not an address - finding one is discovery's job (25.1), not this
    // letter's - so the operator says where they are and the contract still
    // says whose signatures count.
    peers,
  });

  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://node');

      // The preflight a browser sends before a POST it cannot classify as
      // simple. Answered and nothing else: there is no state to change here.
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

      if (req.method === 'GET' && url.pathname === '/identity') {
        return bytes(res, 200, round.pubkey);
      }

      // THE CHAIN, AS BITCOIN'S OWN BYTES. 80-byte headers back to back, which
      // is what `headersOverHttp` reads and the only shape this protocol has
      // ever spoken to a provider in - no explorer JSON, no height, no tip.
      //
      // A NODE IS NOT A CHAIN PROVIDER AND SAYS SO BY DEFAULT. 25.1 wants
      // headers "from several independent sources", and a node serving the
      // chain that proves its OWN bond is one source wearing two hats - so
      // this door does not exist unless an operator handed this daemon a view
      // to serve, and a daemon that was handed none answers 404 by name rather
      // than an empty body a client would have to interpret. Two daemons are
      // two origins, which is what `agreedChain` counts.
      if (req.method === 'GET' && url.pathname === '/headers') {
        if (!headerBytes)
          return text(res, 404, 'this node was given no chain to serve; a chain comes from providers');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(headerBytes));
      }

      // AND THE BOND PROOF THE ADVERTISEMENT COMMITS TO: the transaction and
      // the merkle branch that puts it in a block of that chain. The client
      // re-derives the root and checks it against the header it agreed on, so
      // what is served here is evidence and not an answer.
      if (req.method === 'GET' && url.pathname === '/bond') {
        if (!bondProof)
          return text(res, 404, 'this node was given no bond proof to serve');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(bondProof));
      }

      if (req.method === 'POST' && url.pathname === '/round') {
        const contract = decodeRoundContract(await read(req));
        // Asked BEFORE anything is decoded into the database, so a refusal
        // costs a parse and nothing else.
        if (!funded({ kind: 'round', contract }))
          return text(res, 402, 'this node stores nothing for a round nobody has funded');
        const id = round.open(contract);

        // AND SEAT IT FROM THE CHAIN, when this node can see one. The seated
        // set is the only committee that counts (26), so a contract naming
        // anybody the census did not seat is refused HERE - the round is
        // stored, and it has no seats, so it issues no receipts and counts no
        // results until somebody seats it honestly.
        //
        // A node with no chain view seats nothing and says nothing: it cannot
        // check the list, so it does not pretend to. What it must not do is
        // fall back to the author's list, and it does not.
        if (chainFor) {
          const seated = roster.seatRound(id);
          if (!seated.ok) return text(res, 409, seated.why);
        }
        return bytes(res, 201, id);
      }

      if (req.method === 'GET' && url.pathname === '/round') {
        const row = round.get(Buffer.from(url.searchParams.get('id') || '', 'hex'));
        if (!row) return text(res, 404, 'no such round');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-state': String(row.state), ...CORS });
        return res.end(Buffer.from(row.contract));
      }

      // THE SHARES A PLAYER SPLIT THEIR STAKE PREIMAGE INTO, checked here and
      // kept only if they are one polynomial.
      //
      // This is the door letter 29 exists for. `acceptHandout` runs 23.1's own
      // question - does each share lie on the published polynomial - and it
      // needs a group, which this file has and the protocol package does not.
      // A dealer who split with two polynomials is refused HERE, before any
      // entry naming these shares can be accepted, instead of at settlement
      // when no five seats can open the preimage and there is nothing to do.
      if (req.method === 'POST' && url.pathname === '/handout') {
        let handout;
        try { handout = decodeHandout(await read(req)); }
        catch (e) { return text(res, 400, 'that is not a handout: ' + e.message); }

        const seen = acceptHandout(handout, { curve: feldmanGroup });
        if (!seen.ok) return text(res, 409, seen.why);

        const id = handoutId(handout);
        round.rememberHandout({ id, roundId: handout.roundId, bytes: encodeHandout(handout) });
        return bytes(res, 201, id);
      }

      if (req.method === 'GET' && url.pathname === '/handout') {
        const held = round.handout(Buffer.from(url.searchParams.get('id') || '', 'hex'));
        if (!held) return text(res, 404, 'this node has accepted no such handout');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(held.bytes));
      }

      if (req.method === 'POST' && url.pathname === '/entry') {
        const contract = decodeEntryContract(await read(req));
        if (!funded({ kind: 'entry', contract }))
          return text(res, 402, 'this node stores nothing for an entry nobody has funded');
        return bytes(res, 201, round.enter(contract));
      }

      // THE ENTRY CONTRACT, so 13B's proof is portable to somebody who was not
      // here. The two signed marks mean nothing without the session key they
      // must verify under, and that key is a field of the entry the player
      // signed. Without this door a stranger holding the proof can read it and
      // cannot check it, which is most of what "portable" was supposed to buy.
      if (req.method === 'GET' && url.pathname === '/entry') {
        const eid = Buffer.from(url.searchParams.get('id') || '', 'hex');
        const entry = round.entry(eid);
        if (!entry) return text(res, 404, 'no such entry');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(entry));
      }

      // WHAT THIS NODE HAS SEEN RECEIPTED THAT IT HAS NOT GOT. 13B's gossip
      // signal, and the only thing that surfaces a split committee before
      // settlement: a member has receipted a mark this node never held. It is
      // not a proof and it is not a vote - it says where to go looking, and
      // evidence nobody can ask for does nothing at all.
      if (req.method === 'GET' && url.pathname === '/foreign-receipts') {
        const held = round.foreignReceipts();
        if (!held.length) return text(res, 204, 'this node holds no receipt for a mark it has not got');
        const body = Buffer.concat(held.map((f) => Buffer.from(f.bytes)));
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-foreign-receipts': String(held.length),
          ...CORS,
        });
        return res.end(body);
      }

      // 13B'S PROOF, which a node MUST publish when it holds one. The answer
      // is the two signed marks back to back, per tick, and 204 when this node
      // has never seen the player sign two worlds at once.
      if (req.method === 'GET' && url.pathname === '/equivocation') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const found = round.equivocation(rid, eid);
        if (!found.length) return text(res, 204, 'no equivocation held for that entry');
        const body = Buffer.concat(found.flatMap(
          (f) => [Buffer.from(f.stored), Buffer.from(f.offered)]));
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-equivocations': String(found.length),
          'x-ticks-at': found.map((f) => f.tick).join(','),
          ...CORS,
        });
        return res.end(body);
      }

      // THE CANONICAL TRANSCRIPT (13C), which is not the same object as the
      // transcript above: that one is everything this node was given, and this
      // one is only what the committee has carried. A node serving the first
      // where the second was asked for would be handing over marks four
      // members never saw.
      if (req.method === 'GET' && url.pathname === '/canonical') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        let c;
        try { c = round.canonicalTranscript(rid, eid); }
        catch (e) { return text(res, 409, e.message); }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-transcript-hash': toHex(c.hash),
          'x-ticks': String(c.ticks),
          'x-marks': String(c.marks),
          'x-dropped': String(c.dropped),
          'x-through-tick': String(c.throughTick),
          ...CORS,
        });
        return res.end(Buffer.from(c.bytes));
      }

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
      // WHAT THIS NODE REPLAYED AND SIGNED, so another node can have it
      // without replaying. Section 13's own record, body then signature, as
      // many as this node holds for that run.
      if (req.method === 'GET' && url.pathname === '/results') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const held = round.results(rid, eid);
        const out = new Uint8Array(held.length * SIGNED_RESULT_BYTES);
        held.forEach((r, i) => out.set(r.bytes, i * SIGNED_RESULT_BYTES));
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-results': String(held.length), ...CORS,
        });
        return res.end(Buffer.from(out));
      }

      // AN OBJECTION AGAINST A RUN (13A intake). What an objection costs and
      // who may file one is the objection protocol and is not decided here;
      // that the node KNOWS of one is what lets the replay queue put it first.
      if (req.method === 'POST' && url.pathname === '/objection') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        try {
          const fresh = round.object(rid, eid);
          return text(res, fresh ? 201 : 200, fresh ? 'objected' : 'already objected');
        } catch (err) { return text(res, 404, err.message); }
      }

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

      // WHO IS ON THE COMMITTEE FOR THIS ROUND, answered off the chain: the
      // census at `census_height`, then the round's own lottery over it. A
      // round whose census is too small to hold one is refused BY NAME here,
      // not quietly served with a shorter committee.
      if (req.method === 'GET' && url.pathname === '/committee') {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const role = url.searchParams.get('role') || 'game';
        if (id.length !== 32) return text(res, 400, 'that is not a round id');
        const seats = roster.committeeFor(id, role);
        if (!seats.ok) return text(res, 409, seats.why);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-eligible': String(seats.eligible),
          'x-seats': String(seats.committee.length),
          'x-census-root': toHex(seats.root),
          ...CORS,
        });
        const out = new Uint8Array(seats.committee.length * 32);
        seats.committee.forEach((e, i) => out.set(e.pubkey, i * 32));
        return res.end(Buffer.from(out));
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
  // WHO IS ON THE OTHER END OF A CONNECTION, and nothing is pushed to one that
  // has not said. A socket used to be anonymous - it took input batches and
  // answered a number - so the node had no way to address anybody, which is
  // why no picture could be delivered however well it could be produced.
  const watching = new Map();
  let shed = 0;

  /**
   * What one subscriber has not been shown yet, marked as shown.
   *
   * ALREADY SEEN AT THAT TICK IS NOT NEWS: a subscriber gets a picture when
   * there is a new one, not once per batch anybody publishes.
   */
  const freshFor = (who, { mark = true } = {}) => {
    const out = [];
    for (const frame of ghosts.setFor(who.roundId, who.entryId)) {
      const at = `${hexOf(frame.entryId)}:${frame.tick}`;
      if (who.shown.get(hexOf(frame.entryId)) === at) continue;
      // MARKING IS THE SENDER'S JOB, not the asking's. A subscriber too far
      // behind to be sent anything must not have its pictures marked
      // delivered - that is how a truck that then stops driving becomes
      // invisible to it - so the drop counts them without claiming them.
      if (mark) who.shown.set(hexOf(frame.entryId), at);
      out.push(frame);
    }
    return out;
  };

  /**
   * Push one round's interest set to every subscriber but the entry itself.
   *
   * A SUBSCRIBER THAT IS NOT KEEPING UP IS SHOWN NOTHING, and that is the
   * right answer for a picture rather than a compromise. Piece 2 of this
   * letter already ruled it for the queue on the way in - "a full queue sheds
   * pictures oldest first and never evidence" - and the same holds pushing
   * out: a 5 Hz frame of a truck that has moved on is worth nothing by the
   * time a stalled socket drains to it, while the node buffering it is
   * unbounded memory held for one slow player. Nothing that DECIDES anything
   * is ever shed here; a ghost decides nothing.
   */
  const showRound = (roundIdBytes) => {
    let sent = 0;
    for (const [sock, who] of watching) {
      if (hexOf(who.roundId) !== hexOf(roundIdBytes)) continue;
      if (sock.readyState !== sock.OPEN) continue;
      if (sock.bufferedAmount > GHOST_BACKLOG_BYTES) {
        // COUNTED, AND NOT MARKED AS SHOWN. Nothing is queued here to go
        // stale: `setFor` recomputes the latest picture of each truck every
        // time, so a frame skipped now is simply sent when the socket has
        // drained - and what goes out then is the newest picture that exists,
        // not this one. Marking them shown instead LOST a truck: measured, a
        // player who fell behind while somebody else was driving, and that
        // somebody then stopped, never saw them at all until they moved
        // again.
        shed += freshFor(who, { mark: false }).length;
        continue;
      }
      for (const frame of freshFor(who)) { sock.send(frame.bytes); sent++; }
    }
    return sent;
  };

  wss.on('connection', (sock) => {
    sock.on('close', () => watching.delete(sock));
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
          // SPAWN AND SUBSCRIBE, one word: this connection says which round
          // and which entry it is, and from then on it is shown the others.
          // A text control message like `close`, not a new wire type - the
          // frames that go out are the protocol's TYPE_GHOST and the control
          // channel stays the node's own.
          if (t === 'watch' || t.startsWith('watch ')) {
            const [, rid, eid] = t.trim().split(/\s+/);
            const roundId = Buffer.from(rid || '', 'hex');
            const entryId = Buffer.from(eid || '', 'hex');
            if (roundId.length !== 32 || entryId.length !== 32)
              return sock.send('error a watch names a round and an entry');
            if (!round.get(roundId)) return sock.send('error no such round');
            const held = round.entry(entryId);
            if (!held) return sock.send('error no such entry');
            if (hexOf(decodeEntryContract(held).roundId) !== hexOf(roundId))
              return sock.send('error that entry is in another round');
            const already = watching.get(sock);
            if (already && hexOf(already.entryId) !== hexOf(entryId))
              return sock.send('error this connection is already watching as another entry');

            const who = {
              roundId: new Uint8Array(roundId),
              entryId: new Uint8Array(entryId),
              shown: (already && already.shown) || new Map(),
            };
            watching.set(sock, who);

            // AND THE FIELD AS IT STANDS, so a player joining late sees the
            // trucks already driving instead of waiting for the next batch.
            // THE COUNT GOES FIRST and the frames follow it: a client that
            // reads "watching 3" knows three pictures are coming, and a push
            // that overtook its own answer would arrive before the client had
            // been told it was subscribed at all.
            const fresh = freshFor(who);
            sock.send(`watching ${fresh.length}`);
            for (const frame of fresh) sock.send(frame.bytes);
            return undefined;
          }
          if (t.startsWith('close ')) {
            const id = Buffer.from(t.slice(6).trim(), 'hex');
            const shut = round.close(id);
            // A CLOSED ROUND IS REPLAYED, and by the daemon rather than by
            // whoever asked. The promises are deliberately not awaited here:
            // the socket is told the round is shut, and the replays run on
            // their own threads through the pool.
            // Replay every entry, and then ASK THE OTHER SEATS. Serving a
            // result nobody fetches is a committee of one: the count section
            // 13 asks for only exists on a node holding more than its own
            // signature.
            if (shut) verifier.settleRound(id).catch((e) => console.error(`[verify] ${e.message}`));
            return sock.send(shut ? 'closed' : 'already closed');
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
        if (bytes[0] === TYPE_CHECKPOINT_RECEIPT) {
          const answer = round.takeReceipt(bytes);
          // A RECEIPT CAN COMPLETE WHAT A REPLAY COULD NOT SIGN. 13C's
          // canonical prefix grows as receipts arrive, so a run replayed
          // before its transcript was carried signs now, with nothing else
          // changed. Without this the node would have found the answer and
          // thrown it away.
          try {
            const run = round.runOf(decodeCheckpointReceipt(splitSignedReceipt(bytes).body).checkpointId);
            const held = run && round.get(run.roundId);
            if (run && held && held.state === CLOSED) {
              const again = verifier.retry(run.roundId, run.entryId);
              if (again) again.then((d) => (d && d.stored
                ? verifier.gather(run.roundId, run.entryId) : null))
                .catch((e) => console.error(`[verify] ${e.message}`));
            }
          } catch (e) { console.error(`[verify] ${e.message}`); }
          return sock.send(answer);
        }

        // AND EVERYTHING ELSE IS NOT AUTOMATICALLY AN INPUT. This used to fall
        // straight into `round.batch`, so the door's rule was "anything that
        // is not a mark or a receipt is a tick". A ghost was refused there, but
        // by `decodeInputBatch` noticing its own type byte - an accident of the
        // decoder, answering "not an input batch", which says what the frame is
        // not. 0.10 needs the other sentence: a picture carries no authority,
        // and it is told that here, before a handler sees it.
        const stands = bearsAuthority(bytes, 'an input');
        if (!stands.ok) return sock.send('error ' + stands.why);

        const took = round.batch(bytes);
        sock.send(String(took));

        // A NEW TICK IS A NEW PICTURE. The batch that just landed moved
        // somebody's truck, so everybody watching that round is shown the
        // interest set again - and the entry that published it is not shown
        // itself, because `interestSet` drops the viewer by id.
        if (took > 0) {
          try { showRound(decodeInputBatch(bytes).roundId); }
          catch (e) { console.error(`[ghosts] ${e.message}`); }
        }
      } catch (e) {
        sock.send('error ' + e.message);
      }
    });
  });

  return new Promise((resolve) => {
    http.listen(port, host, () => resolve({
      http, wss, round, host, verifier, ghosts, roster,
      watching: () => watching.size,
      shed: () => shed,
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
