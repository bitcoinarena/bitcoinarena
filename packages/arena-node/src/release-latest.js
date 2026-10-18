// A NEW RELEASE IS AVAILABLE (kanban #471): the newest release as the Arena site names it (release/latest.json, written by
// tools/release/latest.mjs and signed with the release key), read when the owner page asks (/owner/version) and kept for six hours.
// Offered only when the signature verifies with the release key and its version is newer than this node's; anything else says why.
const LATEST_URL = 'https://testnet.bitcoin-arena.io/release/latest.json';
const TTL_MS = 6 * 3600_000;

/** Is version `a` newer than `b`? (major.minor.patch, then a release over its own pre-releases, then rc.N by N) */
export function newerVersion(a, b) {
  const parse = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(String(v || '').trim()); return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || null } : null; };
  const x = parse(a), y = parse(b);
  if (!x) return false;
  if (!y) return true;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i];
  if (!x.pre || !y.pre) return !x.pre && !!y.pre;
  const px = x.pre.split('.'), py = y.pre.split('.');
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    if (px[i] === undefined) return false;
    if (py[i] === undefined) return true;
    const nx = /^\d+$/.test(px[i]), ny = /^\d+$/.test(py[i]);
    if (px[i] !== py[i]) return nx && ny ? Number(px[i]) > Number(py[i]) : nx !== ny ? !nx : px[i] > py[i];
  }
  return false;
}

/**
 * The reader: read(ownVersion) answers { checkedMs, latest: { version, tag, release, commit } | null, newer, why }. `verify(bytes, sigB64)`
 * checks the release key's signature (the installer's release-verify.js; a node without it offers nothing).
 */
export function latestReleaseReader({ url = process.env.ARENA_RELEASE_LATEST_URL ?? LATEST_URL, fetcher = fetch, verify, now = Date.now, ttlMs = TTL_MS } = {}) {
  let kept = null, pending = null;
  const fetchOnce = async () => {
    if (!url) return { latest: null, why: 'release checks are off on this node' };
    if (!verify) return { latest: null, why: 'this node has no release verifier (run from a release)' };
    try {
      const get = async (u) => { const r = await fetcher(u, { signal: AbortSignal.timeout(8000), cache: 'no-store' }); if (r.status !== 200) throw new Error(`${u} answered ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
      const [body, sig] = await Promise.all([get(url), get(`${url}.sig`)]);
      if (!verify(body, sig.toString('utf8'))) return { latest: null, why: 'the published newest release is not signed by the Arena release key' };
      const j = JSON.parse(body.toString('utf8'));
      return { latest: { version: String(j.version), tag: String(j.tag || ''), release: String(j.release || ''), commit: String(j.commit || '') }, why: null };
    } catch (e) { return { latest: null, why: `the newest release could not be read: ${e.message}` }; }
  };
  return {
    async read(ownVersion) {
      if (!kept || now() - kept.checkedMs > ttlMs) {
        pending ??= fetchOnce().then((r) => { kept = { ...r, checkedMs: now() }; pending = null; return kept; });
        await pending;
      }
      return { ...kept, newer: !!kept.latest && newerVersion(kept.latest.version, ownVersion) };
    },
  };
}
