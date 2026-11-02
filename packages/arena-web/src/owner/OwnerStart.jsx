// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S WAY IN, IN REACT (kanban #564, 2026-10-21: "fix ... the owner page"): what owner.html drew by hand before the
// owner area - the welcome (make 24 words, restore them, or log in with Nostr), the new words shown once with three typed back, the restore
// from the words, Login with Nostr (an extension, a phone signer's code, a bunker link, an nsec, or a new account with its key shown once),
// the claim with the code from the node's log, and the one-card messages (no answer, not the owner). The page keeps every rule and hands
// them over: `client` (the owner client's words, Nostr and QR helpers), `holdSeed(seed)` and `holdNostr(login)` (the page holds them in
// memory and writes nothing to the browser until the node has taken a login signed with them, kanban #832), `random32()`, `claim(code)`,
// and `onIn()` (the page starts again with what it now holds).
import React from 'react';

// WHERE THE SECRET STAYS, SAID WHERE IT IS TYPED (kanban #832): `it` the words ("They") or the nsec ("It")
const stays = (it) => `${it} ${it === 'They' ? 'stay' : 'stays'} in this tab's memory until your node confirms ${it === 'They' ? 'them' : 'it'} as its owner. Then this browser keeps ${it === 'They' ? 'them' : 'it'} in its local storage, unencrypted, until you sign out. Use a device you trust.`;
const field = { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false };

// ENTER SUBMITS (kanban #840): each way in is a form
const submit = (go) => (e) => { e.preventDefault(); go(); };
// AN ERROR READS AS ONE (kanban #841): a capital first, one kind of ellipsis, whatever the client or the node said
const said = (e) => { const t = String(e && e.message ? e.message : e).replace(/\.\.\./g, '…'); return t.charAt(0).toUpperCase() + t.slice(1); };
// THE SUB-SCREENS IN THE ADDRESS (kanban #843: Back left the page): step= beside the node's own part of the #, never anything typed
const hashNow = () => (typeof location === 'undefined' ? '' : location.hash);
export const stepOf = (hash) => new URLSearchParams(String(hash || '').replace(/^#/, '')).get('step') || 'welcome';
export function hashWith(hash, step) {
  const h = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  if (step && step !== 'welcome') h.set('step', step); else h.delete('step');
  const t = h.toString();
  return t ? '#' + t : '';
}
/** Focus on a new screen (kanban #843: it fell to <body>): the field named, or else the heading. */
function focusOn(card, field) {
  if (!card) return;
  const h = card.querySelector('h3'), at = (field && card.querySelector(field)) || h;
  if (at === h && h) h.tabIndex = -1;
  if (at) at.focus();
}

// the deep link only where a tap can open it, and the key copied with a refused write said (kanban #853)
const onTouch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** One card: a title, its lines, an error, its buttons. */
export class OwnerMessage extends React.Component {
  constructor(props) { super(props); this.card = React.createRef(); }
  componentDidMount() { focusOn(this.card.current); }
  render() {
    const { title, text, err, buttons = [] } = this.props;
    return (
      <div className="card" ref={this.card}><h3>{title}</h3>{text ? <p>{text}</p> : null}{err ? <p className="err">{err}</p> : null}
        {buttons.map((b) => <button key={b.label} type="button" className={b.primary ? 'primary' : undefined} onClick={b.onClick}>{b.label}</button>)}</div>);
  }
}

export class OwnerStart extends React.Component {
  async copyKey() { try { await navigator.clipboard.writeText(this.state.account.nsec); this.setState({ copied: true }); } catch { this.setState({ copied: false }); } }
  constructor(props) {
    super(props);
    // a reload on a sub-screen stays there: only the two that need nothing from before it
    const step = stepOf(hashNow());
    this.state = { screen: props.screen && props.screen !== 'welcome' ? props.screen : step === 'restore' || step === 'nostr' ? step : 'welcome', err: '', errAt: '', words: null, seed: null, ask: [], typed: {}, phrase: '', code: '',
      bunker: '', nsec: '', qr: null, uri: '', account: null, saved: false, busy: false, copied: false };
    this.card = React.createRef();
    this.onPop = () => this.follow();
    this.depth = (typeof history !== 'undefined' && history.state && history.state.ownerDepth) || 0;
  }
  componentDidMount() { this.focus(); addEventListener('popstate', this.onPop); }
  componentDidUpdate(_, was) { if (was.screen !== this.state.screen) this.focus(); }
  componentWillUnmount() { removeEventListener('popstate', this.onPop); }
  // the words and the claim code are what the screen is for; the others open with their heading, read first
  focus() { focusOn(this.card.current, this.state.screen === 'restore' ? 'textarea' : this.state.screen === 'claim' ? 'input' : null); }
  // what was typed does not outlive its screen: a phrase or an nsec left by Back stayed in the field and the state (kanban #844)
  show(screen, more = {}) { this.setState({ screen, err: '', errAt: '', phrase: '', nsec: '', bunker: '', ...more }); }
  // a new entry in the browser's history for each sub-screen (kanban #843)
  go(screen, more = {}) {
    this.show(screen, more);
    if (typeof history === 'undefined') return;
    this.depth++;
    history.pushState({ ...history.state, ownerDepth: this.depth }, '', location.pathname + location.search + hashWith(location.hash, screen));
  }
  // the page's Back is the browser's Back while there is an entry of ours to go to, so the two never disagree
  leave(to) { if (this.depth > 0) history.back(); else this.go(to); }
  // the browser moved: the screen its entry names, if it can still be shown (new words and a new key live only in this screen's state)
  follow() {
    if (this.props.screen === 'claim') return;
    this.depth = (history.state && history.state.ownerDepth) || 0;
    const s = this.state, step = stepOf(location.hash);
    const can = step === 'restore' || step === 'nostr' || (!this.props.claimed && ((step === 'make' && s.words) || (step === 'account' && s.account)));
    this.show(can ? step : 'welcome');
  }
  // EACH ERROR AT ITS FIELD (kanban #841): one error at a time, named by its place (`errAt`), gone as soon as that field or the way in changes
  fail(e, at = '') { this.setState({ err: said(e), errAt: at, busy: false }); }
  fresh() { this.setState({ err: '', errAt: '' }); }
  edit(name, value) { this.setState({ [name]: value, err: '', errAt: '' }); }

  // 1a. NEW WORDS: shown once, written down, three of them typed back (a different three each time)
  make() {
    const seed = this.props.random32();
    const words = this.props.client.phraseFromSeed(seed).words;
    const ask = [2, 10, 19].map((i) => i + Math.floor(Math.random() * 3));
    this.go('make', { seed, words, ask, typed: {} });
  }
  wrote() {
    const { words, ask, typed, seed } = this.state;
    if (!ask.every((i) => String(typed[i] || '').trim().toLowerCase() === words[i])) return this.setState({ err: 'One of the three words is not right. Check what you wrote.' });
    this.props.holdSeed(seed);
    this.props.onIn();
  }
  // 1b. RESTORE: the 24 words, checked by their checksum word
  restore() {
    const got = this.props.client.seedFromPhrase(this.state.phrase);
    if (!got.ok) { const n = this.wordCount(); return this.setState({ err: n !== 24 ? `Enter all 24 words (${n} entered)` : `Check your words: ${got.why}` }); }
    this.props.holdSeed(got.seed);
    this.props.onIn();
  }
  wordCount() { return this.state.phrase.trim().split(/\s+/).filter(Boolean).length; }
  // Enter in the words is a new line until all 24 are there (typed from paper, a line at a time); Ctrl or Cmd + Enter submits at any time
  phraseKey(e) {
    if (e.key !== 'Enter' || e.shiftKey || !(e.ctrlKey || e.metaKey || this.wordCount() >= 24)) return;
    e.preventDefault(); this.restore();
  }
  // 1c. SIGN IN WITH NOSTR: held as the page holds it, then the page starts again
  signedIn(login, signer) {
    this.props.holdNostr(login);
    if (this.props.onNostr) this.props.onNostr({ how: login.how, pubkey: signer.pubkey });
    this.props.onIn();
  }
  async extension() { this.fresh(); try { const x = await this.props.client.extensionSigner(window.nostr); this.signedIn({ how: 'extension', pubkey: x.pubkey }, x); } catch (e) { this.fail(e, 'signer'); } }
  async bunkerLink() {
    this.fresh();
    const { client, random32 } = this.props;
    try { const c = random32(); const b = await client.bunkerSigner(this.state.bunker, { clientSecret: c, onauth: (u) => window.open(u, '_blank') });
      this.signedIn({ how: 'bunker', bunker: this.state.bunker.trim(), client: client.toHex(c) }, b); } catch (e) { this.fail(e, 'bunker'); }
  }
  async scan() {
    this.fresh();
    const { client, random32 } = this.props;
    try {
      const c = random32();
      const n = client.nostrConnect({ url: location.origin, clientSecret: c, onauth: (u) => window.open(u, '_blank') });
      this.setState({ qr: client.textQrSvg(n.uri), uri: n.uri });
      if (this.props.onConnectUri) this.props.onConnectUri(n.uri);
      const b = await n.signer;
      // kept as a bunker link to the signer that answered, with this page's client key, so it reconnects next time
      this.signedIn({ how: 'bunker', bunker: `bunker://${b.bunker.bp.pubkey}?${b.bunker.bp.relays.map((r) => 'relay=' + encodeURIComponent(r)).join('&')}`, client: client.toHex(c) }, b);
    } catch (e) { this.fail(e, 'signer'); }
  }
  nsec() { this.fresh(); try { const x = this.props.client.signerFromNsec(this.state.nsec); this.signedIn({ how: 'nsec', secret: this.props.client.toHex(x.secret) }, x); } catch (e) { this.fail(e, 'nsec'); } }
  // ONLY WHERE IT CAN BECOME THE OWNER (kanban #833): a new key on a node with an owner was called "this node's owner key" and then refused
  newAccount() {
    if (this.props.claimed) return;
    const a = this.props.client.newAccount();
    this.go('account', { account: a, saved: false });
  }
  // 2. THE NODE HAS NO OWNER: claimed with the code from its log (kanban #550: the file's full path, not a cryptic name)
  async claim() {
    this.setState({ busy: true, err: '', errAt: '' });
    try { await this.props.claim(this.state.code); this.props.onIn(); } catch (e) { this.fail(e); }
  }
  copyFile() { try { navigator.clipboard.writeText(this.props.claimFile); this.setState({ copied: true }); } catch { /* no clipboard: the path is selectable */ } }

  render() {
    const s = this.state, claimed = this.props.claimed;
    // always in the page, empty until there is something to say, so a screen reader hears it arrive (kanban #841)
    const err = (at = '') => <div className="err field-err" role="alert">{s.err && s.errAt === at ? s.err : ''}</div>;
    const back = (to) => <button type="button" onClick={() => this.leave(to)}>Back</button>;
    if (s.screen === 'make') return (
      <div className="card" ref={this.card}><h3>Write these 24 words down</h3>
        <div className="warn">Write them on paper, in order. They're the only way back into this owner area from another browser. Nobody can recover them for you. {stays('They')}</div>
        <div className="words">{s.words.map((w, i) => <span key={i}>{w}</span>)}</div>
        <p>Then type three of them back:</p>
        <form onSubmit={submit(() => this.wrote())}>
          {s.ask.map((i) => <React.Fragment key={i}><label htmlFor={`owner-word-${i}`}>{`Word ${i + 1}`}</label><input {...field} id={`owner-word-${i}`} value={s.typed[i] || ''} onChange={(e) => this.edit('typed', { ...s.typed, [i]: e.target.value })} /></React.Fragment>)}
          {err()}<button type="submit" className="primary">I wrote them down</button>{back('welcome')}</form></div>);
    // SIGNING IN IS NOT RESTORING (kanban #839: "Restore" on a routine sign-in reads as a wallet recovery): Restore only where there is no owner yet
    if (s.screen === 'restore') return (
      <div className="card" ref={this.card}><h3>{claimed ? 'Sign in with your 24 words' : 'Restore from your 24 words'}</h3>
        <form onSubmit={submit(() => this.restore())}><label htmlFor="owner-phrase">The 24 words, in order</label>
          <textarea {...field} id="owner-phrase" value={s.phrase} onChange={(e) => this.edit('phrase', e.target.value)} onKeyDown={(e) => this.phraseKey(e)} />
          {err()}<p className="sub">{stays('They')}</p>
          <button type="submit" className="primary">{claimed ? 'Sign in' : 'Restore'}</button>{back('welcome')}</form></div>);
    if (s.screen === 'nostr') return (
      <div className="card" ref={this.card}><h3>Sign in with Nostr</h3>
        {claimed ? <p>Sign in with the Nostr key that owns this node. A node owned by 24 words needs those words instead. Requests are signed by your extension or signer each time.</p>
          : <p>Your Nostr key becomes this node's owner key - no 24 words to make. Requests are signed by your extension or signer each time.</p>}
        <button type="button" className="primary" onClick={() => this.extension()}>Browser extension (Alby, nos2x…)</button>
        <button type="button" onClick={() => this.scan()}>Phone signer (Amber…): show a code</button>
        {err('signer')}
        <div>{s.qr ? <><div role="img" aria-label="Nostr Connect QR code" style={{ background: '#fff', padding: '8px', borderRadius: '10px', maxWidth: '240px' }} dangerouslySetInnerHTML={{ __html: s.qr }} />
          <p className="sub">Scan it with your signer{onTouch() ? <>, or <a href={s.uri}>open it on this phone</a></> : null}. Waiting for your signer…</p></> : null}</div>
        <form onSubmit={submit(() => this.bunkerLink())}><label htmlFor="owner-bunker">Or a bunker link</label>
          <input {...field} id="owner-bunker" placeholder="bunker://… or you@your-bunker" value={s.bunker} onChange={(e) => this.edit('bunker', e.target.value)} />
          {err('bunker')}<button type="submit">Connect the bunker</button></form>
        <form onSubmit={submit(() => this.nsec())}><label htmlFor="owner-nsec">Or your nsec</label>
          <input {...field} id="owner-nsec" type="password" placeholder="nsec1…" value={s.nsec} onChange={(e) => this.edit('nsec', e.target.value)} />
          {err('nsec')}<p className="sub">{stays('It')}</p>
          <button type="submit">Sign in with the nsec</button>{claimed ? null : <> <button type="button" onClick={() => this.newAccount()}>New to Nostr? Create an account</button></>}</form>
        {back('welcome')}</div>);
    if (s.screen === 'account') return (
      <div className="card" ref={this.card}><h3>Your new Nostr account</h3>
        <div className="warn"><b>Save this key now</b> - in a password manager or on paper. It is your Nostr account and this node's owner key. Nobody can recover it for you. {stays('It')}</div>
        <div className="words" style={{ display: 'block', font: '14px ui-monospace,monospace', wordBreak: 'break-all', padding: '10px' }}>{s.account.nsec}</div>
        <button type="button" onClick={() => this.copyKey()}>{s.copied === true ? 'Copied ✓' : s.copied === false ? 'Copy refused: select the key by hand' : 'Copy the key'}</button>
        <label><input type="checkbox" style={{ width: 'auto' }} checked={s.saved} onChange={(e) => this.setState({ saved: e.target.checked })} /> I saved my key</label>
        {err()}<button type="button" className="primary" disabled={!s.saved}
          onClick={() => this.signedIn({ how: 'nsec', secret: this.props.client.toHex(s.account.signer.secret) }, s.account.signer)}>Continue</button>{back('nostr')}</div>);
    if (s.screen === 'claim') {
      const { claimFile, mine } = this.props;
      return (
        <>
          <div className="card" ref={this.card}><h3>Claim this node</h3>
            <p>This node has no owner yet. Its claim code is in the node's log and in this file on its machine:</p>
            {claimFile ? <div className="path"><code>{claimFile}</code><button type="button" onClick={() => this.copyFile()}>{s.copied ? 'Copied' : 'Copy'}</button></div>
              : <p><code>{'<database>.owner-claim'}</code>, beside the node's database</p>}
            <form onSubmit={submit(() => this.claim())}><label htmlFor="owner-code">Claim code</label>
              <input id="owner-code" autoComplete="off" autoCapitalize="characters" placeholder="XXXX-XXXX-XXXX" value={s.code} onChange={(e) => this.edit('code', e.target.value)} />
              {err()}<button type="submit" className="primary" disabled={s.busy}>Become the owner</button></form></div>
          <div className="card"><div className="row"><span>Your owner key</span><b>{mine}</b></div>
            <p className="sub">Nothing is kept in this browser until the claim works. If you reload this page before that, you start again.</p></div>
        </>);
    }
    return (
      // A NODE THAT HAS AN OWNER (the owner's playtest 2026-10-25: "if there is already a node owner configured, don't allow create a new 24
      // word wallet but ask for the words"): new words could never be its owner, so only the owner's words or Nostr key are offered
      claimed ? <div className="card" ref={this.card}><h3>Sign in as this node's owner</h3>
        <p>This node already has an owner. Sign in with its 24 words or its Nostr key.</p>
        {typeof location !== 'undefined' && /\.trycloudflare\.com$/.test(location.hostname)
          ? <p className="warn" id="tunnel-moved">Logged in before? This address comes from a temporary tunnel, and it changes when your node restarts. Your browser keeps the login per address. On your node's computer, open the owner page from the Bitcoin Arena app instead: its address never changes.</p> : null}
        <button type="button" className="primary" id="owner-words" onClick={() => this.go('restore')}>Sign in with your 24 words</button>
        <button type="button" onClick={() => this.go('nostr')}>Sign in with Nostr</button></div> :
      <div className="card" ref={this.card}><h3>Your owner key</h3>
        <p>The owner of this node is a key made from <b>24 words</b>. Once your node confirms them, this browser keeps them in its local storage, unencrypted; anyone with them is the owner.</p>
        <button type="button" className="primary" onClick={() => this.make()}>Create new 24 words</button>
        <button type="button" onClick={() => this.go('restore')}>I have my 24 words</button>
        <button type="button" onClick={() => this.go('nostr')}>Sign in with Nostr</button></div>);
  }
}
