#!/usr/bin/env python3
# kanban #3265 (#3251): the Arena page around the Orange Pill Run. Applied to src/arena-ui/index.html (committed) and to a stage page's index.html
# (the stage is the live page + stage-2641/apply.sh; this runs after it). Usage: opr-page.py <index.html> - edits it in place, refuses a missing anchor,
# and does nothing to a page that has it already.
#  1. ?game=orange-pill-run: a tab with no wallet makes one at once (the wallet screen's own Create, its welcome asked at once) and the seed words
#     wait for Settings - the game starts at once.
#  2. the game is the page's games/orange-pill-run/index.html in a frame of this origin (#arena-client, as another game's client), with
#     window.ARENA_OPR: the identity key's NIP-98 sign-in, the spendable balance, the welcome's state, the page's pay-an-invoice path, the X link.
#  3. the zaps' pay() is the page's one pay-an-invoice path (window.ARENA_PAY_INVOICE).
import sys

p = sys.argv[1]
s = open(p, encoding="utf-8").read()
if "ARENA_OPR_START" in s:
    print("opr-page: already applied", p)
    sys.exit(0)


def put(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        sys.exit(f"opr-page: anchor found {n} times, not {count}: {old[:80]!r}")
    s = s.replace(old, new)


# 3. the zaps' pay, for the game
put("      window.ARENA_ZAP = { open, close };\n",
    "      window.ARENA_ZAP = { open, close };\n"
    "      window.ARENA_PAY_INVOICE = pay;   // kanban #3265: the page's one pay-an-invoice path (NWC when connected, else the player wallet's withdraw to exactly this invoice)\n")

# 1. the wallet made at once on the game's link
put("        setTimeout(() => { if (window.ARENA_SHOW_SEED) window.ARENA_SHOW_SEED(); }, 0);\n        return { ok: true };\n      };\n",
    "        if (!window.ARENA_OPR_PAGE) setTimeout(() => { if (window.ARENA_SHOW_SEED) window.ARENA_SHOW_SEED(); }, 0);   // kanban #3265: the Orange Pill Run starts at once; the words are in Settings\n"
    "        return { ok: true };\n      };\n"
    "      // THE ORANGE PILL RUN'S LINK PLAYS AT ONCE (kanban #3265, the owner 2026-11-21 ~23:05Z: someone who opens the game URL directly has a new, empty wallet and can still\n"
    "      // join and start playing at once): no screen to choose a wallet - this Create, its welcome asked at once, the seed words kept for Settings\n"
    "      if (window.ARENA_OPR_PAGE) { const made = create(); console.log('[arena] #3265 orange pill run: a new wallet made at once' + (made.ok ? '' : ': ' + made.why)); return; }\n")

# 2. the game in a frame of this page, and its bridge
OPR = r"""    // THE ORANGE PILL RUN (kanban #3245, #3251, #3265): not a node-hosted game - its round service is /api/opr on this origin. Its one-file client,
    // games/orange-pill-run/index.html, runs in a frame of this page (#arena-client, as any game's own client) and is handed window.ARENA_OPR: the
    // identity key's sign-in (NIP-98, kind 27235, the feedback's), the wallet's spendable balance, whether the welcome is on its way, the page's
    // pay-an-invoice path (the zaps' pay; with no paying round listed, the same withdraw of the player wallet that holds the most), and the bug bounty's
    // X link (My feedback). The lobby of the node games is never read here.
    window.ARENA_OPR_PAGE = window.ARENA_SITE_GAME === 'orange-pill-run';
    window.ARENA_OPR = {
      v: 1,
      apiBase: location.origin + '/api/opr', signBase: location.origin + '/api/opr',
      pubkey: () => { try { return ARENACLIENT.tabIdentity({ storage: window.sessionStorage, random: () => { throw new Error('this tab has no wallet yet'); }, curve: window.ARENA_CURVE }).pubkeyHex || null; } catch { return null; } },
      signHttpAuth: (tags) => ARENACLIENT.identitySignEvent({ kind: 27235, tags, content: '' }, { storage: window.sessionStorage, random: () => { throw new Error('this tab has no wallet yet'); }, curve: window.ARENA_CURVE }),
      // what can pay now: notes still being issued or merged are not spendable yet (moneyFirst's rule)
      balance: () => { const b = window.ARENA_WALLET_BALANCE; if (!b) return null;
        const parts = Array.isArray(b.parts) ? b.parts : [];
        const spend = parts.length ? parts.reduce((t, p) => t + Math.max(0, Number(p.sats) - Number(p.merging || 0) - Number(p.arriving || 0)), 0) : Number(b.sats || 0);
        return { sats: spend, total: Number(b.sats || 0) }; },
      welcomeComing: () => { if (window.ARENA_WELCOME_WAIT || window.ARENA_WELCOME_ASKING) return true; try { return !!localStorage.getItem('arena.welcome.pending'); } catch { return false; } },
      pay: async (invoice) => {
        const ctx = typeof moneyContext === 'function' ? moneyContext('withdraw') : { ok: false };
        if (ctx.ok && window.ARENA_PAY_INVOICE) return window.ARENA_PAY_INVOICE(invoice);
        const a = ARENACLIENT.invoiceAmountMsat(invoice); if (!a.ok) return { ok: false, why: a.why };
        const lob = window.ARENA_LEDGER_LOBBY, seed = typeof walletSeed === 'function' ? walletSeed() : null;
        if (!lob || !lob.federation || !seed) return { ok: false, why: 'the wallet is still opening' };
        const statuses = window.ARENA_FED_LOADS && window.ARENA_FED_LOADS.size ? [...window.ARENA_FED_LOADS.values()] : [];
        const out = ARENACLIENT.withdrawFederation({ lobbyInvite: lob.federation, parts: (window.ARENA_WALLET_BALANCE && window.ARENA_WALLET_BALANCE.parts) || [], statuses });
        if (!out || !out.federation || !out.invite) return { ok: false, why: 'no sats in the wallet yet' };
        const wasm = await window.ARENA_LOCK_WASM(); await wasm.default();
        const fid = String(out.federation).toLowerCase();
        let client = window.ARENA_WALLETS && window.ARENA_WALLETS.get(fid);
        if (!client) { client = await ARENACLIENT.openPlayerWallet({ federationId: ARENACLIENT.fromHex(fid), invite: out.invite, seed, LockClient: wasm.LockClient, storage: vault() }); window.ARENA_KEEP_WALLET(fid, client); }
        window.ARENA_TRACK('withdraw-sent', { from: 'orange-pill-run' });
        const r = await ARENACLIENT.withdrawCollected({ client, invoiceFor: async () => ({ ok: true, invoice }), amountMsat: a.msat, gateways: window.ARENA_LEDGER_GATEWAYS || [] })
          .catch((e) => ({ ok: false, why: (e && e.message) || String(e) }));
        try { if (window.ARENA_READ_BALANCE) window.ARENA_READ_BALANCE(); } catch { /* the balance only */ }
        console.log('[arena] #3265 orange pill run entry: ' + (r.ok ? 'paid' : 'not paid: ' + r.why));
        return r.ok ? { ok: true, preimage: r.preimage, by: 'your player wallet' } : { ok: false, why: r.why };
      },
      linkX: () => { if (window.ARENA_MY_FEEDBACK) window.ARENA_MY_FEEDBACK(); },
    };
    window.ARENA_OPR_START = () => {
      if (window.ARENA_OPR_ON) return new Promise(() => {});
      window.ARENA_OPR_ON = true;
      window.ARENA_GAME_NAME = 'orange-pill-run';
      window.ARENA_TRACK('game-open', { game: 'orange-pill-run' });
      if (window.ARENA_OPEN_WALLET_EARLY) window.ARENA_OPEN_WALLET_EARLY(window.ARENA_LEDGER_LOBBY);
      const frame = document.createElement('iframe');
      frame.id = 'arena-client'; frame.title = 'Orange Pill Run'; frame.allow = 'autoplay';
      frame.src = 'games/orange-pill-run/index.html' + location.hash;
      document.body.classList.add('arena-own-client');
      document.body.appendChild(frame);
      const deposit = document.getElementById('arena-deposit'); if (deposit) document.body.appendChild(deposit);
      const b = document.getElementById('boot'); if (b) { b.classList.add('done'); setTimeout(() => { if (b.parentNode) b.remove(); }, 300); }
      frame.addEventListener('load', () => { try { frame.contentWindow.focus(); } catch { /* another origin */ } }, { once: true });
      console.log('[arena] #3265 orange pill run: its client in a frame, the wallet ' + (walletSeed() ? 'open' : 'being made'));
      return new Promise(() => {});   // the node games' lobby is not read for this game
    };
    async function chooseTheGame(nodes) {
      if (window.ARENA_OPR_PAGE) return window.ARENA_OPR_START();
"""
put("    async function chooseTheGame(nodes) {\n", OPR)

open(p, "w", encoding="utf-8").write(s)
print("opr-page: applied", p)
