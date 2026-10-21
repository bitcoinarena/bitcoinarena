// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using NUnit.Framework;
using L = Arena.Layout;

/// <summary>
/// AN ASSAULT MUST BE PERCEPTIBLE (2026-09-20 16:22, 16:26).
///
/// The core's half was measured first, over eight seeds and a whole block each: 21 assaults declared, two to
/// eight events a block, both sides, ending both ways; 17 of the 21 had armour within 6 m of the target lane at
/// some point, and that armour advanced 14.56 m toward the enemy against 0.29 m for the same side's tanks off
/// the lane. So the clock fires and the tanks push - what was missing was any way to see it.
///
/// These pin the seeing. They drive `AssaultWatch` with a chart view built by hand, exactly the two words the
/// core writes into `CH_ASSAULT`, and assert the banner, the sound and the log line at each of the three
/// moments. Red before the watch existed, because nothing said any of these words.
/// </summary>
public class AssaultsAreVisibleTests
{
    const int BULLS = 0, BEARS = 1;
    static int[] View(int side, int phase, int target)
    {
        var v = new int[L.CH_WORDS];
        int b = L.CH_ASSAULT + side * L.CH_ASSAULT_WORDS;
        v[b] = phase; v[b + 1] = target;
        return v;
    }
    static readonly DateTime NOON = new DateTime(2026, 9, 20, 13, 0, 0);

    /// <summary>The declaration: the owner's own banner, and a sound with it.</summary>
    [Test]
    public void ADeclaredAssaultRaisesItsBannerAndAsksForASound()
    {
        var w = new AssaultWatch();
        w.Observe(View(BULLS, L.ASSAULT_PUSH, L.OBJ_HIGH), NOON, 10f);
        Assert.AreEqual("BULLS ASSAULT HIGH", w.Banner, "the banner is the one the letter asks for, word for word");
        Assert.AreEqual(1, w.Chimes, "a sound is asked for when the assault starts");
        Assert.IsTrue(w.BannerShowing(10f), "and it is on screen the moment it is raised");
        Assert.IsTrue(w.BannerShowing(10f + AssaultWatch.BannerSeconds - 0.1f), "it stands long enough to read");
        Assert.IsFalse(w.BannerShowing(10f + AssaultWatch.BannerSeconds + 0.1f), "and then it goes");
    }

    /// <summary>Both endings are named, and named for the hill that was attacked.</summary>
    [Test]
    public void TakingTheObjectiveAndFailingAreBothSaid()
    {
        var won = new AssaultWatch();
        won.Observe(View(BEARS, L.ASSAULT_PUSH, L.OBJ_LOW), NOON, 1f);
        won.Observe(View(BEARS, L.ASSAULT_CONSOLIDATE, L.OBJ_LOW), NOON.AddSeconds(30), 31f);
        Assert.AreEqual("LOW TAKEN", won.Banner);

        var lost = new AssaultWatch();
        lost.Observe(View(BULLS, L.ASSAULT_PUSH, L.OBJ_OPEN), NOON, 1f);
        lost.Observe(View(BULLS, L.ASSAULT_IDLE, L.OBJ_OPEN), NOON.AddSeconds(30), 31f);
        Assert.AreEqual("ASSAULT ON OPEN FAILS", lost.Banner);
        Assert.AreEqual(1, lost.Chimes, "the sound is for the start, not for every word");
    }

    /// <summary>
    /// The core clears the target when the next assault is armed. The ending must still name the hill that was
    /// actually attacked, or the log says the wrong one.
    /// </summary>
    [Test]
    public void TheEndingNamesTheObjectiveThatWasAttacked()
    {
        var w = new AssaultWatch();
        w.Observe(View(BEARS, L.ASSAULT_PUSH, L.OBJ_HIGH), NOON, 1f);
        w.Observe(View(BEARS, L.ASSAULT_IDLE, L.OBJ_LOW), NOON.AddSeconds(30), 31f);   // target word already moved on
        Assert.AreEqual("ASSAULT ON HIGH FAILS", w.Banner, "the hill that was attacked, not the one the word holds now");
    }

    /// <summary>The desktop log: clock times, the side on every line, oldest first, and a bounded length.</summary>
    [Test]
    public void TheLogCarriesTheClockAndTheSide()
    {
        var w = new AssaultWatch();
        w.Observe(View(BULLS, L.ASSAULT_PUSH, L.OBJ_HIGH), NOON, 1f);
        w.Observe(View(BULLS, L.ASSAULT_IDLE, L.OBJ_HIGH), NOON.AddSeconds(43), 44f);
        Assert.AreEqual(2, w.Log.Count);
        Assert.AreEqual("[13:00:00] BULLS ASSAULT HIGH", w.Log[0].Text);
        Assert.AreEqual("[13:00:43] BULLS FAIL ON HIGH", w.Log[1].Text);
        Assert.AreEqual(BULLS, w.Log[1].Side, "the log colours by side, so it has to carry it");

        for (int i = 0; i < AssaultWatch.Keep + 3; i++)
        {
            w.Observe(View(BEARS, L.ASSAULT_PUSH, L.OBJ_OPEN), NOON.AddSeconds(100 + i * 2), 100f + i * 2);
            w.Observe(View(BEARS, L.ASSAULT_CONSOLIDATE, L.OBJ_OPEN), NOON.AddSeconds(101 + i * 2), 101f + i * 2);
            w.Observe(View(BEARS, L.ASSAULT_IDLE, L.OBJ_OPEN), NOON.AddSeconds(101 + i * 2), 101f + i * 2);
        }
        Assert.AreEqual(AssaultWatch.Keep, w.Log.Count, "the log is bounded - it is a debug line, not a transcript");
    }

    /// <summary>A quiet front says nothing at all, and a repeated frame is not a second assault.</summary>
    [Test]
    public void NothingIsSaidWhenNothingHappens()
    {
        var w = new AssaultWatch();
        for (int i = 0; i < 5; i++) w.Observe(View(BULLS, L.ASSAULT_IDLE, L.OBJ_HIGH), NOON, i);
        Assert.AreEqual(0, w.Log.Count);
        Assert.AreEqual(0, w.Chimes);
        Assert.IsNull(w.Banner);

        // the same push seen sixty times a second is ONE assault
        for (int i = 0; i < 60; i++) w.Observe(View(BULLS, L.ASSAULT_PUSH, L.OBJ_HIGH), NOON, 10f + i / 60f);
        Assert.AreEqual(1, w.Log.Count, "one line per assault, not one per frame");
        Assert.AreEqual(1, w.Chimes, "and one sound");
    }

    /// <summary>
    /// The page is told what was drawn, so a browser run can be asked instead of guessed at.
    ///
    /// This is the same idea as the lobby's own `Shown`: measurement plumbing, never an input. It is pinned
    /// because `assaultsee.mjs` reads exactly these three fields off `window.ARENA_UNITY_ASSAULT`.
    /// </summary>
    [Test]
    public void ThePageIsToldWhatTheHudDrew()
    {
        var w = new AssaultWatch();
        Assert.AreEqual(0, w.Revision, "nothing drawn, nothing to tell");
        w.Observe(View(BULLS, L.ASSAULT_PUSH, L.OBJ_HIGH), NOON, 1f);
        string json = w.AsJson();
        StringAssert.Contains("\"banner\":\"BULLS ASSAULT HIGH\"", json);
        StringAssert.Contains("\"chimes\":1", json);
        StringAssert.Contains("[13:00:00] BULLS ASSAULT HIGH", json);
        Assert.AreEqual(1, w.Revision, "the revision is what stops the page being told sixty times a second");
    }

    /// <summary>
    /// A NEW ROUND DOES NOT INHERIT THE LAST ONE'S PUSH.
    ///
    /// Found by reading the wiring, not by a screenshot: a round that ends while a side is still pushing leaves
    /// PUSH in the watch's memory, and the next round opens at IDLE. Without the tick guard that reads as the
    /// push failing, and "BULLS FAIL ON HIGH" lands in the first second of a round where nothing has happened.
    /// </summary>
    [Test]
    public void ARoundThatEndsMidPushDoesNotAccuseTheNextOne()
    {
        var w = new AssaultWatch();
        w.Observe(View(BULLS, L.ASSAULT_PUSH, L.OBJ_HIGH), NOON, 1f, 9000);
        Assert.AreEqual(1, w.Log.Count);

        // the round ends here and the next one starts: the core's tick goes back to the beginning
        w.Observe(View(BULLS, L.ASSAULT_IDLE, L.OBJ_HIGH), NOON.AddSeconds(200), 201f, 12);
        Assert.AreEqual(1, w.Log.Count, "the new round said nothing - the old push is not its failure");
        Assert.AreEqual("BULLS ASSAULT HIGH", w.Banner, "and no new banner was raised over it");

        // and the new round's own assault is still announced normally
        w.Observe(View(BULLS, L.ASSAULT_PUSH, L.OBJ_OPEN), NOON.AddSeconds(230), 231f, 1800);
        Assert.AreEqual("BULLS ASSAULT OPEN", w.Banner);
        Assert.AreEqual(2, w.Log.Count);
    }

    /// <summary>Both sides are watched at once: a bull push does not hide a bear one.</summary>
    [Test]
    public void TheTwoSidesAreWatchedSeparately()
    {
        var w = new AssaultWatch();
        var v = new int[L.CH_WORDS];
        v[L.CH_ASSAULT] = L.ASSAULT_PUSH; v[L.CH_ASSAULT + 1] = L.OBJ_LOW;
        v[L.CH_ASSAULT + L.CH_ASSAULT_WORDS] = L.ASSAULT_PUSH; v[L.CH_ASSAULT + L.CH_ASSAULT_WORDS + 1] = L.OBJ_HIGH;
        w.Observe(v, NOON, 1f);
        Assert.AreEqual(2, w.Log.Count, "two sides pushing is two lines");
        Assert.AreEqual("[13:00:00] BULLS ASSAULT LOW", w.Log[0].Text);
        Assert.AreEqual("[13:00:00] BEARS ASSAULT HIGH", w.Log[1].Text);
        Assert.AreEqual(2, w.Chimes);
    }
}
