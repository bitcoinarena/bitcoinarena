// THE PROPOSALS FORUM (kanban #397, 2026-10-17: "Proposals are on a separate page and look like a forum"). Three views, by the
// address's hash: the thread list (#), one thread (#p=<proposal id>) and a new proposal (#new). What is shown is what five of the
// testnet's nodes hold (GET /funding); a thread or a reply is signed and handed to every node (POST /funding). It lives beside the
// Arena page (testnet.bitcoin-arena.io/proposals/) so it signs with THE PLAYER'S IN-GAME KEY (2026-10-17: "Users can sign in with
// their ingame key and their custom name or their generated name"): the identity key of the wallet phrase this browser keeps - the key
// the lobby and the board name a player by - and nothing else (2026-10-17: "no other options"). Everyone is shown by name: the one the player set (a
// signed name record the nodes keep, player-name.js), else the one made from the key. Each proposal is a PIP, numbered by
// publication. A new proposal shows the reserves and is refused before posting when it asks more than 10 % of them (rule 4).
(function () {
  var ARENA = window.ARENA_BASE || '/';
  var CAP_PCT = 10;
  var ROOT = '00'.repeat(32);
  var forum = document.getElementById('forum');
  var view = document.getElementById('view');
  var $ = function (q) { return forum.querySelector(q); };
  var state = { nodes: [], tip: null, network: null, key: null, keyFrom: null, list: null, reserves: null, names: {} };
  // EVERY VIEW IN REACT (kanban #564, 2026-10-21: "no fall backs"): the list, a thread and the three new-proposal forms drawn by
  // ./react.js (packages/arena-web/src/proposals) from view data made here; this script reads, signs and posts, and draws none of them
  var R = null;
  var reactReady = import('./react.js').then(function () { R = window.ArenaForum; });

  function npub(hex) { return ARENACLIENT.npubOfKey(hex); }
  function sats(n) { return Number(n).toLocaleString('en-US') + ' sat'; }
  function title(p) { var t = parts(p.purpose).title; return t.length > 90 ? t.slice(0, 88) + '…' : t; }
  // A PIP'S THREE PARTS (kanban #432, 2026-10-17: "Separate title field. Content on what the proposal does, in markdown including
  // tables. Separate text field how does it improve bitcoin arena"): kept in the proposal's one signed text (purpose, at most 4,000
  // characters) as its title line, the content, and a last section under IMPROVES - so the seats and the record stay as they are. An
  // older proposal has no such section: all of it after the title is its content.
  var IMPROVES = '## How it improves Bitcoin Arena';
  function parts(purpose) {
    var t = String(purpose || ''), nl = t.indexOf('\n');
    var head = (nl < 0 ? t : t.slice(0, nl)).trim(), rest = nl < 0 ? '' : t.slice(nl + 1);
    var at = rest.lastIndexOf('\n' + IMPROVES + '\n'), lead = rest.indexOf(IMPROVES + '\n') === 0 ? 0 : -1;
    var cut = at >= 0 ? at + 1 : lead;
    return { title: head, content: (cut >= 0 ? rest.slice(0, cut) : rest).trim(), improves: cut >= 0 ? rest.slice(cut + IMPROVES.length + 1).trim() : '' };
  }
  function purposeOf(t, content, improves) { return String(t).trim() + '\n\n' + String(content).trim() + '\n\n' + IMPROVES + '\n\n' + String(improves).trim(); }
  // MARKDOWN, SAFELY (#432): headings, paragraphs, **bold**, *italic*, `code`, fenced code, lists, quotes, links (http/https only) and
  // tables. Everything is escaped first; no HTML a writer types reaches the page.
  function esc(x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function inline(x) {
    var codes = [];
    x = esc(x).replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    x = x.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, t, u) { return '<a href="' + u + '" rel="noopener nofollow" target="_blank">' + t + '</a>'; })
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    return x.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[Number(i)] + '</code>'; });
  }
  function cells(line) { return line.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); }); }
  // A TABLE ROW (kanban #590, the owner 2026-10-23: "not sure how tables work" - "| a | b |" typed under a heading rendered as
  // text): a line that starts and ends with "|". Rows with a separator line (| --- | --- |) under the first are a table with
  // that first row as its header, each column aligned as its separator says (:-- left, :-: centre, --: right); rows without one
  // are a table too, all of them body rows.
  var ROW = /^\s*\|.*\|\s*$/, SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  function alignOf(c) { c = c.trim(); return /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''; }
  function cell(tag, text, align) { return '<' + tag + (align ? ' class="al-' + align + '"' : '') + '>' + inline(text) + '</' + tag + '>'; }
  function markdown(src) {
    var lines = String(src || '').replace(/\r/g, '').split('\n'), out = [], i = 0;
    while (i < lines.length) {
      var l = lines[i];
      if (/^```/.test(l)) { var code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); continue; }
      var h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) { var n = Math.min(6, h[1].length + 2); out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>'); i++; continue; }
      if (/\|/.test(l) && i + 1 < lines.length && SEP.test(lines[i + 1])) {
        var head = cells(l), align = cells(lines[i + 1]).map(alignOf), rows = []; i += 2;
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push('<div class="tbl"><table><thead><tr>' + head.map(function (c, k) { return cell('th', c, align[k]); }).join('') + '</tr></thead><tbody>'
          + rows.map(function (r) { return '<tr>' + head.map(function (_, k) { return cell('td', r[k] || '', align[k]); }).join('') + '</tr>'; }).join('') + '</tbody></table></div>');
        continue;
      }
      if (ROW.test(l)) {
        var body = [];
        while (i < lines.length && ROW.test(lines[i])) body.push(cells(lines[i++]));
        var width = Math.max.apply(null, body.map(function (r) { return r.length; }));
        out.push('<div class="tbl"><table><tbody>' + body.map(function (r) { var row = []; for (var k = 0; k < width; k++) row.push(cell('td', r[k] || '', '')); return '<tr>' + row.join('') + '</tr>'; }).join('')
          + '</tbody></table></div>');
        continue;
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
        var ordered = /^\s*\d+\./.test(l), items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        out.push((ordered ? '<ol>' : '<ul>') + items.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (/^>\s?/.test(l)) { var q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); out.push('<blockquote>' + inline(q.join(' ')) + '</blockquote>'); continue; }
      if (!l.trim()) { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s+)/.test(lines[i]) && !ROW.test(lines[i]) && !(/\|/.test(lines[i]) && i + 1 < lines.length && SEP.test(lines[i + 1]))) para.push(lines[i++]);
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('\n');
  }
  window.ARENA_FORUM_MD = markdown;
  function colour(hex) { var h = parseInt(hex.slice(0, 6), 16) % 360; return 'hsl(' + h + ' 70% 62%)'; }
  function who(hex) { return ARENACLIENT.forumNameOf(hex, state.names); }
  function pip(p) { return 'PIP-' + p.pip; }
  function mine() { return state.key ? ARENACLIENT.toHex(window.ARENA_CURVE.pointX(state.key)) : null; }
  function load(src) { return new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { bad(new Error('could not load ' + src)); }; document.head.appendChild(s); }); }
  // THE IN-GAME KEY: the wallet phrases this browser keeps for the Arena page (arena.seeds); the one whose wallet holds the most here,
  // as the page itself picks it - its identity key, the one the lobby, the board and the player's name go by
  function arenaKey() {
    try {
      var list = JSON.parse(localStorage.getItem('arena.seeds') || '[]').filter(function (x) { return x && /^[0-9a-f]{64}$/i.test(x.hex); });
      if (!list.length) return null;
      var n = function (x) { try { return ARENACLIENT.phraseWalletEntries ? ARENACLIENT.phraseWalletEntries(localStorage, x.hex) : 0; } catch (e) { return 0; } };
      var best = list.map(function (x, i) { return { x: x, i: i, n: n(x) }; }).sort(function (a, b) { return (b.n - a.n) || (a.i - b.i); })[0].x;
      return ARENACLIENT.forumIdentity(best.hex, window.ARENA_CURVE).secret;   // the in-game identity key (PIP)
    } catch (e) { return null; }
  }
  // ONLY THE IN-GAME KEY (2026-10-17: "Proposals always use the ingame key and name, no other options"): no nsec, no other key
  function pickKey() {
    var a = arenaKey();
    state.key = a; state.keyFrom = a ? 'arena' : null;
    showKey();
  }
  function showKey() {
    R.draw($('.key .id'), 'key', state.key ? { name: who(mine()), npub: ARENACLIENT.npubOf(state.key) } : {});
  }
  // THE BALANCE ON TOP (2026-10-17): the reserves the nodes agree on, and the most one PIP may ask
  function showBalance() {
    var b = document.getElementById('balance'); if (!b) return;
    R.draw(b, 'balance', { reserves: state.reserves, why: state.reservesWhy, capPct: CAP_PCT, open: location.hash === '#reserves' });
  }

  function stage(p) {
    if (p.cancelled) return { cls: 'no', text: 'Stopped' };
    var v = p.vote, s = p.signal || {};
    if (v && v.state === 'passed') return { cls: 'ok', text: 'Passed' };
    if (v && v.state === 'failed') return { cls: 'no', text: 'Vote failed' };
    if (v) return { cls: 'on', text: 'Voting' };
    if (s.state === 'failed') return { cls: 'no', text: 'Signal failed' };
    if (s.state === 'passed') return { cls: 'ok', text: 'Signal passed' };
    return { cls: 'on', text: 'Signalling' };
  }
  function stageLine(p) {
    var v = p.vote, s = p.signal || {};
    if (p.cancelled) return p.cancelled;
    if (v && v.count && v.count.approvalPct !== undefined) return 'Vote until block ' + v.last + ': YES ' + v.count.approvalPct + '% of the votes, ' + (v.count.yesOfAllPct || 0) + '% of everyone who could vote';
    if (s.state === 'failed') return 'Signal: ' + (s.supporters || 0) + ' of ' + (s.active || 0) + ' active nodes (15% needed)';
    return 'Signal open until block ' + s.signalEnd + ' · ' + (p.signals || 0) + ' node signal' + (p.signals === 1 ? '' : 's');
  }

  function postData(hex, head, more) {
    var n = who(hex);
    return Object.assign({ name: n, npub: npub(hex), head: head, avatar: { colour: colour(hex), initial: (n.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase() } }, more);
  }
  function listView() {
    R.draw(view, 'list', { status: state.list ? state.list.length + ' proposal' + (state.list.length === 1 ? '' : 's') + ' · ' + state.agreeing + ' of ' + state.asked + ' nodes answered · block ' + state.tip : 'Reading the nodes…',
      items: state.list && state.list.map(function (p) { return { pip: p.pip, href: '#pip=' + p.pip, title: title(p), by: who(p.author) + ' · block ' + p.publishedHeight + ' · to ' + p.lnurl,
        amount: sats(p.amountSats), replies: String(p.comments.length), stage: stage(p) }; }) });
  }

  // a reply signed with the in-game key and handed to every node: { ok, say }
  function postReply(p, text, parentId) {
    if (!state.key) return Promise.resolve({ ok: false, say: 'Open the Arena once first: the forum signs with your in-game key.' });
    var c = ARENACLIENT.signedComment({ secretKey: state.key, proposalId: p.id, parentId: parentId, atHeight: state.tip, text: text });
    return ARENACLIENT.postFunding({ nodes: state.nodes, kind: 'comment', hex: c.hex }).then(function (r) {
      if (!r.ok) return { ok: false, say: 'Not taken: ' + r.why };
      setTimeout(function () { refresh().then(route); }, 1500);
      return { ok: true, say: 'Posted to ' + r.took + ' of ' + r.asked + ' nodes.' };
    });
  }
  function threadView(id) {
    var p = (state.list || []).find(function (x) { return x.id === id; });
    var status = state.list ? 'That proposal is not held by five nodes.' : 'Reading the nodes…';
    if (!p) { R.draw(view, 'thread', { thread: null, status: status, onReply: function () { return Promise.resolve({ ok: false, say: '' }); } }); return; }
    var pp = parts(p.purpose), comments = [], byParent = {};
    p.comments.forEach(function (c) { (byParent[c.parent] = byParent[c.parent] || []).push(c); });
    (function walk(parent, depth) { (byParent[parent] || []).forEach(function (c) { comments.push(postData(c.author, 'block ' + c.atHeight, { id: c.id, depth: depth + 1, text: c.text })); walk(c.id, depth + 1); }); })(ROOT, 0);
    R.draw(view, 'thread', { status: status, onReply: function (text, parentId) { return postReply(p, text, parentId); },
      thread: { heading: pip(p) + ' · ' + title(p), amount: sats(p.amountSats), lnurl: p.lnurl, stage: stage(p), stageLine: stageLine(p), comments: comments,
        // an older proposal of one line: its whole line is what it says (the heading is cut at 90 characters)
        post: postData(p.author, 'proposed at block ' + p.publishedHeight + ' · held by ' + p.holding + ' nodes',
          { html: markdown(pp.content || pp.title) + (pp.improves ? '<h3 class="improves">How it improves Bitcoin Arena</h3>' + markdown(pp.improves) : '') }) } });
  }

  // THE TYPE OF A NEW PROPOSAL (kanban #548): payout to a Lightning address (the default), a leaderboard payout, or a change of fees -
  // one form, its fields following the type; the Why is never optional
  var TYPES = [['#new', 'Payout to Lightning address'], ['#new-leaderboard', 'Leaderboard payout'], ['#new-fees', 'Change fees']];
  // a new proposal signed with the in-game key and handed to every node, then its thread opened: { ok, say }
  function publish(x) {
    return (state.network ? Promise.resolve(state.network) : ARENACLIENT.fetchNetworkId({ nodes: state.nodes })).then(function (net) {
      if (!net) throw new Error('the nodes did not agree on their network');
      state.network = net;
      var p = ARENACLIENT.signedProposal({ secretKey: state.key, networkId: net, publishedHeight: state.tip, amountSats: x.amount, lnurl: x.lnurl, purpose: purposeOf(x.title, x.content, x.improves) });
      return ARENACLIENT.postFunding({ nodes: state.nodes, kind: 'proposal', hex: p.hex }).then(function (r) {
        if (!r.ok) return { ok: false, say: 'Not taken: ' + r.why };
        setTimeout(function () { refresh().then(function () { var q = (state.list || []).find(function (y) { return y.id === p.id; }); location.hash = q ? '#pip=' + q.pip : '#p=' + p.id; }); }, 1500);
        return { ok: true, say: 'Published to ' + r.took + ' of ' + r.asked + ' nodes. Its 1-week signal starts now.' };
      });
    }).catch(function (e) { return { ok: false, say: e.message }; });
  }
  function newView() {
    R.draw(view, 'new', { reserves: state.reserves, reservesWhy: state.reservesWhy, capPct: CAP_PCT, types: TYPES, hash: '#new', markdown: markdown, signedIn: !!state.key,
      purposeLength: function (t, c, i) { return purposeOf(t, c, i).length; }, onPublish: publish });
  }

  // CHANGE FEES (kanban #462, 2026-10-17: "Proposal type change fees. Any of the fees, all combinations can be changed with a
  // proposal"): the fees in force as the nodes answer them (GET /fees), one field per fee with its limit; any of them, in any
  // combination, is one proposal - checked by the seats' own rule (every limit and every sum of the whole set, an activation after
  // its signal and its vote) before it is signed, then handed to every node. Below, every fee proposal with its signal, its vote,
  // the protocol developers' answers (a donation change needs most of them) and its decision.
  var FEE_NAMES = { roundNodeBps: 'Game round: node fee', roundDonationBps: 'Game round: developers\' donation', roundReserveBps: 'Game round: protocol reserve',
    itemNodesPct: 'Item: nodes', itemReservesPct: 'Item: protocol reserve', itemDevsPct: 'Item: developers', marketNodeBps: 'Market: node fee',
    marketDonationBps: 'Market: developers\' donation', marketReserveBps: 'Market: protocol reserve', websitePct: 'Website share of the nodes\' fee' };
  function feeVal(k, v) { return ARENACLIENT.FEE_UNITS[k] === 'bps' ? (Number(v) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' %' : v + ' %'; }
  // the fees form's check, the seats' own rule through the client: { changes, say, bad } - changes null while it does not stand
  function feeCheck(r, typed, activation, purpose) {
    var ch;
    try { ch = ARENACLIENT.feeChangesFrom(r.fees, typed); } catch (e) { return { changes: null, say: e.message, bad: true }; }
    if (!ch.length) return { changes: null, say: 'Change at least one fee.', bad: false };
    var st = ARENACLIENT.feeProposalStands({ networkId: new Uint8Array(32), author: new Uint8Array(32), publishedHeight: Number(r.tip), activationHeight: activation, changes: ch, purpose: purpose }, { current: r.fees, schedule: r.schedule });
    if (!st.ok) return { changes: null, say: st.why, bad: true };
    return { changes: ch, say: ch.length + ' fee' + (ch.length === 1 ? '' : 's') + ' in one proposal' + (st.donations.length ? ' · changes a donation: most of the protocol developers must approve' : '') + '.', bad: false };
  }
  function feesView() {
    var common = { types: TYPES, hash: '#new-fees', feeVal: feeVal, markdown: markdown, signedIn: !!state.key, check: function () { return { changes: null, say: '', bad: false }; }, onPublish: function () { return Promise.resolve({ ok: false, say: '' }); } };
    R.draw(view, 'fees', Object.assign({}, common, { data: null }));
    ARENACLIENT.fetchFees({ nodes: state.nodes }).then(function (r) {
      if (location.hash !== '#new-fees') return;
      if (!r.ok) { R.draw(view, 'fees', Object.assign({}, common, { data: null, error: r.why })); return; }
      state.fees = r;
      var data = { tip: r.tip, agreeing: r.agreeing, asked: r.asked, sums: r.sums, fees: r.fees, limits: r.limits, keys: Object.keys(ARENACLIENT.FEES), names: FEE_NAMES, units: ARENACLIENT.FEE_UNITS,
        earliest: ARENACLIENT.earliestActivation(Number(r.tip), r.schedule), proposals: r.proposals };
      R.draw(view, 'fees', Object.assign({}, common, { data: data, check: function (typed, activation, purpose) { return feeCheck(r, typed, activation, purpose); },
        onPublish: function (x) {
          return (state.network ? Promise.resolve(state.network) : ARENACLIENT.fetchNetworkId({ nodes: state.nodes })).then(function (net) {
            if (!net) throw new Error('the nodes did not agree on their network');
            state.network = net;
            var p = ARENACLIENT.signedFeeProposal({ secretKey: state.key, networkId: net, publishedHeight: Number(r.tip), activationHeight: x.activation, changes: x.changes,
              purpose: x.purpose, current: r.fees, schedule: r.schedule, curve: window.ARENA_CURVE });
            if (!p.ok) throw new Error(p.why);
            return ARENACLIENT.postFunding({ nodes: state.nodes, kind: 'fee', hex: p.hex }).then(function (y) {
              if (!y.ok) return { ok: false, say: 'Not taken: ' + y.why };
              window.ARENA_FEE_PROPOSAL = { id: p.id, took: y.took, asked: y.asked };
              setTimeout(function () { R.clear(view); feesView(); }, 1500);
              return { ok: true, say: 'Published to ' + y.took + ' of ' + y.asked + ' nodes. Its signal starts now.' };
            });
          }).catch(function (e) { return { ok: false, say: e.message }; });
        } }));
      window.ARENA_FEES_VIEW = { inForce: r.fees, tip: r.tip, proposals: r.proposals.length, agreeing: r.agreeing };
    }).catch(function (e) { R.draw(view, 'fees', Object.assign({}, common, { data: null, error: e.message })); });
  }
  // A LEADERBOARD PAYOUT REQUEST (kanban #460, 2026-10-17: "distribution of X sats for the best 10 p&l of last week"; 2026-10-18:
  // "YES >= 25 % of the voting weight is enough on its own"): which game, market or all, the top N, the amount from one federation's
  // reserves (at most 10 % of them), equal or per place, the last 7 / 14 days or month, and the payment date. Its vote: 2 weeks from
  // publication, bond-weighted, no signal; it passes at YES >= 25 % of the voting weight. The winners' payouts land in their wallets as
  // zaps do. Below, every request with its vote.
  // the payout form in React (kanban #564): the request built and checked here, through the client - { ok, why } | { ok, request, say }
  function payoutView() {
    var common = { types: TYPES, hash: '#new-leaderboard', markdown: markdown, signedIn: !!state.key, check: function () { return { ok: false, why: '' }; }, onPublish: function () { return Promise.resolve({ ok: false, say: '' }); } };
    R.draw(view, 'payout', Object.assign({}, common, { data: null }));
    var base = String((state.nodes || [])[0] || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
    Promise.all([ARENACLIENT.fetchLeaderboards({ nodes: state.nodes }), fetch(base + '/reserves').then(function (r) { return r.json(); }).catch(function () { return { federations: [] }; })]).then(function (x) {
      if (location.hash !== '#new-leaderboard') return;
      var lbs = x[0], feds = (x[1].federations || []).filter(function (f) { return f.key || f.reserveKey; });
      var tip = Number(lbs.tip || state.tip || 0);
      var day = new Date(Date.now() + 15 * 86400000); day.setUTCHours(0, 0, 0, 0);
      var held = function (fd) { return Math.floor(Number(fd.heldMsat || 0) / 1000); };
      var list = lbs.ok ? lbs.leaderboards : [];
      var data = { feds: feds.map(function (fd) { return { id: fd.federationId, held: held(fd), max: Math.floor(held(fd) / 10) }; }), tip: tip, topMax: ARENACLIENT.LB_TOP_MAX, periods: ARENACLIENT.LB_PERIOD_DAYS,
        defaultDate: day.toISOString().slice(0, 10), listEmpty: lbs.ok ? 'No leaderboard payouts yet.' : lbs.why,
        list: list.map(function (p) { var v = p.vote || {}, cnt = v.count || {};
          return { id: p.id || (p.federation + p.paymentHeight + p.top), title: 'Top ' + p.top + ' · ' + Number(p.amountSats).toLocaleString('en-US') + ' sat',
            vote: (v.state || '…') + (cnt.yesOfAllPct !== undefined ? ' · YES ' + cnt.yesOfAllPct + ' % of the voting weight (25 % passes)' : ''),
            line: (p.scope === 0 ? 'all games and markets' : p.gameName) + ' · last ' + p.periodDays + ' days · paid at block ' + p.paymentHeight + ' from ' + p.federation.slice(0, 8) + (p.splitBps && p.splitBps.length ? ' · split ' + p.splitBps.map(function (b) { return b / 100 + ' %'; }).join(' / ') : ' · equal'),
            purpose: p.purpose }; }) };
      var check = function (v) {
        var sp = ARENACLIENT.splitFromPercents(v.split, Number(v.top));
        if (!sp.ok) return sp;
        var dateMs = Date.parse(v.date + 'T00:00:00Z');
        if (!(dateMs > Date.now())) return { ok: false, why: 'the payment date is in the future' };
        var b = { scope: Number(v.scope), gameName: v.game.trim(), top: Number(v.top), amountSats: v.amount ? Math.floor(Number(v.amount)) : 0, federationId: v.fed, splitBps: sp.splitBps,
          periodDays: Number(v.period), paymentHeight: ARENACLIENT.heightAtDate({ tip: tip, nowMs: Date.now(), dateMs: dateMs }), purpose: v.purpose };
        var fd = feds.find(function (z) { return z.federationId === b.federationId; }), cap = fd ? Math.floor(held(fd) / 10) : 0;
        if (b.amountSats && fd && b.amountSats > cap) return { ok: false, why: b.amountSats.toLocaleString('en-US') + ' sat is more than 10 % of that federation\'s reserves (' + cap.toLocaleString('en-US') + ' sat): it could never be paid.' };
        return { ok: true, request: b, say: 'Pays the top ' + b.top + ' at block ' + b.paymentHeight + (b.splitBps.length ? ' by the split' : ', equal') + '.' };
      };
      R.draw(view, 'payout', Object.assign({}, common, { data: data, check: check, onPublish: function (b) {
        return (state.network ? Promise.resolve(state.network) : ARENACLIENT.fetchNetworkId({ nodes: state.nodes })).then(function (net) {
          if (!net) throw new Error('the nodes did not agree on their network');
          state.network = net;
          var p = ARENACLIENT.signedLeaderboardPayout(Object.assign({ secretKey: state.key, networkId: net, publishedHeight: tip, curve: window.ARENA_CURVE }, b));
          if (!p.ok) throw new Error(p.why);
          return ARENACLIENT.postFunding({ nodes: state.nodes, kind: 'leaderboard', hex: p.hex }).then(function (y) {
            if (!y.ok) return { ok: false, say: 'Not taken: ' + y.why };
            window.ARENA_LEADERBOARD_PAYOUT = { id: p.id, took: y.took, asked: y.asked };
            setTimeout(function () { R.clear(view); payoutView(); }, 1500);
            return { ok: true, say: 'Published to ' + y.took + ' of ' + y.asked + ' nodes. Its 2-week vote starts now.' };
          });
        }).catch(function (e) { return { ok: false, say: e.message }; });
      } }));
      window.ARENA_PAYOUT_VIEW = { tip: tip, federations: feds.length, requests: list.length };
    }).catch(function (e) { R.draw(view, 'payout', Object.assign({}, common, { data: null, error: e.message })); });
  }
  // THE RESERVES IN DETAIL (kanban #589): every payment in as the first node that answers lists it (GET /reserves?all=1), each with its
  // kind - an item when it names one, a market when its app is one (the Up/Down family), else a game - and the payouts made
  // drawn right under the reserves box, the page's own view (the proposals) left as it is
  var detail = function () { return document.getElementById('reserves-detail'); };
  function reservesView() {
    R.draw(detail(), 'reserves', { rows: null });
    var nodes = (state.nodes || []).map(function (u) { return String(u).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, ''); });
    var tryNode = function (i) {
      if (i >= nodes.length) return Promise.reject(new Error('no node answered'));
      return fetch(nodes[i] + '/reserves?all=1', { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) { return { d: d, from: nodes[i] }; }).catch(function () { return tryNode(i + 1); });
    };
    tryNode(0).then(function (x) {
      if (location.hash !== '#reserves') return;
      // EVERY PAYMENT: each federation's own list (the answer's top-level paidIn is the newest 50 only)
      var all = (x.d.federations || []).reduce(function (t, f) { return t.concat((f.paidIn || []).map(function (p) { return Object.assign({ federationId: f.federationId }, p); })); }, []);
      var rows = (all.length ? all : (x.d.paidIn || [])).map(function (p) {
        var app = p.game || '–';
        return { outpoint: p.outpoint, at: String(p.at || ''), amountMsat: String(p.amountMsat || '0'), app: app, roundId: p.roundId,
          entryId: /^0+$/.test(String(p.entryId || '')) ? null : p.entryId, federation: p.federationId,
          kind: p.image ? 'item' : /updown|market/.test(app) ? 'market' : 'game' };
      }).sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
      R.draw(detail(), 'reserves', { rows: rows, payouts: x.d.payouts || [], status: 'Read from ' + x.from.replace(/^https?:\/\//, '') + ' (' + Number(x.d.totalMsat || 0) / 1000 + ' sat held).' });
    }).catch(function (e) { if (location.hash === '#reserves') R.draw(detail(), 'reserves', { rows: null, error: e.message }); });
  }
  function route() {
    var h = location.hash;
    showBalance();   // its Open / Close details button follows the view (kanban #589)
    // OPEN: the details under the box, the proposals under them as before; CLOSED: nothing there
    if (h === '#reserves') reservesView(); else if (detail()) R.draw(detail(), 'empty', { text: '' });
    if (h === '#payout' || h === '#fees') { location.replace(h === '#payout' ? '#new-leaderboard' : '#new-fees'); return; }   // the old links
    if (h === '#new-leaderboard') payoutView();
    else if (h === '#new-fees') feesView();
    else if (h === '#new') newView();
    else if (h.indexOf('#pip=') === 0) { var q = (state.list || []).find(function (x) { return String(x.pip) === h.slice(5); }); threadView(q ? q.id : ''); }
    else if (h.indexOf('#p=') === 0) threadView(h.slice(3)); else listView();
    showKey();
    window.ARENA_FORUM = { balance: (document.querySelector('#balance') || {}).textContent, view: h || '#', keyFrom: state.keyFrom, me: mine(), name: mine() ? who(mine()) : null, pips: (state.list || []).map(function (p) { return pip(p); }), reserves: state.reserves, proposals: state.list ? state.list.length : null, comments: state.list ? state.list.reduce(function (t, p) { return t + p.comments.length; }, 0) : null, agreeing: state.agreeing, tip: state.tip };
  }
  function refresh() {
    ARENACLIENT.fetchReservesTotal({ nodes: state.nodes }).then(function (r) {
      if (r.ok) { state.reserves = { sats: Number(r.totalMsat / 1000n), agreeing: r.agreeing, asked: r.asked }; state.reservesWhy = null; } else state.reservesWhy = r.why;
      showBalance();
      if (location.hash === '#new') newView();   // React keeps what was typed
    }).catch(function (e) { state.reservesWhy = e.message; showBalance(); });
    return ARENACLIENT.fetchProposals({ nodes: state.nodes, verify: window.ARENA_CURVE.verify }).then(function (r) {
      if (!r.ok) { state.list = []; state.agreeing = 0; state.asked = r.asked; return; }
      state.list = r.proposals; state.tip = r.tip; state.agreeing = r.agreeing; state.asked = r.asked; state.names = r.names || {};
    });
  }

  fetch(ARENA + 'daily.json').then(function (r) { return r.json(); }).then(function (d) {
    state.nodes = ((d.testnet || {}).node || []);
    return load(ARENA + 'arena-curve.js').then(function () { return load(ARENA + 'arena-client.js'); });
    // the key and the reserves are drawn by React too: nothing is drawn before it is here
  }).then(function () { return reactReady; }).then(function () {
    pickKey();
    return refresh().then(function () { window.addEventListener('hashchange', route); route(); });
  }).catch(function (e) { reactReady.then(function () { R.draw(view, 'empty', { text: e.message }); }); });
})();
