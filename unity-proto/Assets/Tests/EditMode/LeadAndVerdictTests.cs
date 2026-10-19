// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// WHO IS LEADING AND WHO WON, in the words §4.14 sets.
///
/// the owner's 12:55 shot (owner-screens/hud-sideways-vs-upside-1255.png) had "$81,330 +0.00% SIDEWAYS" and nothing
/// else: a percentage with no side attached, so the cab could not tell who was ahead. §4.14: "BULLS +0.42%" /
/// "BEARS -0.17%" against the round's open while it runs, "BULLS LEADING +0.42%" on a run's end screen, and only
/// the round's own end says "THE BULLS WIN". The three are different claims and this pins them apart.
/// </summary>
public class LeadAndVerdictTests
{
    [Test]
    public void TheLiveLeadNamesTheSide()
    {
        Assert.AreEqual("BULLS +0.42%", ChartHud.LeadWord(1, 42));
        Assert.AreEqual("BEARS -0.17%", ChartHud.LeadWord(-1, -17));
        Assert.AreEqual("LEVEL +0.00%", ChartHud.LeadWord(0, 0));
    }

    [Test]
    public void ARunsEndScreenSaysLeadingAndNeverWon()
    {
        Assert.AreEqual("BULLS LEADING +0.42%", ChartHud.LeadingWord(1, 42));
        Assert.AreEqual("BEARS LEADING -0.17%", ChartHud.LeadingWord(-1, -17));
        foreach (var lead in new[] { -1, 0, 1 })
            StringAssert.DoesNotContain("WIN", ChartHud.LeadingWord(lead, 42),
                "a run ends inside the round: its screen may not say who won");
    }

    [Test]
    public void OnlyTheRoundsOpenAndCloseDecideTheWinner()
    {
        Assert.AreEqual("THE BULLS WIN", ChartHud.RoundVerdict(8_133_000L, 8_140_000L));
        Assert.AreEqual("THE BEARS WIN", ChartHud.RoundVerdict(8_133_000L, 8_128_800L));
        // "equal to the cent -> NO MOVE" (§4.14). The core carries the tape in cents, so this is an exact test.
        Assert.AreEqual("NO MOVE", ChartHud.RoundVerdict(8_133_000L, 8_133_000L));
        Assert.AreEqual("THE BULLS WIN", ChartHud.RoundVerdict(8_133_000L, 8_133_001L));
    }
}
