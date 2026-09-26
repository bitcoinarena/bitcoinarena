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
    static string[] AllLines() => new[]
    {
        DriveHud.ArrivalHeadline(false, 7225), DriveHud.ArrivalHeadline(true, 0),
        DriveHud.ArrivalHeadline(false, 4123456),
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
            StringAssert.Contains("4,123,456 sat", DriveHud.ArrivalHeadline(false, 4123456));
            StringAssert.Contains("+1,234.00000", DriveHud.ArrivalScoreLine(false, 123400000));
        }
        finally { Thread.CurrentThread.CurrentCulture = was; }
    }

    [Test]
    public void TheHeadlineGrowsWithTheFeeSoTheFitCannotBeMeasuredOnASample()
    {
        // The fault in one line: the sample the fit used is shorter than the line the card draws, and by how much
        // depends on the fee. A fit measured on a constant can never be right for a string that is not one.
        Assert.Greater(DriveHud.ArrivalHeadline(false, 7225).Length,
                       DriveHud.ArrivalHeadline(true, 0).Length,
                       "the delivered headline is no longer than BLOCK MINED WITHOUT YOU - the shot says it is");
        Assert.Greater(DriveHud.ArrivalHeadline(false, 4123456).Length,
                       DriveHud.ArrivalHeadline(false, 7225).Length,
                       "a bigger fee does not make a longer headline");
    }

    // THE OWNER'S 18:29 PLAYTEST (2026-09-25): DELIVERED at tick 4596, SCORE +137, and the card read
    // "load 0.85 x danger 1.00 x speed 1.50 x 1000" - a product of 1275 under a score of 137. The three factors were
    // Unity's meters, not the core's. These are the core's words from THAT RUN, measured - round 6f2d00c2..., entry
    // 66d99bb6..., stepped by the pinned fleet core (02eefc04) over the transcript and beacon in a copy of the Daily's
    // store, its state hash equal to the pinned replay's (DELIVERED, 137): exposure 4842601 (73.892 m), 4596 ticks, and
    // the cargo word the core still holds from init, 45875 (0.70).
    const int ShotExposureWord = 4842601, ShotTicks = 4596, ShotCargoWord = 45875;

    // THE CORE'S SCORE IS THE PRODUCT OF ITS FACTORS (the owner 2026-09-25): 1000 x C x E x T of the factors as printed, in
    // exact decimal arithmetic, rounded to five decimals half up - score.js's divRoundInt - is the score.
    static decimal Product5(string c, string e, string t) =>
        decimal.Round(1000m * decimal.Parse(c, CultureInfo.InvariantCulture) * decimal.Parse(e, CultureInfo.InvariantCulture)
                      * decimal.Parse(t, CultureInfo.InvariantCulture), 5, System.MidpointRounding.AwayFromZero);

    [Test]
    public void TheCardsFactorsAreTheCoresAndTheirProductIsTheScoreOnTheLineAbove()
    {
        float e = CoreScoreFactors.Exposure(ShotExposureWord), t = CoreScoreFactors.Time(ShotTicks), c = CoreScoreFactors.Cargo(ShotCargoWord);
        // the core's score of that run, now the product itself (score.js scoreOf: 13715869 in 1e-5 points)
        string line = DriveHud.ArrivalWorkLine(false, c, e, t, 13715869);
        Debug.Log($"playtest 18:29 card, from the core's words: {line}");
        Assert.AreEqual("load 0.70000   ×   danger 0.23091   ×   speed 0.84856   ×  1000  =  137.15869", line);
        Assert.AreEqual(137.15869m, Product5("0.70000", "0.23091", "0.84856"));
        Assert.AreEqual("SCORE  +137.15869", DriveHud.ArrivalScoreLine(false, 13715869));
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
                float stopped = DriveHud.RunStoppedFont(w, h) * 1.4f;          // one line of "RUN STOPPED - the core said DELIVERED at tick 4596"
                float k = hud.ArrivalScale(w, h, head0, stopped, true, true);
                float head = head0 * k;
                float[] heights = DriveHud.ArrivalRowHeights(head, DriveHud.ArrivalMidFont(head), DriveHud.ArrivalLineFont(head), stopped * k, true, true);
                var card = hud.ArrivalBox(w, h);
                var rows = DriveHud.ArrivalRows(card, head * 0.55f, heights);
                Debug.Log($"[result card] {w}x{h}: card {card.x:0},{card.y:0} {card.width:0}x{card.height:0} (bottom {card.yMax:0} of {h}), "
                          + $"{rows.Length} rows, font scale {k:0.00}");
                Assert.LessOrEqual(card.yMax, h, $"the card runs off the bottom at {w}x{h}");
                Assert.GreaterOrEqual(card.x, 0f); Assert.LessOrEqual(card.xMax, w);
                Assert.AreEqual(7, rows.Length, "run stopped, headline, score, leading, factors, foot, copy game replay");
                for (int i = 0; i < rows.Length; i++)
                {
                    Assert.GreaterOrEqual(rows[i].y, card.y, $"row {i} starts above the card at {w}x{h}");
                    Assert.LessOrEqual(rows[i].yMax, card.yMax + 0.01f, $"row {i} runs out under the card at {w}x{h} (the foot line did)");
                    for (int j = i + 1; j < rows.Length; j++)
                        Assert.LessOrEqual(rows[i].yMax, rows[j].y + 0.01f, $"row {i} crosses row {j} at {w}x{h}");
                }
                // the run-stopped sentence is the card's own FIRST row, above the headline - never drawn across it
                Assert.Less(rows[0].yMax, rows[1].y + 0.01f);
            }
        }
        finally { Object.DestroyImmediate(hud.gameObject); }
    }

    [Test]
    public void WhileTheCardIsUpNothingElseIsDrawnThroughIt()
    {
        Assert.IsTrue(DriveHud.RunStoppedRowHiddenBy(arrivalCarriesIt: true), "the separate run-stopped row is still drawn across the card");
        Assert.IsFalse(DriveHud.RunStoppedRowHiddenBy(arrivalCarriesIt: false), "the run-stopped row is gone when there is no card to carry it");
        Assert.IsTrue(DriveHud.WaypointHiddenBy(arrivalShowing: true), "the DROP-OFF marker is still drawn through the card");
        Assert.IsFalse(DriveHud.WaypointHiddenBy(arrivalShowing: false), "the DROP-OFF marker is gone on the road");
    }

    [Test]
    public void TheReplayControlIsLabelledExactlyCopyGameReplay()
    {
        Assert.AreEqual("copy game replay", DriveHud.CopyReplayLabel);
    }

    // THE CARD'S PRODUCT IS THE CORE'S SCORE (the owner 2026-09-25: "load C x danger E x speed T x 1000 = S"). The 72
    // DELIVERED runs of packages/core/test/fixtures/arrival-card-runs.json - the core's own words, kept current by
    // core/test/arrival-card-runs.test.js - go through the real formatter; the four decimals are read back off the
    // printed row and their product must round to the printed S, which must be the core's S_DELIVERED and the SCORE line's.
    [System.Serializable] class CardRun { public float lane; public int seed, state, exposure, elapsed, cargo, delivered, e5, t5, c5; }
    [System.Serializable] class CardRuns { public CardRun[] runs; }

    [Test]
    public void TheCardsProductIsTheCoresScore()
    {
        string path = System.IO.Path.Combine(Application.dataPath, "../../packages/core/test/fixtures/arrival-card-runs.json");
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
        StringAssert.Contains("public float Exposure => CoreScoreFactors.Exposure(Blwp.BlwpCore.ExposureWord);", src);
    }

    // THE LOADOUT PANEL'S LOAD IS THE CORE'S C (RULED 2026-09-26, A): the same C the card prints, not the bed fill. On
    // this core S_CARGO is 45875 from init, so the panel reads x0.70000 whatever is loaded; the bed fill is TRUCK FULL %.
    [Test]
    public void TheLoadoutsLoadIsTheCoresCargoFactorNotTheBedFill()
    {
        Assert.AreEqual("×0.70000", LoadoutPanel.LoadLabel(45875));
        Assert.AreEqual("0.70000", CoreScoreFactors.Cargo(45875).ToString("0.00000", CultureInfo.InvariantCulture),
            "the panel and the card print C to the same decimals");
        string src = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "Scripts/Cargo/LoadoutPanel.cs"));
        StringAssert.Contains("string load = LoadLabel(Blwp.BlwpCore.CargoWord);", src);
        StringAssert.DoesNotContain("$\"×{Mathf.Clamp01(bay.Fill):0.00}\"", src, "the bed fill is printed as the LOAD factor again");
        StringAssert.Contains("TRUCK FULL", src);
    }

    // "copied!" ON THE CARD (the owner 2026-09-26 07:12): shown once the page's clipboard write resolved - not on the press,
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
        StringAssert.Contains("_copiedAt < 0f && Blwp.BlwpCore.ReplayCopied", hud);
        string lib = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "Plugins/WebGL/blwp.jslib"));
        StringAssert.Contains("c === window.BLWP_REPLAY_URL", lib);
        string page = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "WebGLTemplates/BtcLogistics/index.html"));
        StringAssert.Contains("await navigator.clipboard.writeText(link.url); window.BLWP_REPLAY_COPIED = link.url;", page);
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
        StringAssert.Contains("        if (!ArrivalShowing)\n        {\n            string tail = runScore == null", hud.Replace("\r\n", "\n"),
            "the score block draws under the card");
        StringAssert.Contains("if (watch == null) return;\n        // not under the result card", hud.Replace("\r\n", "\n"));
        StringAssert.Contains("if (ArrivalShowing) return;", hud);
        string page = System.IO.File.ReadAllText(System.IO.Path.Combine(Application.dataPath, "WebGLTemplates/BtcLogistics/index.html"));
        StringAssert.Contains("window.BLWP_CARD_UP = true;", page);
        StringAssert.Contains("if (!window.BLWP_ROUND || window.BLWP_CARD_UP || window.BLWP_LOADOUT_OPEN) { el.style.display = 'none'; return; }", page);
    }
}
