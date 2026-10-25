// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SETUP'S PROGRESS, ON BOTH DASHBOARDS (kanban #635, the owner 2026-10-25: "in dem public Node Dashboard ein Panel einblenden mit dem
// Status der node anzeigen wieviel confirmations Bond und peg in haben. Das selbe auch beim owner Dashboard"): the installer posts the bond
// and the rest without waiting, so this card says how far each is - Bitcoin Core's background sync, the bond's confirmations and whether it
// counts, the peg-in's confirmations against the federation's finality. Drawn from GET /setup-status; nothing when there is nothing to show.
import React from 'react';

const n = (x) => Number(x || 0).toLocaleString('en-US');
const shortTx = (t) => `${String(t).slice(0, 12)}…`;
const pct = (a, b) => Math.max(0, Math.min(100, b ? Math.round((100 * a) / b) : 0));
/** "about 3 h" for an ETA in ms; '' when there is none yet. */
export const eta = (ms) => (ms === null || ms === undefined ? '' : ms < 3600000 ? `about ${Math.max(1, Math.round(ms / 60000))} min left` : ms < 172800000 ? `about ${Math.round(ms / 3600000)} h left` : `about ${Math.round(ms / 86400000)} days left`);

/** One line of the card: a label, the state in words, a meter. */
class Step extends React.Component {
  render() {
    const { id, label, done, text, meter } = this.props;
    return (
      <div className="setup-step" id={id}>
        <span className={done ? 'ok' : 'wait'}>{done ? '✓' : '○'}</span>
        <div><b>{label}</b> <span className="sub">{text}</span>
          {meter !== undefined ? <div className="bar"><i style={{ width: `${meter}%` }} /></div> : null}</div>
      </div>);
  }
}

/** The words for each part (exported for the tests). */
export function coreLine(c) {
  if (!c) return null;
  if (!c.interim) return { done: true, text: 'synced; your node reads the chain from its own Bitcoin Core' };
  const s = c.sync;
  if (!s) return { done: false, text: c.why ? `starting: ${c.why}` : 'starting' };
  return { done: false, meter: Math.round(s.progress * 100), text: `syncing, block ${n(s.blocks)} of ${n(s.headers)} (${(s.progress * 100).toFixed(1)} %)${eta(s.etaMs) ? `, ${eta(s.etaMs)}` : ''}. Until then your node reads the chain from a public server.` };
}
export function bondLine(b) {
  if (!b) return null;
  if (!b.seen) return { done: false, text: `${n(b.sats)} sat, ${shortTx(b.txid)}: not seen on the chain yet` };
  if (!b.confirmations) return { done: false, meter: 0, text: `${n(b.sats)} sat, sent, waiting for its first confirmation. It must confirm by block ${n(b.confirmBy)} to count.` };
  if (b.counts === false) return { done: false, text: `${n(b.sats)} sat, ${n(b.confirmations)} confirmations, but it confirmed after block ${n(b.confirmBy)} and does not count. Post a new bond from the bond panel.` };
  return { done: true, text: `${n(b.sats)} sat, ${n(b.confirmations)} confirmation${b.confirmations === 1 ? '' : 's'}. It counts; locked for ${n(b.blocksToMaturity)} more blocks.` };
}
export function pegInLine(p) {
  if (!p) return null;
  if (!p.seen) return { done: false, text: `${n(p.sats)} sat, ${shortTx(p.txid)}: not seen on the chain yet` };
  if (p.credited) return { done: true, text: `${n(p.sats)} sat, ${n(p.confirmations)} confirmations: the federation has credited it` };
  return { done: false, meter: pct(p.confirmations, p.needed), text: `${n(p.sats)} sat, ${n(p.confirmations)} of ${n(p.needed)} confirmations. The federation credits it at ${n(p.needed)}.` };
}

export class SetupStatus extends React.Component {
  render() {
    const s = this.props.status;
    if (!s || !s.ok) return null;
    const rows = [['setup-core', 'Bitcoin Core', coreLine(s.core)], ['setup-bond', 'Bond', bondLine(s.bond)], ['setup-pegin', 'Peg-in', pegInLine(s.pegIn)]].filter(([, , l]) => l);
    if (!rows.length) return null;
    const all = rows.every(([, , l]) => l.done);
    return (
      <div className="card setup-status" id="setup-status">
        <h3>Setup {all ? <span className="ok">complete</span> : <span className="sub">in progress</span>}</h3>
        {rows.map(([id, label, l]) => <Step key={id} id={id} label={label} done={l.done} text={l.text} meter={l.meter} />)}
        {s.tip ? <p className="sub">Chain tip: block {n(s.tip)}</p> : null}
      </div>);
  }
}
