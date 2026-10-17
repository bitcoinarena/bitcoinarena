// PROJECT PROPOSALS ON THE HOMEPAGE (kanban #397, the owner 2026-10-17: "Add a Project Proposals section to the website where people can
// comment and review"; "Anyone can do a proposal to pay out"). The list is what five of the testnet's nodes hold (GET /funding); a
// visitor comments, replies or proposes with their own key - an nsec, or a key this browser keeps - and every node is handed the
// signed object (POST /funding). The Arena page's own client does the reading and signing (arena-client.js + blwp-curve.js from
// testnet.bitcoin-arena.io), loaded only once the section is in view.
(function () {
  var ARENA = window.ARENA_BASE || 'https://testnet.bitcoin-arena.io/';
  var KEY = 'arena.proposals.key';
  var root = document.getElementById('proposals');
  if (!root) return;
  var $ = function (q) { return root.querySelector(q); };
  var state = { nodes: [], tip: null, network: null, key: null, replyTo: {} };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function short(npub) { return npub.slice(0, 12) + '…' + npub.slice(-6); }
  function sats(n) { return Number(n).toLocaleString('en-US') + ' sat'; }
  function load(src) { return new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { bad(new Error('could not load ' + src)); }; document.head.appendChild(s); }); }
  function getKey() { try { var h = localStorage.getItem(KEY); return h && /^[0-9a-f]{64}$/.test(h) ? Uint8Array.from(h.match(/../g).map(function (x) { return parseInt(x, 16); })) : null; } catch (e) { return null; } }
  function setKey(k) { state.key = k; try { if (k) localStorage.setItem(KEY, Array.from(k).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('')); else localStorage.removeItem(KEY); } catch (e) { /* kept for this visit only */ } showKey(); }
  function say(where, text, bad) { var s = $(where); if (!s) return; s.textContent = text; s.classList.toggle('bad', !!bad); }

  function stage(p) {
    if (p.cancelled) return { cls: 'no', text: 'Stopped: ' + p.cancelled };
    var v = p.vote, s = p.signal || {};
    if (v && v.state === 'passed') return { cls: 'ok', text: 'Vote passed · paid after the 2-week window, if no NO stops it' };
    if (v && v.state === 'failed') return { cls: 'no', text: 'Vote failed' };
    if (v) return { cls: 'on', text: 'Voting until block ' + v.last + (v.count && v.count.approvalPct !== undefined ? ' · YES ' + v.count.approvalPct + ' % of the votes, ' + (v.count.yesOfAllPct || 0) + ' % of everyone' : '') };
    if (s.state === 'failed') return { cls: 'no', text: 'Signal failed · ' + (s.supporters || 0) + ' of ' + (s.active || 0) + ' active nodes (15 % needed)' };
    if (s.state === 'passed') return { cls: 'ok', text: 'Signal passed · the vote opens' };
    return { cls: 'on', text: 'Signal open until block ' + s.signalEnd + ' · ' + (p.signals || 0) + ' node signal' + (p.signals === 1 ? '' : 's') };
  }

  function render(list) {
    var box = $('.p-list'); box.textContent = '';
    if (!list.length) { box.append(el('p', 'p-empty', 'No proposals yet. Be the first: propose a project below.')); return; }
    list.forEach(function (p) {
      var card = el('article', 'p-card');
      var head = el('div', 'p-head');
      head.append(el('strong', 'p-amt', sats(p.amountSats)), el('span', 'p-to', 'to ' + p.lnurl));
      var st = stage(p); head.append(el('span', 'p-stage ' + st.cls, st.text));
      card.append(head, el('p', 'p-purpose', p.purpose));
      card.append(el('div', 'p-meta', 'Proposed by ' + short(BLWPCLIENT.npubOfKey(p.author)) + ' at block ' + p.publishedHeight + ' · held by ' + p.holding + ' nodes'));
      var thread = el('div', 'p-thread');
      var byParent = {};
      p.comments.forEach(function (c) { (byParent[c.parent] = byParent[c.parent] || []).push(c); });
      (function walk(parent, depth) {
        (byParent[parent] || []).forEach(function (c) {
          var row = el('div', 'p-comment'); row.style.marginLeft = Math.min(depth, 4) * 18 + 'px';
          row.append(el('span', 'p-who', short(BLWPCLIENT.npubOfKey(c.author)) + ' · block ' + c.atHeight), el('p', null, c.text));
          var r = el('button', 'p-reply', 'Reply'); r.type = 'button';
          r.addEventListener('click', function () { state.replyTo[p.id] = c.id; form.querySelector('textarea').placeholder = 'Reply to ' + short(BLWPCLIENT.npubOfKey(c.author)); form.querySelector('textarea').focus(); });
          row.append(r); thread.append(row); walk(c.id, depth + 1);
        });
      })('00'.repeat(32), 0);
      card.append(thread);
      var form = el('form', 'p-cform');
      var ta = el('textarea'); ta.rows = 2; ta.maxLength = 4000; ta.placeholder = 'Comment or ask a question';
      var b = el('button', 'btn ghost', 'Comment'); b.type = 'submit';
      var out = el('span', 'p-say');
      form.append(ta, b, out);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!ta.value.trim()) return;
        if (!state.key) { out.textContent = 'Set your key above first.'; out.classList.add('bad'); return; }
        var c = BLWPCLIENT.signedComment({ secretKey: state.key, proposalId: p.id, parentId: state.replyTo[p.id] || null, atHeight: state.tip, text: ta.value });
        out.textContent = 'Sending…'; out.classList.remove('bad');
        BLWPCLIENT.postFunding({ nodes: state.nodes, kind: 'comment', hex: c.hex }).then(function (r) {
          if (!r.ok) { out.textContent = 'Not taken: ' + r.why; out.classList.add('bad'); return; }
          out.textContent = 'Posted to ' + r.took + ' of ' + r.asked + ' nodes.'; ta.value = ''; state.replyTo[p.id] = null; setTimeout(refresh, 1500);
        });
      });
      card.append(form);
      box.append(card);
    });
  }

  function refresh() {
    return BLWPCLIENT.fetchProposals({ nodes: state.nodes }).then(function (r) {
      window.ARENA_HOME_PROPOSALS = r.ok ? { proposals: r.proposals.length, comments: r.proposals.reduce(function (t, p) { return t + p.comments.length; }, 0), agreeing: r.agreeing, asked: r.asked, tip: r.tip } : { why: r.why };
      if (!r.ok) { say('.p-status', 'The nodes could not be read: ' + r.why, true); return; }
      state.tip = r.tip;
      say('.p-status', r.proposals.length + ' proposal' + (r.proposals.length === 1 ? '' : 's') + ' · ' + r.agreeing + ' of ' + r.asked + ' nodes answered · block ' + r.tip);
      render(r.proposals);
    });
  }

  function showKey() {
    var k = $('.p-key-id');
    k.textContent = state.key ? 'Signing as ' + short(BLWPCLIENT.npubOf(state.key)) : 'No key yet: comments and proposals are signed by your key.';
    $('.p-forget').hidden = !state.key;
  }

  function wire() {
    $('.p-new').addEventListener('click', function () { setKey(BLWPCLIENT.newProposalKey()); });
    $('.p-forget').addEventListener('click', function () { setKey(null); });
    $('.p-nsec-form').addEventListener('submit', function (e) {
      e.preventDefault(); var i = $('.p-nsec');
      try { setKey(BLWPCLIENT.keyOfNsec(i.value)); i.value = ''; say('.p-key-say', 'Your nsec is kept in this browser only.'); } catch (x) { say('.p-key-say', x.message, true); }
    });
    $('.p-propose').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!state.key) { say('.p-prop-say', 'Set your key above first.', true); return; }
      var f = e.target, amount = Number(f.amount.value);
      if (!(amount >= 1)) { say('.p-prop-say', 'Ask at least 1 sat.', true); return; }
      say('.p-prop-say', 'Signing…');
      (state.network ? Promise.resolve(state.network) : BLWPCLIENT.fetchNetworkId({ nodes: state.nodes })).then(function (net) {
        if (!net) throw new Error('the nodes did not agree on their network');
        state.network = net;
        var p = BLWPCLIENT.signedProposal({ secretKey: state.key, networkId: net, publishedHeight: state.tip, amountSats: Math.floor(amount), lnurl: f.lnurl.value, purpose: f.purpose.value });
        return BLWPCLIENT.postFunding({ nodes: state.nodes, kind: 'proposal', hex: p.hex });
      }).then(function (r) {
        if (!r.ok) { say('.p-prop-say', 'Not taken: ' + r.why, true); return; }
        say('.p-prop-say', 'Proposed: handed to ' + r.took + ' of ' + r.asked + ' nodes. Its 1-week signal starts now.'); f.reset(); setTimeout(refresh, 1500);
      }).catch(function (x) { say('.p-prop-say', x.message, true); });
    });
  }

  var started = false;
  function start() {
    if (started) return; started = true;
    say('.p-status', 'Reading the nodes…');
    fetch(ARENA + 'daily.json').then(function (r) { return r.json(); }).then(function (d) {
      state.nodes = ((d.testnet || {}).node || []);
      return load(ARENA + 'blwp-curve.js').then(function () { return load(ARENA + 'arena-client.js'); });
    }).then(function () {
      state.key = getKey(); showKey(); wire(); return refresh();
    }).catch(function (e) { say('.p-status', e.message, true); });
  }
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) { if (es.some(function (e) { return e.isIntersecting; })) { io.disconnect(); start(); } }, { rootMargin: '400px' });
    io.observe(root);
  } else start();
})();
