// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Live BTC tape: price and trade flow from Binance spot, forced liquidations
/// from Binance futures. Self-healing - a dropped socket reconnects, and a
/// socket that is open but silent counts as dead, because that is the failure
/// that actually happens.
/// </summary>
public class MarketFeed : MonoBehaviour
{
    const string SpotUrl =
        "wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/btcusdt@ticker";
    // ROUTED. Binance moved the futures streams behind /public and /market, and
    // the old unrouted host only answers for /public - which is why a socket
    // carrying bookTicker AND !forceOrder@arr flooded with one and never heard
    // the other. Measured over 110 s from this machine:
    //
    //   /ws/!forceOrder@arr                     0 messages
    //   /market/ws/!forceOrder@arr             42 messages
    //   /public/ws/btcusdt@bookTicker       75635 messages
    //   /market/stream?streams=btcusdt@forceOrder   0 messages
    //
    // So: the all-market stream on /market, and nothing else on this socket.
    // Per-symbol forced orders return nothing even on the right route, and
    // mixing a /public stream in is what broke it in the first place. BTC is
    // filtered in code, where BTCDOM - dominance, not the coin - never matches.
    //
    // No separate heartbeat socket: this stream carries every symbol on the
    // exchange and delivered 42 messages in 110 s on its own, so the silence
    // window already tells a dead socket from a quiet market.
    const string FuturesUrl = "wss://fstream.binance.com/market/ws/!forceOrder@arr";

    // THE COIN-MARGINED BOOK, which is a different exchange underneath.
    //
    // BTCUSD_PERP is settled in coin, not in USDT, and its forced orders never
    // appear on fstream - so a coin-margined liquidation paid the player
    // nothing at all, in any build. The stream is Binance's own, named in
    // their docs (COIN-M "All Market Liquidation Order Streams", base
    // wss://dstream.binance.com, stream !forceOrder@arr), and the /market
    // route is the one the 2026-04-23 change notice leaves standing.
    //
    // It carries BOTH books. Measured over 300 s: 588 messages, 214 symbols,
    // of which three were coin-M contracts - ETHUSD_PERP, BTCUSD_PERP,
    // XRPUSD_PERP - and the rest USDT-M names fstream is already delivering.
    // Half a percent. That is why `IsCoinMargined` is not a nicety: without
    // it this socket would double every USDT-M liquidation on the map.
    const string CoinMarginedUrl =
        "wss://dstream.binance.com/market/stream?streams=!forceOrder@arr";
    const string BybitUrl = "wss://stream.bybit.com/v5/public/linear";
    const string OkxUrl = "wss://ws.okx.com:8443/ws/v5/public";

    [Serializable]
    public struct Liquidation
    {
        public bool Long;          // a long being liquidated is a forced SELL
        public double UsdValue;
        public double Price;
        public float Age;
        /// <summary>Which exchange it came off. The HUD names it.</summary>
        public string Venue;
    }

    public double Price { get; private set; }
    public double DayChangePct { get; private set; }
    /// <summary>Signed trade flow over the last few seconds: >0 buyers lifting offers.</summary>
    public float Flow { get; private set; }
    public bool Fresh => Price > 0 && Time.realtimeSinceStartup - _lastPriceMove < 20f;
    /// <summary>The SPOT socket: price and flow.</summary>
    public string Status { get; private set; } = "connecting";

    /// <summary>
    /// The FUTURES socket: the liquidations, and its own state.
    ///
    /// Separate because it fails separately. `Status` was computed from `_spot`
    /// alone and so was the retry under it, so a dead futures socket read as a
    /// healthy feed for a whole session - the price kept ticking, the HUD said
    /// "live", and not one liquidation ever arrived. Measured: twelve minutes
    /// with no message on this socket at all, not even a forced order in a
    /// symbol `HandleFutures` would have thrown away.
    /// </summary>
    public string FuturesStatus => Sources.Count > 0 ? Sources[0].Status : "none";

    /// <summary>Messages drained off the Binance socket. For a watcher to count.</summary>
    public int FuturesMessages => Sources.Count > 0 ? Sources[0].Messages : 0;

    /// <summary>
    /// One liquidation feed: a socket, its subscription, its keepalive and its
    /// own health.
    ///
    /// Three of them rather than one, because one is not enough to check.
    /// Binance's forced-order stream sits open and empty for very long stretches
    /// - measured 0 messages in 180 s from node and from a bare browser page,
    /// while bookTicker on the very same host gave 4397 in four seconds. So the
    /// stream is quiet, not the host, and a second and third venue is the only
    /// way to tell a quiet market from a broken subscription.
    ///
    /// The keepalive is not optional. Bybit dropped at 1006 and OKX at 4004
    /// inside a minute with nothing sent; both document a ping and both were
    /// measured closing without one.
    /// </summary>
    public class Source
    {
        public readonly string Name, Url, Subscribe, Ping;
        public readonly float PingEvery;
        public WebSocketClient Sock;
        public float LastMsg, LastPing, Retry;
        public bool Sent, Spoke, Logged;
        /// <summary>Forced orders seen in ANY symbol. The liveness proof.</summary>
        public int Forced;
        public int Messages, Accepted;
        public string Status = "connecting";

        public Source(string name, string url, string subscribe, string ping, float every)
        { Name = name; Url = url; Subscribe = subscribe; Ping = ping; PingEvery = every; }
    }

    /// <summary>Every liquidation feed, for the HUD to name.</summary>
    public readonly List<Source> Sources = new List<Source>();

    public readonly List<Liquidation> Liquidations = new List<Liquidation>();
    public event Action<Liquidation> OnLiquidation;

    WebSocketClient _spot;
    float _lastSpot, _lastPriceMove, _retrySpot;

    // A ticker that goes quiet for twelve seconds is broken. An EVENT stream is
    // not a ticker: forced orders arrive when they arrive. But this one carries
    // every symbol on the exchange, so three minutes of complete silence is not
    // a quiet market either - it is a socket nobody is talking to.
    const float SpotSilence = 12f;
    const float FuturesSilence = 180f;
    double _lastPrice;
    float _flowAccum;

    void Start()
    {
        float now = Time.realtimeSinceStartup;
        _lastSpot = _lastPriceMove = now;

        // Binance needs no subscription - the stream is in the URL - and no
        // keepalive, because the server pings and both socket paths answer it.
        // The other two need both, and were measured closing without them.
        Sources.Add(new Source("binance", FuturesUrl, null, null, 0f));
        Sources.Add(new Source("binance-cm", CoinMarginedUrl, null, null, 0f));
        Sources.Add(new Source("bybit", BybitUrl,
            "{\"op\":\"subscribe\",\"args\":[\"allLiquidation.BTCUSDT\"]}",
            "{\"op\":\"ping\"}", 20f));
        Sources.Add(new Source("okx", OkxUrl,
            "{\"op\":\"subscribe\",\"args\":[{\"channel\":\"liquidation-orders\",\"instType\":\"SWAP\"}]}",
            "ping", 20f));
        foreach (var v in Sources) { v.LastMsg = now; v.LastPing = now; }

        Connect();
    }

    void Connect()
    {
        ConnectSpot();
        foreach (var v in Sources) Open(v);
    }

    void Open(Source v)
    {
        v.Sock?.Dispose();
        v.Sock = new WebSocketClient(v.Url);
        v.Status = "connecting";
        v.Sent = false;
        v.Spoke = false;
    }

    // Separately, because one of them dying is not a reason to drop the other.
    void ConnectSpot()
    {
        _spot?.Dispose();
        _spot = new WebSocketClient(SpotUrl);
        Status = "connecting";
    }

    /// <summary>What a socket looks like from outside: live, stale, or its own fault.</summary>
    static string Health(WebSocketClient c, float last, float silence, float now)
    {
        if (c == null) return "none";
        var st = c.Status;
        if (st != WebSocketClient.State.Open) return st.ToString().ToLower();
        return now - last > silence ? "stale" : "live";
    }

    /// <summary>True when a socket needs opening again.</summary>
    static bool Ailing(WebSocketClient c, float last, float silence, float now)
    {
        if (c == null) return true;
        var st = c.Status;
        return st == WebSocketClient.State.Error || st == WebSocketClient.State.Closed
            || now - last > silence;
    }

    void Update()
    {
        float now = Time.realtimeSinceStartup;

        if (_spot != null)
            foreach (var msg in _spot.Drain()) { _lastSpot = now; HandleSpot(msg); }
        foreach (var v in Sources) Pump(v, now);

        // trade flow decays, so it reads as "right now" rather than "since boot"
        _flowAccum = Mathf.Lerp(_flowAccum, 0f, 1f - Mathf.Exp(-1.5f * Time.deltaTime));
        Flow = Mathf.Clamp(_flowAccum, -1f, 1f);

        for (int i = Liquidations.Count - 1; i >= 0; i--)
        {
            var l = Liquidations[i];
            l.Age += Time.deltaTime;
            Liquidations[i] = l;
            if (l.Age > 90f) Liquidations.RemoveAt(i);
        }

        // A socket that is open but silent is dead in every way that matters -
        // and each of these two is judged on its OWN silence and reopened on its
        // own, because the price ticking says nothing about the liquidations.
        Status = Health(_spot, _lastSpot, SpotSilence, now);

        if (Ailing(_spot, _lastSpot, SpotSilence, now) && now - _retrySpot > 6f)
        {
            _retrySpot = now;
            _lastSpot = now;
            Debug.Log("[feed] spot socket reopened");
            ConnectSpot();
        }
    }

    /// <summary>
    /// Drive one liquidation feed: subscribe when it opens, keep it alive,
    /// drain it, and reopen it when it goes quiet.
    /// </summary>
    void Pump(Source v, float now)
    {
        if (v.Sock == null) { Open(v); return; }

        // Subscribe once, and only after it is actually open - a frame sent to
        // a socket still connecting goes nowhere.
        if (!v.Sent && v.Sock.Status == WebSocketClient.State.Open)
        {
            v.Sent = true;
            if (!string.IsNullOrEmpty(v.Subscribe)) v.Sock.Send(v.Subscribe);
            Debug.Log($"[feed] {v.Name} open, subscribe {(v.Subscribe == null ? "not needed" : "sent")}");
        }

        if (v.Sent && !string.IsNullOrEmpty(v.Ping) && now - v.LastPing > v.PingEvery)
        {
            v.LastPing = now;
            v.Sock.Send(v.Ping);
        }

        foreach (var msg in v.Sock.Drain())
        {
            v.LastMsg = now;
            v.Messages++;
            if (!v.Spoke)
            {
                v.Spoke = true;
                Debug.Log($"[feed] {v.Name} is delivering");
            }
            Take(v, msg);
        }

        v.Status = Health(v.Sock, v.LastMsg, FuturesSilence, now);
        if (Ailing(v.Sock, v.LastMsg, FuturesSilence, now) && now - v.Retry > 15f)
        {
            v.Retry = now;
            v.LastMsg = now;
            Debug.Log($"[feed] {v.Name} reopened after {v.Messages} messages");
            Open(v);
        }
    }

    void Take(Source v, string msg)
    {
        switch (v.Name)
        {
            case "binance": HandleFutures(v, msg); break;
            case "binance-cm": HandleCoinMargined(v, msg); break;
            case "bybit": HandleBybit(v, msg); break;
            case "okx": HandleOkx(v, msg); break;
        }
    }

    void Raise(Source v, bool isLong, double usd, double price)
    {
        if (usd <= 0 || price <= 0) return;
        v.Accepted++;
        var liq = new Liquidation
        {
            Long = isLong, UsdValue = usd, Price = price, Age = 0f, Venue = v.Name,
        };
        Liquidations.Add(liq);
        Debug.Log($"[feed] liquidation {v.Name} {(isLong ? "long" : "short")} ${usd:N0}");
        OnLiquidation?.Invoke(liq);
    }

    /// <summary>
    /// Bybit `allLiquidation.BTCUSDT`: data is an array of forced orders with a
    /// side, a size in BTC and a price.
    ///
    /// THE SIDE IS THE POSITION, NOT THE ORDER. This was read the way Binance's
    /// is - a forced Sell closes a long - and that was wrong, so every Bybit
    /// strike flew the other side's skin.
    ///
    /// Settled against the price rather than against a field name, because the
    /// price is the only ground truth here: a rising book forces shorts out, a
    /// falling one forces longs. Scored over a 20-minute window, each print
    /// against the move that led into it:
    ///
    ///   S=Buy  means a long was liquidated   17/17
    ///   S=Sell means a long was liquidated    0/17
    ///
    /// Not a coincidence with OKX either - the two venues were only in the same
    /// second three times, and never disagreed.
    /// </summary>
    void HandleBybit(Source v, string msg)
    {
        var arr = Json.GetRaw(msg, "data");
        if (arr == null || !arr.TrimStart().StartsWith("[")) return;
        LogFirstPayload(v, msg);
        foreach (var e in Json.Elements(arr))
        {
            if (Json.GetString(e, "s") != "BTCUSDT") continue;
            double qty = Json.GetDouble(e, "v"), price = Json.GetDouble(e, "p");
            Raise(v, Json.GetString(e, "S") == "Buy", qty * price, price);
        }
    }

    /// <summary>
    /// OKX `liquidation-orders`, SWAP: each entry carries `details`, and each
    /// detail names the position side outright - "long" or "short" - so nothing
    /// has to be inferred from an order side.
    ///
    /// SIZE IS IN BTC, and the first real payload is what says so. It read
    /// `sz: "0.02"` on BTC-USDT-SWAP, and 0.02 cannot be a count of contracts:
    /// the minimum order on that instrument is one whole contract. 0.02 BTC is
    /// exactly two contracts of 0.01, so the field is the coin amount and the
    /// price multiplies it straight. The first cut divided by a hundred and
    /// made a $1,592 liquidation read as $16 - which would have dug the
    /// smallest crater the rule has for every strike OKX ever sent.
    /// </summary>
    void HandleOkx(Source v, string msg)
    {
        var arr = Json.GetRaw(msg, "data");
        if (arr == null || !arr.TrimStart().StartsWith("[")) return;
        foreach (var e in Json.Elements(arr))
        {
            if (Json.GetString(e, "instId") != "BTC-USDT-SWAP") continue;
            LogFirstPayload(v, msg);
            var details = Json.GetRaw(e, "details");
            if (details == null) continue;
            foreach (var d in Json.Elements(details))
            {
                double sz = Json.GetDouble(d, "sz"), px = Json.GetDouble(d, "bkPx");
                Raise(v, Json.GetString(d, "posSide") == "long", sz * px, px);
            }
        }
    }

    /// <summary>
    /// The first real payload off a venue, whole, once.
    ///
    /// Every side and size mapping here is read off documentation, and this
    /// letter has already been caught twice by a shape that was not what it was
    /// assumed to be. One log line makes the assumption checkable instead of
    /// permanent.
    /// </summary>
    void LogFirstPayload(Source v, string msg)
    {
        if (v.Accepted > 0 || v.Logged) return;
        v.Logged = true;
        Debug.Log($"[feed] {v.Name} first payload: {(msg.Length > 400 ? msg.Substring(0, 400) : msg)}");
    }

    void HandleSpot(string msg)
    {
        var data = Json.GetRaw(msg, "data");
        if (data == null) return;
        string kind = Json.GetString(data, "e");

        if (kind == "aggTrade")
        {
            double p = Json.GetDouble(data, "p");
            double q = Json.GetDouble(data, "q");
            if (p <= 0) return;
            SetPrice(p);
            // "m" is true when the buyer is the market maker, i.e. an aggressive SELL
            bool sell = Json.GetString(data, "m") == "true";
            _flowAccum += (float)(q * (sell ? -1 : 1)) * 0.6f;
        }
        else if (kind == "24hrTicker")
        {
            double c = Json.GetDouble(data, "c");
            if (c > 0) SetPrice(c);
            DayChangePct = Json.GetDouble(data, "P");
        }
    }

    void SetPrice(double p)
    {
        // Freshness has to be measured on a price CHANGE. A ticker that keeps
        // arriving with an identical price looks alive and is not.
        if (Math.Abs(p - _lastPrice) > 1e-9) { _lastPrice = p; _lastPriceMove = Time.realtimeSinceStartup; }
        Price = p;
    }

    void HandleFutures(Source v, string msg)
    {
        var data = Json.GetRaw(msg, "data") ?? msg;
        var order = Json.GetRaw(data, "o");
        if (order == null) return;
        // Counted for EVERY symbol: one forced order anywhere proves the
        // subscription is alive, which a BTC-only counter never could - BTC can
        // be quiet for an hour while the rest of the book is being cleared out.
        v.Forced++;

        string sym = Json.GetString(order, "s") ?? "";
        if (!sym.StartsWith("BTC") || sym.StartsWith("BTCDOM")) return;   // the coin only

        double qty = Json.GetDouble(order, "q");
        double price = Json.GetDouble(order, "ap");
        if (price <= 0) price = Json.GetDouble(order, "p");
        if (qty <= 0 || price <= 0) return;

        LogFirstPayload(v, msg);
        // a forced SELL is a long position being closed out
        Raise(v, Json.GetString(order, "S") == "SELL", qty * price, price);
    }

    /// <summary>
    /// Is this Binance's name for a COIN-margined contract?
    ///
    /// Not "has an underscore": USDT-M has dated contracts too, and
    /// BTCUSDT_261225 arrived on this very socket during the capture. The
    /// shape is a base, then USD, then the underscore - BTCUSD_PERP,
    /// BTCUSD_260925 - where a USDT-M dated name has USDT before it.
    ///
    /// Checked against Binance's own two lists rather than reasoned about:
    /// of dapi's 30 coin-M symbols this accepts 30, and of fapi's 897 USDT-M
    /// symbols it accepts 0, including all four of fapi's underscore names.
    /// </summary>
    public static bool IsCoinMargined(string symbol)
    {
        if (string.IsNullOrEmpty(symbol)) return false;
        int bar = symbol.IndexOf('_');
        return bar > 3 && symbol.Substring(0, bar).EndsWith("USD");
    }

    /// <summary>
    /// What a coin-margined forced order is worth in dollars.
    ///
    /// The quantity on this book is CONTRACTS, not coin. Reading it the way
    /// the USDT-M handler does - `q * price` - would have called a single
    /// BTCUSD_PERP contract $79,000 of liquidation when it is $100 of it, and
    /// reading it as coin would have paid nothing recognisable either.
    ///
    /// The sizes are Binance's, off dapi's exchangeInfo: BTCUSD_PERP,
    /// BTCUSD_260925 and BTCUSD_261225 are 100 USD a contract, and the other
    /// twenty-seven coin-M symbols are 10 USD.
    /// </summary>
    public static double CoinMarginedUsd(string symbol, double contracts)
        => contracts * (symbol != null && symbol.StartsWith("BTC") ? 100.0 : 10.0);

    /// <summary>
    /// The coin-margined socket. Same payload shape as `HandleFutures` - it is
    /// the same `forceOrder` event - and two things different: only coin-M
    /// names are taken, because the USDT-M ones on this socket are already
    /// arriving on the other, and the value is contracts times contract size
    /// rather than quantity times price.
    /// </summary>
    public void HandleCoinMargined(Source v, string msg)
    {
        var data = Json.GetRaw(msg, "data") ?? msg;
        var order = Json.GetRaw(data, "o");
        if (order == null) return;
        v.Forced++;

        string sym = Json.GetString(order, "s") ?? "";
        if (!IsCoinMargined(sym)) return;                 // fstream has this one
        if (!sym.StartsWith("BTC") || sym.StartsWith("BTCDOM")) return;   // the coin only

        double contracts = Json.GetDouble(order, "q");
        double price = Json.GetDouble(order, "ap");
        if (price <= 0) price = Json.GetDouble(order, "p");
        if (contracts <= 0 || price <= 0) return;

        LogFirstPayload(v, msg);
        // a forced SELL is a long position being closed out, as on the other book
        Raise(v, Json.GetString(order, "S") == "SELL", CoinMarginedUsd(sym, contracts), price);
    }

    void OnDestroy()
    {
        _spot?.Dispose();
        foreach (var v in Sources) v.Sock?.Dispose();
    }
}
