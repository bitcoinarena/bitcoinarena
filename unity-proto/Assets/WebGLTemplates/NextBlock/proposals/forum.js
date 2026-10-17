// THE PROPOSALS FORUM (kanban #397, the owner 2026-10-17: "Proposals are on a separate page and look like a forum"). Three views, by the
// address's hash: the thread list (#), one thread (#p=<proposal id>) and a new proposal (#new). What is shown is what five of the
// testnet's nodes hold (GET /funding); a thread or a reply is signed and handed to every node (POST /funding). It lives beside the
// Arena page (testnet.bitcoin-arena.io/proposals/) so it signs with THE PLAYER'S IN-GAME KEY (the owner 2026-10-17: "Users can sign in with
// their ingame key and their custom name or their generated name"): the identity key of the wallet phrase this browser keeps - the key
// the lobby and the board name a player by - and nothing else (the owner 2026-10-17: "no other options"). Everyone is shown by name: the one the player set (a
// signed name record the nodes keep, player-name.js), else the one made from the key. Each proposal is a PIP, numbered by
// publication. A new proposal shows the reserves and is refused before posting when it asks more than 10 % of them (rule 4).
(function () {
  var ARENA = window.ARENA_BASE || '/';
  var CAP_PCT = 10;
  var ROOT = '00'.repeat(32);
  var forum = document.getElementById('forum');
  var view = document.getElementById('view');
  var $ = function (q) { return forum.querySelector(q); };
  var state = { nodes: [], tip: null, network: null, key: null, keyFrom: null, list: null, replyTo: null, reserves: null, names: {} };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function npub(hex) { return BLWPCLIENT.npubOfKey(hex); }
  function short(n) { return n.slice(0, 10) + '…' + n.slice(-4); }
  function sats(n) { return Number(n).toLocaleString('en-US') + ' sat'; }
  function title(p) { var t = parts(p.purpose).title; return t.length > 90 ? t.slice(0, 88) + '…' : t; }
  // A PIP'S THREE PARTS (kanban #432, the owner 2026-10-17: "Separate title field. Content on what the proposal does, in markdown including
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
  function markdown(src) {
    var lines = String(src || '').replace(/\r/g, '').split('\n'), out = [], i = 0;
    while (i < lines.length) {
      var l = lines[i];
      if (/^```/.test(l)) { var code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); continue; }
      var h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) { var n = Math.min(6, h[1].length + 2); out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>'); i++; continue; }
      if (/\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        var head = cells(l), rows = []; i += 2;
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push('<div class="tbl"><table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>'
          + rows.map(function (r) { return '<tr>' + head.map(function (_, k) { return '<td>' + inline(r[k] || '') + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>');
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
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s+)/.test(lines[i]) && !(/\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]))) para.push(lines[i++]);
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('\n');
  }
  window.ARENA_FORUM_MD = markdown;
  function colour(hex) { var h = parseInt(hex.slice(0, 6), 16) % 360; return 'hsl(' + h + ' 70% 62%)'; }
  function who(hex) { return BLWPCLIENT.forumNameOf(hex, state.names); }
  function pip(p) { return 'PIP-' + p.pip; }
  function avatar(hex) { var a = el('div', 'ava', (who(hex).match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase()); a.style.background = colour(hex); a.title = npub(hex); return a; }
  function mine() { return state.key ? BLWPCLIENT.toHex(window.BLWP_CURVE.pointX(state.key)) : null; }
  function load(src) { return new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { bad(new Error('could not load ' + src)); }; document.head.appendChild(s); }); }
  // THE IN-GAME KEY: the wallet phrases this browser keeps for the Arena page (arena.seeds); the one whose wallet holds the most here,
  // as the page itself picks it - its identity key, the one the lobby, the board and the player's name go by
  function arenaKey() {
    try {
      var list = JSON.parse(localStorage.getItem('arena.seeds') || '[]').filter(function (x) { return x && /^[0-9a-f]{64}$/i.test(x.hex); });
      if (!list.length) return null;
      var n = function (x) { try { return BLWPCLIENT.phraseWalletEntries ? BLWPCLIENT.phraseWalletEntries(localStorage, x.hex) : 0; } catch (e) { return 0; } };
      var best = list.map(function (x, i) { return { x: x, i: i, n: n(x) }; }).sort(function (a, b) { return (b.n - a.n) || (a.i - b.i); })[0].x;
      return BLWPCLIENT.forumIdentity(best.hex, window.BLWP_CURVE).secret;   // the in-game identity key (PIP)
    } catch (e) { return null; }
  }
  // ONLY THE IN-GAME KEY (the owner 2026-10-17: "Proposals always use the ingame key and name, no other options"): no nsec, no other key
  function pickKey() {
    var a = arenaKey();
    state.key = a; state.keyFrom = a ? 'arena' : null;
    showKey();
  }
  function showKey() {
    var id = $('.key .id'); id.textContent = '';
    if (state.key) { var b = el('b', null, who(mine())); b.title = BLWPCLIENT.npubOf(state.key);
      id.append(document.createTextNode('Signed in as '), b, document.createTextNode(' · your in-game key and name')); }
    else id.textContent = 'Read freely. To post, open the Arena once: the forum signs with the key and the name you play with.';
  }
  // THE BALANCE ON TOP (the owner 2026-10-17): the reserves the nodes agree on, and the most one PIP may ask
  function showBalance() {
    var b = document.getElementById('balance'); if (!b) return;
    var r = state.reserves;
    b.querySelector('.sats').textContent = r ? sats(r.sats) : '–';
    b.querySelector('.sub').textContent = r ? r.agreeing + ' of ' + r.asked + ' nodes agree · a PIP may ask up to ' + sats(Math.floor(r.sats * CAP_PCT / 100))
      : (state.reservesWhy ? 'could not be read: ' + state.reservesWhy : 'reading the nodes');
  }
  function say(node, text, bad) { node.textContent = text; node.classList.toggle('bad', !!bad); }

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

  function listView() {
    view.textContent = '';
    var bar = el('div', 'bar');
    var st = el('span', 'say', state.list ? state.list.length + ' proposal' + (state.list.length === 1 ? '' : 's') + ' · ' + state.agreeing + ' of ' + state.asked + ' nodes answered · block ' + state.tip : 'Reading the nodes…');
    var nw = el('a', 'btn primary grow', 'New proposal'); nw.href = '#new';
    bar.append(st, nw); view.append(bar);
    var t = el('div', 'topics');
    var th = el('div', 'th'); th.append(el('span', null, 'Proposal'), el('span', 'n', 'Amount'), el('span', 'n', 'Replies'), el('span', 'n', 'Stage')); t.append(th);
    if (state.list && !state.list.length) t.append(el('div', 'empty', 'No proposals yet. Start the first one.'));
    (state.list || []).forEach(function (p) {
      var a = el('a', 'topic'); a.href = '#pip=' + p.pip;
      var c = el('span', 't'); c.append(el('span', 'pip', pip(p)), document.createTextNode(' ' + title(p)), el('span', 'by', who(p.author) + ' · block ' + p.publishedHeight + ' · to ' + p.lnurl));
      var sg = stage(p);
      a.append(c, el('span', 'amt', sats(p.amountSats)), el('span', 'n', String(p.comments.length)), el('span', 'stage ' + sg.cls, sg.text));
      t.append(a);
    });
    view.append(t);
  }

  function postNode(hex, head, body, extra, depth) {
    var p = el('article', 'post' + (depth ? ' reply' : '')); if (depth) p.style.setProperty('--depth', Math.min(depth, 4));
    var col = el('div');
    var line = el('div', 'who'); var b = el('b', null, who(hex)); b.title = npub(hex); line.append(b, document.createTextNode(' · ' + head));
    var bd = el('div', 'body'); if (body && body.html !== undefined) { bd.classList.add('md'); bd.innerHTML = body.html; } else bd.textContent = body;
    col.append(line, bd);
    if (extra) col.append(extra);
    p.append(avatar(hex), col);
    return { node: p, col: col };
  }

  function threadView(id) {
    var p = (state.list || []).find(function (x) { return x.id === id; });
    view.textContent = '';
    var back = el('a', 'btn', '← All proposals'); back.href = '#';
    var bar = el('div', 'bar'); bar.append(back); view.append(bar);
    if (!p) { view.append(el('div', 'empty', state.list ? 'That proposal is not held by five nodes.' : 'Reading the nodes…')); return; }
    var sg = stage(p);
    view.append(el('h1', null, pip(p) + ' · ' + title(p)));
    var facts = el('div', 'facts');
    var amt = el('span'); amt.append(el('b', null, sats(p.amountSats)), document.createTextNode(' to ' + p.lnurl)); facts.append(amt, el('span', 'stage ' + sg.cls, sg.text), el('span', null, stageLine(p)));
    var pp = parts(p.purpose);
    // an older proposal of one line: its whole line is what it says (the title above is cut at 90 characters)
    var html = markdown(pp.content || pp.title) + (pp.improves ? '<h3 class="improves">How it improves Bitcoin Arena</h3>' + markdown(pp.improves) : '');
    view.append(postNode(p.author, 'proposed at block ' + p.publishedHeight + ' · held by ' + p.holding + ' nodes', { html: html }, facts, 0).node);
    var byParent = {};
    p.comments.forEach(function (c) { (byParent[c.parent] = byParent[c.parent] || []).push(c); });
    (function walk(parent, depth) {
      (byParent[parent] || []).forEach(function (c) {
        var acts = el('div', 'acts'); var r = el('button', null, 'Reply'); r.type = 'button';
        r.addEventListener('click', function () { state.replyTo = c.id; ta.placeholder = 'Reply to ' + who(c.author); ta.focus(); });
        acts.append(r);
        view.append(postNode(c.author, 'block ' + c.atHeight, c.text, acts, depth + 1).node);
        walk(c.id, depth + 1);
      });
    })(ROOT, 0);
    var form = el('form', 'compose'); var ta = el('textarea'); ta.rows = 4; ta.maxLength = 4000; ta.placeholder = 'Write a reply';
    var send = el('button', 'btn primary', 'Post reply'); send.type = 'submit'; var out = el('span', 'say');
    var row = el('div', 'bar'); row.append(send, out); form.append(ta, row);
    form.addEventListener('submit', function (e) {
      e.preventDefault(); if (!ta.value.trim()) return;
      if (!state.key) { say(out, 'Open the Arena once first: the forum signs with your in-game key.', true); return; }
      var c = BLWPCLIENT.signedComment({ secretKey: state.key, proposalId: p.id, parentId: state.replyTo, atHeight: state.tip, text: ta.value });
      say(out, 'Sending…');
      BLWPCLIENT.postFunding({ nodes: state.nodes, kind: 'comment', hex: c.hex }).then(function (r) {
        if (!r.ok) { say(out, 'Not taken: ' + r.why, true); return; }
        say(out, 'Posted to ' + r.took + ' of ' + r.asked + ' nodes.'); ta.value = ''; state.replyTo = null; setTimeout(function () { refresh().then(route); }, 1500);
      });
    });
    view.append(form);
  }

  function newView() {
    view.textContent = '';
    var back = el('a', 'btn', '← All proposals'); back.href = '#';
    var bar = el('div', 'bar'); bar.append(back); view.append(bar, el('h1', null, 'New proposal'));
    var f = el('form', 'compose');
    var r = state.reserves, max = r ? Math.floor(r.sats * CAP_PCT / 100) : null;
    var reservesLine = r ? 'The protocol reserves hold <b>' + r.sats.toLocaleString('en-US') + ' sat</b> (' + r.agreeing + ' of ' + r.asked + ' nodes agree). A proposal may ask at most <b>' + CAP_PCT + '%: ' + max.toLocaleString('en-US') + ' sat</b>.'
      : 'The reserves could not be read' + (state.reservesWhy ? ': ' + state.reservesWhy : '') + '. A proposal may ask at most ' + CAP_PCT + '% of them.';
    f.innerHTML = '<p class="reserves-line">' + reservesLine + '</p>' +
      '<label>Title<input name="title" maxlength="120" required placeholder="A short name for the PIP"></label>' +
      '<label>What the proposal does <span class="hint">Markdown: # headings, **bold**, lists, `code`, links and tables (| a | b |)</span><textarea name="content" rows="10" required></textarea></label>' +
      '<div class="bar"><button type="button" class="btn preview-go">Preview</button><span class="say count"></span></div><div class="md preview" hidden></div>' +
      '<label>How it improves Bitcoin Arena <span class="hint">its games, its protocol, its tools or its players</span><textarea name="improves" rows="4" required></textarea></label>' +
      '<div class="row"><label>Amount (sat)<input name="amount" type="number" min="1" step="1" required' + (max ? ' max="' + max + '"' : '') + '></label><label>Lightning address to pay<input name="lnurl" placeholder="you@wallet.example" required></label></div>' +
      '<div class="bar"><button class="btn primary" type="submit">Sign and publish</button><span class="say out"></span></div>';
    var check = function () {
      var a = Number(f.amount.value), out = f.querySelector('.out');
      if (!f.amount.value) { say(out, ''); return true; }
      if (!(a >= 1)) { say(out, 'Ask at least 1 sat.', true); return false; }
      if (!r) { say(out, 'The reserves could not be read, so the amount cannot be checked yet.', true); return false; }
      if (a > max) { say(out, a.toLocaleString('en-US') + ' sat is more than ' + CAP_PCT + '% of the reserves (' + max.toLocaleString('en-US') + ' sat): it could never be paid.', true); return false; }
      if (!/^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(f.lnurl.value.trim()) && !/^lnurl1[02-9ac-hj-np-z]{20,}$/i.test(f.lnurl.value.trim())) { if (f.lnurl.value) { say(out, 'That is not a Lightning address (you@wallet.example) or an LNURL.', true); return false; } }
      say(out, 'Within the cap: ' + (a * 100 / r.sats).toFixed(2) + '% of the reserves.'); return true;
    };
    f.amount.addEventListener('input', check); f.lnurl.addEventListener('input', check);
    // the one signed text holds all three parts: at most 4,000 characters (the record's limit), counted as typed
    var used = function () { return purposeOf(f.title.value, f.content.value, f.improves.value).length; };
    var count = function () { var n = used(); say(f.querySelector('.count'), n.toLocaleString('en-US') + ' of 4,000 characters', n > 4000); return n <= 4000; };
    [f.title, f.content, f.improves].forEach(function (x) { x.addEventListener('input', count); });
    f.querySelector('.preview-go').addEventListener('click', function () {
      var pv = f.querySelector('.preview'); pv.hidden = !pv.hidden; this.textContent = pv.hidden ? 'Preview' : 'Hide preview';
      pv.innerHTML = '<h3>' + esc(f.title.value) + '</h3>' + markdown(f.content.value) + '<h3 class="improves">How it improves Bitcoin Arena</h3>' + markdown(f.improves.value);
    });
    count();
    f.addEventListener('submit', function (e) {
      e.preventDefault(); var out = f.querySelector('.out');
      if (!state.key) { say(out, 'Open the Arena once first: the forum signs with your in-game key.', true); return; }
      if (!f.title.value.trim() || !f.content.value.trim() || !f.improves.value.trim()) { say(out, 'Fill in the title, what it does, and how it improves Bitcoin Arena.', true); return; }
      if (/\n/.test(f.title.value)) { say(out, 'The title is one line.', true); return; }
      if (!count()) { say(out, 'The three parts together are more than 4,000 characters.', true); return; }
      if (!check() || !f.lnurl.value.trim()) { if (!f.lnurl.value.trim()) say(out, 'Name the Lightning address to pay.', true); return; }
      var amount = Number(f.amount.value);
      say(out, 'Signing…');
      (state.network ? Promise.resolve(state.network) : BLWPCLIENT.fetchNetworkId({ nodes: state.nodes })).then(function (net) {
        if (!net) throw new Error('the nodes did not agree on their network');
        state.network = net;
        var p = BLWPCLIENT.signedProposal({ secretKey: state.key, networkId: net, publishedHeight: state.tip, amountSats: Math.floor(amount), lnurl: f.lnurl.value, purpose: purposeOf(f.title.value, f.content.value, f.improves.value) });
        return BLWPCLIENT.postFunding({ nodes: state.nodes, kind: 'proposal', hex: p.hex }).then(function (r) { return { r: r, id: p.id }; });
      }).then(function (x) {
        if (!x.r.ok) { say(out, 'Not taken: ' + x.r.why, true); return; }
        say(out, 'Published to ' + x.r.took + ' of ' + x.r.asked + ' nodes. Its 1-week signal starts now.');
        setTimeout(function () { refresh().then(function () { var q = (state.list || []).find(function (y) { return y.id === x.id; }); location.hash = q ? '#pip=' + q.pip : '#p=' + x.id; }); }, 1500);
      }).catch(function (x) { say(out, x.message, true); });
    });
    view.append(f);
  }

  function route() {
    var h = location.hash;
    if (h === '#new') newView();
    else if (h.indexOf('#pip=') === 0) { var q = (state.list || []).find(function (x) { return String(x.pip) === h.slice(5); }); threadView(q ? q.id : ''); }
    else if (h.indexOf('#p=') === 0) threadView(h.slice(3)); else listView();
    showKey();
    window.ARENA_FORUM = { balance: (document.querySelector('#balance') || {}).textContent, view: h || '#', keyFrom: state.keyFrom, me: mine(), name: mine() ? who(mine()) : null, pips: (state.list || []).map(function (p) { return pip(p); }), reserves: state.reserves, proposals: state.list ? state.list.length : null, comments: state.list ? state.list.reduce(function (t, p) { return t + p.comments.length; }, 0) : null, agreeing: state.agreeing, tip: state.tip };
  }
  function refresh() {
    BLWPCLIENT.fetchReservesTotal({ nodes: state.nodes }).then(function (r) {
      if (r.ok) { state.reserves = { sats: Number(r.totalMsat / 1000n), agreeing: r.agreeing, asked: r.asked }; state.reservesWhy = null; } else state.reservesWhy = r.why;
      showBalance();
      var typed = document.querySelector('.compose input[name=amount]');
      if (location.hash === '#new' && !(typed && typed.value)) newView();
    }).catch(function (e) { state.reservesWhy = e.message; showBalance(); });
    return BLWPCLIENT.fetchProposals({ nodes: state.nodes, verify: window.BLWP_CURVE.verify }).then(function (r) {
      if (!r.ok) { state.list = []; state.agreeing = 0; state.asked = r.asked; return; }
      state.list = r.proposals; state.tip = r.tip; state.agreeing = r.agreeing; state.asked = r.asked; state.names = r.names || {};
    });
  }

  view.append(el('div', 'empty', 'Reading the nodes…'));
  fetch(ARENA + 'daily.json').then(function (r) { return r.json(); }).then(function (d) {
    state.nodes = ((d.testnet || {}).node || []);
    return load(ARENA + 'blwp-curve.js').then(function () { return load(ARENA + 'arena-client.js'); });
  }).then(function () {
    pickKey();
    window.addEventListener('hashchange', route);
    return refresh().then(route);
  }).catch(function (e) { view.textContent = ''; view.append(el('div', 'empty', e.message)); });
})();
