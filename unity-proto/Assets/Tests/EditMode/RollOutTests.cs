// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using Arena;

/// <summary>
/// WHETHER A ROLL-OUT MAY RESTART THE CORE, WHICH IS A RULE AND NOT A HABIT.
///
/// `LoadoutPanel` calls `CoreDrivenTruck.StartRound` when the bay shuts, and
/// that called `ArenaCore.Restart` unconditionally. On the daily it must: one
/// core plays many rounds and `outcome` latches, so a second round on a state
/// still holding the first is unplayable - the fault that reset was written
/// for.
///
/// ON A LIVE ROUND IT MUST NOT. The run began when the page seeded the core
/// from the committee's own randomness, and the client has recorded every tick
/// since the join - the 16:08 two-Chrome report saw tick 4241 while the truck
/// was still in its bay. A restart in the middle puts the player's core back at
/// tick zero while the transcript they are publishing runs straight through, so
/// the committee replaying those very ticks reaches a different state.
/// MEASURED in `world-seed-bridge.test.js`, 120 ticks with a roll-out at 60:
/// the page holds afa591f2… and the replay holds 686abbf1…, and the two trucks
/// are 0.28 m apart already. Every mark signed after it commits to a state
/// nobody else computes, and every watcher's picture is of the replay rather
/// than of the truck being driven.
///
/// The rule is pure - no core, no player - which is why it can be measured
/// here at all.
/// </summary>
public class RollOutTests
{
    const int Daily = 0x5eed1234;

    [Test]
    public void TheDailyRestartsIntoItsOwnConstantWorld()
    {
        Assert.IsTrue(CoreDrivenTruck.RollOutRestarts(0, Daily, out int world),
            "the daily stopped resetting between rounds, so round two inherits round one");
        Assert.AreEqual(Daily, world,
            "the daily restarted into some other world than the one its vectors were measured in");
    }

    [Test]
    public void ALiveRoundIsNotRestartedInTheMiddleOfItself()
    {
        // A round seed the page could really have been given: not zero, and
        // not the constant either.
        const int Round = unchecked((int)0x0ae8bebb);
        Assert.IsFalse(CoreDrivenTruck.RollOutRestarts(Round, Daily, out int world),
            "a roll-out restarted a live run, so the transcript being published "
            + "no longer replays to the state the player is driving");
        Assert.AreEqual(Round, world,
            "the world named for a live round is not the round's own");
    }

    /// <summary>
    /// AND THE CONSTANT IS NEVER THE ANSWER WHILE A ROUND IS NAMED.
    ///
    /// This is the leftover that could put the two trucks back in two worlds,
    /// so it is asked of every seed a round could carry rather than of one.
    /// </summary>
    [Test]
    public void NoLiveRoundEverFallsBackToTheConstant()
    {
        foreach (var round in new[] { 1, -1, 0x7fffffff, unchecked((int)0x80000000),
                                      unchecked((int)0xdeadbeef), Daily + 1, Daily - 1 })
        {
            Assert.IsFalse(CoreDrivenTruck.RollOutRestarts(round, Daily, out int world),
                $"round seed 0x{round:x8} was restarted mid-run");
            Assert.AreEqual(round, world, $"round seed 0x{round:x8} was replaced");
            Assert.AreNotEqual(Daily, world, "a live round fell back to the daily's constant");
        }

        // AND THE ONE SEED THAT IS BOTH: a round whose own seed happens to be
        // the constant is still a round, and must not be restarted.
        Assert.IsFalse(CoreDrivenTruck.RollOutRestarts(Daily, Daily, out int same),
            "a round that landed on the harness seed was treated as the daily");
        Assert.AreEqual(Daily, same);
    }
}
