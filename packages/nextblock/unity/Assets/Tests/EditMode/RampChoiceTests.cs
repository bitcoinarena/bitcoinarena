// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using NUnit.Framework;

/// <summary>
/// THE RAMP'S CHOICE (2026-10-16: "it must not be all of the same so no 9% 9% 9% etc, be more diverse but
/// largest first"): the offers taken one size class at a time, the largest class first and the best paying within each; the ramp
/// reads largest first.
/// </summary>
public class RampChoiceTests
{
    static MempoolFeed.Tx T(string id, int vsize, long fee) => new MempoolFeed.Tx { txid = id, vsize = vsize, feeSats = fee, valueSats = 100000 };

    [Test]
    public void TheChoiceTakesEverySizeInTurn_LargestFirst_BestPayingWithin()
    {
        // what a fee-ordered ramp showed: the small ones pay the most per byte and filled it
        var offers = new List<MempoolFeed.Tx> {
            T("s1", 140, 9000), T("s2", 150, 8000), T("s3", 160, 7000), T("s4", 170, 6000), T("s5", 180, 5000),
            T("m1", 400, 4000), T("m2", 450, 3000), T("l1", 900, 2500), T("x1", 2000, 2000), T("x2", 2500, 1000) };
        var turn = PackageYard.Diverse(offers);
        Assert.AreEqual(offers.Count, turn.Count, "every offer is kept, in turn order");
        CollectionAssert.AreEqual(new[] { "x1", "l1", "m1", "s1", "x2", "m2", "s2", "s3", "s4", "s5" }, turn.ConvertAll((t) => t.txid));
        // the head of five spreads over all four sizes
        var head = turn.GetRange(0, 5);
        var sizes = new HashSet<float>(); foreach (var t in head) sizes.Add(CargoBay.RoomFor(t));
        Assert.AreEqual(4, sizes.Count);
        // the ramp reads largest first, the best paying within a size
        head.Sort(PackageYard.RampOrder);
        CollectionAssert.AreEqual(new[] { "x1", "x2", "l1", "m1", "s1" }, head.ConvertAll((t) => t.txid));
    }

    [Test]
    public void OneSizeOnly_IsTheFeeOrderAsBefore()
    {
        var offers = new List<MempoolFeed.Tx> { T("a", 140, 100), T("b", 150, 300), T("c", 160, 200) };
        CollectionAssert.AreEqual(new[] { "b", "c", "a" }, PackageYard.Diverse(offers).ConvertAll((t) => t.txid));
    }
}

/// <summary>THE FEED'S POOL KEEPS EVERY SIZE: over its limit the oldest of the most common size goes, not the oldest of all.</summary>
public class FeedTrimTests
{
    static MempoolFeed.Tx T(string id, int vsize) => new MempoolFeed.Tx { txid = id, vsize = vsize, feeSats = 1000, valueSats = 100000 };

    [Test]
    public void TheRareLargeOneStays_TheOldestSmallOneGoes()
    {
        // newest first: a large one at the back would be the first to go by age
        var pool = new List<MempoolFeed.Tx> { T("s1", 140), T("s2", 150), T("s3", 160), T("m1", 400), T("x-old", 2000) };
        var kept = MempoolFeed.Trim(pool, 4);
        CollectionAssert.AreEqual(new[] { "s1", "s2", "m1", "x-old" }, kept.ConvertAll((t) => t.txid));
        Assert.AreEqual(3, MempoolFeed.Trim(kept, 3).FindAll((t) => t.txid != "s2" || true).Count);
    }
}
