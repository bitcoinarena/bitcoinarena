// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S WAY IN, IN REACT (kanban #564, 2026-10-21: "fix ... the owner page"): what owner.html drew by hand before the
// owner area - the welcome (make 24 words, restore them, or log in with Nostr), the new words shown once with three typed back, the restore
// from the words, Login with Nostr (an extension, a phone signer's code, a bunker link, an nsec, or a new account with its key shown once),
// the claim with the code from the node's log, and the one-card messages (no answer, not the owner). The page keeps every rule and hands
// them over: `client` (the owner client's words, Nostr and QR helpers), `keepSeed(seed)` and `keepNostr(login)` (false when the browser
// keeps nothing), `random32()`, `claim(code)`, and `onIn()` (the page starts again with what this browser now keeps).
import React from 'react';

const KEEP_FAILED = 'This browser does not let the page keep them (private mode?).';
const field = { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false };

// the deep link only where a tap can open it, and the key copied with a refused write said (kanban #853)
const onTouch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** One card: a title, its lines, an error, its buttons. */
export class OwnerMessage extends React.Component {
  render() {
    const { title, text, err, buttons = [] } = this.props;
    return (
      <div className="card"><h3>{title}</h3>{text ? <p>{text}</p> : null}{err ? <p className="err">{err}</p> : null}
        {buttons.map((b) => <button key={b.label} type="button" className={b.primary ? 'primary' : undefined} onClick={b.onClick}>{b.label}</button>)}</div>);
  }
}

export class OwnerStart extends React.Component {
  async copyKey() { try { await navigator.clipboard.writeText(this.state.account.nsec); this.setState({ copied: true }); } catch { this.setState({ copied: false }); } }
  constructor(props) {
    super(props);
    this.state = { screen: props.screen || 'welcome', err: '', words: null, seed: null, ask: [], typed: {}, phrase: '', code: '',
      bunker: '', nsec: '', qr: null, uri: '', account: null, saved: false, busy: false, copied: false };
  }
  go(screen, more = {}) { this.setState({ screen, err: '', ...more }); }
  fail(e) { this.setState({ err: e && e.message ? e.message : String(e), busy: false }); }

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
    if (!this.props.keepSeed(seed)) return this.setState({ err: KEEP_FAILED });
    this.props.onIn();
  }
  // 1b. RESTORE: the 24 words, checked by their checksum word
  restore() {
    const got = this.props.client.seedFromPhrase(this.state.phrase);
    if (!got.ok) return this.setState({ err: 'These are not your 24 words: ' + got.why });
    if (!this.props.keepSeed(got.seed)) return this.setState({ err: KEEP_FAILED });
    this.props.onIn();
  }
  // 1c. LOGIN WITH NOSTR: kept as the page keeps it, then the page starts again
  signedIn(login, signer) {
    if (!this.props.keepNostr(login)) return this.fail('This browser does not let the page keep it (private mode?)');
    if (this.props.onNostr) this.props.onNostr({ how: login.how, pubkey: signer.pubkey });
    this.props.onIn();
  }
  async extension() { try { const x = await this.props.client.extensionSigner(window.nostr); this.signedIn({ how: 'extension', pubkey: x.pubkey }, x); } catch (e) { this.fail(e); } }
  async bunkerLink() {
    const { client, random32 } = this.props;
    try { const c = random32(); const b = await client.bunkerSigner(this.state.bunker, { clientSecret: c, onauth: (u) => window.open(u, '_blank') });
      this.signedIn({ how: 'bunker', bunker: this.state.bunker.trim(), client: client.toHex(c) }, b); } catch (e) { this.fail(e); }
  }
  async scan() {
    const { client, random32 } = this.props;
    try {
      const c = random32();
      const n = client.nostrConnect({ url: location.origin, clientSecret: c, onauth: (u) => window.open(u, '_blank') });
      this.setState({ qr: client.textQrSvg(n.uri), uri: n.uri });
      if (this.props.onConnectUri) this.props.onConnectUri(n.uri);
      const b = await n.signer;
      // kept as a bunker link to the signer that answered, with this page's client key, so it reconnects next time
      this.signedIn({ how: 'bunker', bunker: `bunker://${b.bunker.bp.pubkey}?${b.bunker.bp.relays.map((r) => 'relay=' + encodeURIComponent(r)).join('&')}`, client: client.toHex(c) }, b);
    } catch (e) { this.fail(e); }
  }
  nsec() { try { const x = this.props.client.signerFromNsec(this.state.nsec); this.signedIn({ how: 'nsec', secret: this.props.client.toHex(x.secret) }, x); } catch (e) { this.fail(e); } }
  newAccount() {
    const a = this.props.client.newAccount();
    if (this.props.onNewNsec) this.props.onNewNsec(a.nsec);
    this.go('account', { account: a, saved: false });
  }
  // 2. THE NODE HAS NO OWNER: claimed with the code from its log (kanban #550: the file's full path, not a cryptic name)
  async claim() {
    this.setState({ busy: true, err: '' });
    try { await this.props.claim(this.state.code); this.props.onIn(); } catch (e) { this.fail(e); }
  }
  copyFile() { try { navigator.clipboard.writeText(this.props.claimFile); this.setState({ copied: true }); } catch { /* no clipboard: the path is selectable */ } }

  render() {
    const s = this.state, err = s.err ? <div className="err">{s.err}</div> : <div className="err" />;
    const back = (to) => <button type="button" onClick={() => this.go(to)}>Back</button>;
    if (s.screen === 'make') return (
      <div className="card"><h3>Write these 24 words down</h3>
        <div className="warn">Write them on paper, in order. They're the only way back into this owner area from another browser. Nobody can recover them for you.</div>
        <div className="words">{s.words.map((w, i) => <span key={i}>{w}</span>)}</div>
        <p>Then type three of them back:</p>
        {s.ask.map((i) => <React.Fragment key={i}><label>{`Word ${i + 1}`}</label><input {...field} value={s.typed[i] || ''} onChange={(e) => this.setState({ typed: { ...s.typed, [i]: e.target.value } })} /></React.Fragment>)}
        {err}<button type="button" className="primary" onClick={() => this.wrote()}>I wrote them down</button>{back('welcome')}</div>);
    if (s.screen === 'restore') return (
      <div className="card"><h3>Restore from your 24 words</h3><label>The 24 words, in order</label>
        <textarea {...field} value={s.phrase} onChange={(e) => this.setState({ phrase: e.target.value })} />
        {err}<button type="button" className="primary" onClick={() => this.restore()}>Restore</button>{back('welcome')}</div>);
    if (s.screen === 'nostr') return (
      <div className="card"><h3>Login with Nostr</h3>
        <p>Your Nostr key becomes this node's owner key - no 24 words to make. Requests are signed by your extension or signer each time.</p>
        <button type="button" className="primary" onClick={() => this.extension()}>Browser extension (Alby, nos2x…)</button>
        <button type="button" onClick={() => this.scan()}>Phone signer (Amber…): show a code</button>
        <div>{s.qr ? <><div style={{ background: '#fff', padding: '8px', borderRadius: '10px', maxWidth: '240px' }} dangerouslySetInnerHTML={{ __html: s.qr }} />
          <p className="sub">Scan it with your signer{onTouch() ? <>, or <a href={s.uri}>open it on this phone</a></> : null}. Waiting for your signer…</p></> : null}</div>
        <label>Or a bunker link</label><input {...field} placeholder="bunker://… or you@your-bunker" value={s.bunker} onChange={(e) => this.setState({ bunker: e.target.value })} />
        <button type="button" onClick={() => this.bunkerLink()}>Connect the bunker</button>
        <label>Or your nsec (only on a device you trust - it is kept in this browser)</label>
        <input {...field} type="password" placeholder="nsec1…" value={s.nsec} onChange={(e) => this.setState({ nsec: e.target.value })} />
        <button type="button" onClick={() => this.nsec()}>Log in with the nsec</button> <button type="button" onClick={() => this.newAccount()}>New to Nostr? Create an account</button>
        {err}{back('welcome')}</div>);
    if (s.screen === 'account') return (
      <div className="card"><h3>Your new Nostr account</h3>
        <div className="warn"><b>Save this key now</b> - in a password manager or on paper. It is your Nostr account and this node's owner key. Nobody can recover it for you.</div>
        <div className="words" style={{ display: 'block', font: '14px ui-monospace,monospace', wordBreak: 'break-all', padding: '10px' }}>{s.account.nsec}</div>
        <button type="button" onClick={() => this.copyKey()}>{s.copied === true ? 'Copied ✓' : s.copied === false ? 'Copy refused: select the key by hand' : 'Copy the key'}</button>
        <label><input type="checkbox" style={{ width: 'auto' }} checked={s.saved} onChange={(e) => this.setState({ saved: e.target.checked })} /> I saved my key</label>
        {err}<button type="button" className="primary" disabled={!s.saved}
          onClick={() => this.signedIn({ how: 'nsec', secret: this.props.client.toHex(s.account.signer.secret) }, s.account.signer)}>Continue</button>{back('nostr')}</div>);
    if (s.screen === 'claim') {
      const { claimFile, mine } = this.props;
      return (
        <>
          <div className="card"><h3>Claim this node</h3>
            <p>This node has no owner yet. Its claim code is in the node's log and in this file on its machine:</p>
            {claimFile ? <div className="path"><code>{claimFile}</code><button type="button" onClick={() => this.copyFile()}>{s.copied ? 'Copied' : 'Copy'}</button></div>
              : <p><code>{'<database>.owner-claim'}</code>, beside the node's database</p>}
            <label>Claim code</label><input autoComplete="off" autoCapitalize="characters" placeholder="XXXX-XXXX-XXXX" value={s.code} onChange={(e) => this.setState({ code: e.target.value })} />
            {err}<button type="button" className="primary" disabled={s.busy} onClick={() => this.claim()}>Become the owner</button></div>
          <div className="card"><div className="row"><span>Your owner key</span><b>{mine}</b></div></div>
        </>);
    }
    return (
      // A NODE THAT HAS AN OWNER (the owner's playtest 2026-10-25: "if there is already a node owner configured, don't allow create a new 24
      // word wallet but ask for the words"): new words could never be its owner, so only the owner's words or Nostr key are offered
      this.props.claimed ? <div className="card"><h3>Sign in as this node's owner</h3>
        <p>This node already has an owner. Sign in with its 24 words or its Nostr key.</p>
        {typeof location !== 'undefined' && /\.trycloudflare\.com$/.test(location.hostname)
          ? <p className="warn" id="tunnel-moved">Logged in before? This address comes from a temporary tunnel, and it changes when your node restarts. Your browser keeps the login per address. On your node's computer, open the owner page from the Bitcoin Arena app instead: its address never changes.</p> : null}
        <button type="button" className="primary" id="owner-words" onClick={() => this.go('restore')}>Sign in with my 24 words</button>
        <button type="button" onClick={() => this.go('nostr')}>Login with Nostr</button></div> :
      <div className="card"><h3>Your owner key</h3>
        <p>The owner of this node is a key made from <b>24 words</b>. This browser keeps them; anyone with them is the owner.</p>
        <button type="button" className="primary" onClick={() => this.make()}>Create new 24 words</button>
        <button type="button" onClick={() => this.go('restore')}>I have my 24 words</button>
        <button type="button" onClick={() => this.go('nostr')}>Login with Nostr</button></div>);
  }
}
