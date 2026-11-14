// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import test from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "../../arena-node/node_modules/@noble/curves/secp256k1.js";
import { readFileSync } from "node:fs";
import { signedProposal, signedComment, newProposalKey, fetchProposals } from "../src/funding-page.js";
// kanban #2528 (Daniel 2026-11-14: links by proposal id): the forum's own link helpers, read from the page as forum-markdown.test.js reads its markdown
const forum = readFileSync(new URL("../../../src/arena-ui/proposals/forum.js", import.meta.url), "utf8");
const { hrefOf, idOfHash } = new Function(forum.slice(forum.indexOf("  function hrefOf(p)"), forum.indexOf("  // (end of the #2528 links)")) + "\nreturn { hrefOf, idOfHash };")();
const curve = { pointX: (k) => schnorr.getPublicKey(k), signSchnorr: (m, k) => schnorr.sign(m, k) };
const verify = (sig, msg, pk) => schnorr.verify(sig, msg, pk);
const NET = "1060078b1d4458b32c47aa68279f2260ad8e731ae365ce3f22260dbdc92d7a15";
const nodes = Array.from({ length: 7 }, (_, i) => `http://127.0.0.1:${9100 + i}`);
const fetcherOf = (lists, tip = 156905) => async (url) => { const i = Number(new URL(url).port) - 9100; return { ok: true, json: async () => ({ tip, proposals: lists[i] }) }; };
const mk = (h = 156900, purpose = "Pay me") => { const sk = newProposalKey(curve);
  const p = signedProposal({ curve, secretKey: sk, networkId: NET, publishedHeight: h, amountSats: 5000000, lnurl: "me@x.example", purpose });
  return { p, sk, view: { id: p.id, hex: p.hex, signal: { state: "passed", signalEnd: 157908, supporters: 3, active: 7 }, vote: null, cancelled: null, signals: [], comments: [] } }; };

// kanban #1617 refute (skeptic 2, stranger, reload path): the PIP number is meant never to change once held ("so a number never
// changes once the proposals before it are held"). A stranger signs a proposal backdated to block 1 (the seats refuse only one dated
// AHEAD of their chain), all seven seats keep it, and after a reload every PIP shifts: a shared #pip=1 link now opens the stranger's.
// kanban #2528 (Daniel 2026-11-14): links go by proposal id - the number may move, a shared link never opens another proposal.
test('a backdated proposal by a stranger does not renumber the PIPs already shown', async () => {
  const a = mk(156900, 'Pay the server bill'), b = mk(156950, 'Pay the artist');
  const before = await fetchProposals({ nodes, fetcher: fetcherOf(Array.from({ length: 7 }, () => [a.view, b.view])), verify });
  const pipA = before.proposals.find((x) => x.id === a.p.id).pip;
  assert.equal(pipA, 1);
  const s = mk(1, 'Pay the server bill - new address');
  const after = await fetchProposals({ nodes, fetcher: fetcherOf(Array.from({ length: 7 }, () => [a.view, b.view, s.view])), verify });
  // the PIP number is display only (it follows the author's own publishedHeight); the link a page shows and shares is the id
  const link = hrefOf(before.proposals.find((x) => x.id === a.p.id));
  assert.equal(link, `#p=${a.p.id}`);
  const opened = after.proposals.find((x) => x.id === idOfHash(link, after.proposals));
  assert.equal(opened.id, a.p.id, `the shared link now opens the stranger's ${JSON.stringify(opened.purpose)}`);
  assert.equal(after.proposals.find((x) => x.id === a.p.id).pip, 2, 'the number shown moved, the link did not');
});
