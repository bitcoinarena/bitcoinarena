// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using Arena;
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// The liquidation latch in `StrikeTheatre`, driven by hand.
///
/// The thing this covers cannot be waited for: two liquidations inside one
/// frame is a market event, and twenty passive minutes against the live feeds
/// produced none (0.10 liquidations a minute; one collision falls about every
/// 200 h at that rate). So the order is FORCED here instead - the strike serial
/// is stepped by hand, which is exactly what the core does when it consumes a
/// liquidation, and the latch is asked what it kept.
///
/// The component is built on an INACTIVE object on purpose: `Awake` wants a URP
/// shader and builds materials, and none of that is what the latch is.
/// </summary>
public class StrikeLatchTests
{
    const int Serial = Layout.O_STRIKE + Layout.K_SERIAL;

    static StrikeTheatre Rig()
    {
        ArenaCore.State[Serial] = 0;
        var go = new GameObject("theatre");
        go.SetActive(false);                    // no Awake, no shader, no materials
        return go.AddComponent<StrikeTheatre>();
    }

    /// <summary>Bear is a liquidated short, bull a liquidated long.</summary>
    const bool Bear = true, Bull = false;

    [Test]
    public void TheLargerOfTwoInOneFrameIsKept()
    {
        var t = Rig();
        t.NoteSubmitter(Bull, 1_000_000);
        t.NoteSubmitter(Bear, 5_000_000);
        Assert.AreEqual(5_000_000, t.PendingUsd, 1.0, "the larger must win");
        Assert.AreEqual(Bear, t.PendingSide, "and its side must come with it");
    }

    [Test]
    public void TheSmallerDoesNotOverwriteTheLarger()
    {
        var t = Rig();
        t.NoteSubmitter(Bear, 5_000_000);
        t.NoteSubmitter(Bull, 1_000_000);
        Assert.AreEqual(5_000_000, t.PendingUsd, 1.0, "the smaller must not win");
        Assert.AreEqual(Bear, t.PendingSide, "and must not drag its side along");
    }

    [Test]
    public void ATieKeepsTheFirst()
    {
        var t = Rig();
        t.NoteSubmitter(Bear, 3_000_000);
        t.NoteSubmitter(Bull, 3_000_000);
        Assert.AreEqual(Bear, t.PendingSide, "the core takes the first of a tie");
    }

    /// <summary>
    /// THE FRAME BOUNDARY. The core has consumed the pending liquidation - its
    /// serial moved - but `Update` has not run yet, because `CoreDrivenTruck`
    /// steps the core from its own accumulator and no component has a fixed
    /// Update order. A smaller liquidation arriving in that gap must NOT lose
    /// to the size that is already spent.
    /// </summary>
    [Test]
    public void ALiquidationAfterTheCoreConsumedDoesNotLoseToASpentSize()
    {
        var t = Rig();
        t.NoteSubmitter(Bear, 5_000_000);
        ArenaCore.State[Serial] = 1;             // the core took it, Update has not seen it
        t.NoteSubmitter(Bull, 1_000_000);

        Assert.AreEqual(1_000_000, t.PendingUsd, 1.0,
                        "the spent 5M must not still be defending the slot");
        Assert.AreEqual(Bull, t.PendingSide, "the new arrival's side must be held");
    }

    /// <summary>
    /// And the side of what the core DID take has to survive that, or the
    /// bomber that is about to be drawn for the 5M strike wears the 1M's skin.
    /// </summary>
    [Test]
    public void TheConsumedSideIsHandedOverBeforeTheNextArrivalOverwritesIt()
    {
        var t = Rig();
        t.NoteSubmitter(Bear, 5_000_000);
        ArenaCore.State[Serial] = 1;
        t.NoteSubmitter(Bull, 1_000_000);

        Assert.AreEqual(Bear, t.ArmedSide,
                        "the strike the core dug belongs to the bear liquidation");
    }

    [Test]
    public void NothingIsArmedBeforeTheCoreHasTakenAnything()
    {
        var t = Rig();
        t.NoteSubmitter(Bear, 5_000_000);
        Assert.IsNull(t.ArmedSide, "no strike has been consumed yet");
    }

    /* ------------------------------------ two liquidations, one consumption */

    /// <summary>
    /// THE DOUBLE STRIKE, forced rather than waited for.
    ///
    /// Measured in the core first, with `tools`-style arithmetic against the
    /// real module: two `submitLiquidation` calls before a tick raise the
    /// SUBMISSION counter to 2 but move the STRIKE serial by exactly 1, dig
    /// exactly one crater, and load it with the larger of the two - in either
    /// order. Six hundred further ticks add nothing: the smaller is dropped,
    /// not queued. So the picture owes one bomber wearing the larger's side,
    /// and two skins over one crater would be the fault.
    /// </summary>
    [Test]
    public void TwoInOneFrameLeaveOneStrikeWearingTheLargerSide()
    {
        var t = Rig();
        t.SetBearAirframe(new GameObject("bear"));
        t.SetBullAirframe(new GameObject("bull"));

        t.NoteSubmitter(Bull, 1_000_000);       // the smaller, first
        t.NoteSubmitter(Bear, 9_000_000);       // the larger, same frame
        ArenaCore.State[Serial] = 1;             // the core takes ONE of them
        t.Spent(1);                             // and the theatre notices

        Assert.AreEqual(Bear, t.ArmedSide, "the crater belongs to the 9M bear");
        Assert.AreEqual("bear", t.Wearing(t.ArmedSide), "so the bomber wears bear");
        Assert.AreEqual(0.0, t.PendingUsd, 1.0,
                        "the smaller is dropped by the core, not carried over");
    }

    /// <summary>The same the other way round, so the order is not the rule.</summary>
    [Test]
    public void TheLargerWinsWhicheverArrivesFirst()
    {
        var t = Rig();
        t.SetBearAirframe(new GameObject("bear"));
        t.SetBullAirframe(new GameObject("bull"));

        t.NoteSubmitter(Bear, 9_000_000);
        t.NoteSubmitter(Bull, 1_000_000);
        ArenaCore.State[Serial] = 1;
        t.Spent(1);

        Assert.AreEqual(Bear, t.ArmedSide, "the crater still belongs to the 9M bear");
        Assert.AreEqual("bear", t.Wearing(t.ArmedSide), "and the skin still follows it");
    }

    /* -------------------------------------------- the core's own resolution */

    /// <summary>
    /// The core takes MILLIONS in Q16.16, so one step is $15.26. Two forced
    /// orders inside one step are the same size to it, and it keeps the first.
    /// </summary>
    [Test]
    public void OneStepIsFifteenDollarsAndAQuarter()
    {
        Assert.AreEqual(65536, ArenaCore.Scale(1_000_000), "a million is one");
        Assert.AreEqual(ArenaCore.Scale(5_000_000), ArenaCore.Scale(5_000_005),
                        "five dollars apart is one size");
        Assert.AreNotEqual(ArenaCore.Scale(5_000_000), ArenaCore.Scale(5_000_010),
                           "sixteen dollars apart is two");
        Assert.AreEqual(1, ArenaCore.Scale(5), "a five dollar order still lands");
        Assert.AreEqual(1, ArenaCore.Scale(10), "and ties with a ten dollar one");
        Assert.AreEqual(0, ArenaCore.Scale(0), "nothing is nothing");
    }

    /// <summary>
    /// The latch compares what the core compares. In raw dollars the 5,000,005
    /// would have taken the slot and dressed the bomber in ITS side over the
    /// other one's crater - the a10 fault, one resolution down.
    /// </summary>
    [Test]
    public void ATieInsideOneStepKeepsTheFirstEvenThoughItIsFewerDollars()
    {
        var t = Rig();
        t.NoteSubmitter(Bear, 5_000_000);
        t.NoteSubmitter(Bull, 5_000_005);

        Assert.AreEqual(5_000_000, t.PendingUsd, 1.0,
                        "one step apart is a tie, and the core keeps the first");
        Assert.AreEqual(Bear, t.PendingSide, "so the side stays with the first too");
    }

    /// <summary>A full step apart is a real ordering, and the larger wins.</summary>
    [Test]
    public void AFullStepApartTheLargerStillWins()
    {
        var t = Rig();
        t.NoteSubmitter(Bear, 5_000_000);
        t.NoteSubmitter(Bull, 5_000_020);

        Assert.AreEqual(5_000_020, t.PendingUsd, 1.0);
        Assert.AreEqual(Bull, t.PendingSide);
    }

    /// <summary>
    /// A side with no model of its own flies the plain airframe rather than
    /// the other side's. There is no bull model streamed in the build yet.
    /// </summary>
    [Test]
    public void ASideWithNoModelFliesThePlainAirframeAndNotTheOtherSide()
    {
        var t = Rig();
        t.SetBearAirframe(new GameObject("bear"));
        Assert.AreEqual("bear", t.Wearing(Bear));
        Assert.AreEqual("primitives", t.Wearing(Bull), "never the bear skin for a bull");
        Assert.AreEqual("primitives", t.Wearing(null), "and never one for no side at all");
    }

    /* ---------------------------------------- which one, and off which venue */

    /// <summary>
    /// The HUD names the liquidation that RAN. It used to sum every forced
    /// order of the last eight seconds and list every exchange among them,
    /// while the core keeps one - the largest still pending - and digs one
    /// crater from it. So the line named orders the core had already thrown
    /// away, and named their exchanges beside the one that actually landed.
    /// </summary>
    [Test]
    public void TheVenueThatIsNamedIsTheOneTheCoreKept()
    {
        var t = Rig();
        t.NoteSubmitter(Bull, 1_000_000, "bybit");
        t.NoteSubmitter(Bear, 5_000_000, "okx");
        t.NoteSubmitter(Bull, 2_000_000, "binance");

        ArenaCore.State[Serial] = 1;              // the core consumes one
        t.Spent(ArenaCore.StrikeCount);

        Assert.AreEqual("okx", t.ArmedVenue,
            "the exchange named must be the one the kept liquidation came off");
        Assert.AreEqual(5_000_000, t.ArmedUsd, 1.0,
            "and the size with it, off the same order");
    }

    /// <summary>
    /// A size off one order and a venue off another would name a liquidation
    /// that never happened, so they are taken together or not at all.
    /// </summary>
    [Test]
    public void TheSizeAndTheVenueComeOffTheSameOrder()
    {
        var t = Rig();
        t.NoteSubmitter(Bear, 9_000_000, "binance");
        t.NoteSubmitter(Bull, 3_000_000, "bybit");   // loses, and takes its venue with it

        ArenaCore.State[Serial] = 1;
        t.Spent(ArenaCore.StrikeCount);

        Assert.AreEqual("binance", t.ArmedVenue);
        Assert.AreEqual(9_000_000, t.ArmedUsd, 1.0);
        Assert.AreEqual(Bear, t.ArmedSide, "and the side too, still off that order");
    }

    /// <summary>Nobody sent a simulated strike, so it names no exchange.</summary>
    [Test]
    public void ASimulatedStrikeNamesNoExchange()
    {
        var t = Rig();
        t.NoteSubmitter(null, 40_000_000);        // the clock, not a venue

        ArenaCore.State[Serial] = 1;
        t.Spent(ArenaCore.StrikeCount);

        Assert.IsNull(t.ArmedVenue, "a strike nobody submitted has no exchange to name");
        Assert.AreEqual(40_000_000, t.ArmedUsd, 1.0);
    }
}
