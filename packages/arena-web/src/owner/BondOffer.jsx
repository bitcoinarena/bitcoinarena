// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BOND AS AN OFFER, AND THE CAPACITY PLEA, IN REACT (kanban #564): what owner.html's bondAnswer() and capacityPlea() drew by hand.
// DO I NEED TO ADD TO MY BOND? (kanban #553, 2026-10-20: "The operator does not need to add a bond, he can if he wants to earn more.
// Less text, more graphics and more direct instructions"; "earn 350% more e.g"): whether this node is drawn (its standing: its bond against
// what most rounds ask) and, apart from that, the federation it guards that pays most for a bigger bond while it fills up - one headline, a
// bar from the bond now to the bond that pays most, and two steps with the numbers worked out: send the rest to the bond wallet (its
// address and QR), then add, with the plan shown before it is posted. THE CAPACITY PLEA (§23A.3a, kanban #543): a federation this node
// guards is filling up, said when the Bond answer does not already carry it. The page reads the seat and hands over: `standing`, `capacity`,
// `bond` (each null when it did not answer), `address()`, `plan(sats)`, `add(sats)`, `qr(text)`, `onNeed(key, level, text)`.
import React from 'react';

const n = (x) => Number(x).toLocaleString('en-US');
const fedLabel = (fid) => `Federation ${String(fid).slice(0, 8)}`;
/** blocks as days and hours (kanban #553: "the number of blocks left AND the estimated times in days and hours") */
export const daysHours = (ms) => { const h = Math.max(0, Math.round(ms / 3600000)); const d = Math.floor(h / 24); return d ? `${d} day${d === 1 ? '' : 's'} ${h % 24} h` : `${h} h`; };

/** What the answer says, worked out from what the seat said: drawn or not, and the best offer to add (null when none pays extra). */
export function bondAnswerOf({ standing: st, capacity: c, bond: b }) {
  const w = st && (st.warnings || []).find((x) => x.kind === 'losing brackets');
  const short = w ? Math.max(0, Number(st.commonBondMinSats) - Number(st.ownBondSats)) : 0;
  const drawn = !st || st.ownBondSats === null ? { tone: 'sub', text: 'Your bond is not counted yet: this node is not drawn for rounds until it is.' }
    : w ? { tone: 'err', text: `⚠ Your bond is below what most rounds ask (${n(st.commonBondMinSats)} sat): add ${n(short)} sat to be drawn again.` }
    : { tone: 'ok', text: '✓ Your bond is enough: this node is drawn for rounds.' };
  // the federation that pays most for a bigger bond (the weighting is on while it is filling up)
  const offers = ((c && c.mine) || []).filter((m) => Number(m.addSats) > 0 && ['PRESSURE', 'CRITICAL', 'FULL'].includes(m.band))
    .sort((x, y) => y.ifRaised / y.now - x.ifRaised / x.now);
  if (!offers.length) return { drawn, short: w ? short : null, offer: null };
  const m = offers[0], add = Number(m.addSats), x = m.ifRaised / m.now;
  const wl = b && b.wallet && !b.wallet.why ? b.wallet : null;
  return { drawn, short: w ? short : null, offer: { add, times: x >= 1.95 ? `${x.toFixed(1)}× more` : `${Math.round((x - 1) * 100)} % more`, fed: fedLabel(m.federation),
    loadPct: Math.round(m.load * 100), now: Number(m.bondSats), target: Number(m.targetBondSats),
    pct: Math.max(2, Math.min(100, Math.round(Number(m.bondSats) * 100 / Number(m.targetBondSats)))),
    send: wl ? Math.max(0, add + Number(wl.addOverheadSats || 0) - Number(wl.spendableSats)) : null, wallet: wl } };
}

export class BondAnswer extends React.Component {
  constructor(props) {
    super(props);
    this.state = { address: null, addressWhy: '', copied: false, step: null, plan: null, done: null, why: '' };
  }
  componentDidMount() {
    const a = bondAnswerOf(this.props);
    const { onNeed } = this.props;
    if (onNeed) {
      if (a.short !== null) onNeed('bond', 'bad', `Your bond is too small to be drawn for rounds. Add ${n(a.short)} sat.`);
      if (a.offer) onNeed('earn', 'warn', `Earn up to ${a.offer.times} from ${a.offer.fed}: add ${n(a.offer.add)} sat to your bond.`);
    }
    if (a.offer && a.offer.wallet && a.offer.send > 0) {
      this.props.address().then((r) => this.setState({ address: r.address }), (e) => this.setState({ addressWhy: e.message }));
    }
  }
  // ADD TO THE BOND: the plan, then one button (kanban #553: posted from the page)
  async plan(add) {
    this.setState({ step: 'planning', why: '', done: null });
    try { this.setState({ step: 'plan', plan: await this.props.plan(add) }); } catch (e) { this.setState({ step: null, why: e.message }); }
  }
  async confirm(add) {
    this.setState({ step: 'posting' });
    try { const d = await this.props.add(add); this.setState({ step: 'done', done: d }); } catch (e) { this.setState({ step: null, why: e.message }); }
  }
  copy() { navigator.clipboard.writeText(this.state.address).then(() => this.setState({ copied: true }), () => {}); }
  render() {
    const a = bondAnswerOf(this.props), s = this.state, o = a.offer;
    const drawn = <p className={a.drawn.tone}>{a.drawn.text}</p>;
    if (!o) return <><h3>Your bond</h3>{drawn}<p className="sub">No federation you guard pays extra for a bigger bond right now. This page tells you when one does.</p></>;
    const p = s.plan;
    return (
      <>
        <h3 className="offer">💰 Earn up to {o.times}</h3>
        <p>{o.fed} is {o.loadPct} % full and pays guardians with bigger bonds more. Optional.</p>
        <div className="bar"><div style={{ width: `${o.pct}%` }} /></div>
        <div className="row sub" style={{ border: 0 }}><span>your bond {n(o.now)} sat</span><span>{n(o.target)} sat</span></div>
        <ol className="steps">
          {o.send === null ? null : o.send > 0
            ? <li><b>Send {n(o.send)} sat</b> to your bond wallet<div id="ab-addr" className="sub">
              {s.address ? <><div className="path"><code>{s.address}</code><button type="button" id="ab-copy" onClick={() => this.copy()}>{s.copied ? 'Copied ✓' : 'Copy'}</button></div>
                <div className="qr" dangerouslySetInnerHTML={{ __html: this.props.qr('bitcoin:' + s.address + '?amount=' + (o.send / 1e8).toFixed(8)) }} />
                <p className="sub">Your bond wallet has {n(o.wallet.spendableSats)} sat. This adds the rest and about {n(o.wallet.addOverheadSats)} sat for fees.</p></>
                : s.addressWhy || 'getting the address…'}</div></li>
            : <li className="ok">✓ Your bond wallet has enough.</li>}
          <li><button type="button" className="primary" id="ab-go" disabled={o.send > 0 || s.step !== null} onClick={() => this.plan(o.add)}>Add {n(o.add)} sat to my bond</button>
            {o.send > 0 ? <span className="sub"> - once the coins have arrived</span> : null}
            <div id="ab-msg">
              {s.step === 'planning' ? 'Working it out…' : null}
              {(s.step === 'plan' || s.step === 'posting') && p ? <><div className="warn">Bond {n(p.bondSats)} → <b>{n(p.totalSats)} sat</b> · fees {n(p.fees.total)} sat · locked until block {String(p.maturity)} (about {daysHours(p.lock.estimatedMs - Date.now())}) · counts in about an hour</div>
                <button type="button" className="primary" id="ab-post" disabled={s.step === 'posting'} onClick={() => this.confirm(o.add)}>Confirm</button> <button type="button" id="ab-cancel" onClick={() => this.setState({ step: null, plan: null })}>Cancel</button></> : null}
              {s.step === 'done' && s.done ? <p className="ok"><b>Done ✓</b> {n(p.addSats)} sat added (<code>{s.done.bond.txid.slice(0, 16)}…</code>). It counts in about an hour.</p> : null}
              {s.why ? <p className="err">{s.why}</p> : null}
            </div></li>
        </ol>
        {drawn}
      </>);
  }
}

/** THE CAPACITY PLEA (§23A.3a): nothing while all is calm, or when the Bond answer carries the plea (a guardian's own federations). */
export class CapacityPlea extends React.Component {
  render() {
    const c = this.props.capacity;
    const p = c && c.plea && !(c.mine || []).length ? c.plea : null;
    if (!p) return null;
    return (
      <div className="card"><h3>A federation you guard is filling up</h3><p className="warnline">{p.says}</p>
        {p.addSats ? <p className="sub">This is optional and separate from whether your node is drawn: a larger bond lets that federation take more deposits (it lowers its load) and earns you a larger share. Add to bond is below.</p> : null}</div>);
  }
}
