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
            StringAssert.Contains("+1,234", DriveHud.ArrivalScoreLine(false, 1234));
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

    static int ProductTimes1000(float c, float e, float t) => Mathf.RoundToInt(1000f * c * e * t);

    [Test]
    public void TheCardsFactorsAreTheCoresAndTheirProductIsTheScoreOnTheLineAbove()
    {
        float e = CoreScoreFactors.Exposure(ShotExposureWord), t = CoreScoreFactors.Time(ShotTicks), c = CoreScoreFactors.Cargo(ShotCargoWord);
        string line = DriveHud.ArrivalWorkLine(false, c, e, t);
        Debug.Log($"playtest 18:29 card, from the core's words: {line}  -> product {1000f * c * e * t:0.0}");
        Assert.AreEqual("load 0.70   ×   danger 0.23   ×   speed 0.85   ×  1000", line);
        Assert.AreEqual(137, ProductTimes1000(c, e, t), "the card's factors do not multiply to the core's 137");
    }

    [Test]
    public void ADangerOf100OnThatSameRunWouldHavePaid594()
    {
        // The card said 1.00; a real 1.00 is the 320 m reference. On the same run it pays the core's 594 (scoreOf with
        // exposure 320 m, 4596 ticks, cargo 45875) - not 137, and not the card's 1275.
        float e = CoreScoreFactors.Exposure(320 * 65536), t = CoreScoreFactors.Time(ShotTicks), c = CoreScoreFactors.Cargo(ShotCargoWord);
        Assert.AreEqual(1f, e);
        Assert.AreEqual(594, ProductTimes1000(c, e, t));
    }

    [Test]
    public void ARunPastParCannotReadSpeed150AndOneMetreOfExposureIsNotDanger100()
    {
        // The two faults the shot named: speed was a wall-clock cap, danger was Clamp01 of raw metres.
        Assert.Less(CoreScoreFactors.Time(ShotTicks), 1f, "a run past the 3900-tick par read a speed factor of 1 or more");
        Assert.AreEqual(1.5f, CoreScoreFactors.Time(1), 1e-6f, "an instant run is held to the core's 1.5");
        Assert.AreEqual(0.25f, CoreScoreFactors.Time(100000), 1e-6f, "a very slow run is held to the core's 0.25");
        Assert.AreEqual(1f / 320f, CoreScoreFactors.Exposure(65536), 1e-6f, "one metre of exposure is not danger 1.00");
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
                float k = hud.ArrivalScale(w, h, head0, stopped, true);
                float head = head0 * k;
                float[] heights = DriveHud.ArrivalRowHeights(head, DriveHud.ArrivalMidFont(head), DriveHud.ArrivalLineFont(head), stopped * k, true);
                var card = hud.ArrivalBox(w, h);
                var rows = DriveHud.ArrivalRows(card, head * 0.55f, heights);
                Debug.Log($"[result card] {w}x{h}: card {card.x:0},{card.y:0} {card.width:0}x{card.height:0} (bottom {card.yMax:0} of {h}), "
                          + $"{rows.Length} rows, font scale {k:0.00}");
                Assert.LessOrEqual(card.yMax, h, $"the card runs off the bottom at {w}x{h}");
                Assert.GreaterOrEqual(card.x, 0f); Assert.LessOrEqual(card.xMax, w);
                Assert.AreEqual(6, rows.Length, "run stopped, headline, score, leading, factors, foot");
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
}

