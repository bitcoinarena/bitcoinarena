// A NODE THAT KEEPS MISSING ITS SEATS (§5A.3, kanban #302): "A node that stops answering without stepping out is not punished for the
// absence itself - it earns no fee share (§22A) and yields its seat to the reserve (§5A.7) - but it wastes the reserve, so the
// reference node warns its operator when it has missed three seatings in a row and offers the serving = false update."
//
// A seating is missed when this node was drawn for a round and the round's certified seating seats somebody else in its place.
// Counted over the rounds this seat holds whose seating stands, newest first, until the first it sat.

/** How many seatings in a row, newest first, this node was drawn for and not seated. `rows` [{ atMs, drawn, seated }]. */
export function missedInARow(rows) {
  let n = 0;
  for (const r of [...rows].filter((x) => x && x.drawn).sort((a, b) => b.atMs - a.atMs)) {
    if (r.seated) break;
    n++;
  }
  return n;
}

/** The warning and the offer, once three are missed in a row; null before. */
export function seatingWarning(missed, { nodeLabel = 'this node' } = {}) {
  if (missed < 3) return null;
  return { missed, says: `${nodeLabel} was drawn and not seated ${missed} times in a row: the reserve sat for it. If it will be away, step it `
    + 'out of the census with an advertisement update saying serving = false - its bond stays, and serving = true brings it back from the next census.',
    update: 'ARENA_ADVERT_SERVING=false ARENA_ADVERT_NODES=<n> node tools/testnet4-advert-update.mjs --publish' };
}
