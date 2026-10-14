// A PROTOCOL VERSION'S NAME (kanban #349, the owner 2026-10-12 ~15:05Z): "the version template is YYYY.x.y" - YYYY the year it was
// released, y the build number, and x starts at 0 for now ("0.0.1 is the newest version").
//
// THE WIRE KEEPS ITS u16: what a contract, an advert and a manifest carry is y alone, and y only ever grows, so "at or above"
// is a comparison of y and no byte moves. YYYY and x are not on the wire; they come from this table of releases, which a
// build extends when it ships a version. A y this build has no release for is named by its number alone ("?.?.y").
export const PROTOCOL_RELEASES = Object.freeze([
  Object.freeze({ version: 1, year: 2026, x: 0 }),
  // the round contract that does not name its draw (kanban #348, RULED the owner 2026-10-13)
  Object.freeze({ version: 2, year: 2026, x: 0 }),
  // every game through every federation: a round that names no single federation, each entry its own (kanban #348)
  Object.freeze({ version: 3, year: 2026, x: 0 }),
  // top-N prize splits: a replayed game's manifest may pay fixed shares over its top places (kanban #362)
  Object.freeze({ version: 4, year: 2026, x: 0 }),
]);

const byVersion = new Map(PROTOCOL_RELEASES.map((r) => [r.version, r]));

/** The YYYY.x.y name of wire version `v`. */
export function protocolVersionName(v) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) return String(v);
  const r = byVersion.get(v);
  return r ? `${r.year}.${r.x}.${v}` : `?.?.${v}`;
}

/**
 * The wire version a YYYY.x.y name stands for: y, once the name is well formed - and, for a version this build has a
 * release for, only if YYYY and x are that release's. A plain number is taken as y. Answers { ok, version, known } or why not.
 */
export function readProtocolVersionName(name) {
  const s = String(name ?? '').trim();
  if (/^\d+$/.test(s)) { const v = Number(s); return v >= 1 && v <= 0xffff ? { ok: true, version: v, known: byVersion.has(v) } : { ok: false, why: `${s} is not a protocol version (1..65535)` }; }
  const m = /^(\d{4})\.(\d+)\.(\d+)$/.exec(s);
  if (!m) return { ok: false, why: `${s || 'nothing'} is not a version of the form YYYY.x.y` };
  const [year, x, v] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (v < 1 || v > 0xffff) return { ok: false, why: `${s}: the build number is 1..65535` };
  const r = byVersion.get(v);
  if (r && (r.year !== year || r.x !== x)) return { ok: false, why: `${s}: build ${v} is ${protocolVersionName(v)}` };
  return { ok: true, version: v, known: !!r };
}
