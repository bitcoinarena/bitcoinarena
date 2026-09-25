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
    // Unity's meters, not the core's. These are the core's words from that run: exposure 4819968 (73.5 m in Q16.16 - the
    // first word that scores 137 there, measured by the core's scoreOf), 4596 ticks, and the cargo word the core still
    // holds from init, 45875 (0.70).
    const int ShotExposureWord = 4819968, ShotTicks = 4596, ShotCargoWord = 45875;

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
}

