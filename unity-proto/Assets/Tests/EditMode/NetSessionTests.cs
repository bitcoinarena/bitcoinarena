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
        Assert.AreEqual("", Blwp.BlwpNet.Ending(), "and it has no run to have ended");
        Assert.IsFalse(Blwp.BlwpNet.Ended);
    }

    /// <summary>
    /// A ROUND THAT CANNOT BE SETTLED IS NOT DRIVEN ON.
    ///
    /// The client says VOID when its hold fills and no transcript from there
    /// can be replayed - and until this rule existed nothing in the game was
    /// told. The truck kept driving, the core kept stepping, and a player
    /// finished a round nobody could pay out.
    ///
    /// The word and the reason are the CLIENT'S. Unity reads them; it does not
    /// choose one, and there is no branch here on which word it was.
    /// </summary>
    [Test]
    public void AnEndedRunStopsBeingDriven()
    {
        Assert.IsTrue(Blwp.CoreDrivenTruck.ShouldStop(true, true),
            "a VOID run must stop being stepped, not merely stop publishing");
        Assert.IsFalse(Blwp.CoreDrivenTruck.ShouldStop(true, false),
            "a live run keeps driving: an outage is not an ending");
        Assert.IsFalse(Blwp.CoreDrivenTruck.ShouldStop(false, true),
            "and a truck the core never drove is not stopped by it");
    }

    /// <summary>
    /// And the player stops steering it. Two directions to one answer: the
    /// game's own lock, and a run that is over.
    /// </summary>
    [Test]
    public void AnEndedRunTakesNoMoreInput()
    {
        Assert.IsTrue(Blwp.CoreDrivenTruck.LocksControls(false, true),
            "steering a round that cannot settle is the thing this door is about");
        Assert.IsTrue(Blwp.CoreDrivenTruck.LocksControls(true, false),
            "the game's own lock still locks");
        Assert.IsFalse(Blwp.CoreDrivenTruck.LocksControls(false, false),
            "and a live run is driven by the player, as it always was");
    }

    /// <summary>
    /// WHAT THE PLAYER IS TOLD, AND WHAT THEY ARE NOT.
    ///
    /// The client's word is `VOID`, which is the protocol's name for what a
    /// COMMITTEE decides under the no-quorum rule - not something a browser may
    /// announce. What this client knows is that it cannot record any more of
    /// this round, and that is all the screen says. A payout word on a HUD
    /// would be a browser-side outcome, which is the one thing the whole design
    /// forbids.
    /// </summary>
    [Test]
    public void TheStoppedLineSaysWhyAndNotWhatItPays()
    {
        const string ending = "VOID a tick was dropped at 601: the hold was full at 600, "
                              + "so no transcript from here can be replayed";
        string line = DriveHud.RunStoppedLine(ending);

        Assert.IsTrue(line.StartsWith("RUN STOPPED"), line);
        StringAssert.Contains("the hold was full at 600", line,
            "the player is told why, in the client's own words");

        foreach (var word in new[] { "VOID", "REFUND", "REFUNDED", "WON", "LOST",
                                     "FORFEIT", "PAID", "DELIVERED" })
            Assert.IsFalse(line.ToUpperInvariant().Contains(word),
                $"the HUD claimed an outcome: {word} in \"{line}\"");
    }

    [Test]
    public void ALiveRunSaysNothingAtAll()
    {
        Assert.AreEqual("", DriveHud.RunStoppedLine(""),
            "a banner on a healthy run is a banner nobody reads on a broken one");
        Assert.AreEqual("", DriveHud.RunStoppedLine(null));
        Assert.AreEqual("RUN STOPPED", DriveHud.RunStoppedLine("VOID"),
            "and a word with no reason still stops the run rather than saying nothing");
    }
}
