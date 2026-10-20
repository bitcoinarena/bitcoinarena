// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// THE STARS AND THE SHOOTING READ ONE NUMBER.
///
/// The overlay used to take its heat from `CargoBay.Heat` - Unity's own copy
/// of the rule - while the war took its heat from the core's `S_HEAT`. The two
/// agreed only because the formula is written twice and identically, which is
/// the arrangement that stops being true the first time one side is changed.
/// The yard still chooses the number and hands it over at roll-out; from then
/// on the picture reports the word the shooting uses.
///
/// What is pinned here is the display rule itself - how many stars a heat is
/// worth and when the word becomes HUNTED - because those two must not be able
/// to disagree with each other either, and because a rule with a ceiling and a
/// threshold has edges worth naming.
/// </summary>
public class WantedStarsTests
{
    [Test]
    public void NothingAboardIsNotWantedAtAll()
    {
        Assert.AreEqual(0, DriveHud.StarsFor(0f),
            "an empty bed draws stars");
    }

    [Test]
    public void TheFirstSatOfFeeIsAlreadyOneStar()
    {
        // Ceiling, not rounding: carrying anything at all is being wanted for
        // something, and a load that pays is never at zero stars.
        Assert.AreEqual(1, DriveHud.StarsFor(0.0001f));
        Assert.AreEqual(1, DriveHud.StarsFor(0.2f));
        Assert.AreEqual(2, DriveHud.StarsFor(0.21f));
    }

    [Test]
    public void FiveIsTheCeilingAndItHolds()
    {
        Assert.AreEqual(5, DriveHud.StarsFor(1f));
        Assert.AreEqual(5, DriveHud.StarsFor(4f),
            "a heat past one must not draw six stars");
        Assert.AreEqual(0, DriveHud.StarsFor(-1f),
            "a negative heat must not draw negative stars");
    }

    /// <summary>
    /// HUNTED is four stars of five, which is a heat over 0.6. The two sides
    /// of that edge are both named so the word cannot drift off the stars.
    /// </summary>
    [Test]
    public void HuntedIsTheTopTwoStarsAndNothingBelow()
    {
        Assert.AreEqual("WANTED", DriveHud.WantedWord(DriveHud.StarsFor(0.60f)));
        Assert.AreEqual("HUNTED", DriveHud.WantedWord(DriveHud.StarsFor(0.61f)));
        Assert.AreEqual("HUNTED", DriveHud.WantedWord(DriveHud.StarsFor(1f)));
        Assert.AreEqual("WANTED", DriveHud.WantedWord(1));
        Assert.AreEqual("HUNTED", DriveHud.WantedWord(4));
    }

    /// <summary>
    /// A core that is not answering shows nothing rather than something made
    /// up. This is the single-source rule stated as a fact about the build: in
    /// the editor `ArenaCore.Available` is false because the core is a stub
    /// outside a WebGL player, and the overlay has no second opinion to fall
    /// back on - so the heat it reads is zero and the stars stay off.
    /// </summary>
    [Test]
    public void WithNoCoreAnsweringThereAreNoStarsToInvent()
    {
        Assert.AreEqual(0f, Arena.ArenaCore.Heat, 0.0001f);
        Assert.AreEqual(0, DriveHud.StarsFor(Arena.ArenaCore.Heat));
    }
}

/// <summary>
/// THE STREAMING LIST SPEAKS ENGLISH.
///
/// It said "aus Cache", "fehlgeschlagen" and "wartet" on the driving HUD of a
/// build whose every other string is English. The one German check in this
/// project reads the model LABELS - which have been English all along - so
/// nothing looked at the words beside them, and no photograph had ever been
/// taken of the HUD with the list up. A captured frame found it in one look.
/// </summary>
public class StreamingWordsTests
{
    [Test]
    public void NoGermanNextToAModelName()
    {
        string[] german = { "wartet", "Cache", "fehlgeschlagen", "geladen", "laedt", "ä", "ö", "ü" };

        foreach (var state in new[] { ModelStreamer.State.Waiting, ModelStreamer.State.Loading,
                                      ModelStreamer.State.Loaded, ModelStreamer.State.Failed })
            foreach (float mb in new[] { 0f, 12.3f })
            {
                string mark = DriveHud.StreamMark(state, mb, 0.42f);
                foreach (var bad in german)
                    Assert.IsFalse(mark.Contains(bad),
                        $"{state} with {mb:0.0} MB reads \"{mark}\", which is German");
                Assert.IsNotEmpty(mark, $"{state} says nothing at all");
            }
    }

    [Test]
    public void TheWordsSayWhatTheStateIs()
    {
        Assert.AreEqual("waiting", DriveHud.StreamMark(ModelStreamer.State.Waiting, 0f, 0f));
        Assert.AreEqual("failed", DriveHud.StreamMark(ModelStreamer.State.Failed, 0f, 0f));
        Assert.AreEqual("cached", DriveHud.StreamMark(ModelStreamer.State.Loaded, 0f, 0f),
            "a model that came from cache has no size to report");
        Assert.AreEqual("12.3 MB", DriveHud.StreamMark(ModelStreamer.State.Loaded, 12.3f, 0f));
    }
}

/// <summary>
/// THE DANGER RATE IS A DIFFERENCE, NOT A SCALED ONE.
///
/// `RunScore` multiplied the core's exposure by a C# `exposureReference` of
/// 190 before differencing it - the value a13 replaced with 320 in the core,
/// applied to a number already in the core's own units. Measured on a drive
/// the core gains 0.255, 1.386 and 1.700 of exposure per metre; times 190
/// that is 48, 263 and 323, and the 0..2 clamp pinned the meter at 2.00 for
/// the whole run. The bright cap, the cold test and the stalled warning were
/// all reading a saturated constant.
///
/// So the units are pinned here: what goes in comes out, divided by the
/// ground, and nothing scales it.
/// </summary>
public class DangerRateTests
{
    [Test]
    public void TheRateIsExposureGainedPerMetreAndNothingElse()
    {
        // the three readings the core actually produced, a metre apart
        Assert.AreEqual(0.255f, RunScore.RateFrom(10.255f, 10f, 1f), 0.0001f);
        Assert.AreEqual(1.386f, RunScore.RateFrom(11.386f, 10f, 1f), 0.0001f);
        Assert.AreEqual(1.700f, RunScore.RateFrom(11.7f, 10f, 1f), 0.0001f);

        // ten metres of ground for the same gain is a tenth of the rate
        Assert.AreEqual(0.17f, RunScore.RateFrom(11.7f, 10f, 10f), 0.0001f);
    }

    [Test]
    public void TheRateIsHeldInsideTheBandTheMeterDraws()
    {
        Assert.AreEqual(2f, RunScore.RateFrom(100f, 0f, 1f), 0.0001f,
            "the meter is drawn 0..2 and the cap is what stops a spike leaving it");
        Assert.AreEqual(0f, RunScore.RateFrom(0f, 100f, 1f), 0.0001f,
            "exposure never falls, so a negative rate is not a reading");
    }

    [Test]
    public void NoGroundMadeGoodIsNoRateAtAll()
    {
        Assert.AreEqual(0f, RunScore.RateFrom(50f, 10f, 0f), 0.0001f,
            "standing still paid a rate");
        Assert.AreEqual(0f, RunScore.RateFrom(50f, 10f, 0.00001f), 0.0001f,
            "a rounding error of ground paid a rate");
    }
}
