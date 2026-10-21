// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SMALL PARTS OF THE ARENA PAGE IN REACT (kanban #564): the refund key's line in an open round (its fingerprint, where the seed came from,
// how to check it, the seed's backup folded away - the restore lives in Settings since 2026-10-04) and the way back to the Arena when a
// game's client is not loaded. Class components; the page hands them their words and its rules.
import React from 'react';

export class RefundKey extends React.Component {
  render() {
    const { fingerprint, imported, roundIdHex, seedHex } = this.props;
    return (
      <>
        {'refund key fingerprint ' + fingerprint
          + (imported ? ' (from the seed you imported)' : ' (from a seed this page made: back it up, or restore your own in Settings)')
          + ' - check it: refund-key.mjs <your seed> ' + roundIdHex}
        <details><summary>seed backup</summary><code>{seedHex}</code></details>
      </>);
  }
}

/** every way back says Arena */
export class BackToArena extends React.Component {
  render() { return <button type="button" className="game" onClick={this.props.onBack}>{'← Arena'}</button>; }
}
