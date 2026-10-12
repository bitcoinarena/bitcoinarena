#!/usr/bin/env node
// #324 ON A TWO-FEDERATION REGTEST (§23A.3): each seat's /federations answer on stdin, one JSON a line - A's seats name A's
// signed record, B's seats B's - read as the page reads them: each federation's newest record, its load (reserve over the
// exposure cap, both signed), and Move as the page's own moveOffer answers it for each federation. Prints one JSON.
import { moveOffer, pickFederation } from '../../arena-client/src/federations.js';
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const by = new Map();
  for (const line of s.split('\n').filter((l) => l.trim().startsWith('{'))) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    for (const f of j.federations || []) {
      const had = by.get(f.federation);
      if (!had || (f.height || 0) > (had.height || 0)) by.set(f.federation, { federation: f.federation, status: f.status, height: f.height, signers: f.signers,
        reserveSats: f.reserveSats, exposureCapSats: f.exposureCapSats, load: typeof f.load === 'number' ? f.load : null });
    }
  }
  const all = [...by.values()];
  const offers = Object.fromEntries(all.map((f) => [f.federation.slice(0, 16), moveOffer(f, all)]));
  const pick = pickFederation(all);
  console.log(JSON.stringify({ federations: all, moveOffers: offers, firstDepositGoesTo: pick ? pick.federation.slice(0, 16) : null }));
});
