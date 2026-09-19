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
}
