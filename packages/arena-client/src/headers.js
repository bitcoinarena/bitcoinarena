// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHERE THE CHAIN COMES FROM, AND WHY MORE THAN ONE OF THEM.
//
// Section 25.1: "block headers from several independent sources, most work
// wins... A list provider can then OMIT but not FORGE, and omission is
// answered by asking a second one. This is the difference between using a
// provider and trusting one."
//
// FORGING IS ALREADY IMPOSSIBLE - a header that does not follow the one before
// it is not part of a chain, and the work is arithmetic over bytes nobody can
// choose. OMISSION IS NOT. A provider that simply leaves out the block a bond
// is in looks exactly like a provider that has never heard of it, and a client
// with one source cannot tell those apart. That is the whole reason this file
// takes a list.
//
// SO ONE SOURCE IS REFUSED, always, however good it looks. Not because it is
// probably lying but because nothing it says can be weighed. Running our own
// instances does not change that: for a stranger an API operated by whoever
// wrote the client is worth what that party's word is worth, and redundancy is
// not an argument about trust.
//
// AND A DISAGREEMENT IS REFUSED RATHER THAN RESOLVED. Bitcoin's own rule is
// most work wins, and that is right for a node with the whole chain; here the
// question is different. Two providers whose chains fork are two providers of
// whom at least one is lying or broken, and picking the heavier one would be
// guessing which - so the answer is that there is no answer yet, by name. A
// SHORTER chain is not a disagreement: it is omission, it is the case this
// design expects, and the longer one simply carries it.
import { chainWork, blockHashOf, targetOf } from '../../arena-protocol/src/chain.js';
import { HEADER_BYTES } from '../../arena-protocol/src/chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { readWithOneRetry } from './reread.js';

/**
 * One provider's answer, over HTTP, as 80-byte records back to back.
 *
 * THE CALLER GIVES THE WHOLE URL. No host and no path is written here: this
 * protocol has no chain API of its own, and inventing one - even as a default
 * - would put an address in the client that a player never chose. What a real
 * provider's URLs look like is a separate question from what a client does
 * with the bytes, and only the second one is decided here.
 *
 * THE BODY IS BOUNDED AND THE READ IS ABORTABLE. A provider is not trusted, and
 * an untrusted party that can make a client allocate as much memory as it likes
 * is a provider that can stop the game without ever telling a lie. The cap is
 * counted while reading rather than only on `content-length`, because that
 * header is the provider's word too.
 */
export async function headersOverHttp(url, { fetcher = fetch, signal, maxHeaders = 100000 } = {}) {
  const cap = maxHeaders * HEADER_BYTES;
  const r = await readWithOneRetry(fetcher, url, { signal });
  if (!r.ok) throw new Error(`the provider answered ${r.status}`);

  const offered = Number(r.headers.get('content-length') || 0);
  if (offered > cap)
    throw new Error(`the provider offered ${offered} bytes, more than the ${cap} this client reads`);

  let body;
  if (r.body && r.body.getReader) {
    const reader = r.body.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        throw new Error(`the provider sent more than the ${cap} bytes this client reads`);
      }
      parts.push(value);
    }
    body = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { body.set(part, at); at += part.length; }
  } else {
    body = new Uint8Array(await r.arrayBuffer());
    if (body.length > cap)
      throw new Error(`the provider sent more than the ${cap} bytes this client reads`);
  }

  if (body.length === 0 || body.length % HEADER_BYTES !== 0)
    throw new Error(`${body.length} bytes is not a whole number of headers`);
  const out = [];
  for (let at = 0; at < body.length; at += HEADER_BYTES)
    out.push(body.subarray(at, at + HEADER_BYTES));
  return out;
}

/**
 * A provider bound to one address, and TAGGED with it.
 *
 * The tag is the whole reason this exists. `agreedChain` needs several
 * INDEPENDENT sources, and two calls to the same server are one source however
 * many times it is listed - a mistake that reads as success, which is the worst
 * kind. Independence cannot be established from inside a client in general:
 * two different hostnames can be one machine, and nothing here can tell. What
 * can be caught is the obvious case, and it is caught by name.
 *
 * `where` may be a function of the question, for a provider whose URL carries
 * the range being asked about; then the tag has to be given, because there is
 * no address to read one off yet.
 */
export function httpProvider(where, { tag, ...rest } = {}) {
  const at = (ask) => (typeof where === 'function' ? where(ask) : where);
  const get = (ask, opts) => headersOverHttp(at(ask), { ...rest, ...opts });
  get.tag = tag || (typeof where === 'string' ? new URL(where).origin : undefined);
  return get;
}

const tips = (headers) => headers.map((h) => toHex(blockHashOf(h)));
/** How deep a split at the tip may run and still be a split, not a fork: twice the six blocks a beacon is taken under. */
export const TIP_SPLIT_BLOCKS = 12;
/**
 * How far the chain answered may run past the blocks `need` sources hold (kanban #1908, refute of #1529/#1713): one block, for a
 * source that is simply one block behind - fewer than the six a census or beacon is taken under, so no block a client decides on
 * rests on one source alone - and only at a difficulty no easier than the easiest the sources agree on, so it cannot be free.
 */
export const TIP_LAG_BLOCKS = 1;

/**
 * Ask several providers and answer only if they can be weighed against each
 * other.
 *
 * A provider is a function returning headers in order. It is injected rather
 * than built here for the same reason signing is: transport belongs to whoever
 * runs the client, and a module that decides things should not also decide who
 * it talks to.
 *
 * `least` is 2 and is not a tuning knob - it is the whole property. One source
 * is a directory, which is the thing 25.1 exists to remove.
 */
export async function agreedChain(providers, { least = 2, timeoutMs = 10000, ask, anchor } = {}) {
  // AN ANCHOR IS NOT OPTIONAL, and it may not come from the page.
  //
  // Agreement and mining together still only prove that a set of headers is a
  // chain of SOMETHING. Mining a short chain at trivial difficulty costs
  // almost nothing, so a client whose whole provider list belongs to one
  // operator - two hostnames, one machine, which an origin tag catches only
  // when it is obvious - would take that operator's fork by default, because
  // there is nothing heavier to compare it against. The anchor is what makes
  // the winner have to be BITCOIN's chain: a block the client already knows,
  // which the chain must contain.
  //
  // It is a caller's argument rather than a page's value on purpose. An anchor
  // an attacker supplies is no anchor - he would name a block of his own fork -
  // so this has to come from the client, and `BITCOIN_MAINNET_GENESIS` is one
  // that can never go stale or be argued with.
  if (!(anchor instanceof Uint8Array) || anchor.length !== 32)
    return { ok: false, why: 'no anchor: a chain of headers that link and are mined is still only a chain of something' };

  if (!providers || providers.length < least)
    return { ok: false, why: `${(providers || []).length} providers is fewer than the ${least} it takes to weigh one against another` };

  // Two listings of one server are one source. Checked before anyone is asked,
  // for the same reason the count is: the request would be wasted and it would
  // tell that server what is being looked for.
  const tags = new Map();
  for (let i = 0; i < providers.length; i++) {
    const tag = providers[i] && providers[i].tag;
    if (!tag) continue;
    if (tags.has(tag))
      return { ok: false, why: `providers ${tags.get(tag)} and ${i} are the same source, ${tag}` };
    tags.set(tag, i);
  }

  const answers = await Promise.all(providers.map(async (p, at) => {
    let timer;
    try {
      // A provider that never answers must not stop the ones that did. The
      // timer is cleared and unreferenced either way, or a client that got its
      // chain would sit waiting for a source it no longer needs.
      // The read is aborted, not merely abandoned: a provider that never
      // answers would otherwise hold a socket open for the rest of the run.
      const stop = new AbortController();
      const headers = await Promise.race([
        Promise.resolve().then(() => p(ask, { signal: stop.signal })),
        new Promise((_, no) => {
          timer = setTimeout(() => {
            stop.abort();
            no(new Error(`no answer in ${timeoutMs} ms`));
          }, timeoutMs);
          if (timer.unref) timer.unref();
        }),
      ]);
      const seen = chainWork(headers);
      if (!seen.ok) return { at, ok: false, why: seen.why };
      const hashes = tips(headers);
      // Checked per source, not only on the winner: a chain that does not hold
      // the anchor is not an inferior answer to the question, it is an answer
      // to a different one, and it must not be weighed at all.
      if (!hashes.includes(toHex(anchor)))
        return { at, ok: false, why: `this chain does not contain ${toHex(anchor)}, the block this client is anchored to`
          + ` (it answered ${headers.length} headers, tip ${hashes[hashes.length - 1]})` };
      return { at, ok: true, headers, work: seen.work, hashes };
    } catch (e) {
      // THE CAUSE, NOT ONLY "fetch failed" (M3.3-27): Node's fetch puts the
      // socket's own words - a reset, a closed keep-alive - in `cause`.
      const cause = e.cause ? `: ${[e.cause.code, e.cause.message].filter(Boolean).join(' ')}` : '';
      return { at, ok: false, why: `${e.message}${cause}` };
    } finally { clearTimeout(timer); }
  }));

  const good = answers.filter((a) => a.ok);
  const bad = answers.filter((a) => !a.ok);
  if (good.length < least) {
    const said = bad.map((b) => `provider ${b.at}: ${b.why}`).join('; ');
    return {
      ok: false,
      why: `only ${good.length} of ${providers.length} providers gave a chain, `
        + `which is fewer than the ${least} it takes to weigh one against another`,
      refused: said,
    };
  }

  // Most work wins - Bitcoin's rule, not a vote - and then every other answer
  // has to be a part of that one. A source whose headers are all in the best
  // chain has merely left some out, which is the case this design expects; a
  // source holding a block the best chain does not have is a fork, and there
  // is no honest way to choose between them here.
  // THE MOST-WORK SOURCE ALONE DOES NOT DECIDE WHO FORKS (kanban #2042, refute of #1529/#1713/#1908): one seat forking one
  // block below the honest tip with 13+ headers of its own (on testnet4 that needs only one minimum-difficulty block's work, on
  // regtest nothing) outweighed the honest chain, and #1713's depth rule then set all three honest answers aside as forks of
  // it: agreed 1 < 2, "no chain" for every join that picked that seat - #1529's effect from the other side. The chain is now the
  // heaviest one that `need` sources agree on: the answers are tried as the most-work chain in order of work, and one that too
  // few others agree with is set aside by name. With no answer that enough sources agree on, the read is refused with the
  // heaviest one's reason, as before - two sources that fork are still two of whom one is lying.
  const order = good.map((a, k) => [a, k]).sort((x, y) => (y[0].work > x[0].work ? 1 : y[0].work < x[0].work ? -1 : x[1] - y[1]))
    .map(([a]) => a);
  let firstWhy = null;
  const outweighed = [];
  for (const best of order) {
    if (outweighed.some((o) => o.hashes.length === best.hashes.length && o.hashes.every((h, k) => h === best.hashes[k]))) continue;
    const seen = weigh(best);
    // a heavier answer that forks off this chain is already in `refused` by name, with the block it does not share
    if (seen.ok) return seen.result;
    if (!firstWhy) firstWhy = seen.why;
    outweighed.push(best);
  }
  return { ok: false, why: firstWhy };

  function weigh(best) {
    const inBest = new Set(best.hashes);

    // A SPLIT AT THE TIP IS NOT A FORK TO REFUSE (the owner's testnet4, measured 2026-10-14 ~10:00Z: the test host's bitcoind and the
    // the test host's stood at one height and one chainwork on two branches six blocks long - testnet4's minimum-difficulty blocks tie
    // often - and every committee this client built from all 14 seats' headers was refused, "providers 0 and 1 do not agree").
    // A provider whose chain leaves the most-work one only in its last TIP_SPLIT_BLOCKS blocks still agrees on everything below,
    // and the chain answered stops at the last block every provider shares: a round's census and beacon are taken at least six
    // blocks deep, so nothing a client decides sits in the split. A provider that leaves it deeper is a fork, refused as before.
    const bestAt = new Map(best.hashes.map((h, i) => [h, i]));
    let cut = best.hashes.length;
    // ONE FORKING SOURCE IS DROPPED, NOT OBEYED (kanban #1529): a seat answering the real chain cut 13 blocks below the tip plus
    // headers of its own - mined at the easiest target it claims, so free - refused every join that picked it, although the other
    // three sources agreed on the chain with the most work. A source that forks off the most-work chain deeper than a tip split is
    // now set aside by name, and the chain stands only while at least `least` sources (and never fewer than two, the most-work one
    // among them) still agree on it; with fewer the fork is refused as before: two sources that fork are two of whom one is lying.
    const forked = [];
    const splits = [];
    const lags = [];
    let firstFork = null;
    for (const a of good) {
      // ANSWERS ABOUT DIFFERENT PARTS OF THE CHAIN used to be told apart from a
      // fork here, and that branch is gone rather than left unreachable: every
      // chain that gets this far contains the anchor, so any two of them share
      // at least that block, and no test or mutant could ever reach it again. A
      // provider whose range does not reach the anchor is refused earlier, by
      // name, which is the same fact said in the right place.
      const i = a.hashes.findIndex((h) => !inBest.has(h));
      // A SHORTER ANSWER IS AGREEMENT ONLY AS FAR AS IT GOES (kanban #1908, refute of #1529/#1713): headers claim their own target,
      // so one seat could answer the honest chain plus any number of free headers on top of the honest tip, outweigh it, and have
      // the three honest answers counted as omission - the agreed chain was then 76 headers of which 36 only that seat held, the
      // round's beacon and any bond depth its to choose. A source holding a part of the most-work chain counts as holding it up to
      // its own last block, like a tip split there, so the cut below stops where `need` sources still hold every block.
      if (i < 0) {
        const last = bestAt.get(a.hashes[a.hashes.length - 1]) + 1;
        if (last < best.hashes.length) lags.push(last);
        continue;
      }
      const stray = a.hashes[i];
      const shared = i > 0 ? bestAt.get(a.hashes[i - 1]) : undefined;
      // A TIP SPLIT SITS AT THE TIP OF BOTH CHAINS (kanban #1713, #1777, refute of #1529): it was taken from the forking source's
      // side alone, so one seat answering the honest chain up to block 10 plus 12 headers of its own was a "tip split" wherever it
      // sat, and cut the chain three honest seats agree on to 11 headers - below the census and the bonds. The split must also leave
      // at most TIP_SPLIT_BLOCKS blocks of the most-work chain out; deeper, the source is set aside as a fork.
      if (a.hashes.length - i > TIP_SPLIT_BLOCKS || shared === undefined
        || best.hashes.length - (shared + 1) > TIP_SPLIT_BLOCKS) {
        const why = `providers ${best.at} and ${a.at} do not agree on the chain: `
          + `${stray} is not in the one with the most work`;
        if (!firstFork) firstFork = why;
        forked.push({ at: a.at, why });
        continue;
      }
      splits.push(shared + 1);
    }
    const need = Math.max(least, 2);
    const agree = good.length - forked.length;
    if (forked.length && agree < need) return { ok: false, why: firstFork };
    // ONE SOURCE NEVER SHORTENS THE CHAIN THE OTHERS SHARE (kanban #1713, #1777): the chain is cut only as far as it takes for
    // `need` sources to agree on every block it holds - the longest length at which at most agree - need of the tip splits leave
    // it. Two sources split at the tip still stop at the last block both hold; one splitting source among three that agree on
    // the whole chain cuts nothing.
    // (a split source holds the most-work chain's first `s` blocks; at a length L it disagrees when s < L)
    const held = [...splits, ...lags];
    for (const at of [best.hashes.length, ...held.sort((x, y) => y - x)]) {
      cut = at;
      if (agree - held.filter((s) => s < at).length >= need) break;
    }
    // ONE BLOCK OF LAG STILL PASSES (kanban #1908): a source one block behind is every day, and with two sources the chain would
    // otherwise always stop a block short. Only past blocks no agreeing source contradicts (no tip split at or below the cut), at
    // most TIP_LAG_BLOCKS, and each no easier to mine than the easiest block the sources agree on - free headers do not pass.
    if (cut > 0 && cut < best.hashes.length && !splits.some((s) => s <= cut)) {
      let easiest = 0n;
      for (const h of best.headers.slice(0, cut)) { const t = targetOf(h); if (t > easiest) easiest = t; }
      const stop = Math.min(best.hashes.length, cut + TIP_LAG_BLOCKS);
      while (cut < stop && targetOf(best.headers[cut]) <= easiest) cut++;
    }

    return { ok: true, result: {
      ok: true,
      ...(cut < best.hashes.length ? { split: best.hashes.length - cut } : {}),
      headers: best.headers.slice(0, cut),
      work: best.work,
      from: best.at,
      agreed: good.length - forked.length,
      refused: [...bad, ...forked].map((b) => `provider ${b.at}: ${b.why}`),
    } };
  }
}

/**
 * THE CHAIN FROM A FEW SOURCES, NOT FROM EVERY SEAT (2026-10-16 ~10:58Z: "Lower the amount of concurrent
 * connections and network load"; measured 11:29Z on preview UI 153, Unity's PLAY tapped: "no chain: only 0 of 14 providers gave a
 * chain ... provider 0: no answer in 10000 ms" two seconds before the round's start). Every PLAY read /headers from all 14 seats at
 * once - 218800 bytes each, about 3 MB; curl from the test host took 1.6-5.3 s for the fourteen together, and a busy tab took more
 * than 10 s for every one; and building a round's committee read them again from every seat (committee.js: "0 of 14 providers
 * gave a chain", measured on preview UI 159). HEADER_SOURCES_ASKED distinct sources, picked at random so no seat carries every page: two must agree
 * (PROVIDERS_NEEDED), and two may be slow.
 */
export const HEADER_SOURCES_ASKED = 4;
// one source per seat: the origin and the first path segment (join.js sourceKey) - the seats behind one public host differ by path
const headerSourceKey = (u) => { try { const x = new URL(u); const head = x.pathname.split('/').filter(Boolean)[0] || ''; return head ? `${x.origin}/${head}` : x.origin; } catch { return null; } };
export function headerSources(urls, { n = HEADER_SOURCES_ASKED, random = Math.random } = {}) {
  const bySource = new Map();
  for (const u of urls || []) { const k = headerSourceKey(u); if (k && !bySource.has(k)) bySource.set(k, u); }
  const all = [...bySource.values()];
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  return all.slice(0, Math.max(2, n));
}
