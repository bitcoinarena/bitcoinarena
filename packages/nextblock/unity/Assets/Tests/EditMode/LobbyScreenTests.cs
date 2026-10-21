// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;
using Arena;

/// <summary>
/// THE DAILY'S LOBBY IN UNITY, FULLY VISIBLE ON EVERY PHONE (M3.3-34, the owner
/// 2026-09-12 22:16: "lobby and all its elements must be fully visible in Unity
/// on iOS and Android").
///
/// OnGUI never runs in batch mode, so visible is measured the way the title
/// screen's own test measures it: the layout is arithmetic, asked for at the
/// screen shapes iPhones and Android phones actually have - portrait and
/// landscape, in CSS pixels, as the page lays the title screen out - and
/// every element has to sit inside the panel, clear of every other, with room
/// for at least two rounds and buttons a finger can hit.
/// </summary>
public class LobbyScreenTests
{
    static readonly Vector2[] Css =
    {
        // iOS: SE, 12-15, Pro Max - portrait and landscape
        new Vector2(375, 667), new Vector2(667, 375), new Vector2(390, 844), new Vector2(844, 390),
        new Vector2(430, 932), new Vector2(932, 430),
        // Android: common small and large phones - portrait and landscape
        new Vector2(360, 800), new Vector2(800, 360), new Vector2(412, 915), new Vector2(915, 412),
        // tablets and desktops
        new Vector2(768, 1024), new Vector2(1024, 768), new Vector2(1366, 768), new Vector2(1920, 1080),
    };

    static void Inside(Rect inner, Rect outer, string what)
    {
        const float e = 0.5f;
        Assert.IsTrue(inner.xMin >= outer.xMin - e && inner.yMin >= outer.yMin - e
                      && inner.xMax <= outer.xMax + e && inner.yMax <= outer.yMax + e,
            $"{what}: {inner} is not inside {outer}");
    }

    static string Heights(DailyLobby.Frame f) => string.Join("/", System.Array.ConvertAll(f.howToCells, c => c.height.ToString("0.0")));

    /// <summary>
    /// A PHONE UPRIGHT'S FOUR PAGES (2026-09-15, option B): panel i alone on page i, each
    /// taller than the same panel in the grid that screen had (`grid`), and 1 and 2 at least
    /// CarouselTaller x that grid's top row; the arrows a finger's size, in the box, on no panel
    /// and not on each other.
    /// </summary>
    static void CarouselPagesAreRight(DailyLobby.Frame l, DailyLobby.Frame grid, Rect copy, string at)
    {
        float top = Mathf.Max(grid.howToCells[0].height, grid.howToCells[1].height);
        for (int i = 0; i < 4; i++)
        {
            Assert.AreEqual(i, DailyLobby.HowToPageOf(i), $"panel {i + 1} is not alone on page {i + 1} {at}");
            Assert.Greater(l.howToCells[i].height, grid.howToCells[i].height + 0.5f,
                $"panel {i + 1} is {l.howToCells[i].height:0.0} px, no taller than the grid's {grid.howToCells[i].height:0.0} px {at} (copy {copy}, box {l.howTo})");
        }
        for (int i = 0; i < 2; i++)
            Assert.GreaterOrEqual(l.howToCells[i].height, DailyLobby.CarouselTaller * top - 0.5f,
                $"panel {i + 1} is {l.howToCells[i].height:0.0} px, not {DailyLobby.CarouselTaller} x the grid's top row {top:0.0} px {at}"
                + $" (copy {copy}, box {l.howTo})");
        foreach (var (r, what) in new[] { (l.howToPrev, "the left arrow"), (l.howToNext, "the right arrow") })
        {
            Assert.GreaterOrEqual(r.width, 34f, $"{what} is under a finger's width {at}: {r}");
            Assert.GreaterOrEqual(r.height, 34f, $"{what} is under a finger's height {at}: {r}");
            Inside(r, l.howTo, $"{what} {at}");
            for (int i = 0; i < 4; i++) Assert.IsFalse(r.Overlaps(l.howToCells[i]), $"{what} overlaps panel {i + 1} {at}");
        }
        Assert.IsFalse(l.howToPrev.Overlaps(l.howToNext), $"the arrows overlap {at}");
    }

    [Test]
    public void EveryLobbyElementIsInsideThePanelAndClearOfEveryOtherOnEveryPhone()
    {
        foreach (var css in Css)
        {
            // IN CSS PIXELS, AS THE PAGE LAYS IT OUT: SplashScreen.OnGUI measures Screen / UiScale -
            // the canvas's pixels per CSS pixel, since 0.0.1159 - so an iPhone drawing at 3x
            // (1170x2532) is laid out at 390x844. The 2x / 2.625x / 3x shapes this once multiplied
            // out are shapes no live phone lays out.
            float w = css.x, h = css.y;
            float min = Mathf.Min(w, h);
            float sub = Mathf.Clamp(min * 0.028f, 14f, 24f);
            float btn = Mathf.Clamp(min * 0.040f, 18f, 34f);
            var f = SplashScreen.Measure(w, h, sub, btn);
            var l = DailyLobby.MeasureLobby(f.copy, Mathf.Round(sub), css.y > css.x);
            string at = $"at {css.x}x{css.y} css";

            Inside(f.panel, new Rect(0, 0, w, h), $"the panel {at}");
            foreach (var (r, what) in new[] { (f.play, "PLAY"), (f.spectate, "SPECTATE"), (f.hint, "the hint") })
                Inside(r, f.panel, $"{what} {at}");

            var parts = new[] { (l.you, "who you are"), (l.name, "NAME"), (l.key, "KEY"), (l.head, "the rounds header"),
                                (l.more, "the page button"), (l.list, "the round list"), (l.howTo, "the how-to art") };
            // THE OWNER'S HOW-TO, FOUR PANELS (2026-09-14 07:55): each whole - never
            // stretched, never a sliver - in layout units, like every size checked
            // here; 1-2 over 3-4 on a portrait screen, one row on a desktop.
            Assert.IsNotNull(l.howToCells, $"no how-to panels {at}");
            Assert.AreEqual(4, l.howToCells.Length, $"not four how-to panels {at}");
            // A PHONE UPRIGHT TURNS PAGES (2026-09-15 11:57): panels on different pages
            // share the box, so only panels on the same page must keep clear of each other.
            bool portrait = css.y > css.x;
            Assert.IsFalse(l.howToCarousel && !portrait, $"a carousel on a screen that is not portrait {at}");
            for (int i = 0; i < 4; i++)
            {
                var c = l.howToCells[i];
                Assert.GreaterOrEqual(c.height, DailyLobby.HowToMinCell - 0.5f, $"how-to panel {i + 1} is under {DailyLobby.HowToMinCell} px high {at}: {c}");
                Assert.AreEqual(DailyLobby.PanelAspectOf(i), c.width / c.height, 0.01f, $"how-to panel {i + 1} is stretched {at}: {c}");
                Inside(c, l.howTo, $"how-to panel {i + 1} {at}");
                for (int j = i + 1; j < 4; j++)
                    if (!l.howToCarousel || DailyLobby.HowToPageOf(i) == DailyLobby.HowToPageOf(j))
                        Assert.IsFalse(c.Overlaps(l.howToCells[j]), $"how-to panels {i + 1} and {j + 1} overlap {at}");
            }
            // THE GRID THE HOW-TO HAD ON THIS SCREEN BEFORE (carousel: false): what a phone's pages
            // are held to, and on a screen that is not portrait, exactly what it must still be.
            var grid = DailyLobby.MeasureLobby(f.copy, Mathf.Round(sub), portrait, carousel: false);
            if (portrait)
            {
                Assert.IsTrue(l.howToCarousel, $"a portrait screen without the one-panel pages {at}");
                CarouselPagesAreRight(l, grid, f.copy, at);
                TestContext.Out.WriteLine($"HOWTO {css.x}x{css.y} copy {f.copy.width:0} grid {Heights(grid)} rows {grid.rows}"
                    + $" -> pages {Heights(l)} rows {l.rows}");
            }
            else
            {
                Assert.AreEqual(grid.howTo, l.howTo, $"the how-to moved on a screen that is not portrait {at}");
                for (int i = 0; i < 4; i++)
                    Assert.AreEqual(grid.howToCells[i], l.howToCells[i], $"panel {i + 1} moved on a screen that is not portrait {at}");
            }
            if (css.x >= 1366f)
                Assert.AreEqual(l.howToCells[0].y, l.howToCells[3].y, 0.5f, $"a wide desktop does not get 1-2-3-4 in one row {at}");
            Assert.IsFalse(l.howTo.Overlaps(f.play) || l.howTo.Overlaps(f.spectate) || l.howTo.Overlaps(f.hint),
                $"the how-to art and the buttons overlap {at}");
            foreach (var (r, what) in parts) Inside(r, f.copy, $"{what} {at}");
            for (int i = 0; i < parts.Length; i++)
                for (int j = i + 1; j < parts.Length; j++)
                    Assert.IsFalse(parts[i].Item1.Overlaps(parts[j].Item1), $"{parts[i].Item2} and {parts[j].Item2} overlap {at}");
            foreach (var (r, what) in new[] { (f.play, "PLAY"), (f.spectate, "SPECTATE"), (f.hint, "the hint") })
                Assert.IsFalse(l.list.Overlaps(r) || l.you.Overlaps(r), $"the lobby and {what} overlap {at}");

            Assert.GreaterOrEqual(l.rows, 2, $"fewer than two rounds fit {at}: list {l.list.height:0} px, row {l.rowH:0} px"
                + $" (copy {f.copy}, how-to {l.howTo} grid {l.howToGrid}, narrow {l.narrow}, you {l.you}, head {l.head}, list {l.list})");
            Assert.LessOrEqual(l.rows * l.rowH, l.list.height + 0.5f, $"the rows run out of the list {at}");
            foreach (var (r, what) in new[] { (l.name, "NAME"), (l.key, "KEY"), (l.more, "the page button") })
                Assert.GreaterOrEqual(r.height, 27f, $"{what} is too small to press {at}");
            Assert.GreaterOrEqual(l.name.height, 34f, $"NAME is under a finger's height {at}");
            Assert.GreaterOrEqual(l.rowH, 34f, $"a round row is under a finger's height {at}");
            Assert.GreaterOrEqual(f.play.height, 30f, $"PLAY is under a finger's height {at}");
        }
    }

    /// <summary>
    /// the owner's whole how-to ships in Resources and is imported whole - 1448x1086,
    /// not a power-of-two rounding - because every panel is drawn from it by its box.
    /// </summary>
    [Test]
    public void TheHowToArtLoadsWhole()
    {
        var t = Resources.Load<Texture2D>(DailyLobby.HowToWhole);
        Assert.IsNotNull(t, "the lobby's how-to is not in Resources");
        Assert.AreEqual(1448, t.width, "the how-to was rescaled on import");
        Assert.AreEqual(1086, t.height, "the how-to was rescaled on import");
    }

    const string Sample ="{\"mode\":\"lobby\",\"from\":\"daily.json\",\"you\":{\"name\":\"azure-elk-1364\",\"custom\":false,"
        + "\"generated\":\"azure-elk-1364\",\"fingerprint\":\"1a2b3c4d\"},\"rows\":["
        + "{\"id\":\"aaaa1111\",\"free\":true,\"agree\":2,\"needed\":2,\"joinable\":true,\"leftS\":40,\"joined\":0},"
        + "{\"id\":\"bbbb2222\",\"free\":true,\"agree\":1,\"needed\":2,\"joinable\":false,\"leftS\":170,\"joined\":0},"
        + "{\"id\":\"cccc3333\",\"free\":true,\"agree\":2,\"needed\":2,\"joinable\":true,\"leftS\":150,\"joined\":1}],"
        + "\"refused\":[],\"nodes\":2}";

    [Test]
    public void TheLobbyIsReadFromThePageAndPlayPicksTheJoinableRoundWithTheMostTimeLeft()
    {
        var s = DailyLobby.Parse(Sample);
        Assert.IsNotNull(s);
        Assert.AreEqual("azure-elk-1364", s.you.name);
        Assert.AreEqual(3, s.rows.Length);
        // the 1-of-2 round has more time left and is still never picked: no Join without both signer nodes
        Assert.AreEqual(2, DailyLobby.PickDefault(s.rows));
        Assert.AreEqual(0, DailyLobby.Keep(s.rows, "aaaa1111"), "a picked joinable round stays picked");
        Assert.AreEqual(2, DailyLobby.Keep(s.rows, "bbbb2222"), "a round that is not joinable cannot stay picked");
        Assert.AreEqual(2, DailyLobby.Keep(s.rows, "gone"), "a round no longer listed falls back to the default");

        Assert.IsNull(DailyLobby.Parse(""), "no page, no lobby");
        Assert.IsNull(DailyLobby.Parse("{\"mode\":\"round\"}"), "a round page is not a lobby");
        Assert.IsNull(DailyLobby.Parse("not json"), "garbage is not a lobby");
        Assert.AreEqual(-1, DailyLobby.PickDefault(new LobbyRow[0]), "nothing to join, nothing picked");
        Assert.IsFalse(DailyLobby.Join("aaaa1111"), "outside a WebGL page nothing is joined");
    }

    /// <summary>
    /// PLAY JOINS A FREE ROUND FIRST (2026-09-15, the 12:54 lobby: one free round and one
    /// paying 2-of-2 open at once). The rows the Daily listed after its first rollover: the old
    /// free round about to close, the new free round, the paying round with the most entry left -
    /// all joinable. Measured before: PLAY picked the paying round, so a player with no sats who
    /// pressed PLAY landed on a stake while a free round was listed. The paying round stays one tap.
    /// </summary>
    [Test]
    public void AfterRolloverWithBothRoundsJoinablePlayJoinsTheFreeRoundAndTheTapOnThePaidRowStays()
    {
        LobbyRow Row(string id, bool free, int leftS) => new LobbyRow { id = id, free = free, joinable = true, agree = 2, needed = 2, leftS = leftS };
        var after = new[] { Row("a5be918a", true, 48), Row("01e305d9", true, 1694), Row("81a75ce7", false, 1761) };
        Assert.AreEqual(1, DailyLobby.PickDefault(after),
            "PLAY's target is not the free round with the most entry left: a player with no sats lands on the paying round");
        Assert.AreEqual(1, DailyLobby.Keep(after, ""), "with nothing tapped, PLAY does not target the free round");

        // A MOMENT WITH ONLY THE PAYING ROUND JOINABLE (the free one between close and the next):
        // it is PLAY's then - and nothing of it sticks once a free round is back and nobody tapped.
        var paidOnly = new[] { Row("81a75ce7", false, 1761) };
        Assert.AreEqual(0, DailyLobby.PickDefault(paidOnly), "with no free round, the paying round is PLAY's");
        Assert.AreEqual(1, DailyLobby.Keep(after, ""), "a default on the paying round outlived the free round's return");

        // THE PLAYER'S OWN TAP ON THE PAYING ROW STAYS - one tap away, and kept.
        Assert.AreEqual(2, DailyLobby.Keep(after, "81a75ce7"), "the player's tap on the paying round was taken back");
        // and a free round that is not joinable is never PLAY's
        var closing = new[] { new LobbyRow { id = "a5be918a", free = true, joinable = false, leftS = 30 }, Row("81a75ce7", false, 1761) };
        Assert.AreEqual(1, DailyLobby.PickDefault(closing), "a free round that cannot be joined was picked over a joinable paying one");
    }

    /// <summary>
    /// A PAYING ROW SAYS WHAT IT COSTS (2026-09-15 16:08: "Paid must read like 'PAID ·
    /// 100 sats'"). Measured before: the live Daily's paying round (100000 msat) read
    /// "PAID · closes ... · 2 of 2 signer nodes" in every form. The stake is in every form the row is
    /// shortened to, from the page's own view row; a free row says FREE and no amount.
    /// </summary>
    [Test]
    public void APaidRowSaysItsStakeInSatsInEveryFormAndAFreeRowSaysFree()
    {
        var s = DailyLobby.Parse("{\"mode\":\"lobby\",\"rows\":["
            + "{\"id\":\"5a343b8d00\",\"free\":true,\"agree\":2,\"needed\":2,\"joinable\":true,\"leftS\":993,\"joined\":1,\"stakeSats\":0},"
            + "{\"id\":\"eb1109af00\",\"free\":false,\"agree\":2,\"needed\":2,\"joinable\":true,\"leftS\":1000,\"joined\":0,\"stakeSats\":100}]}");
        Assert.IsNotNull(s, "the page's lobby view was not read");
        // every form names the stake and the time; the first three the signer nodes too (the shorter ones are a phone's)
        var paidForms = DailyLobby.RowWords(s.rows[1]);
        for (int i = 0; i < 3; i++) StringAssert.StartsWith("PAID · 100 sats · join until 16:40 · 2 signer nodes (2 needed)", paidForms[i]);
        foreach (var w in paidForms)
        {
            StringAssert.StartsWith("PAID · 100 sats · join until 16:40", w, "a form of the paying row does not say its stake");
            // NEVER "SEAT" TO THE PLAYER (2026-09-15 16:22).
            StringAssert.DoesNotContain("seat", w.ToLowerInvariant(), "a lobby row says seat to the player");
        }
        foreach (var w in DailyLobby.RowWords(s.rows[0]))
        {
            StringAssert.StartsWith("FREE · join until 16:33", w);
            StringAssert.DoesNotContain("sat", w, "a free row names an amount");
            StringAssert.DoesNotContain("seat", w.ToLowerInvariant(), "a lobby row says seat to the player");
        }
        StringAssert.Contains("1 joined", DailyLobby.RowWords(s.rows[0])[1]);
        Assert.AreEqual("PAID · 1 sat · entry open · 2 signer nodes (2 needed)",
            DailyLobby.RowWords(new LobbyRow { free = false, stakeSats = 1, agree = 2, needed = 2, joinable = true })[2]);
    }

    /// <summary>
    /// THE ROW NEVER READS AS A ROUND LENGTH (2026-10-04 11:25Z: "PAID · 100 sats · closes 1:57 · 7 of 5
    /// signer nodes" - how can that be a 90 s round?). The countdown was the ENTRY close of a round not yet started. The row
    /// says when the round starts and until when it can be joined, from the page's own fields; "7 signer nodes (5 needed)".
    /// </summary>
    [Test]
    public void BeforeTheStartTheRowSaysStartsInAndJoinUntil()
    {
        var s = DailyLobby.Parse("{\"mode\":\"lobby\",\"rows\":["
            + "{\"id\":\"58a0072b00\",\"free\":false,\"agree\":7,\"needed\":5,\"joinable\":true,\"leftS\":90,\"startS\":45,\"joined\":0,\"stakeSats\":100}]}");
        Assert.AreEqual(45, s.rows[0].startS, "the page's startS was not read");
        Assert.AreEqual("PAID · 100 sats · starts in 0:45 · join until 1:30 · 7 signer nodes (5 needed)", DailyLobby.RowWords(s.rows[0])[2]);
        foreach (var w in DailyLobby.RowWords(s.rows[0])) StringAssert.DoesNotContain("closes", w);
    }

    [Test]
    public void AfterTheStartALateJoinRowSaysStartedAndJoinUntil()
    {
        var late = new LobbyRow { id = "58a0072b00", free = false, stakeSats = 100, agree = 7, needed = 5, joinable = true, leftS = 30, startS = 0 };
        Assert.AreEqual("PAID · 100 sats · started · join until 0:30 · 7 signer nodes (5 needed)", DailyLobby.RowWords(late)[2]);
        var free = new LobbyRow { id = "aaaa1111", free = true, agree = 2, needed = 2, joinable = true, leftS = 75, startS = 15 };
        Assert.AreEqual("FREE · starts in 0:15 · join until 1:15 · 2 signer nodes (2 needed)", DailyLobby.RowWords(free)[2], "a free row reads the same without the price");
    }

    /// <summary>An OLDER PAGE sends no startS: the row says only until when it can be joined - no start, and no countdown that reads like a round length.</summary>
    [Test]
    public void AnOlderPageWithNoStartTimeShowsNoRoundLength()
    {
        var s = DailyLobby.Parse("{\"mode\":\"lobby\",\"rows\":["
            + "{\"id\":\"58a0072b00\",\"free\":false,\"agree\":7,\"needed\":5,\"joinable\":true,\"leftS\":117,\"joined\":0,\"stakeSats\":100}]}");
        Assert.AreEqual(-1, s.rows[0].startS, "no startS from the page is -1, not 0 (0 would say started)");
        Assert.AreEqual("PAID · 100 sats · join until 1:57 · 7 signer nodes (5 needed)", DailyLobby.RowWords(s.rows[0])[2]);
        foreach (var w in DailyLobby.RowWords(s.rows[0])) { StringAssert.DoesNotContain("closes", w); StringAssert.DoesNotContain("starts", w); StringAssert.DoesNotContain("started", w); }
    }

    /// <summary>
    /// PLAY STARTS THE ROUND, IN THIS PAGE (M3.3-34, 2026-09-13 07:11:
    /// "after PLAY the loading screen must not come again"). The page takes the
    /// signer node without a reload and says so; the round starts once the page says
    /// joined and the session is open - or after the patience without one - and
    /// a refusal comes back to the title screen with the page's reason.
    /// </summary>
    [Test]
    public void PlayStartsTheRoundWhenThePageSaysJoinedWithoutAReload()
    {
        var before = DailyLobby.Parse(Sample);
        Assert.AreEqual("", before.join.state, "a lobby with no press yet carries an empty join");
        Assert.AreEqual("wait", DailyLobby.AfterJoin(before, true, 0f));

        var joining = DailyLobby.Parse(Sample.Replace("\"nodes\":2}", "\"nodes\":2,\"join\":{\"state\":\"joining\",\"why\":\"\",\"stage\":\"stake lock: deposit\"}}"));
        Assert.AreEqual("stake lock: deposit", joining.join.stage);
        Assert.AreEqual("wait", DailyLobby.AfterJoin(joining, true, 60f), "no round starts before the page has joined");

        var joined = DailyLobby.Parse(Sample.Replace("\"nodes\":2}", "\"nodes\":2,\"join\":{\"state\":\"joined\"}}"));
        Assert.AreEqual("play", DailyLobby.AfterJoin(joined, true, 0f), "joined with the session open: the round starts");
        Assert.AreEqual("wait", DailyLobby.AfterJoin(joined, false, DailyLobby.SessionPatienceS - 0.1f));
        Assert.AreEqual("play", DailyLobby.AfterJoin(joined, false, DailyLobby.SessionPatienceS),
            "a session that has not opened does not keep the player on the title screen");

        var refused = DailyLobby.Parse(Sample.Replace("\"nodes\":2}", "\"nodes\":2,\"join\":{\"state\":\"refused\",\"why\":\"no signer node\"}}"));
        Assert.AreEqual("refused", DailyLobby.AfterJoin(refused, true, 60f));
        Assert.AreEqual("no signer node", refused.join.why);
        Assert.AreEqual("wait", DailyLobby.AfterJoin(null, true, 60f));
    }

    /// <summary>
    /// A WITHDRAWAL AVAILABLE, SAID IN THE LOBBY AFTER START (2026-09-14): the page looks
    /// at every kept round and hands the lobby what one still owes; the lobby says so with the
    /// amount until it is withdrawn, and says where when another tab of the browser holds it.
    /// </summary>
    [Test]
    public void TheLobbySaysAWithdrawalIsAvailableWithItsAmountUntilItIsWithdrawn()
    {
        string With(string w) => Sample.Replace("\"nodes\":2}", "\"nodes\":2,\"withdraw\":" + w + "}");
        Assert.AreEqual("", DailyLobby.WithdrawNotice(DailyLobby.Parse(Sample)), "a page that names no withdrawal showed one");
        Assert.AreEqual("Withdrawal available: 1958 sat - press Withdraw in the wallet panel",
            DailyLobby.WithdrawNotice(DailyLobby.Parse(With("{\"available\":true,\"msat\":\"1958000\",\"elsewhere\":false}"))));
        Assert.AreEqual("Withdrawal available - open in another tab of this browser",
            DailyLobby.WithdrawNotice(DailyLobby.Parse(With("{\"available\":true,\"msat\":\"0\",\"elsewhere\":true}"))));
        Assert.AreEqual("", DailyLobby.WithdrawNotice(DailyLobby.Parse(With("{\"available\":false,\"msat\":\"0\",\"elsewhere\":false}"))),
            "a withdrawn round still showed the notice");
        Assert.AreEqual("", DailyLobby.WithdrawNotice(DailyLobby.Parse(With("{\"available\":true,\"msat\":\"0\",\"elsewhere\":false}"))),
            "nothing owed was shown as available");
        Assert.AreEqual("", DailyLobby.WithdrawNotice(null));
    }
}
