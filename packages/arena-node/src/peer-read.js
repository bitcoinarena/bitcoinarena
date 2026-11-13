/**
 * ANOTHER SEAT'S ANSWER, READ UP TO A BOUND (kanban #1540, #1723): a seat in the census or the peers list could answer GET /games,
 * /plugin or /network with hundreds of MB, and `await r.json()` held all of it and its parsed objects at once (measured: one
 * 120 MB /games listing grew the reading seat's heap 218 MB and held its event loop 3.6 s). The body is read chunk by chunk
 * and refused, the connection dropped, as soon as it passes `maxBytes`. Shared by server.js (readNetworkApps, autoUpdate,
 * takeGame, takeNetwork) and the duty poster (duty-day.js createGridBase, duty-poster.js) - #1723: the poster's copy of the
 * /games reader was left unbounded by #1540.
 */
// 2.0 (kanban #1489 port of #1723): the same bounds as server.js LISTING_ANSWER_MAX_BYTES (4 MB) and PACKAGE_ANSWER_MAX_BYTES (16 MB)
export const PEER_LISTING_BYTES = 4 * 1048576, PEER_LISTING_GAMES = 64, PEER_PACKAGE_BYTES = 16 * 1048576;
// kanban #2018, #2052 (refute of #1540/#1723, the duty poster's other census reads): a seat's GET /rounds?next=1&ahead=50h - one open
// round of each series and the few closing within 2 min, measured 600-900 KB on live seats - and the rows of it walked; a seat's GET
// /headers is 80 bytes a block of ITS chain, so its bound is the reader's own tip plus PEER_HEADERS_SLACK blocks (testnet4: ~10 MB), and
// PEER_HEADERS_BYTES when the reader's tip is not known
export const PEER_ROUNDS_BYTES = 8 * 1048576, PEER_ROUNDS_ROWS = 8192, PEER_HEADERS_SLACK = 2016, PEER_HEADERS_BYTES = 128 * 1048576;

// THE BODY AS BYTES, READ UP TO A BOUND (kanban #2018, #2052): the same chunk loop for an answer that is not text - a seat's GET /headers,
// which the duty poster read with r.arrayBuffer() and no bound (measured: one census seat sending 256 MB was held whole and
// 3,355,443 headers hashed in the seat's own process)
export async function bytesUpTo(r, maxBytes) {
  const said = Number(r.headers?.get?.('content-length'));
  if (said > maxBytes) { try { await r.body?.cancel(); } catch { /* dropped */ } throw new Error(`its answer is ${said} bytes, more than ${maxBytes}`); }
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader();
  const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) { reader.cancel().catch(() => {}); throw new Error(`its answer passed ${maxBytes} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength)));
}

export async function textUpTo(r, maxBytes) { return (await bytesUpTo(r, maxBytes)).toString('utf8'); }

// a fetch Response always has `body` (a stream, or null for no body); only an injected stand-in (tests' fetchFn) has none at all,
// and that one is read as it offers itself
export const jsonUpTo = async (r, maxBytes) => (r.body === undefined && typeof r.json === 'function' ? r.json() : JSON.parse(await textUpTo(r, maxBytes)));
// the same for bytes (kanban #2018, #2052): a stand-in with no body at all offers its arrayBuffer(), still held to the bound
export const binaryUpTo = async (r, maxBytes) => {
  if (r.body !== undefined || typeof r.arrayBuffer !== 'function') return bytesUpTo(r, maxBytes);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length > maxBytes) throw new Error(`its answer is ${b.length} bytes, more than ${maxBytes}`);
  return b;
};

/** a seat's games, at most PEER_LISTING_GAMES of them: the rest of a longer list is not read (kanban #1540) */
export const listedGames = (got) => (got && Array.isArray(got.games) ? got.games.slice(0, PEER_LISTING_GAMES) : []);

// EVERY ANSWER A SEAT READS FROM ANOTHER SEAT HAS A LIMIT, AS EVERY REQUEST BODY DOES (kanban #2637, a bypass of #1469): #1469 capped what a
// seat reads from a request (body-read.js, 413); the same bytes came back in as a peer's ANSWER read with a bare r.json() - pullProposals'
// GET /proposals held a 16 MiB answer whole (heap +20.4 MB in one pull, no upper bound), as did /reserves, /absences, /emergency-departures,
// /funding-items, /lock-namer, /founding, address pulls and others. Fixing them one read at a time left the next one open, so the cap now
// sits on the fetch itself: answersUpTo(fetch) gives a fetch whose answers' json(), text(), arrayBuffer(), bytes(), blob() and formData()
// read at most `maxBytes` (chunk by chunk; past it the stream is cancelled and the read throws, as bytesUpTo). The stream itself (r.body)
// is untouched, so a read that names its own bound (bytesUpTo / textUpTo / jsonUpTo with PEER_PACKAGE_BYTES, PEER_HEADERS_BYTES, ...) still
// reads up to that. A stand-in answer with no body at all (a test's fetchFn) is handed on as it is. server.js reads every peer through it.
export const PEER_ANSWER_BYTES = 8 * 1048576;
export function capAnswer(r, maxBytes = PEER_ANSWER_BYTES) {
  if (!r || typeof r !== 'object' || r.body === undefined) return r;
  const own = (k, v) => { try { Object.defineProperty(r, k, { value: v, configurable: true, writable: true }); } catch { /* frozen: left as is */ } };
  const clone = typeof r.clone === 'function' ? r.clone.bind(r) : null;
  const bytes = () => bytesUpTo(r, maxBytes);
  own('arrayBuffer', async () => { const b = await bytes(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
  own('bytes', async () => new Uint8Array(await bytes()));
  own('text', async () => (await bytes()).toString('utf8'));
  own('json', async () => JSON.parse((await bytes()).toString('utf8')));
  own('blob', async () => new Blob([await bytes()], { type: r.headers?.get?.('content-type') || '' }));
  own('formData', async () => new Response(await bytes(), { headers: r.headers }).formData());
  if (clone) own('clone', () => capAnswer(clone(), maxBytes));
  return r;
}
export const answersUpTo = (fetchFn, maxBytes = PEER_ANSWER_BYTES) => async (...a) => capAnswer(await fetchFn(...a), maxBytes);
