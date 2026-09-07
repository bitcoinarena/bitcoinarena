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

/**
 * One provider's answer, over HTTP, as 80-byte records back to back.
 *
 * THE CALLER GIVES THE WHOLE URL. No host and no path is written here: this
 * protocol has no chain API of its own, and inventing one - even as a default
 * - would put an address in the client that a player never chose. What a real
 * provider's URLs look like is a separate question from what a client does
 * with the bytes, and only the second one is decided here.
 */
export async function headersOverHttp(url, { fetcher = fetch } = {}) {
  const r = await fetcher(url);
  if (!r.ok) throw new Error(`the provider answered ${r.status}`);
  const body = new Uint8Array(await r.arrayBuffer());
  if (body.length === 0 || body.length % HEADER_BYTES !== 0)
    throw new Error(`${body.length} bytes is not a whole number of headers`);
  const out = [];
  for (let at = 0; at < body.length; at += HEADER_BYTES)
    out.push(body.subarray(at, at + HEADER_BYTES));
  return out;
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
export async function agreedChain(providers, { least = 2, timeoutMs = 10000 } = {}) {
  if (!providers || providers.length < least)
    return { ok: false, why: `${(providers || []).length} providers is fewer than the ${least} it takes to weigh one against another` };

  const answers = await Promise.all(providers.map(async (p, at) => {
    let timer;
    try {
      // A provider that never answers must not stop the ones that did. The
      // timer is cleared and unreferenced either way, or a client that got its
      // chain would sit waiting for a source it no longer needs.
      const headers = await Promise.race([
        Promise.resolve().then(() => p()),
        new Promise((_, no) => {
          timer = setTimeout(() => no(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
          if (timer.unref) timer.unref();
        }),
      ]);
      const seen = chainWork(headers);
      if (!seen.ok) return { at, ok: false, why: seen.why };
      return { at, ok: true, headers, work: seen.work, hashes: tips(headers) };
    } catch (e) {
      return { at, ok: false, why: e.message };
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
