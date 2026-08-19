using NUnit.Framework;
using UnityEngine;

/// <summary>
/// Pure-logic cover for the pieces the live feeds are built on. These need no
/// play mode and no network, so they run in a couple of seconds.
/// </summary>
public class JsonTests
{
    const string AggTrade =
        "{\"stream\":\"btcusdt@aggTrade\",\"data\":{\"e\":\"aggTrade\",\"E\":1,\"s\":\"BTCUSDT\",\"p\":\"63012.45\",\"q\":\"0.0137\",\"m\":true}}";

    [Test] public void ReadsNestedObject()
    {
        var data = Json.GetRaw(AggTrade, "data");
        Assert.IsNotNull(data);
        Assert.AreEqual("aggTrade", Json.GetString(data, "e"));
        Assert.AreEqual(63012.45, Json.GetDouble(data, "p"), 0.001);
        Assert.AreEqual(0.0137, Json.GetDouble(data, "q"), 1e-6);
    }

    [Test] public void ReadsStreamName()
        => Assert.AreEqual("btcusdt@aggTrade", Json.GetString(AggTrade, "stream"));

    [Test] public void HandlesUnquotedNumbers()
        => Assert.AreEqual(1700, Json.GetDouble("{\"n\":1700,\"x\":2}", "n"), 0.001);

    [Test] public void MissingFieldFallsBack()
        => Assert.AreEqual(-1, Json.GetDouble("{\"a\":1}", "nope", -1), 0.001);

    [Test] public void SplitsArrayOfPairs()
    {
        var els = Json.Elements("[[1.5,900],[2.0,1200],[3.25,50]]");
        Assert.AreEqual(3, els.Count);
        Assert.AreEqual("[2.0,1200]", els[1]);
    }

    [Test] public void SplitsArrayOfObjects()
    {
        var els = Json.Elements("[{\"a\":1},{\"a\":2}]");
        Assert.AreEqual(2, els.Count);
        Assert.AreEqual(2, Json.GetDouble(els[1], "a"), 0.001);
    }

    [Test] public void ForceOrderShape()
    {
        const string liq = "{\"e\":\"forceOrder\",\"o\":{\"s\":\"BTCUSDT\",\"S\":\"SELL\",\"q\":\"1.5\",\"ap\":\"62000\"}}";
        var o = Json.GetRaw(liq, "o");
        Assert.AreEqual("SELL", Json.GetString(o, "S"));
        Assert.AreEqual(1.5 * 62000, Json.GetDouble(o, "q") * Json.GetDouble(o, "ap"), 1.0);
    }
}

public class PriceHistoryTests
{
    [Test] public void SeedsOnFirstPriceSoTheMapIsNeverEmpty()
    {
        var h = new PriceHistory(64);
        Assert.IsFalse(h.Seeded);
        h.Feed(63000, 0.016f);
        Assert.IsTrue(h.Seeded);
        Assert.AreEqual(64, h.Count);
    }

    [Test] public void WindowTracksARisingMarket()
    {
        var h = new PriceHistory(64, 6.4f);   // 0.1 s per sample
        h.Feed(60000, 0.1f);
        for (int i = 0; i < 400; i++) h.Feed(60000 + i * 20, 0.1f);
        Assert.Greater(h.Hi, 63000, "window never followed the price up");
        Assert.Greater(h.Ema, 62000, "ema lagged far behind a sustained trend");
    }

    [Test] public void FlatTapeStillProducesAUsableWindow()
    {
        var h = new PriceHistory(64, 6.4f);
        for (int i = 0; i < 200; i++) h.Feed(63000, 0.1f);
        Assert.Greater(h.Hi - h.Lo, 0, "a frozen tape collapsed the window to zero");
        float z = h.FrontlineZ(0, 260, 170);
        Assert.IsFalse(float.IsNaN(z), "frontline went NaN on a flat tape");
    }

    [Test] public void FrontlineSpansTheMapAndStaysInBounds()
    {
        var h = new PriceHistory(64, 6.4f);
        h.Feed(60000, 0.1f);
        for (int i = 0; i < 300; i++) h.Feed(60000 + Mathf.Sin(i * 0.05f) * 400f, 0.1f);
        for (float x = -130; x <= 130; x += 5)
        {
            float z = h.FrontlineZ(x, 260, 170);
            Assert.LessOrEqual(Mathf.Abs(z), 170 * 0.5f, $"frontline left the map at x={x}");
        }
    }

    [Test] public void RisingPriceMovesTheLine()
    {
        var h = new PriceHistory(64, 6.4f);
        h.Feed(60000, 0.1f);
        for (int i = 0; i < 200; i++) h.Feed(60000, 0.1f);
        float flat = h.FrontlineZ(120, 260, 170);
        for (int i = 0; i < 200; i++) h.Feed(60000 + i * 30, 0.1f);
        float risen = h.FrontlineZ(120, 260, 170);
        Assert.Greater(Mathf.Abs(risen - flat), 0.5f, "the frontline ignored a 6000 dollar rally");
    }
}
