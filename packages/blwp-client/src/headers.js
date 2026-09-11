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
import { chainWork, blockHashOf } from '../../protocol/src/chain.js';
import { HEADER_BYTES } from '../../protocol/src/chain.js';
import { toHex } from '../../protocol/src/hash.js';
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
  let best = good[0];
  for (const a of good) if (a.work > best.work) best = a;
  const inBest = new Set(best.hashes);

  for (const a of good) {
    // ANSWERS ABOUT DIFFERENT PARTS OF THE CHAIN used to be told apart from a
    // fork here, and that branch is gone rather than left unreachable: every
    // chain that gets this far contains the anchor, so any two of them share
    // at least that block, and no test or mutant could ever reach it again. A
    // provider whose range does not reach the anchor is refused earlier, by
    // name, which is the same fact said in the right place.
    const stray = a.hashes.find((h) => !inBest.has(h));
    if (stray) {
      return {
        ok: false,
        why: `providers ${best.at} and ${a.at} do not agree on the chain: `
          + `${stray} is not in the one with the most work`,
      };
    }
  }

  return {
    ok: true,
    headers: best.headers,
    work: best.work,
    from: best.at,
    agreed: good.length,
    refused: bad.map((b) => `provider ${b.at}: ${b.why}`),
  };
}
