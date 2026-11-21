// #064: on a live page, which versions of a game the page holds (ARENA_GAMES_FULL, the tiles) and the client hashes each names.
import { launch } from '../lib/cdp.mjs';
import { mkdirSync } from 'node:fs';
const [url, name, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b = await launch({ dir: `${out}/chrome` });
try {
  const t = await b.tab('about:blank', { allowExternal: true, noUnity: true });
  await t.go(url, 15000);
  console.log(await t.js(`JSON.stringify((() => {
    const hex = (u) => ARENACLIENT.toHex(u);
    const desc = (g) => g && ({ id: g.id.slice(0, 12), version: g.version, known: g.known, clients: ((g.manifest && g.manifest.clients) || []).map((h) => hex(h).slice(0, 16)), dev: g.manifest && g.manifest.gameDevPubkey ? hex(g.manifest.gameDevPubkey).slice(0, 12) : null, older: (g.older || []).map((o) => o.id.slice(0, 12)) });
    const full = (window.ARENA_GAMES_FULL || []).filter((g) => g.name === ${JSON.stringify(name)}).map(desc);
    const ids = (window.ARENA_GAME_IDS || []).length;
    const known = Object.keys(window).filter((k) => /KNOWN/.test(k));
    return { full, gameIds: ids, knownGlobals: known };
  })())`));
} finally { await b.close(); process.exit(0); }
