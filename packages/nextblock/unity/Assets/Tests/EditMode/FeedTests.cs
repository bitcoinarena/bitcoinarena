// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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

/// <summary>
/// The controls have to survive real phone aspect ratios. Overlapping pads
/// would make "gas and steer at once" ambiguous, and a pad half off the screen
/// is simply unreachable.
/// </summary>
public class TouchPadTests
{
    static readonly (int w, int h, string name)[] Screens =
    {
        (844, 390, "iPhone 14 quer"),
        (932, 430, "iPhone 15 Pro Max quer"),
        (390, 844, "iPhone 14 hoch"),
        (1180, 820, "iPad quer"),
        (2340, 1080, "Android sehr breit"),
        (360, 640, "kleines Android hoch"),
    };

    [Test] public void PadsNeverOverlap()
    {
        foreach (var s in Screens)
            Assert.IsTrue(TouchPad.LayoutIsDisjoint(s.w, s.h), $"Pads ueberlappen auf {s.name} ({s.w}x{s.h})");
    }

    [Test] public void PadsStayOnScreen()
    {
        foreach (var s in Screens)
            Assert.IsTrue(TouchPad.LayoutFitsOnScreen(s.w, s.h), $"Pad liegt ausserhalb auf {s.name} ({s.w}x{s.h})");
    }

    [Test] public void ButtonsAreBigEnoughForAThumb()
    {
        foreach (var s in Screens)
            Assert.GreaterOrEqual(TouchPad.ButtonSize(s.w, s.h), 76f, $"zu klein auf {s.name}");
    }

    [Test] public void HitTestFindsThePressedPad()
    {
        const int W = 844, H = 390;
        var up = TouchPad.RectFor(TouchPad.Pad.Up, W, H);
        var points = new System.Collections.Generic.List<Vector2> { up.center };
        Assert.IsTrue(TouchPad.Hit(TouchPad.Pad.Up, W, H, points));
        Assert.IsFalse(TouchPad.Hit(TouchPad.Pad.Down, W, H, points));
    }

    [Test] public void TwoThumbsRegisterTogether()
    {
        const int W = 844, H = 390;
        var points = new System.Collections.Generic.List<Vector2>
        {
            TouchPad.RectFor(TouchPad.Pad.Up, W, H).center,
            TouchPad.RectFor(TouchPad.Pad.Left, W, H).center,
        };
        Assert.IsTrue(TouchPad.Hit(TouchPad.Pad.Up, W, H, points), "Gas nicht erkannt");
        Assert.IsTrue(TouchPad.Hit(TouchPad.Pad.Left, W, H, points), "Lenken nicht erkannt");
    }
}

public class TouchResolveTests
{
    const int W = 844, H = 390;
    static Vector2 C(TouchPad.Pad p) => TouchPad.RectFor(p, W, H).center;

    [Test] public void GasAndSteerAtTheSameTime()
    {
        var pts = new System.Collections.Generic.List<Vector2> { C(TouchPad.Pad.Up), C(TouchPad.Pad.Left) };
        TouchPad.Resolve(pts, W, H, out var thr, out var steer, out var hb);
        Assert.AreEqual(1f, thr, 0.001f, "Gas nicht erkannt");
        Assert.AreEqual(-1f, steer, 0.001f, "Lenken links nicht erkannt");
        Assert.IsFalse(hb);
    }

    [Test] public void BrakeIsNegativeThrottle()
    {
        var pts = new System.Collections.Generic.List<Vector2> { C(TouchPad.Pad.Down) };
        TouchPad.Resolve(pts, W, H, out var thr, out _, out _);
        Assert.AreEqual(-1f, thr, 0.001f);
    }

    [Test] public void HandbrakeIsItsOwnPad()
    {
        var pts = new System.Collections.Generic.List<Vector2> { C(TouchPad.Pad.Handbrake) };
        TouchPad.Resolve(pts, W, H, out var thr, out var steer, out var hb);
        Assert.IsTrue(hb);
        Assert.AreEqual(0f, thr, 0.001f, "Handbremse hat versehentlich Gas gegeben");
        Assert.AreEqual(0f, steer, 0.001f);
    }

    [Test] public void OppositePadsCancel()
    {
        var pts = new System.Collections.Generic.List<Vector2> { C(TouchPad.Pad.Left), C(TouchPad.Pad.Right) };
        TouchPad.Resolve(pts, W, H, out _, out var steer, out _);
        Assert.AreEqual(0f, steer, 0.001f);
    }

    [Test] public void EmptyScreenIsNeutral()
    {
        TouchPad.Resolve(new System.Collections.Generic.List<Vector2>(), W, H,
                         out var thr, out var steer, out var hb);
        Assert.AreEqual(0f, thr, 0.001f); Assert.AreEqual(0f, steer, 0.001f); Assert.IsFalse(hb);
    }

    [Test] public void WorksInPortraitToo()
    {
        var pts = new System.Collections.Generic.List<Vector2> { TouchPad.RectFor(TouchPad.Pad.Up, 390, 844).center };
        TouchPad.Resolve(pts, 390, 844, out var thr, out _, out _);
        Assert.AreEqual(1f, thr, 0.001f);
    }
}

/// <summary>The view toggle must not collide with the driving pads.</summary>
public class ViewPadTests
{
    static readonly (int w, int h)[] Screens =
        { (844, 390), (932, 430), (390, 844), (1180, 820), (2340, 1080), (360, 640) };

    [Test] public void ViewPadNeverOverlapsTheControls()
    {
        foreach (var (w, h) in Screens)
            Assert.IsTrue(TouchPad.LayoutIsDisjoint(w, h), $"Pads ueberlappen auf {w}x{h}");
    }

    [Test] public void ViewPadStaysOnScreen()
    {
        foreach (var (w, h) in Screens)
            Assert.IsTrue(TouchPad.LayoutFitsOnScreen(w, h), $"Pad ausserhalb auf {w}x{h}");
    }

    [Test] public void TappingViewDoesNotSteerOrAccelerate()
    {
        const int W = 844, H = 390;
        var pts = new System.Collections.Generic.List<Vector2>
            { TouchPad.RectFor(TouchPad.Pad.View, W, H).center };
        TouchPad.Resolve(pts, W, H, out var thr, out var steer, out var hb);
        Assert.AreEqual(0f, thr, 0.001f); Assert.AreEqual(0f, steer, 0.001f); Assert.IsFalse(hb);
    }
}
