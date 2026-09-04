using Blwp;
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
        BlwpCore.State[Serial] = 0;
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
        BlwpCore.State[Serial] = 1;             // the core took it, Update has not seen it
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
        BlwpCore.State[Serial] = 1;
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
}
