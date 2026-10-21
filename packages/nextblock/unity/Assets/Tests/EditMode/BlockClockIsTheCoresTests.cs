// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// THE CLOCK ON SCREEN IS THE CORE'S CLOCK (2026-09-20 16:21: "when the round timer hits 0, the game must
/// end and return to the lobby by itself. It used to. It no longer does").
///
/// THIS IS WHAT HE SEES. `BlockClock.RunTicks` was a hand-written 9000 while the core's `BLOCK_TICKS` had moved
/// to 10800 (c01cc655, "a round is three minutes, and the constant is the default a contract overrides"). The
/// HUD counts down `RunTicks - elapsed`, so it reached 0:00 at elapsed 9000 - and the core does not call the run
/// MISSED until 10800. Thirty seconds of a round, every round, with a timer showing nothing left and a truck
/// still driving. Nothing threw, no test was red, and the only way to find it was to read both numbers.
///
/// It is also the second time: the same clock told him the same lie on 2026-09-16 15:36, when it was a Unity
/// stopwatch. It was made the core's count then, and then the core's count changed underneath it.
///
/// So the constant is GENERATED now, and this is the guard that says so.
/// </summary>
public class BlockClockIsTheCoresTests
{
    /// <summary>One number, from the one place that decides it.</summary>
    [Test]
    public void TheRunIsAsLongAsTheCoreSaysItIs()
    {
        Assert.AreEqual(Arena.Layout.BLOCK_TICKS, BlockClock.RunTicks,
            "the HUD's run length is not the core's - the clock will hit 0:00 while the round is still live, "
            + "which is exactly the bug this guards");
    }

    /// <summary>
    /// And the clock reaches zero on the tick the core ends the run - not before it, not after it.
    ///
    /// The seconds come from the core's own rate (65536/1092 a second, packages/nextblock/src/tick.js), so this also
    /// pins that a full block is the three minutes the ruling calls for.
    /// </summary>
    [Test]
    public void ZeroOnScreenIsTheTickTheRunEnds()
    {
        Assert.Greater(BlockClock.CoreSecondsLeft(Arena.Layout.BLOCK_TICKS - 1), 0f,
            "one tick before the end the clock still has something on it");
        Assert.AreEqual(0f, BlockClock.CoreSecondsLeft(Arena.Layout.BLOCK_TICKS), 0.0001f,
            "the clock reads 0:00 on the tick the core calls the run MISSED");
        Assert.AreEqual(0f, BlockClock.CoreSecondsLeft(Arena.Layout.BLOCK_TICKS + 5000), 0.0001f,
            "and it never goes negative");

        float wholeBlock = BlockClock.CoreSecondsLeft(0);
        Assert.AreEqual(180f, wholeBlock, 0.5f,
            $"a round is three minutes (RULED 2026-09-19, WAR_TACTICS §4.12/§4.14); this one is {wholeBlock:F1}s");
    }

    /// <summary>The outcomes the client names are the core's own numbers too, for the same reason.</summary>
    [Test]
    public void TheOutcomeWordsAreTheCores()
    {
        Assert.AreEqual(0, Arena.Layout.RUN_LIVE);
        Assert.AreEqual(1, Arena.Layout.RUN_DELIVERED);
        Assert.AreEqual(2, Arena.Layout.RUN_WRECKED);
        Assert.AreEqual(3, Arena.Layout.RUN_MISSED);
    }
}
