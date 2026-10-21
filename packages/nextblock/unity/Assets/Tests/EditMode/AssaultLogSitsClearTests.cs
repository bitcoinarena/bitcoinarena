// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE ASSAULT LOG SITS ON THE LEFT HUD STACK, AND THE BANNER STAYS OFF THE PRICE.
///
/// Two rulings. 2026-09-20 16:26 gave the log its rules - "a small desktop-only debug log under the HUD, clock
/// times ... Not on phone. Do not overlap the $ price" - and it was first drawn in the headline gap under the
/// block clock, which cleared the price and then sat CENTRED OVER THE ROAD, photographed on Daily 0.0.1835.
/// The second ruling settled where it goes: "Left column. Under SIM, left-aligned, small font, same six assault
/// lines, colour still by side. Not the right column - that edge already carries WANTED and the touch buttons,
/// and the road has to stay clear."
///
/// So this pins the LEFT column now, and that is a change of what is asserted, not a loosening: the old
/// position was itself the fault. The BANNER is unchanged and still checked against the headline stack - it is
/// the loud thing, it belongs in front of the player, and only the log went to the edge.
///
/// Checked at the size the screenshots are taken at and at two others, because a box that clears the road at
/// 1280x800 and lands on it at 844x390 is the same bug photographed later.
/// </summary>
public class AssaultLogSitsClearTests
{
    static DriveHud Hud()
    {
        var go = new GameObject("hud-under-test");
        return go.AddComponent<DriveHud>();
    }

    static readonly Vector2Int[] Screens =
    {
        new Vector2Int(1280, 800),      // the test host Chrome playtest
        new Vector2Int(1920, 1080),     // a desktop
        new Vector2Int(844, 390),       // a phone in landscape, where the gap is narrowest
    };

    /// <summary>The banner is under the block clock, in the gap, never over the price.</summary>
    [Test]
    public void TheBannerSitsUnderTheHeadlineStack()
    {
        var hud = Hud();
        foreach (var s in Screens)
        {
            int w = s.x, h = s.y;
            float priceTop = hud.HeadlineRowY(w, h, 0);
            var clock = hud.BlockTimerBox(w, h);
            var banner = hud.AssaultBannerBox(w, h);

            Assert.GreaterOrEqual(banner.y, clock.yMax,
                $"{w}x{h}: the banner starts below the block clock, not across it");
            Assert.Greater(banner.y, priceTop, $"{w}x{h}: the banner is under the price, never over it");
            Assert.Greater(banner.height, 0f, $"{w}x{h}: a banner with no height is a banner nobody sees");
        }
    }

    /// <summary>
    /// THE LOG IS ON THE LEFT EDGE, UNDER SIM, AND OFF THE ROAD.
    ///
    /// The road is the middle of the screen and it is the game. This is the guard that the log cannot drift back
    /// into it: it shares the left column's x, starts below the SIM switch, and its right edge stops well short
    /// of the middle.
    /// </summary>
    [Test]
    public void TheLogSitsOnTheLeftStackUnderSim()
    {
        var hud = Hud();
        foreach (var s in Screens)
        {
            int w = s.x, h = s.y;
            var sim = hud.SimBox(w, h);
            var log = hud.AssaultLogBox(w, h);

            Assert.AreEqual(sim.x, log.x, 0.5f, $"{w}x{h}: the log is on the left column's own edge");
            Assert.GreaterOrEqual(log.y, sim.yMax, $"{w}x{h}: the log starts under the SIM switch");
            Assert.Less(log.xMax, w * 0.42f,
                $"{w}x{h}: the log reaches into the middle of the screen - that is the road, and the road is the game");
            Assert.Greater(log.height, 0f, $"{w}x{h}: a log with no height is the bug being fixed");
        }
    }

    /// <summary>
    /// The log's row is reserved whether or not a banner is up, so lines do not jump when one ends.
    ///
    /// Both boxes are pure geometry - they are worked out from the screen, not from the watch - so this is the
    /// check that the banner's presence cannot move them.
    /// </summary>
    [Test]
    public void TheLogDoesNotMoveWhenABannerComesAndGoes()
    {
        var hud = Hud();
        var before = hud.AssaultLogBox(1280, 800);
        ChartHud.Watch.Observe(new int[Arena.Layout.CH_WORDS], System.DateTime.Now, 1f);
        var after = hud.AssaultLogBox(1280, 800);
        Assert.AreEqual(before, after, "the log's box is the screen's, not the war's");
    }

    /// <summary>It keeps whole lines and never hangs off the bottom, however short the window is.</summary>
    [Test]
    public void TheLogGivesUpOldLinesRatherThanTheScreenEdge()
    {
        var hud = Hud();
        foreach (var s in new[] { new Vector2Int(1280, 800), new Vector2Int(1280, 520), new Vector2Int(1024, 440) })
        {
            var log = hud.AssaultLogBox(s.x, s.y);
            int lines = hud.AssaultLogLines(s.x, s.y);
            Assert.LessOrEqual(log.yMax, s.y,
                $"{s.x}x{s.y}: the log runs off the bottom of the screen");
            Assert.LessOrEqual(lines, AssaultWatch.Keep, $"{s.x}x{s.y}: it cannot draw more than it keeps");
            Assert.GreaterOrEqual(lines, 1, $"{s.x}x{s.y}: a log with no room for one line is not a log");
        }
    }

}
