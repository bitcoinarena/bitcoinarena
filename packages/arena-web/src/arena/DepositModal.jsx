// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEPOSIT WINDOW IN REACT (kanban #564, the Arena page): what the page's showDepositOffer drew by hand - the amount tabs of the offer
// (a round's 1, 2, 5, 10 rounds or plain amounts, and Custom, typed and made into an invoice 450 ms after the last key), why a round's
// deposit is what it is, the player's own wallet paying in one tap (Nostr Wallet Connect, its balance against the invoice; WebLN when the
// browser has it), the QR, the invoice with Copy, and what is happening now under it. A paid deposit that still falls short asks the rest of
// the round's fees in the same window (the offer's outcome names it). The page keeps its rules and hands them over: the offer (invoice,
// watch, claimed, outcome, close), `due` (a deposit's whole notes), `qrSvg`, `whyLine` (depositWhyLine), `nwc` (the link kept in this
// browser and the Nostr module), `webln`, `onNwc`/`onWebln` (the page's probes), `onDone` (the window cleared). A class component; the
// class names are the page's, so its stylesheet and its probes read it as before. `.dep-backup-host` is the page's: its backup warning
// goes in there (React leaves an element it drew with no children alone).
import React from 'react';

/** msat as sat, exact: "1,234" or "1,234.5" (deposits are whole sats, notes 1 msat - never rounded to a sat they are not) */
export function satNum(msat) {
  const m = BigInt(msat); const w = (m / 1000n).toLocaleString('en-US'); const f = m % 1000n;
  return f ? `${w}.${String(f).padStart(3, '0').replace(/0+$/, '')}` : w;
}
const sats = (msat) => `${satNum(msat)} sat`;
const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u || ''); } };
// the 5 sat floor (2026-10-01): a rest under the smallest deposit the federation takes is asked at that floor
const restPay = (o) => (o.restPayMsat !== undefined && o.restPayMsat !== null ? o.restPayMsat : o.restMsat);
export const restWords = (o) => (restPay(o) > o.restMsat
  ? `This round needs ${satNum(o.restMsat)} more sat for fees. The smallest Lightning deposit is ${satNum(restPay(o))} sat. Pay ${satNum(restPay(o))} sat to join.`
  : `This round needs ${satNum(o.restMsat)} more sat for fees. Pay the rest to join.`);
const hasRest = (o) => o.restMsat !== null && o.restMsat !== undefined;

export class DepositModal extends React.Component {
  constructor(props) {
    super(props);
    const o = props.offer;
    this.active = o; this.token = 0; this.timers = new Set(); this.gone = false;
    this.field = React.createRef(); this.box = React.createRef(); this.link = React.createRef();
    this.state = { tab: null, rest: hasRest(o) ? o : null, typed: '', amount: '', why: '', invoice: null, invoiceText: '', qr: null,
      hold: 'Creating the QR code …', copy: '', status: null,
      nwcUri: this.nwcUri(), linkShown: false, note: null, balanceMsat: null, balanceWhy: '', want: null, nwcBusy: false, weblnBusy: false };
  }
  later(fn, ms) { const t = setTimeout(() => { this.timers.delete(t); if (!this.gone) fn(); }, ms); this.timers.add(t); return t; }
  set(u) { if (!this.gone) this.setState(u); }
  status(step, words, kind = '') { this.set({ status: { step, words, kind } }); }
  nwcUri() { try { return this.props.nwc ? this.props.nwc.uri() || '' : ''; } catch { return ''; } }
  componentDidMount() {
    this.bind(this.active);
    if (this.state.nwcUri) this.readBalance();
    // the first tab, as the page always did - an offer that opens on a rest keeps its tabs unseen under the rest's words
    this.choose(this.active.choices[0]);
  }
  componentWillUnmount() { this.gone = true; for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
  done() { if (!this.gone) this.props.onDone(); }
  close() { this.active.close(); this.done(); }

  // THE OFFER THIS WINDOW SHOWS: the gross one, then - when a paid deposit still falls short - the rest of the round's fees
  watcher(o) {
    return (d, final) => {
      if (o !== this.active || d.invoice !== this.state.invoice) return;
      const again = o.restMsat === null ? ' Pick an amount to get a new one.' : '';
      if (final === 'Claimed') this.status(3, `Payment received! ${sats(d.amountMsat)} are now in your wallet.`, 'ok');
      else if (final === 'Expired') this.status(3, 'This invoice has expired and nothing was charged.' + again, 'fail');
      else this.status(3, `The deposit did not go through (${final}), and nothing was charged.` + again, 'fail');
    };
  }
  // PAID: the green line stays; the round is looked at again (`outcome`). Funded - the window goes 2.5 s later. Still short - after the
  // green line has stood 2 s, the rest of the fees in this same window (never the tabs again).
  bind(o) {
    if (o.watch) o.watch(this.watcher(o));
    o.claimed.then(async () => {
      const greenAt = Date.now();
      const out = o.outcome ? await Promise.race([o.outcome, new Promise((r) => setTimeout(() => r({ funded: true }), 120000))]) : { funded: true };
      if (o !== this.active || this.gone) return;
      if (out.funded || !out.rest) { this.later(() => this.done(), 2500); return; }
      await new Promise((r) => setTimeout(r, Math.max(0, 2000 - (Date.now() - greenAt))));
      if (o === this.active && !this.gone) this.takeRest(out.rest);
    }, () => { if (o === this.active) this.done(); });
  }
  takeRest(o) { this.active = o; this.bind(o); this.set({ rest: o, why: '', tab: null }); this.show(restPay(o)); }

  due(msat) { return this.props.due ? this.props.due(msat) : BigInt(msat); }
  async show(msat) {
    const mine = ++this.token;
    this.set({ amount: `Pay ${sats(this.due(msat))} from any Lightning wallet to top up your player wallet.`, qr: null, hold: 'Creating the QR code …',
      invoiceText: 'creating the invoice …', invoice: null, want: null });
    this.status(1, `Creating your invoice for ${sats(this.due(msat))} …`, 'busy');
    try {
      const d = await this.active.invoice(msat);
      if (mine !== this.token || this.gone) return;
      this.set({ invoice: d.invoice, invoiceText: d.invoice, qr: this.props.qrSvg(d.invoice), want: BigInt(d.amountMsat) });
      this.status(2, `Waiting for your Lightning payment of ${sats(d.amountMsat)}` + (d.gateway ? ` via ${hostOf(d.gateway)}` : '') + ' …', 'busy');
    } catch (e) {
      if (mine !== this.token || this.gone) return;
      const why = e && e.message ? e.message : String(e);
      this.set({ invoiceText: 'No invoice: ' + why, qr: null, hold: 'No QR code' });
      this.status(3, 'The invoice could not be created: ' + why, 'fail');
    }
  }
  choose(c) {
    const { offer, whyLine } = this.props;
    // WHY NOT EXACTLY THE STAKE: the round tabs only (Custom and the rest say their own amount)
    const one = offer.choices[0] && offer.choices[0].rounds === 1 ? offer.choices[0].msat : null;
    // Custom's field is focused once it is shown (a hidden field takes no focus)
    this.setState({ tab: c.key, why: c.rounds && whyLine ? whyLine(offer.perRoundStake, one) : '' },
      () => { if (c.key === 'custom' && this.field.current) this.field.current.focus(); });
    if (c.key !== 'custom') this.show(c.msat); else this.typed(this.state.typed);
  }
  // CUSTOM: typed, read with parseInt as it is typed, the invoice made a moment after the last key - no Set button
  typed(text) {
    clearTimeout(this.typeTimer); this.timers.delete(this.typeTimer);
    this.setState({ typed: text });
    const sat = parseInt(String(text).replace(/[^0-9]/g, ''), 10);
    if (!(sat > 0)) {
      this.token++;
      this.setState({ invoice: null, invoiceText: '', amount: 'Enter an amount in sat.', qr: null, hold: 'The QR code appears as soon as you enter an amount', want: null });
      return this.status(0, 'Enter an amount in sat.', '');
    }
    this.setState({ amount: `Pay ${sats(this.due(BigInt(sat) * 1000n))} from any Lightning wallet to top up your player wallet.` });
    this.typeTimer = this.later(() => this.show(BigInt(sat) * 1000n), 450);
  }

  // COPY INVOICE (2026-09-30): green "Copied ✓" for 1.5 s, or red "Copy failed" with the invoice selected to copy by hand
  copied(ok) {
    clearTimeout(this.copyTimer); this.timers.delete(this.copyTimer);
    this.set({ copy: ok ? 'copied' : 'failed' });
    this.copyTimer = this.later(() => this.set({ copy: '' }), 1500);
  }
  async copyInvoice() {
    const text = this.state.invoiceText;
    if (!/^ln/i.test(text)) return;
    try { await navigator.clipboard.writeText(text); this.copied(true); return; } catch { /* the older way below */ }
    const r = document.createRange(); r.selectNodeContents(this.box.current);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    this.copied(ok);
  }

  // PAY WITH MY WALLET (2026-10-10): the player's own wallet pays this invoice over Nostr Wallet Connect (NIP-47) - its link pasted once,
  // kept in this browser. Connected, it is the default, its balance beside it (get_balance). It pays only when tapped.
  async readBalance() {
    const { nwc } = this.props; const u = this.nwcUri();
    if (!u || !nwc || !nwc.load) return;
    try {
      const N = await nwc.load();
      const b = await N.nwcBalance(u, { timeoutMs: 15000 });
      if (this.props.onNwc) this.props.onNwc({ balanceMsat: String(b) });
      this.set({ balanceMsat: BigInt(b), balanceWhy: '' });
    } catch (e) { this.set({ balanceMsat: null, balanceWhy: e.code || 'no answer' }); }
  }
  disconnect(e) { e.preventDefault(); try { this.props.nwc.forget(); } catch { /* none */ } this.set({ nwcUri: '', balanceMsat: null, balanceWhy: '', note: null }); }
  async payNwc() {
    const { nwc, onNwc } = this.props;
    const N = await (nwc && nwc.load ? nwc.load() : Promise.reject(new Error('the wallet connection did not load'))).catch((e) => { this.set({ note: e.message }); return null; });
    if (!N) return;
    let u = this.nwcUri();
    if (!u) {
      if (!this.state.linkShown) {
        return this.setState({ linkShown: true, note: 'Your wallet\'s link lets this page ask it to pay; your wallet decides, and you can disconnect it there.' },
          () => this.link.current && this.link.current.focus());
      }
      u = this.link.current ? this.link.current.value.trim() : '';
      try { N.parseNwc(u); } catch (e) { return this.set({ note: e.message }); }
      this.set({ nwcBusy: true, note: 'Asking your wallet …' });
      try { const i = await N.nwcGetInfo(u, { timeoutMs: 20000 }); nwc.keep(u); if (onNwc) onNwc({ connected: true, alias: i.alias || null, network: i.network || null }, true); }
      catch (e) { if (!/does not|unknown|NOT_IMPLEMENTED/i.test(e.code || e.message)) return this.set({ note: e.message, nwcBusy: false }); nwc.keep(u); }
      this.set({ nwcUri: u, linkShown: false, note: null });
    }
    const invoice = this.state.invoice;
    if (!invoice) return this.set({ note: 'No invoice yet - pick an amount first', nwcBusy: false });
    this.set({ nwcBusy: true });
    this.status(2, 'Your wallet is paying this invoice over Nostr Wallet Connect …', 'busy');
    const t0 = Date.now();
    try {
      const r = await N.nwcPay(u, invoice, { timeoutMs: 60000 });
      if (onNwc) onNwc({ paid: invoice.slice(0, 24), ms: Date.now() - t0, preimage: r.preimage.slice(0, 16) });
      this.set({ note: 'Paid by your wallet - waiting for the e-cash …' });
    } catch (e) {
      if (onNwc) onNwc({ failed: e.message });
      this.status(2, 'Your wallet did not pay: ' + e.message + ' - you can still pay the invoice above from any wallet.', 'fail');
    } finally { this.set({ nwcBusy: false }); this.readBalance(); }
  }
  // WEBLN WHERE AVAILABLE (spec §24): a browser wallet that puts window.webln on the page pays this invoice when tapped - enable() asks the
  // player's permission, sendPayment(invoice) pays. Shown only when such a wallet is there.
  async payWebln() {
    const { webln, onWebln } = this.props; const invoice = this.state.invoice;
    if (!webln || !invoice) return;
    this.set({ weblnBusy: true });
    this.status(2, 'Your browser wallet is paying this invoice (WebLN) …', 'busy');
    const t0 = Date.now();
    try {
      if (typeof webln.enable === 'function') await webln.enable();
      const r = await webln.sendPayment(invoice);
      if (onWebln) onWebln({ paid: invoice.slice(0, 24), ms: Date.now() - t0, preimage: String((r && r.preimage) || '').slice(0, 16) });
      this.set({ note: 'Paid by your browser wallet - waiting for the e-cash …' });
    } catch (e) {
      const failed = e && e.message ? e.message : String(e);
      if (onWebln) onWebln({ failed });
      this.status(2, 'Your browser wallet did not pay: ' + failed + ' - you can still pay the invoice above from any wallet.', 'fail');
    } finally { this.set({ weblnBusy: false }); }
  }

  render() {
    const { offer, title = 'Deposit', message = '', webln } = this.props;
    const s = this.state;
    const custom = s.tab === 'custom' && !s.rest;
    // the wallet's balance against this invoice: shown, and the button off when it cannot cover it
    const enough = s.balanceMsat === null || s.want === null || s.balanceMsat >= s.want;
    const nwcLabel = !s.nwcUri ? (s.linkShown ? 'Connect and pay' : 'Connect my wallet to pay in one tap (Nostr Wallet Connect)')
      : s.balanceMsat === null ? 'Pay with my wallet (Nostr Wallet Connect)'
        : enough ? `Pay with my wallet · ${sats(s.balanceMsat)} in it` : `My wallet has ${sats(s.balanceMsat)} - not enough for this`;
    const note = s.note !== null ? s.note : s.nwcUri
      ? <>{s.balanceWhy ? `Wallet connected (its balance is not shared: ${s.balanceWhy}) · ` : 'Wallet connected in this browser · '}<a href="#" style={{ color: '#c9a8ff' }} onClick={(e) => this.disconnect(e)}>disconnect</a></>
      : '';
    const st = s.status;
    return (
      <>
        <button type="button" className="dep-close" title="Close" onClick={() => this.close()}>{'×'}</button>
        <div className="dep-title">{s.rest ? restWords(s.rest) : message || title}</div>
        <div className="dep-backup-host" style={{ display: 'contents' }} />
        <div className="dep-tabs" style={s.rest ? { visibility: 'hidden' } : undefined}>
          {offer.choices.map((c) => <button key={c.key} type="button" data-key={c.key} className={s.tab === c.key ? 'on' : undefined} onClick={() => this.choose(c)}>{c.label}</button>)}
        </div>
        {/* the row keeps its place when hidden (visibility), so choosing Custom moves nothing */}
        <div className="dep-custom" style={{ visibility: custom ? 'visible' : 'hidden' }}>
          <input ref={this.field} type="text" inputMode="numeric" autoComplete="off" placeholder="amount in sat" value={s.typed} onChange={(e) => this.typed(e.target.value)} />
        </div>
        <div className="dep-amount">{s.amount}</div>
        <div className="dep-why">{s.why}</div>
        <div className="dep-nwc" style={{ margin: '8px 0 4px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <button type="button" className="dep-nwc-pay" disabled={!s.invoice || s.nwcBusy || (!!s.nwcUri && !enough)} onClick={() => this.payNwc()}
            style={{ font: '600 15px system-ui,sans-serif', padding: '11px', borderRadius: '10px', border: '1px solid #8e5cf2', background: s.nwcUri ? '#8e5cf2' : '#2a1f3d', color: s.nwcUri ? '#fff' : '#efe7ff', cursor: 'pointer' }}>{nwcLabel}</button>
          <input ref={this.link} type="text" autoComplete="off" spellCheck={false} placeholder={'nostr+walletconnect://… from your wallet\'s "connect an app"'}
            style={{ display: s.linkShown ? undefined : 'none', font: '13px ui-monospace,monospace', padding: '9px', borderRadius: '9px', border: '1px solid #3a4655', background: '#0b0f14', color: '#e8eaed' }} />
          <div style={{ fontSize: '12.5px', color: '#a9b3c1' }}>{note}</div>
          {webln ? <button type="button" className="dep-webln-pay" disabled={!s.invoice || s.weblnBusy} onClick={() => this.payWebln()}
            style={{ font: '600 15px system-ui,sans-serif', padding: '11px', borderRadius: '10px', border: '1px solid #f7931a', background: '#3a2a12', color: '#fff3e0', cursor: 'pointer' }}>Pay with my browser wallet (WebLN)</button> : null}
        </div>
        {s.qr
          ? <div className="arena-deposit-qr" style={{ background: '#fff', padding: '8px', width: 'min(80vw,320px,28vh)', margin: '6px auto', lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: s.qr }} />
          : <div className="arena-deposit-qr" style={{ background: '#fff', padding: '8px', width: 'min(80vw,320px,28vh)', margin: '6px auto', lineHeight: 0 }}><div className="qr-hold">{s.hold}</div></div>}
        <div className="dep-inv-row">
          <code ref={this.box} className="dep-invoice">{s.invoiceText}</code>
          <button type="button" className={'dep-copy' + (s.copy ? ' ' + s.copy : '')} disabled={!s.invoice} onClick={() => this.copyInvoice()}>
            {s.copy === 'copied' ? 'Copied ✓' : s.copy === 'failed' ? 'Copy failed - select the invoice' : 'Copy invoice'}</button>
        </div>
        {/* WHAT IS HAPPENING NOW, UNDER THE INVOICE (2026-09-30): making the invoice, waiting for the payment, the e-cash in the wallet */}
        <div className={'pay-status' + (st && st.kind ? ' ' + st.kind : '')}>
          <div className="pay-status-text">{st ? st.words : ''}</div>
          <div className="pay-bar"><div className="pay-bar-fill" style={{ width: `${st ? Math.max(0, Math.min(3, st.step)) / 3 * 100 : 0}%` }} /></div>
        </div>
      </>);
  }
}

/** THE WAIT BEFORE THE OFFER (2026-10-12 16:44: the box opens on the tap and says what it waits for; the invoice fills it when it is made):
 *  its close, its title, the page's backup warning, and the line - what it waits for, or why there is no deposit. */
export class DepositWait extends React.Component {
  render() {
    const { title, line, onClose } = this.props;
    return (
      <>
        <button type="button" className="dep-close" title="Close" onClick={onClose}>{'×'}</button>
        <div className="dep-title">{title}</div>
        <div className="dep-backup-host" style={{ display: 'contents' }} />
        <div className="dep-why">{line}</div>
      </>);
  }
}
