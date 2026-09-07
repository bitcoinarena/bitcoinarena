using NUnit.Framework;

/// <summary>
/// WHEN A SESSION IS ASKED FOR, and when it is not.
///
/// The rest of step B cannot be checked in an editor at all: `BlwpNet` is a
/// stub outside a WebGL player, exactly as `BlwpCore` is, so nothing here will
/// ever open a socket, sign a mark or receive a receipt. What CAN be pinned is
/// the rule that decides whether a session should exist - and that is worth
/// pinning, because every way of getting it wrong is quiet.
///
/// A session opened without a node named would be a connection to nowhere. One
/// opened while the core is not driving would commit to a state that is not
/// the round. One opened twice would be a second entry for one player. And one
/// opened on the first tick would land its handshake in the frame the world is
/// still being built in.
/// </summary>
public class NetSessionTests
{
    const int Settle = 30;

    [Test]
    public void WithANodeAndACoreDrivingItOpensOnce()
    {
        Assert.IsTrue(Blwp.NetSession.ShouldOpen("http://node", true, false, 30, Settle));
        Assert.IsTrue(Blwp.NetSession.ShouldOpen("http://node", true, false, 900, Settle));
    }

    [Test]
    public void NoNodeMeansNoSession()
    {
        Assert.IsFalse(Blwp.NetSession.ShouldOpen("", true, false, 900, Settle),
            "a player with no node to play against gets the game they had before");
        Assert.IsFalse(Blwp.NetSession.ShouldOpen(null, true, false, 900, Settle));
    }

    [Test]
    public void NothingIsCommittedToWhileTheCoreIsNotDriving()
    {
        Assert.IsFalse(Blwp.NetSession.ShouldOpen("http://node", false, false, 900, Settle),
            "a mark taken with no core behind it commits to a state that is not the round");
    }

    [Test]
    public void ASessionIsOpenedOnceAndNotAgain()
    {
        Assert.IsFalse(Blwp.NetSession.ShouldOpen("http://node", true, true, 900, Settle),
            "a second session is a second entry for one player");
    }

    [Test]
    public void TheWorldIsLetSettleFirst()
    {
        Assert.IsFalse(Blwp.NetSession.ShouldOpen("http://node", true, false, 0, Settle));
        Assert.IsFalse(Blwp.NetSession.ShouldOpen("http://node", true, false, 29, Settle));
        Assert.IsTrue(Blwp.NetSession.ShouldOpen("http://node", true, false, 30, Settle),
            "and it opens on the tick it is allowed to, not one later");
    }

    /// <summary>
    /// The cadence is the spec's, written as the arithmetic rather than as two
    /// numbers. IMPLEMENTATION.md puts INPUT_BATCH at 10 Hz and CHECKPOINT at
    /// 1 Hz beside the messages; the core runs at 60 ticks a second.
    /// </summary>
    [Test]
    public void TheCadenceIsTenHertzAndOneHertz()
    {
        Assert.AreEqual(60, Blwp.BlwpNet.TicksPerSecond);
        Assert.AreEqual(6, Blwp.BlwpNet.BatchEvery, "batches are 10 Hz");
        Assert.AreEqual(60, Blwp.BlwpNet.MarkEvery, "checkpoints are 1 Hz");
    }

    /// <summary>
    /// And in an editor the whole thing is off, which is the honest answer
    /// there: there is no core to commit to and no page to sign in.
    /// </summary>
    [Test]
    public void OutsideAPlayerThereIsNoSession()
    {
        Assert.IsFalse(Blwp.BlwpNet.Compiled);
        Assert.IsFalse(Blwp.BlwpNet.Running);
        Assert.AreEqual("off", Blwp.BlwpNet.Status());
        Assert.AreEqual(0, Blwp.BlwpNet.Marks);
        Assert.IsFalse(Blwp.BlwpNet.Start("http://node"),
            "an editor must not report that it opened a session");
    }
}
