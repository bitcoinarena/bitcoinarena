// A SEAT OPENING A ROUND NAMES THE OPEN FEDERATION WITH THE LOWEST LOAD (§23A.3: "A seat opening a round names the OPEN
// federation with the lowest load among those its own bond qualifies it to serve; a creator who names another has the client
// show why"; kanban #324 step 2). From a seat's /federations list (each federation's newest signed record: status, load):
// the OPEN ones this opener can serve - it holds their invite (`serves`, federation ids hex) - the lowest load first, the
// newest record on a tie; a record naming no load counts as the highest. None of them: the opener's own (`own`).
//   -> { federationId (hex), load, why }
export function openingFederation({ listed = [], serves = [], own }) {
  const can = new Set((serves || []).map((f) => String(f).toLowerCase()));
  const open = (listed || []).filter((f) => f && f.status === 'OPEN' && can.has(String(f.federation).toLowerCase()));
  const loadOf = (f) => (typeof f.load === 'number' ? f.load : Infinity);
  const best = open.sort((a, b) => loadOf(a) - loadOf(b) || (b.height || 0) - (a.height || 0))[0];
  if (!best) return { federationId: String(own).toLowerCase(), load: null, why: 'no OPEN federation with a signed record that this opener serves: its own' };
  return { federationId: String(best.federation).toLowerCase(), load: typeof best.load === 'number' ? best.load : null,
    why: `the lowest load among ${open.length} OPEN federation(s) this opener serves` };
}
