// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// WHEN A SESSION IS ASKED FOR, and when it is not.
///
/// The rest of step B cannot be checked in an editor at all: `ArenaNet` is a
/// stub outside a WebGL player, exactly as `ArenaCore` is, so nothing here will
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
        Assert.IsTrue(Arena.NetSession.ShouldOpen("http://node", true, false, 30, Settle));
        Assert.IsTrue(Arena.NetSession.ShouldOpen("http://node", true, false, 900, Settle));
    }

    [Test]
    public void NoNodeMeansNoSession()
    {
        Assert.IsFalse(Arena.NetSession.ShouldOpen("", true, false, 900, Settle),
            "a player with no node to play against gets the game they had before");
        Assert.IsFalse(Arena.NetSession.ShouldOpen(null, true, false, 900, Settle));
    }

    [Test]
    public void NothingIsCommittedToWhileTheCoreIsNotDriving()
    {
        Assert.IsFalse(Arena.NetSession.ShouldOpen("http://node", false, false, 900, Settle),
            "a mark taken with no core behind it commits to a state that is not the round");
    }

    [Test]
    public void ASessionIsOpenedOnceAndNotAgain()
    {
        Assert.IsFalse(Arena.NetSession.ShouldOpen("http://node", true, true, 900, Settle),
            "a second session is a second entry for one player");
    }

    [Test]
    public void TheWorldIsLetSettleFirst()
    {
        Assert.IsFalse(Arena.NetSession.ShouldOpen("http://node", true, false, 0, Settle));
        Assert.IsFalse(Arena.NetSession.ShouldOpen("http://node", true, false, 29, Settle));
        Assert.IsTrue(Arena.NetSession.ShouldOpen("http://node", true, false, 30, Settle),
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
        Assert.AreEqual(60, Arena.ArenaNet.TicksPerSecond);
        Assert.AreEqual(6, Arena.ArenaNet.BatchEvery, "batches are 10 Hz");
        Assert.AreEqual(60, Arena.ArenaNet.MarkEvery, "checkpoints are 1 Hz");
    }

    /// <summary>
    /// And in an editor the whole thing is off, which is the honest answer
    /// there: there is no core to commit to and no page to sign in.
    /// </summary>
    [Test]
    public void OutsideAPlayerThereIsNoSession()
    {
        Assert.IsFalse(Arena.ArenaNet.Compiled);
        Assert.IsFalse(Arena.ArenaNet.Running);
        Assert.AreEqual("off", Arena.ArenaNet.Status());
        Assert.AreEqual(0, Arena.ArenaNet.Marks);
        Assert.IsFalse(Arena.ArenaNet.Start("http://node"),
            "an editor must not report that it opened a session");
        Assert.AreEqual("", Arena.ArenaNet.Ending(), "and it has no run to have ended");
        Assert.IsFalse(Arena.ArenaNet.Ended);
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
        Assert.IsTrue(Arena.CoreDrivenTruck.ShouldStop(true, true),
            "a VOID run must stop being stepped, not merely stop publishing");
        Assert.IsFalse(Arena.CoreDrivenTruck.ShouldStop(true, false),
            "a live run keeps driving: an outage is not an ending");
        Assert.IsFalse(Arena.CoreDrivenTruck.ShouldStop(false, true),
            "and a truck the core never drove is not stopped by it");
    }

    /// <summary>
    /// And the player stops steering it. Two directions to one answer: the
    /// game's own lock, and a run that is over.
    /// </summary>
    [Test]
    public void AnEndedRunTakesNoMoreInput()
    {
        Assert.IsTrue(Arena.CoreDrivenTruck.LocksControls(false, true),
            "steering a round that cannot settle is the thing this door is about");
        Assert.IsTrue(Arena.CoreDrivenTruck.LocksControls(true, false),
            "the game's own lock still locks");
        Assert.IsFalse(Arena.CoreDrivenTruck.LocksControls(false, false),
            "and a live run is driven by the player, as it always was");
    }

    /// <summary>
    /// NO RUN-STOPPED SENTENCE ON ANY ENDING (2026-09-29 21:03, NO-STOPPED-LINE-2103): "RUN STOPPED - the core said
    /// DELIVERED at tick 1845" broke mid-word on his phone and says nothing the ending's headline does not. The HUD has no
    /// sentence to print and no draw to print it with - on delivery, WRECKED, WASTED, the timer, a miss, an empty truck, VOID.
    /// </summary>
    [Test]
    public void NoEndingPrintsARunStoppedSentence()
    {
        const System.Reflection.BindingFlags All = System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic
            | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Instance;
        foreach (var name in new[] { "RunStoppedLine", "DrawRunStopped", "RunStoppedRowHiddenBy" })
            Assert.IsNull(typeof(DriveHud).GetMethod(name, All), $"DriveHud still has {name}");
    }

    /// <summary>
    /// AND IT DOES NOT SIT ON THE BLOCK CLOCK.
    ///
    /// Photographed on the built player: the first version hung this off the
    /// UNDER FIRE line and landed straight across "BLOCK 965,982 - 0:55" and
    /// the drop-off marker. The horizontal rule - the gap between the columns,
    /// never the whole width - had been obeyed, and the vertical one had never
    /// been asked. It is a row of the headline stack now.
    /// </summary>
    [Test]
    public void TheStoppedLineSitsUnderTheHeadlineStack()
    {
        var hud = new GameObject("hud").AddComponent<DriveHud>();
        try
        {
            foreach (var size in new[] { (1280, 660), (1920, 1080), (844, 390), (390, 844) })
            {
                var box = hud.RunStoppedBox(size.Item1, size.Item2);
                var clock = hud.BlockTimerBox(size.Item1, size.Item2);
                var head = hud.HeadlineBox(size.Item1, size.Item2);
                Assert.GreaterOrEqual(box.y, clock.yMax,
                    $"the line sits on the block clock at {size.Item1}x{size.Item2}");
                Assert.AreEqual(head.x, box.x, 0.5f, "and it is in the gap, not on a column");
                Assert.LessOrEqual(box.width, head.width + 0.5f,
                    "a full-width box is the mistake this file has made four times");
            }
        }
        finally { Object.DestroyImmediate(hud.gameObject); }
    }

}
