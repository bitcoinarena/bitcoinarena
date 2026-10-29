// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEW RELEASE IS AVAILABLE: the newest release as the Arena site names it (release/latest.json, written by
// tools/release/latest.mjs and signed with the release key), read when the owner page asks (/owner/version) and kept for six hours.
// Offered only when the signature verifies with the release key and its version is newer than this node's; anything else says why.
const LATEST_URL = 'https://testnet.bitcoin-arena.io/release/latest.json';
const TTL_MS = 6 * 3600_000;
// THE UPDATER SERVICE KEEPS A READ ONE MINUTE (kanban #765, measured 2026-10-29: 2026.1.9.12 live on the channel from ~12:14Z, and the
// inst577 nodes' checks at 12:30, 12:34 and 12:35Z all said "up to date (2026.1.9.11)" - `bitcoinarena auto-update` holds one reader for its
// whole life, and at the six hours above its "every 30 min" read the channel once in 6 h): below its 30-minute checks, so each check reads
export const SERVICE_TTL_MS = 60_000;

/**
 * WHERE THE NEWEST RELEASE IS READ (kanban #546, 2026-10-20: "a signed, unlisted latest.json, read only when ARENA_LATEST_URL is set,
 * and only when that URL is limited to testnet.bitcoin-arena.io"): the production latest.json unless ARENA_LATEST_URL (or the node's
 * arena.conf `latest_url`, which an update keeps where a launcher's env would be rewritten) names an https latest.json on the Arena
 * testnet site - a test channel, still believed only under the release key's signature. Anything else is refused and the production
 * URL read. ARENA_RELEASE_LATEST_URL='' (empty) still turns the checks off. Answers { url, why }.
 */
export const TEST_CHANNEL_RE = /^https:\/\/testnet\.bitcoin-arena\.io\/[A-Za-z0-9._\/-]*latest\.json$/;
export function latestUrlFrom(env = process.env, conf = {}) {
  if (env.ARENA_RELEASE_LATEST_URL === '') return { url: '', why: 'release checks are off (ARENA_RELEASE_LATEST_URL is empty)' };
  const given = env.ARENA_LATEST_URL || conf.latest_url || '';
  if (!given) return { url: LATEST_URL, why: null };
  if (TEST_CHANNEL_RE.test(given)) return { url: given, why: `the test channel ${given}` };
  return { url: LATEST_URL, why: `${given} is not a latest.json on https://testnet.bitcoin-arena.io/: refused, the production release read` };
}

/** Is version `a` newer than `b`? Releases are 2026.xx.yy and a fix 2026.xx.yy.zz (2026-10-19), compared part by part (a missing
 *  fourth part is 0: 2026.1.1.1 is newer than 2026.1.1); then a release over its own pre-releases, then rc.N by N (the older x.y.z-rc.N). */
export function newerVersion(a, b) {
  const parse = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.]+))?$/.exec(String(v || '').trim()); return m ? { n: [+m[1], +m[2], +m[3], +(m[4] || 0)], pre: m[5] || null } : null; };
  const x = parse(a), y = parse(b);
  if (!x) return false;
  if (!y) return true;
  for (let i = 0; i < 4; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i];
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
 * The reader: read(ownVersion) answers { checkedMs, latest: { version, tag, release, commit, assets, download } | null, newer, why }. `verify(bytes, sigB64)`
 * checks the release key's signature (the installer's release-verify.js; a node without it offers nothing).
 */
export function latestReleaseReader({ url = latestUrlFrom().url, fetcher = fetch, verify, now = Date.now, ttlMs = TTL_MS } = {}) {
  let kept = null, pending = null;
  const fetchOnce = async () => {
    if (!url) return { latest: null, why: 'release checks are off on this node' };
    if (!verify) return { latest: null, why: 'this node has no release verifier (run from a release)' };
    try {
      const get = async (u) => { const r = await fetcher(u, { signal: AbortSignal.timeout(8000), cache: 'no-store' }); if (r.status !== 200) throw new Error(`${u} answered ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
      const [body, sig] = await Promise.all([get(url), get(`${url}.sig`)]);
      if (!verify(body, sig.toString('utf8'))) return { latest: null, why: 'the published newest release is not signed by the Arena release key' };
      const j = JSON.parse(body.toString('utf8'));
      // the assets' SHA-256 and where a node downloads them (auto update): both under the release key's signature
      return { latest: { version: String(j.version), tag: String(j.tag || ''), release: String(j.release || ''), commit: String(j.commit || ''),
        assets: j.assets && typeof j.assets === 'object' ? j.assets : {}, download: j.download && typeof j.download === 'object' ? j.download : null }, why: null };
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
