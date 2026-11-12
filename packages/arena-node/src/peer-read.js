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

export async function textUpTo(r, maxBytes) {
  const said = Number(r.headers?.get?.('content-length'));
  if (said > maxBytes) { try { await r.body?.cancel(); } catch { /* dropped */ } throw new Error(`its answer is ${said} bytes, more than ${maxBytes}`); }
  if (!r.body) return '';
  const reader = r.body.getReader();
  const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) { reader.cancel().catch(() => {}); throw new Error(`its answer passed ${maxBytes} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))).toString('utf8');
}

// a fetch Response always has `body` (a stream, or null for no body); only an injected stand-in (tests' fetchFn) has none at all,
// and that one is read as it offers itself
export const jsonUpTo = async (r, maxBytes) => (r.body === undefined && typeof r.json === 'function' ? r.json() : JSON.parse(await textUpTo(r, maxBytes)));

/** a seat's games, at most PEER_LISTING_GAMES of them: the rest of a longer list is not read (kanban #1540) */
export const listedGames = (got) => (got && Array.isArray(got.games) ? got.games.slice(0, PEER_LISTING_GAMES) : []);
