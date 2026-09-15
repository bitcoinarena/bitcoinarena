using NUnit.Framework;
using UnityEngine;
using Blwp;

/// <summary>
/// THE DAILY'S LOBBY IN UNITY, FULLY VISIBLE ON EVERY PHONE (M3.3-34, the owner
/// 2026-09-12 22:16: "lobby and all its elements must be fully visible in Unity
/// on iOS and Android").
///
/// OnGUI never runs in batch mode, so visible is measured the way the title
/// screen's own test measures it: the layout is arithmetic, asked for at the
/// screen shapes iPhones and Android phones actually have - portrait and
/// landscape, at 1x and at the 2x drawing buffer the page gives a phone - and
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

    /// <summary>
    /// A PHONE UPRIGHT'S TWO PAGES (the owner 2026-09-15 11:57): page one is 1 and 2 side by side, each
    /// CarouselTaller x the grid's top row on that same screen (`top`); page two is 3 and 4 side by
    /// side; the arrows are a finger's size, in the box, on no panel and not on each other.
    /// </summary>
    static void CarouselPagesAreRight(DailyLobby.Frame l, Rect copy, float top, string at)
    {
        Assert.GreaterOrEqual(l.howToCells[1].x, l.howToCells[0].xMax - 0.5f, $"2 is not right of 1 {at}");
        for (int i = 0; i < 2; i++)
            Assert.GreaterOrEqual(l.howToCells[i].height, DailyLobby.CarouselTaller * top - 0.5f,
                $"panel {i + 1} is {l.howToCells[i].height:0.0} px, not {DailyLobby.CarouselTaller} x the grid's top row {top:0.0} px {at}"
                + $" (copy {copy}, box {l.howTo})");
        Assert.AreEqual(l.howToCells[2].y, l.howToCells[3].y, 0.5f, $"3 and 4 are not side by side {at}");
        Assert.GreaterOrEqual(l.howToCells[3].x, l.howToCells[2].xMax - 0.5f, $"4 is not right of 3 {at}");
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
        // 1x, 2x, and the densities phones actually draw at - measured on the
        // live page, an iPhone's Unity screen is 3x (1170x2532); Android 2.625x.
        foreach (var dpr in new[] { 1f, 2f, 2.625f, 3f })
        {
            float w = css.x * dpr, h = css.y * dpr;
            float min = Mathf.Min(w, h);
            float sub = Mathf.Clamp(min * 0.028f, 14f, 24f);
            float btn = Mathf.Clamp(min * 0.040f, 18f, 34f);
            var f = SplashScreen.Measure(w, h, sub, btn);
            var l = DailyLobby.MeasureLobby(f.copy, Mathf.Round(sub), css.y > css.x);
            string at = $"at {css.x}x{css.y} css, {dpr}x";

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
            // A PHONE UPRIGHT TURNS PAGES (the owner 2026-09-15 11:57): panels on different pages
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
            if (portrait)
            {
                // PAGE ONE: 1 and 2 side by side, each at least 15% taller than the grid's top row
                // on this same screen - the grid a phone upright had before (carousel: false).
                var grid = DailyLobby.MeasureLobby(f.copy, Mathf.Round(sub), true, carousel: false);
                float top = Mathf.Max(grid.howToCells[0].height, grid.howToCells[1].height);
                Assert.AreEqual(l.howToCells[0].y, l.howToCells[1].y, 0.5f, $"1 and 2 are not side by side {at}");
                if (!l.howToCarousel)
                {
                    // THE GRID STAYS ONLY WHERE THE CAROUSEL CANNOT BE THAT MUCH TALLER (the owner, option A):
                    // the least it needs - 1 and 2 at CarouselTaller x the top row and two 34 px arrows,
                    // no gaps at all - is wider than the copy area. And there it is 1-2 over 3-4.
                    float least = DailyLobby.CarouselTaller * top * (DailyLobby.PanelAspectOf(0) + DailyLobby.PanelAspectOf(1)) + 2f * 34f;
                    Assert.Greater(least, f.copy.width + 0.5f, $"the carousel fits ({least:0} px in {f.copy.width:0}) and the grid was kept {at}");
                    Assert.Greater(l.howToCells[2].y, l.howToCells[0].yMax - 0.5f, $"3-4 are not under 1-2 {at}");
                }
                else CarouselPagesAreRight(l, f.copy, top, at);
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
        + "{\"id\":\"aaaa1111\",\"free\":true,\"agree\":2,\"needed\":2,\"joinable\":true,\"leftS\":40,\"seated\":0},"
        + "{\"id\":\"bbbb2222\",\"free\":true,\"agree\":1,\"needed\":2,\"joinable\":false,\"leftS\":170,\"seated\":0},"
        + "{\"id\":\"cccc3333\",\"free\":true,\"agree\":2,\"needed\":2,\"joinable\":true,\"leftS\":150,\"seated\":1}],"
        + "\"refused\":[],\"nodes\":2}";

    [Test]
    public void TheLobbyIsReadFromThePageAndPlayPicksTheJoinableRoundWithTheMostTimeLeft()
    {
        var s = DailyLobby.Parse(Sample);
        Assert.IsNotNull(s);
        Assert.AreEqual("azure-elk-1364", s.you.name);
        Assert.AreEqual(3, s.rows.Length);
        // the 1-of-2 round has more time left and is still never picked: no Join without both seats
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
    /// PLAY STARTS THE ROUND, IN THIS PAGE (M3.3-34, the owner 2026-09-13 07:11:
    /// "after PLAY the loading screen must not come again"). The page takes the
    /// seat without a reload and says so; the round starts once the page says
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
        Assert.AreEqual("wait", DailyLobby.AfterJoin(joining, true, 60f), "no round starts before the page has the seat");

        var joined = DailyLobby.Parse(Sample.Replace("\"nodes\":2}", "\"nodes\":2,\"join\":{\"state\":\"joined\"}}"));
        Assert.AreEqual("play", DailyLobby.AfterJoin(joined, true, 0f), "joined with the session open: the round starts");
        Assert.AreEqual("wait", DailyLobby.AfterJoin(joined, false, DailyLobby.SessionPatienceS - 0.1f));
        Assert.AreEqual("play", DailyLobby.AfterJoin(joined, false, DailyLobby.SessionPatienceS),
            "a session that has not opened does not keep the player on the title screen");

        var refused = DailyLobby.Parse(Sample.Replace("\"nodes\":2}", "\"nodes\":2,\"join\":{\"state\":\"refused\",\"why\":\"no seat\"}}"));
        Assert.AreEqual("refused", DailyLobby.AfterJoin(refused, true, 60f));
        Assert.AreEqual("no seat", refused.join.why);
        Assert.AreEqual("wait", DailyLobby.AfterJoin(null, true, 60f));
    }

    /// <summary>
    /// A WITHDRAWAL AVAILABLE, SAID IN THE LOBBY AFTER START (the owner 2026-09-14): the page looks
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
