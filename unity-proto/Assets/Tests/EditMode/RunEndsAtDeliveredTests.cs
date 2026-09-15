using NUnit.Framework;

/// <summary>
/// THE RUN ENDS WHEN THE CORE SAYS DELIVERED (the owner 2026-09-15 16:14). Measured before, replaying
/// every run a signer node held: each truck that drove into the miner's mouth was DELIVERED in the
/// core, then drove on 10-89 s to the tunnel's back wall, the HUD reading 11-30 m to the drop-off;
/// and a live round's delivery teleported the truck to the bay in a core that still said DELIVERED,
/// so the next load could never deliver. The page ends the run (measured in node); these are the
/// three Unity rules around it.
/// </summary>
public class RunEndsAtDeliveredTests
{
    [Test]
    public void InsideALiveRoundADeliveryDoesNotSendTheTruckBackToTheBay()
    {
        Assert.IsTrue(DeliveryGate.BackToTheBay(0), "with no round, the next run starts at the ramp as before");
        Assert.IsFalse(DeliveryGate.BackToTheBay(1234567), "a live round's delivery teleported the truck into a core that still says DELIVERED");
        Assert.IsFalse(DeliveryGate.BackToTheBay(-5), "a round seed is any nonzero word");
    }

    [Test]
    public void TheHudSaysDeliveredInsteadOfMetresOnceTheCoreSaysSo()
    {
        Assert.AreEqual("14 m", DriveHud.DropOffWords(false, 14.2f));
        Assert.AreEqual("DELIVERED", DriveHud.DropOffWords(true, 14.2f), "metres to a drop-off already made");
        Assert.AreEqual("DELIVERED", DriveHud.DropOffWords(true, 0f));
    }

    /// <summary>
    /// A SECOND PLAY IN THE SAME TAB STARTS A NEW ROUND (the owner 2026-09-15 16:14, hole 1). Measured
    /// before: `BlwpNet.Running` never went false and the page refused a second session, so after a
    /// run ended the lobby's next PLAY could never open one; and the truck, handed back at the end,
    /// was never driven by the core again.
    /// </summary>
    [Test]
    public void AfterARunIsOverTheNextSessionMayOpenAndTheCoreDrivesAgain()
    {
        Assert.IsTrue(Blwp.BlwpNet.MayStart(false, false), "the first session could not open");
        Assert.IsFalse(Blwp.BlwpNet.MayStart(true, false), "a second session opened beside a live run");
        Assert.IsTrue(Blwp.BlwpNet.MayStart(true, true), "after the run was over no new session could open");

        Assert.IsTrue(Blwp.CoreDrivenTruck.ResumesDriving(false, true, true), "a new live session found a truck the core no longer drives");
        Assert.IsFalse(Blwp.CoreDrivenTruck.ResumesDriving(false, true, false), "the core took the truck back with no live session");
        Assert.IsFalse(Blwp.CoreDrivenTruck.ResumesDriving(false, false, true), "a truck handed away (not ended) was taken back");
        Assert.IsFalse(Blwp.CoreDrivenTruck.ResumesDriving(true, true, true), "a truck already driven was taken again");
    }

    [Test]
    public void AnEndedRunStartedFromTheLobbyComesBackToTheLobby()
    {
        Assert.IsTrue(SplashScreen.BackToLobby(true, true), "the run ended and the player was left on a truck that cannot be driven");
        Assert.IsFalse(SplashScreen.BackToLobby(false, true), "a run still going was taken away from the player");
        Assert.IsFalse(SplashScreen.BackToLobby(true, false), "a session not started from the lobby was sent to it");
    }
}
