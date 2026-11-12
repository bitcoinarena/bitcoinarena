/**
 * ANOTHER SEAT'S ANSWER, READ UP TO A BOUND (kanban #1540, #1723): a seat in the census or the peers list could answer GET /games,
 * /plugin or /network with hundreds of MB, and `await r.json()` held all of it and its parsed objects at once (measured: one
 * 120 MB /games listing grew the reading seat's heap 218 MB and held its event loop 3.6 s). The body is read chunk by chunk
 * and refused, the connection dropped, as soon as it passes `maxBytes`. Shared by server.js (readNetworkApps, autoUpdate,
 * takeGame, takeNetwork) and the duty poster (duty-day.js createGridBase, duty-poster.js) - #1723: the poster's copy of the
 * /games reader was left unbounded by #1540.
 */
export const PEER_LISTING_BYTES = 4 * 1048576, PEER_LISTING_GAMES = 64, PEER_PACKAGE_BYTES = 32 * 1048576;
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
