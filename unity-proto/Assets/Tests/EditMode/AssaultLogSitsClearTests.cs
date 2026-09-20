using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE ASSAULT LOG AND BANNER STAY OFF THE PRICE (the owner 2026-09-20 16:26: "Do not overlap the $ price. Do not
/// restyle the headline"), AND OFF PHONES ("Not on phone").
///
/// The words themselves are `AssaultsAreVisibleTests`. This is the other half of that letter: where they are
/// allowed to be. The headline stack owns the top of the gap between the columns - price, per-cent, liquidation,
/// block clock - and everything this letter adds goes UNDER the clock, in that order, with the banner keeping
/// its row whether or not one is showing so the log does not walk up the screen.
///
/// Checked at the size the screenshots are taken at and at two others, because a box that clears the price at
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

    /// <summary>Under the block clock, in this order, never touching the price's own row.</summary>
    [Test]
    public void TheBannerAndTheLogSitUnderTheHeadlineStack()
    {
        var hud = Hud();
        foreach (var s in Screens)
        {
            int w = s.x, h = s.y;
            float priceTop = hud.HeadlineRowY(w, h, 0);
            var clock = hud.BlockTimerBox(w, h);
            var banner = hud.AssaultBannerBox(w, h);
            var log = hud.AssaultLogBox(w, h);

            Assert.GreaterOrEqual(banner.y, clock.yMax,
                $"{w}x{h}: the banner starts below the block clock, not across it");
            Assert.GreaterOrEqual(log.y, banner.yMax,
                $"{w}x{h}: the log starts below the banner's own row");
            Assert.Greater(banner.y, priceTop,
                $"{w}x{h}: the banner is under the price, never over it");
            Assert.Greater(log.y, hud.HeadlineRowY(w, h, 3),
                $"{w}x{h}: the log is under every row of the headline stack");
            Assert.Greater(banner.height, 0f, $"{w}x{h}: a banner with no height is a banner nobody sees");
            Assert.Greater(log.height, 0f, $"{w}x{h}: and a log with none is the bug being fixed");
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
        ChartHud.Watch.Observe(new int[Blwp.Layout.CH_WORDS], System.DateTime.Now, 1f);
        var after = hud.AssaultLogBox(1280, 800);
        Assert.AreEqual(before, after, "the log's box is the screen's, not the war's");
    }

    /// <summary>The whole stack still fits on the screen it is drawn on.</summary>
    [Test]
    public void TheLogEndsAboveTheBottomOfTheScreen()
    {
        var hud = Hud();
        foreach (var s in Screens)
        {
            var log = hud.AssaultLogBox(s.x, s.y);
            Assert.Less(log.yMax, s.y,
                $"{s.x}x{s.y}: {AssaultWatch.Keep} lines run off the bottom of the screen");
        }
    }
}
