// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S UPTIME (kanban #756, a tester in Arena Chat 1385: "Show the 24h uptime that is important for node inclusion (mention where it
// is important in simple language) and also when it is not reached. Also display 7d uptime and 30d uptime and all time uptime. That belongs in
// owner dashboard and public dashboard (without the instructions)"). One answer, GET /uptime (packages/arena-node/src/uptime.js), drawn three
// ways: the four figures with a "below inclusion" marker on the node dashboard (UptimeStats), the same with where the 24 h matters and what to
// do on the owner page (UptimePanel), one cell per node on the health page (uptimeCell).
import React from 'react';

/** A share as the page shows it: one decimal under 100 %, "-" while nothing is kept. */
export const uptimePct = (share) => (typeof share !== 'number' ? '-' : share >= 1 ? '100 %' : `${(Math.floor(share * 1000) / 10).toFixed(1)} %`);
/** "28 Oct 14:02 UTC". */
export const uptimeWhen = (ms) => {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.toISOString().slice(11, 16)} UTC`;
};
const mins = (ms) => Math.round(Number(ms) / 60000);
/** Is the 24 h below what the draw reads? */
export const belowInclusion = (U) => !!(U && U.inclusion && U.inclusion.met === false);

/** The four figures: { key, label, value, since } - `since` the date the record starts when the window reaches back past it. */
export function uptimeRows(U) {
  if (!U || !Array.isArray(U.windows)) return [];
  return U.windows.map((w) => ({ key: w.key, label: w.label, value: uptimePct(w.share), share: typeof w.share === 'number' ? w.share : null,
    since: (w.partial || w.key === 'all') && U.sinceMs ? uptimeWhen(U.sinceMs) : null }));
}

/** THE PUBLIC FIGURES: four tiles, the 24 h marked when below inclusion; no instructions. */
export class UptimeStats extends React.Component {
  render() {
    const U = this.props.uptime;
    if (!U || !Array.isArray(U.windows)) return null;
    const below = belowInclusion(U);
    return (
      <div className="stats uptime">{uptimeRows(U).map((r) => (
        <div key={r.key} className="stat"><span>Uptime · {r.label}</span>
          <b className={r.key === '24h' ? (below ? 'bad' : 'ok') : undefined}>{r.value}</b>
          {r.key === '24h' ? <small className={below ? 'bad' : undefined}>{below ? (U.inclusion.inForce ? 'below inclusion' : 'below inclusion (from 2.0)') : 'inclusion reached'}</small> : null}
          {r.since ? <small>since {r.since}</small> : null}
        </div>))}
      </div>);
  }
}

/** Where the 24 h matters, in plain words: this line's rule. */
export function whereItMatters(U) {
  const need = mins((U && U.inclusion && U.inclusion.needMs) || 900000);
  const rule = `your node is drawn into game and settlement committees only if it was seen online in the 24 hours before the day's census - at least once, at one heartbeat or seating (one every ${need} minutes). A node seen at none is left out of the draw until it is seen again; its bond is not touched.`;
  return U && U.inclusion && U.inclusion.inForce ? `Y${rule.slice(1)}`
    : `From Bitcoin Arena 2.0, ${rule} In this release uptime does not decide the draw yet, but a drawn node that is offline loses that seat to a reserve and earns no fee for the round.`;
}

/** The warning when the 24 h is below the line, with when it is reached again. */
export function belowWarning(U) {
  if (!belowInclusion(U)) return null;
  const inc = U.inclusion, need = mins(inc.needMs);
  const what = inc.inForce ? 'so it is left out of the next census' : 'from 2.0 that leaves a node out of the draw';
  const again = inc.metAgainAtMs ? ` It is reached again at ${uptimeWhen(inc.metAgainAtMs)}, after ${need} minutes up without a break${inc.inForce ? '; the census after that draws it again' : ''}.` : '';
  return `Your node has not run ${need} minutes without a break in the last 24 hours, ${what}.${again} Keep it running and online.`;
}

/** THE OWNER'S CARD: the four figures as tiles, the 24 h's inclusion as its status, the warning when it is not reached, and where the 24 h
 *  matters folded under one line (kanban #805, a tester in Arena Chat 9213: "do this not as a wall of text but as nice looking tiles").
 *  Reads GET /uptime itself. */
export class UptimePanel extends React.Component {
  constructor(props) { super(props); this.state = { uptime: null, error: null, ...(props.initial ? { uptime: props.initial } : {}) }; }
  async componentDidMount() {
    if (this.state.uptime || !this.props.api) return;
    try {
      const uptime = await this.props.api.get('/uptime');
      this.setState({ uptime });
      if (belowInclusion(uptime) && this.props.onBelow) this.props.onBelow(uptime);
    } catch (e) { this.setState({ error: e.message }); }
  }
  render() {
    const { uptime: U, error } = this.state;
    if (error) return <p className="sub">Uptime not readable: {error}</p>;
    if (!U || !Array.isArray(U.windows)) return null;
    const warn = belowWarning(U), below = belowInclusion(U);
    return (
      <div className="uptime">
        <div className="up-tiles">{uptimeRows(U).map((r) => {
          const day = r.key === '24h';
          return (
            <div key={r.key} className={'up-tile' + (day && below ? ' bad' : day && (r.share ?? 0) >= 0.5 ? ' ok' : '')}>
              <span className="up-win">{day ? 'Last 24 hours' : r.label}</span>
              <b className="up-pct">{r.value}</b>
              <span className="up-bar" aria-hidden="true"><i style={{ width: `${Math.round((r.share ?? 0) * 100)}%` }} /></span>
              {day ? <span className={'pill ' + (below ? 'bad' : 'on')}>{below ? 'Below inclusion' : 'Inclusion reached'}</span>
                : r.since ? <small>since {r.since}</small> : <small>&nbsp;</small>}
            </div>);
        })}</div>
        {warn ? <p className="err up-warn"><b>Below inclusion</b>: {warn}</p> : null}
        <details className="more up-why"><summary>Why the last 24 hours matter</summary>
          <p className="sub">{whereItMatters(U)}</p>
          {U.sinceMs ? <p className="sub">This node keeps its uptime from {uptimeWhen(U.sinceMs)}, when it first ran a release that records it; nothing before is counted.</p> : null}
        </details>
      </div>);
  }
}

/** ONE CELL ON THE HEALTH PAGE: "24 h · 7 d · 30 d · all" and whether the 24 h is below inclusion; null when the node did not answer. */
export function uptimeCell(U) {
  if (!U || !Array.isArray(U.windows)) return null;
  const by = Object.fromEntries(U.windows.map((w) => [w.key, uptimePct(w.share)]));
  return { text: `${by['24h']} · ${by['7d']} · ${by['30d']} · ${by.all}`, below: belowInclusion(U), since: U.sinceMs ? uptimeWhen(U.sinceMs) : null };
}
