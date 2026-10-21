// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// THE PAGE DOES NOT CLEAR THE CORE'S IMPACT WORD IN A SIGNED RUN (2026-09-16). Measured
/// before on the Daily (0.0.1358, round bc691348): `TakeImpact` zeroed word 17 (T_IMPACT) 35 times
/// inside one signed run; outcome, score and tick equal to the signer nodes, the state hash not. No
/// rule reads the word - the core prices each crash from that tick's own impact - so the clear was a
/// page write into the replayed state for the sake of a camera shake. In a signed run the page now
/// reads the word and remembers what it has felt; the word only rises there, so a rise is a crash.
/// </summary>
public class ImpactReadTests
{
    const int ONE = 65536;

    [Test]
    public void TheImpactWordIsClearedOnlyOutsideASignedRun()
    {
        Assert.IsFalse(Arena.ArenaCore.MayClearImpact(true), "the page wrote the impact word of the core the signer nodes replay");
        Assert.IsTrue(Arena.ArenaCore.MayClearImpact(false), "outside a signed run the mailbox stopped being emptied");
    }

    [Test]
    public void AReadOnlyWordIsFeltWhenItRisesAndOnceOnly()
    {
        int seen = 0;
        Assert.AreEqual(0, Arena.ArenaCore.FeltImpact(0, ref seen), "no impact was felt as one");
        Assert.AreEqual(3 * ONE, Arena.ArenaCore.FeltImpact(3 * ONE, ref seen), "the first crash was not felt");
        Assert.AreEqual(0, Arena.ArenaCore.FeltImpact(3 * ONE, ref seen), "one crash was felt twice");
        Assert.AreEqual(5 * ONE, Arena.ArenaCore.FeltImpact(5 * ONE, ref seen), "a harder crash was not felt");
        // A new world (init or restart) starts the word at zero again.
        Assert.AreEqual(0, Arena.ArenaCore.FeltImpact(0, ref seen));
        Assert.AreEqual(0, seen, "the next run's crashes were measured against the last run's hardest");
        Assert.AreEqual(2 * ONE, Arena.ArenaCore.FeltImpact(2 * ONE, ref seen), "the next run's first crash was not felt");
    }
}
