// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// COPY GAME REPLAY AFTER EVERY ENDING (2026-09-27 13:19: "After every round end he must be able to copy a
/// replay. The button is missing on the Wasted screen and on the timeout screen ... An empty truck is not a reason to
/// hide it"). The result card carries the control for a delivery and a miss with freight aboard; every other ending -
/// WASTED, a run the timer or a VOID stopped, a truck with nothing on the bed - has no card, so the same control is
/// drawn on its own row. Which run it copies is the bridge's: the run that just ended, kept at its end from the session
/// ROLL OUT found for it (arena.jslib `ArenaRunStarts`).
/// </summary>
public class CopyReplayEveryEndingTests
{
    [Test]
    public void TheLoneControlShowsWhereNoCardCarriesItAndNeverOverTheLobby()
    {
        Assert.IsTrue(DriveHud.CopyReplayAlone(true, false, false), "wasted / timeout / empty truck: the control is there");
        Assert.IsFalse(DriveHud.CopyReplayAlone(true, true, false), "the card carries it: not twice");
        Assert.IsFalse(DriveHud.CopyReplayAlone(true, false, true), "the lobby is up: not over the lobby");
        Assert.IsFalse(DriveHud.CopyReplayAlone(false, false, false), "no run of this roll-out has ended: nothing to copy");
    }

    /// <summary>
    /// "copied!" STANDS ON WRECKED TOO (2026-09-29 17:45, SEE-AND-COPIED-1745): on WRECKED only the lone control
    /// is up, and the press was forgotten every frame the result card was not showing. It is forgotten only when neither
    /// control is up.
    /// </summary>
    [Test]
    public void APressIsForgottenOnlyWhenNeitherTheCardNorTheLoneControlIsUp()
    {
        Assert.IsFalse(DriveHud.CopyStateResets(cardShowing: false, loneShowing: true), "WRECKED: the lone control keeps its press and its copied!");
        Assert.IsFalse(DriveHud.CopyStateResets(cardShowing: true, loneShowing: false), "the result card keeps its press and its copied!");
        Assert.IsTrue(DriveHud.CopyStateResets(cardShowing: false, loneShowing: false), "no control up: the next one starts unpressed");
        Assert.AreEqual("copied!", DriveHud.CopiedLabel);
    }

    [TestCase(1170, 2532, TestName = "phone upright")]
    [TestCase(1280, 720, TestName = "desktop")]
    public void ItsRowIsOnScreenUnderTheWastedBandAndClearOfThePads(int w, int h)
    {
        var row = DriveHud.CopyReplayAloneRow(w, h);
        Assert.That(row.xMin, Is.GreaterThanOrEqualTo(0f)); Assert.That(row.xMax, Is.LessThanOrEqualTo(w));
        Assert.That(row.yMin, Is.GreaterThanOrEqualTo(0f)); Assert.That(row.yMax, Is.LessThanOrEqualTo(h));
        // the WASTED band: h * 0.34, 1.5 of a font of 0.17 of the smaller side (DriveHud.DrawWasted)
        float bandBottom = h * 0.34f + Mathf.Min(w, h) * 0.17f * 1.5f;
        Assert.That(row.yMin, Is.GreaterThanOrEqualTo(bandBottom), $"the row {row} is on the WASTED band (bottom {bandBottom})");
        foreach (TouchPad.Pad pad in System.Enum.GetValues(typeof(TouchPad.Pad)))
            Assert.IsFalse(TouchPad.RectFor(pad, w, h).Overlaps(row), $"the row {row} is on the {pad} pad");
        Assert.That(row.height, Is.GreaterThan(30f), "a control a thumb can press");
    }
}
