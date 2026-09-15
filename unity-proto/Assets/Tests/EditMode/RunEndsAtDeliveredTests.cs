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

    [Test]
    public void AnEndedRunStartedFromTheLobbyComesBackToTheLobby()
    {
        Assert.IsTrue(SplashScreen.BackToLobby(true, true), "the run ended and the player was left on a truck that cannot be driven");
        Assert.IsFalse(SplashScreen.BackToLobby(false, true), "a run still going was taken away from the player");
        Assert.IsFalse(SplashScreen.BackToLobby(true, false), "a session not started from the lobby was sent to it");
    }
}
