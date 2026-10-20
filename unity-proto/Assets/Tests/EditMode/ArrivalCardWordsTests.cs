// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Globalization;
using System.Threading;
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE ARRIVAL CARD'S WORDS, from the owner's 13:05 shot (owner-screens/delivered-text-clip-1305.jpg).
///
/// Three faults in one card, all of them in the strings rather than in the box:
///
/// 1. "DELIVERED  7.225 sat to the" - the rest of the headline was past the screen edge. The card fitted its font
///    to "BLOCK MINED WITHOUT YOU" and then drew a line half again as long. The fix is structural: the four lines
///    are built once, the fit is measured on them, and the same strings are drawn. That is what these tests read.
/// 2. "those fees go to the miners   the score is what the run pays you" - the em dash between the halves drew as
///    nothing. WebGL has no OS fonts to fall back on, so a glyph the embedded font lacks is simply absent.
/// 3. "load 0,83" - the decimals came out under the browser's culture. The build is English (CLAUDE.md).
///
/// The width itself is not asserted here: GUIStyle.CalcSize is legal only inside OnGUI (GlyphProbeTests says so),
/// so it is measured on the live page instead. What is checked here is that every line the card draws is a line
/// the card can draw at all.
/// </summary>
public class ArrivalCardWordsTests
{
    // THE PAGE AS IT RUNS (kanban #521): index.html and the game page parts it loads from games/<game>/, which hold the
    // lines that once sat in index.html itself.
    static string PageText()
    {
        string dir = System.IO.Path.Combine(Application.dataPath, "WebGLTemplates/NextBlock");
        var sb = new System.Text.StringBuilder(System.IO.File.ReadAllText(System.IO.Path.Combine(dir, "index.html")));
        foreach (string g in System.IO.Directory.GetDirectories(System.IO.Path.Combine(dir, "games")))
            foreach (string f in System.IO.Directory.GetFiles(g, "*.js")) sb.Append('\n').Append(System.IO.File.ReadAllText(f));
        return sb.ToString();
    }

    static string[] AllLines() => new[]
    {
        DriveHud.ArrivalHeadline(false, 0.0036), DriveHud.ArrivalHeadline(true, 0),
        DriveHud.ArrivalHeadline(false, 15.92), DriveHud.ArrivalHeadline(false, 12.34567891),
        DriveHud.ArrivalScoreLine(false, 155), DriveHud.ArrivalScoreLine(true, 0),
        DriveHud.ArrivalWorkLine(false, 0.83f, 1f, 1.5f), DriveHud.ArrivalWorkLine(true, 0f, 0f, 0f),
        DriveHud.ArrivalFootLine(false), DriveHud.ArrivalFootLine(true),
    };

    [Test]
    public void EveryCharacterOfTheCardExistsInTheFontTheBuildShips()
    {
        var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf")
                ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
        Assert.IsNotNull(font, "no embedded font to ask");
        font.RequestCharactersInTexture("0123456789", 32);

        foreach (var line in AllLines())
            foreach (char c in line)
            {
                if (c == ' ') continue;
                Assert.IsTrue(font.HasCharacter(c),
                    $"U+{(int)c:X4} '{c}' is not in {font.name}, and the card draws it in \"{line}\"");
            }
    }

    [Test]
    public void TheNumbersAreEnglishWhateverTheBrowsersCultureIs()
    {
        var was = Thread.CurrentThread.CurrentCulture;
        try
        {
            Thread.CurrentThread.CurrentCulture = new CultureInfo("de-DE");
            StringAssert.Contains("load 0.83", DriveHud.ArrivalWorkLine(false, 0.83f, 1f, 1.5f));
            StringAssert.Contains("speed 1.50", DriveHud.ArrivalWorkLine(false, 0.83f, 1f, 1.5f));
            StringAssert.Contains("DELIVERED  12.34567891 BTC to the miners", DriveHud.ArrivalHeadline(false, 12.34567891));
            StringAssert.Contains("+1,234.00000", DriveHud.ArrivalScoreLine(false, 123400000));
        }
        finally { Thread.CurrentThread.CurrentCulture = was; }
    }

    [Test]
    public void TheHeadlineGrowsWithTheFeeSoTheFitCannotBeMeasuredOnASample()
    {
        // The fault in one line: the sample the fit used is shorter than the line the card draws, and by how much
        // depends on the fee. A fit measured on a constant can never be right for a string that is not one.
        Assert.Greater(DriveHud.ArrivalHeadline(false, 0.0036).Length,
                       DriveHud.ArrivalHeadline(true, 0).Length,
                       "the delivered headline is no longer than BLOCK MINED WITHOUT YOU - the shot says it is");
        Assert.Greater(DriveHud.ArrivalHeadline(false, 12.34567891).Length,
                       DriveHud.ArrivalHeadline(false, 0.5).Length,
                       "a load with more digits does not make a longer headline");
    }

    // THE OWNER'S 18:29 PLAYTEST (2026-09-25): DELIVERED at tick 4596, SCORE +137, and the card read
    // "load 0.85 x danger 1.00 x speed 1.50 x 1000" - a product of 1275 under a score of 137. The three factors were
    // Unity's meters, not the core's. These are the core's words from THAT RUN, measured - round 6f2d00c2..., entry
    // 66d99bb6..., stepped by the pinned fleet core (02eefc04) over the transcript and beacon in a copy of the Daily's
    // store, its state hash equal to the pinned replay's (DELIVERED, 137): exposure 4842601 (73.892 m), 4596 ticks, and
    // the cargo word the core still holds from init, 45875 (0.70).
    const int ShotExposureWord = 4842601, ShotTicks = 4596, ShotCargoWord = 45875;

    // THE CORE'S SCORE IS THE PRODUCT OF ITS FACTORS (2026-09-25): 1000 x C x E x T of the factors as printed, in
    // exact decimal arithmetic, rounded to five decimals half up - score.js's divRoundInt - is the score.
    static decimal Product5(string c, string e, string t) =>
        decimal.Round(1000m * decimal.Parse(c, CultureInfo.InvariantCulture) * decimal.Parse(e, CultureInfo.InvariantCulture)
                      * decimal.Parse(t, CultureInfo.InvariantCulture), 5, System.MidpointRounding.AwayFromZero);

    [Test]
    public void TheCardsFactorsAreTheCoresAndTheirProductIsTheScoreOnTheLineAbove()
    {
        float e = CoreScoreFactors.Exposure(ShotExposureWord), t = CoreScoreFactors.Time(ShotTicks), c = CoreScoreFactors.Cargo(ShotCargoWord);
        // ON THE CORE THAT RUN WAS PLAYED ON (par 3900): speed 0.84856, and the score 137.15869 is the product of the
        // three factors - history, kept as the product it was.
        Assert.AreEqual(137.15869m, Product5("0.70000", "0.23091", "0.84856"));
        // AND THE SAME WORDS ON TODAY'S CARD (par 1800, 2026-10-04 09:17): speed 0.39164, and the core's score of
        // those words (score.js scoreOf: 6330351 in 1e-5 points) is again the product of the factors the card prints.
        string line = DriveHud.ArrivalWorkLine(false, c, e, t, 6330351);
        Debug.Log($"the 18:29 words on today's card: {line}");
        Assert.AreEqual("load 0.70000   ×   danger 0.23091   ×   speed 0.39164   ×  1000  =  63.30351", line);
        Assert.AreEqual(63.30351m, Product5("0.70000", "0.23091", "0.39164"));
        Assert.AreEqual("SCORE  +63.30351", DriveHud.ArrivalScoreLine(false, 6330351));
    }

    [Test]
    public void ADangerOf100OnThatSameRunWouldHavePaid593_992()
    {
        // The card said 1.00; a real 1.00 is the 320 m reference. On the same run it pays the product 593.99200 (scoreOf with
        // exposure 320 m, 4596 ticks, cargo 45875: 59399200) - not 137.15869, and not the old card's 1275.
        float e = CoreScoreFactors.Exposure(320 * 65536);
        Assert.AreEqual(1f, e);
        Assert.AreEqual(593.99200m, Product5("0.70000", "1.00000", "0.84856"));
        Assert.AreEqual("593.99200", CoreScoreFactors.Points(59399200));
    }

    [Test]
    public void ARunPastParCannotReadSpeed150AndOneMetreOfExposureIsNotDanger100()
    {
        // The two faults the shot named: speed was a wall-clock cap, danger was Clamp01 of raw metres.
        Assert.Less(CoreScoreFactors.Time(ShotTicks), 1f, "a run past the 3900-tick par read a speed factor of 1 or more");
        Assert.AreEqual(150000, CoreScoreFactors.Time5(1), "an instant run is held to the core's 1.5");
        Assert.AreEqual(25000, CoreScoreFactors.Time5(100000), "a very slow run is held to the core's 0.25");
        // one metre is 1/320 = 0.003125, on the core's five-decimal grid 0.00313 (rounded once, half up) - not danger 1.00
        Assert.AreEqual(313, CoreScoreFactors.Exposure5(65536));
    }

    // THE OWNER'S 18:39 PLAYTEST (2026-09-25): two shots of the same result screen, 2048x887. The run-stopped line was drawn
    // across the headline, the DROP-OFF / DELIVERED marker through it, the foot line ran out under the card's bottom edge
    // and the truck showed through the plate. Measured here on the rects the card draws, at the shot's own frame and at
    // the frames the layout tests already hold.
    static readonly Vector2[] Frames = { new Vector2(2048, 887), new Vector2(1920, 1080), new Vector2(844, 390), new Vector2(1000, 360) };

    [Test]
    public void TheResultCardsRowsDoNotCrossAndStayInsideTheCardOnScreen()
    {
        var hud = new GameObject("hud-under-test").AddComponent<DriveHud>();
        try
        {
            foreach (var f in Frames)
            {
                int w = (int)f.x, h = (int)f.y;
                float head0 = DriveHud.CardHead(w, h, true);
                // NO RUN-STOPPED ROW, NO WHO-LEADS ROW (CARD-NARROW-2101, NO-STOPPED-LINE-2103)
                float k = hud.ArrivalScale(w, h, head0, 0f, false, true);
                float head = head0 * k;
                float[] heights = DriveHud.ArrivalRowHeights(head, DriveHud.ArrivalMidFont(head), DriveHud.ArrivalLineFont(head), 0f, false, true);
                var card = hud.ArrivalBox(w, h);
                var rows = DriveHud.ArrivalRows(card, head * 0.55f, heights);
                Debug.Log($"[result card] {w}x{h}: card {card.x:0},{card.y:0} {card.width:0}x{card.height:0} (bottom {card.yMax:0} of {h}), "
                          + $"{rows.Length} rows, font scale {k:0.00}");
                Assert.LessOrEqual(card.yMax, h, $"the card runs off the bottom at {w}x{h}");
                Assert.GreaterOrEqual(card.x, 0f); Assert.LessOrEqual(card.xMax, w);
                Assert.AreEqual(5, rows.Length, "headline, score, factors, foot, copy game replay");
                for (int i = 0; i < rows.Length; i++)
                {
                    Assert.GreaterOrEqual(rows[i].y, card.y, $"row {i} starts above the card at {w}x{h}");
                    Assert.LessOrEqual(rows[i].yMax, card.yMax + 0.01f, $"row {i} runs out under the card at {w}x{h} (the foot line did)");
                    for (int j = i + 1; j < rows.Length; j++)
                        Assert.LessOrEqual(rows[i].yMax, rows[j].y + 0.01f, $"row {i} crosses row {j} at {w}x{h}");
                }
            }
        }
        finally { Object.DestroyImmediate(hud.gameObject); }
    }

    /// <summary>
    /// ON A PHONE HELD UPRIGHT THE CARD HAS THE WIDTH (2026-09-29 21:01, CARD-NARROW-2101: on his phone the card was
    /// the centre strip, 150 of 924 px in his shot, and broke RUN STOPPED and DELIVERED mid-word). At the phone's own size -
    /// 390x844 points and its 1170x2532 pixels - the card is at least 88% of the width, starts under the left column
    /// (SIM, its last box) and ends on the screen; a landscape screen keeps the gap between the columns.
    /// </summary>
    [Test]
    public void OnAnUprightPhoneTheCardTakesTheWidth()
    {
        var hud = new GameObject("hud").AddComponent<DriveHud>();
        try
        {
            foreach (var (w, h) in new[] { (390, 844), (1170, 2532), (360, 780) })
            {
                var card = hud.ArrivalBox(w, h);
                Assert.GreaterOrEqual(card.width, w * 0.88f, $"{w}x{h}: the card is {card.width:0} of {w} wide");
                Assert.GreaterOrEqual(card.x, 0f); Assert.LessOrEqual(card.xMax, w);
                Assert.GreaterOrEqual(card.y, hud.SimBox(w, h).yMax, $"{w}x{h}: the card starts on the left column");
                Assert.LessOrEqual(card.yMax, h, $"{w}x{h}: the card runs off the bottom");
            }
            var wide = hud.ArrivalBox(1280, 720);
            Assert.AreEqual(hud.HeadlineBox(1280, 720).width, wide.width, 0.5f, "landscape keeps the gap between the columns");
        }
        finally { Object.DestroyImmediate(hud.gameObject); }
    }

    /// <summary>
    /// THE CARD FOLDS (2026-09-29 22:00, PRIORITIES item 2): "fold" under the card collapses it so the game and
    /// spectating are seen; "show result" brings it back. The control sits under the card's bottom edge - over none of its
    /// lines - and on the screen, at a phone's size and a desktop's.
    /// </summary>
    [Test]
    public void TheFoldControlSitsUnderTheCardAndOnTheScreen()
    {
        Assert.AreEqual("fold", DriveHud.FoldLabel);
        Assert.AreEqual("show result", DriveHud.ShowResultLabel);
        var hud = new GameObject("hud").AddComponent<DriveHud>();
        try
        {
            foreach (var (w, h) in new[] { (390, 844), (1170, 2532), (1280, 720) })
            {
                var card = hud.ArrivalBox(w, h);
                var tab = DriveHud.FoldTab(card, h, 14, DriveHud.FoldLabel, null);
                Assert.GreaterOrEqual(tab.y, card.yMax, $"{w}x{h}: the fold control is on the card");
                Assert.LessOrEqual(tab.yMax, h, $"{w}x{h}: the fold control is off the bottom");
                Assert.GreaterOrEqual(tab.x, 0f); Assert.LessOrEqual(tab.xMax, w + 0.5f);
            }
        }
        finally { Object.DestroyImmediate(hud.gameObject); }
    }

    [Test]
    public void WhileTheCardIsUpNothingElseIsDrawnThroughIt()
    {
        Assert.IsTrue(DriveHud.WaypointHiddenBy(arrivalShowing: true), "the DROP-OFF marker is still drawn through the card");
        Assert.IsFalse(DriveHud.WaypointHiddenBy(arrivalShowing: false), "the DROP-OFF marker is gone on the road");
    }

    [Test]
    public void TheReplayControlIsLabelledExactlyCopyGameReplay()
    {
        Assert.AreEqual("copy game replay", DriveHud.CopyReplayLabel);
    }

    // THE CARD'S PRODUCT IS THE CORE'S SCORE (2026-09-25: "load C x danger E x speed T x 1000 = S"). The 72
    // DELIVERED runs of packages/nextblock/test/fixtures/arrival-card-runs.json - the core's own words, kept current by
    // core/test/arrival-card-runs.test.js - go through the real formatter; the four decimals are read back off the
    // printed row and their product must round to the printed S, which must be the core's S_DELIVERED and the SCORE line's.
    [System.Serializable] class CardRun { public float lane; public int seed, state, exposure, elapsed, cargo, delivered, e5, t5, c5; }
    [System.Serializable] class CardRuns { public CardRun[] runs; }

    [Test]
    public void TheCardsProductIsTheCoresScore()
    {
        string path = System.IO.Path.Combine(Application.dataPath, "../../packages/nextblock/test/fixtures/arrival-card-runs.json");
        var runs = JsonUtility.FromJson<CardRuns>(System.IO.File.ReadAllText(path)).runs;
        Assert.AreEqual(72, runs.Length);
        // T and C both move in the fixture (its cargo word is a FIXTURE WRITE, not a player input - this core has none)
        Assert.IsTrue(System.Array.Exists(runs, r => CoreScoreFactors.Time(r.elapsed) < 1.5f), "no run has T below 1.5");
        Assert.IsTrue(System.Array.Exists(runs, r => r.cargo != 45875), "every run carries the default cargo 0.70");
        var row = new System.Text.RegularExpressions.Regex(
            @"^load (\d\.\d{5})\s+×\s+danger (\d\.\d{5})\s+×\s+speed (\d\.\d{5})\s+×\s+1000\s+=\s+([\d,]+\.\d{5})$");
        foreach (var r in runs)
        {
            // THE C# FACTORS ARE THE CORE'S, FACTOR BY FACTOR - not only their product
            Assert.AreEqual(r.e5, CoreScoreFactors.Exposure5(r.exposure), $"lane {r.lane} seed {r.seed}: E is not the core's");
            Assert.AreEqual(r.t5, CoreScoreFactors.Time5(r.elapsed), $"lane {r.lane} seed {r.seed}: T is not the core's");
            Assert.AreEqual(r.c5, CoreScoreFactors.Cargo5(r.cargo), $"lane {r.lane} seed {r.seed}: C is not the core's");
            float c = CoreScoreFactors.Cargo(r.cargo), e = CoreScoreFactors.Exposure(r.exposure), t = CoreScoreFactors.Time(r.elapsed);
            string line = DriveHud.ArrivalWorkLine(false, c, e, t, r.delivered);
            var m = row.Match(line);
            Assert.IsTrue(m.Success, $"lane {r.lane} seed {r.seed}: the row does not read 'load C x danger E x speed T x 1000 = S': {line}");
            decimal printed = decimal.Parse(m.Groups[4].Value.Replace(",", ""), CultureInfo.InvariantCulture);
            Assert.AreEqual(r.delivered / 100000m, printed, $"lane {r.lane} seed {r.seed}: the printed S is not the core's S_DELIVERED");
            Assert.AreEqual(printed, Product5(m.Groups[1].Value, m.Groups[2].Value, m.Groups[3].Value),
                $"lane {r.lane} seed {r.seed}: {line} - the product of the printed factors is not the printed S");
            StringAssert.Contains("+" + CoreScoreFactors.Points(r.delivered), DriveHud.ArrivalScoreLine(false, r.delivered),
                "the SCORE line and the product row name different numbers");
        }
    }

    // THE LIVE DANGER METER IS THE CORE'S E (2026-09-26): it printed Clamp01 of the exposure in METRES, x1.00 past the
    // first metre, while the card beside it said the core's E. The 18:29 shot's word (73.892 m) reads x0.23, not x1.00.
    [Test]
    public void TheDangerMeterReadsTheCoresFactorNotMetres()
    {
        Assert.AreEqual("DANGER  ×0.23", DriveHud.DangerLabel(CoreScoreFactors.Exposure(4842601)));
        Assert.AreEqual("DANGER  ×0.32", DriveHud.DangerLabel(CoreScoreFactors.Exposure(6652286)), "the live run of round 14bff641");
        string src = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "Scripts/Cargo/RunScore.cs"));
        StringAssert.Contains("public float Exposure => CoreScoreFactors.Exposure(Arena.ArenaCore.ExposureWord);", src);
    }

    // THE LOADOUT PANEL'S LOAD IS THE CORE'S C (RULED 2026-09-26, A): the same C the card prints, never Unity's float bed
    // fill. Since C is the bed fill (2026-10-04 08:54) the load is declared to the core whenever the bed changes
    //, so the core's C is the bed's from the first parcel on, and the panel prints that C, on the card's grid.
    [Test]
    public void TheLoadoutsLoadIsTheCoresCargoFactorNotTheBedFill()
    {
        Assert.AreEqual("×0.70000", LoadoutPanel.LoadLabel(45875));
        Assert.AreEqual("0.70000", CoreScoreFactors.Cargo(45875).ToString("0.00000", CultureInfo.InvariantCulture),
            "the panel and the card print C to the same decimals");
        string src = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "Scripts/Cargo/LoadoutPanel.cs"));
        // (playtest 2026-10-04 13:30: LOAD x0.00000 after AUTO): the panel prints the core's own C, and the load is
        // declared to the core whenever the bed changes, so the two move together before ROLL OUT
        StringAssert.Contains("string load = LoadLabel(Arena.ArenaCore.CargoWord);", src);
        StringAssert.Contains("if (bed != _bedDeclared && Arena.ArenaCore.SubmitLoad(bay.FeeCarried, bay.BtcHundredths, bay.VsizeList))", src,
            "the bed's changes are not declared to the core");
        StringAssert.Contains("Arena.ArenaCore.SubmitLoad(bay.FeeCarried, bay.BtcHundredths, bay.VsizeList)", src, "the load carries the bed's vsizes");
        StringAssert.DoesNotContain("$\"×{Mathf.Clamp01(bay.Fill):0.00}\"", src, "the bed fill is printed as the LOAD factor again");
        StringAssert.Contains("of {CargoBay.BtcLimit:0.##} BTC", src, "the gauge reads the BTC on board against the truck's limit");
    }

    /// <summary>
    /// BTC TO THE MINERS, AND A TRUCK CARRIES AT MOST 20 BTC (2026-09-29, CARGO-BTC-2148: measured 15.92 - ten
    /// parcels of an average real block's transactions - and set to 20 by the owner). A
    /// parcel bigger than the limit does not fit an empty truck; the words say BTC, never sat fees.
    /// </summary>
    [Test]
    public void TheTruckCarriesBtcToTheMinersUpToItsLimit()
    {
        Assert.AreEqual(20.0, CargoBay.BtcLimit, 1e-9);
        var bay = new GameObject("bay").AddComponent<CargoBay>();
        try
        {
            var small = new MempoolFeed.Tx { txid = "a", valueSats = 360000, feeSats = 500, vsize = 140 };
            var whale = new MempoolFeed.Tx { txid = "b", valueSats = 2_600_000_000L, feeSats = 900, vsize = 300 };
            Assert.IsTrue(bay.Fits(small), "0.0036 BTC fits an empty truck");
            Assert.IsFalse(bay.Fits(whale), "26 BTC does not fit a truck that carries 20");
        }
        finally { Object.DestroyImmediate(bay.gameObject); }
        StringAssert.Contains("BTC to the miners", DriveHud.ArrivalHeadline(false, 1.5));
        StringAssert.Contains("that BTC goes to the miners", DriveHud.ArrivalFootLine(false));
        StringAssert.DoesNotContain("sat", DriveHud.ArrivalHeadline(false, 1.5) + DriveHud.ArrivalFootLine(false) + DriveHud.ArrivalFootLine(true));
        Assert.AreEqual("0.0036 BTC", LoadoutPanel.BtcLabel(0.0036));
        // A CRATE'S VALUE: three significant digits, so a small parcel is never read as a big one by a clipped edge
        Assert.AreEqual("0.000234 BTC", LoadoutPanel.BtcShort(0.00023427));
        Assert.AreEqual("0.0036 BTC", LoadoutPanel.BtcShort(0.0036));
        Assert.AreEqual("12.3 BTC", LoadoutPanel.BtcShort(12.3456));
        Assert.AreEqual("321 BTC", LoadoutPanel.BtcShort(321.2299));
    }

    // "copied!" ON THE CARD (2026-09-26 07:12): shown once the page's clipboard write resolved - not on the press,
    // and not as a log line - and only while it is fresh.
    [Test]
    public void CopiedShowsOnlyOnceTheClipboardAnswered()
    {
        Assert.AreEqual("copied!", DriveHud.CopiedLabel);
        Assert.IsFalse(DriveHud.CopiedTooltipShows(-1f, 10f), "pressed, the clipboard not yet answered");
        Assert.IsTrue(DriveHud.CopiedTooltipShows(10f, 10f));
        Assert.IsTrue(DriveHud.CopiedTooltipShows(10f, 12.9f));
        Assert.IsFalse(DriveHud.CopiedTooltipShows(10f, 13f));
        string hud = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "Scripts/DriveHud.cs"));
        StringAssert.Contains("_copiedAt < 0f && Arena.ArenaCore.ReplayCopied", hud);
        string lib = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "Plugins/WebGL/arena.jslib"));
        StringAssert.Contains("c === window.ARENA_REPLAY_URL", lib);
        string page = PageText();
        StringAssert.Contains("await navigator.clipboard.writeText(link.url); window.ARENA_REPLAY_COPIED = link.url;", page);
    }

    // THE CARD STANDS AT FULL STRENGTH AND NOTHING IS UNDER IT (PRIORITIES item 3: "nothing overlaps", "stays up ... 8 s";
    // measured 2026-09-26: it faded from 5.76 s, and at 1280x720 the score block, the HIGH TAKEN banner and the players
    // panel crossed it).
    [Test]
    public void TheCardStandsWholeAndNothingIsUnderIt()
    {
        string hud = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "Scripts/DriveHud.cs"));
        StringAssert.Contains("float k = 1f;", hud, "the card fades again");
        StringAssert.DoesNotContain("(Hold * 0.28f)", hud);
        // the score block steps aside under the card - and, since 2026-10-04, under the wreck's summary too
        StringAssert.Contains("bool scoreBlock = !ArrivalShowing && !_wreckSummaryUp;", hud, "the score block draws under the card");
        StringAssert.Contains("        if (scoreBlock)\n        {\n            string tail = runScore == null", hud.Replace("\r\n", "\n"),
            "the score block draws under the card");
        StringAssert.Contains("if (watch == null) return;\n        // not under the result card", hud.Replace("\r\n", "\n"));
        StringAssert.Contains("if (ArrivalShowing) return;", hud);
        string page = PageText();
        StringAssert.Contains("window.ARENA_CARD_UP = true;", page);
        // the node strip still steps aside under the card; since the console (427bab76) it also tells the Console button so
        StringAssert.Contains("if (!window.ARENA_ROUND || window.ARENA_CARD_UP || window.ARENA_LOADOUT_OPEN) { el.style.display = 'none'; consoleHas('players', false); return; }", page);
    }

    // THE COPIED REPLAY IS THE CARD'S RUN (2026-09-26 14:08): a session is its page join's (ARENA_ENTRY); another
    // join replaces it, and the card offers and makes the copy only from the current join's session.
    [Test]
    public void TheCopiedReplayIsTheRunOnScreen()
    {
        string lib = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "Plugins/WebGL/arena.jslib"));
        // THE RUN THAT ENDED, kept at its end from the session ROLL OUT found for it (2026-09-27 13:19); the
        // button and the copy read that run and nothing the page has on hand at the click
        StringAssert.Contains("Module.arenaRunNet = (net && !(net.client && net.client.ended)) ? net : null;", lib);
        StringAssert.Contains("var mine = n === Module.arenaRunNet", lib);
        StringAssert.Contains("return Module.arenaEndedRun ? 1 : 0;", lib);
        StringAssert.Contains("var run = Module.arenaEndedRun;", lib);
        string hud = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "Scripts/DriveHud.cs"));
        StringAssert.Contains("bool replay = runScore != null && Arena.ArenaCore.ReplayForThisRun;", hud);
        string panel = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "Scripts/Cargo/LoadoutPanel.cs"));
        StringAssert.Contains("Arena.ArenaCore.RunStarts();", panel);
        // and the root: a session another page join has replaced is over, and the next start replaces it
        StringAssert.Contains("pageEntry: (typeof window !== 'undefined' && window.ARENA_ENTRY) || null,", lib);
        StringAssert.Contains("if (n && n.pageEntry && typeof window !== 'undefined' && window.ARENA_ENTRY && window.ARENA_ENTRY !== n.pageEntry) return 1;", lib);
        StringAssert.Contains("&& window.ARENA_ENTRY !== Module.arenaNet.pageEntry) {", lib);
    }
}

