// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SHOP'S ITEMS IN REACT (kanban #564, the Arena page): what the page's openShop drew by hand into #arena-shop .items - one row per item
// the game sells, its picture, name, what it does and its price; an owned one says so with its "Play with it" switch, any other has its Buy
// button, off while its purchase runs. The page keeps the rules and hands them over: `items` (the shop's), `owned` (what this player owns,
// read from the seats), `use` (the items chosen to play with, null = all owned), `picture(id)` (the item's SVG, the page's own),
// `what(id)`, `price(priceSat)` (the price with the player's share), `onUse(id, on)` and `onBuy(item)` (resolves when the purchase is done
// or refused). A class component; the class names are the page's, so its stylesheet reads it as before.
import React from 'react';

export class ShopItems extends React.Component {
  constructor(props) { super(props); this.state = { buying: null }; }
  async buy(it) {
    this.setState({ buying: it.id });
    try { await this.props.onBuy(it); } finally { this.setState({ buying: null }); }
  }
  render() {
    const { items, owned, use, picture, what, price, onUse } = this.props;
    return items.map((it) => {
      const mine = owned.some((o) => o.itemId === it.id);
      const sat = String(price(it.priceSat));
      return (
        <div key={it.id} className="item" data-item={it.id}>
          <div className="pic" dangerouslySetInnerHTML={{ __html: picture(it.id) || '' }} />
          <div><div className="name">{it.name}</div><div className="what">{(what(it.id) ? what(it.id) + ' · ' : '') + sat + ' sat'}</div></div>
          <div>{mine
            ? <><div className="owned">Owned ✓</div>
              <label className="use"><input type="checkbox" checked={!use || use.includes(it.id)} onChange={(e) => onUse(it.id, e.target.checked)} />Play with it</label></>
            : <button type="button" className="buy" disabled={this.state.buying === it.id} onClick={() => this.buy(it)}>{'Buy · ' + sat + ' sat'}</button>}
          </div>
        </div>);
    });
  }
}
