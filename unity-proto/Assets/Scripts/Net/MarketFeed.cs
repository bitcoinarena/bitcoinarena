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
    const string FuturesUrl = "wss://fstream.binance.com/stream?streams=!forceOrder@arr";

    [Serializable]
    public struct Liquidation
    {
        public bool Long;          // a long being liquidated is a forced SELL
        public double UsdValue;
        public double Price;
        public float Age;
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
    public string FuturesStatus { get; private set; } = "connecting";

    /// <summary>Messages drained off the futures socket. For a watcher to count.</summary>
    public int FuturesMessages { get; private set; }

    public readonly List<Liquidation> Liquidations = new List<Liquidation>();
    public event Action<Liquidation> OnLiquidation;

    WebSocketClient _spot, _futures;
    float _lastSpot, _lastFutures, _lastPriceMove, _retrySpot, _retryFutures;

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
        _lastSpot = _lastFutures = _lastPriceMove = Time.realtimeSinceStartup;
        Connect();
    }

    void Connect() { ConnectSpot(); ConnectFutures(); }

    // Separately, because one of them dying is not a reason to drop the other.
    void ConnectSpot()
    {
        _spot?.Dispose();
        _spot = new WebSocketClient(SpotUrl);
        Status = "connecting";
    }

    void ConnectFutures()
    {
        _futures?.Dispose();
        _futures = new WebSocketClient(FuturesUrl);
        FuturesStatus = "connecting";
        _futuresSpoke = false;
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
        if (_futures != null)
            foreach (var msg in _futures.Drain())
            {
                _lastFutures = now;
                FuturesMessages++;
                // The FUTURES socket carries the liquidations, and nothing here
                // ever looked at it: `Status` and the retry below are both
                // computed from the spot socket alone, so this one can be dead
                // while the HUD says "live" and the price keeps ticking. One
                // line, once, so a silent stream is visible instead of being
                // mistaken for a quiet market.
                if (!_futuresSpoke)
                {
                    _futuresSpoke = true;
                    Debug.Log("[feed] futures stream is delivering");
                }
                HandleFutures(msg);
            }

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
        FuturesStatus = Health(_futures, _lastFutures, FuturesSilence, now);

        if (Ailing(_spot, _lastSpot, SpotSilence, now) && now - _retrySpot > 6f)
        {
            _retrySpot = now;
            _lastSpot = now;
            Debug.Log("[feed] spot socket reopened");
            ConnectSpot();
        }

        if (Ailing(_futures, _lastFutures, FuturesSilence, now) && now - _retryFutures > 15f)
        {
            _retryFutures = now;
            _lastFutures = now;
            Debug.Log($"[feed] futures socket reopened after {FuturesMessages} messages");
            ConnectFutures();
        }
    }

    bool _futuresSpoke;

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

    void HandleFutures(string msg)
    {
        var data = Json.GetRaw(msg, "data") ?? msg;
        var order = Json.GetRaw(data, "o");
        if (order == null) return;
        if (Json.GetString(order, "s") != "BTCUSDT") return;      // BTC only

        double qty = Json.GetDouble(order, "q");
        double price = Json.GetDouble(order, "ap");
        if (price <= 0) price = Json.GetDouble(order, "p");
        if (qty <= 0 || price <= 0) return;

        // Every one of them, at the call site. Which side is liquidated decides
        // which skin the bomber wears, and fourteen minutes of watching showed
        // only the sideless simulated strike - so the question is whether this
        // is ever reached at all.
        Debug.Log($"[feed] liquidation {(Json.GetString(order, "S") == "SELL" ? "long" : "short")} " +
                  $"${qty * price:N0}");

        var liq = new Liquidation
        {
            // a forced SELL is a long position being closed out
            Long = Json.GetString(order, "S") == "SELL",
            UsdValue = qty * price,
            Price = price,
            Age = 0f,
        };
        Liquidations.Add(liq);
        OnLiquidation?.Invoke(liq);
    }

    void OnDestroy() { _spot?.Dispose(); _futures?.Dispose(); }
}
