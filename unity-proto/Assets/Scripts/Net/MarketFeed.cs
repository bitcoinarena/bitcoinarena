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
    public string Status { get; private set; } = "connecting";

    public readonly List<Liquidation> Liquidations = new List<Liquidation>();
    public event Action<Liquidation> OnLiquidation;

    WebSocketClient _spot, _futures;
    float _lastMessage, _lastPriceMove, _retrySpot, _retryFutures;
    double _lastPrice;
    float _flowAccum;

    void Start()
    {
        _lastMessage = _lastPriceMove = Time.realtimeSinceStartup;
        Connect();
    }

    void Connect()
    {
        _spot?.Dispose();
        _futures?.Dispose();
        _spot = new WebSocketClient(SpotUrl);
        _futures = new WebSocketClient(FuturesUrl);
        Status = "connecting";
    }

    void Update()
    {
        float now = Time.realtimeSinceStartup;

        if (_spot != null)
            foreach (var msg in _spot.Drain()) { _lastMessage = now; HandleSpot(msg); }
        if (_futures != null)
            foreach (var msg in _futures.Drain()) { _lastMessage = now; HandleFutures(msg); }

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

        // A socket that is open but silent is dead in every way that matters.
        bool stale = now - _lastMessage > 12f;
        var s = _spot?.Status ?? WebSocketClient.State.Error;
        Status = stale ? "stale" : s == WebSocketClient.State.Open ? "live" : s.ToString().ToLower();

        if ((stale || s == WebSocketClient.State.Error || s == WebSocketClient.State.Closed)
            && now - _retrySpot > 6f)
        {
            _retrySpot = now;
            _lastMessage = now;
            Connect();
        }
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
