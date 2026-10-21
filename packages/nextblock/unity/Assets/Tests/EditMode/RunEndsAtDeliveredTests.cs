// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// THE RUN ENDS WHEN THE CORE SAYS DELIVERED (2026-09-15 16:14). Measured before, replaying
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
    /// A SECOND PLAY IN THE SAME TAB STARTS A NEW ROUND (2026-09-15 16:14, hole 1). Measured
    /// before: `ArenaNet.Running` never went false and the page refused a second session, so after a
    /// run ended the lobby's next PLAY could never open one; and the truck, handed back at the end,
    /// was never driven by the core again.
    /// </summary>
    [Test]
    public void AfterARunIsOverTheNextSessionMayOpenAndTheCoreDrivesAgain()
    {
        Assert.IsTrue(Arena.ArenaNet.MayStart(false, false), "the first session could not open");
        Assert.IsFalse(Arena.ArenaNet.MayStart(true, false), "a second session opened beside a live run");
        Assert.IsTrue(Arena.ArenaNet.MayStart(true, true), "after the run was over no new session could open");

        Assert.IsTrue(Arena.CoreDrivenTruck.ResumesDriving(false, true, true), "a new live session found a truck the core no longer drives");
        Assert.IsFalse(Arena.CoreDrivenTruck.ResumesDriving(false, true, false), "the core took the truck back with no live session");
        Assert.IsFalse(Arena.CoreDrivenTruck.ResumesDriving(false, false, true), "a truck handed away (not ended) was taken back");
        Assert.IsFalse(Arena.CoreDrivenTruck.ResumesDriving(true, true, true), "a truck already driven was taken again");
    }

    [Test]
    public void AnEndedRunStartedFromTheLobbyComesBackToTheLobby()
    {
        Assert.IsTrue(SplashScreen.BackToLobby(true, true), "the run ended and the player was left on a truck that cannot be driven");
        Assert.IsFalse(SplashScreen.BackToLobby(false, true), "a run still going was taken away from the player");
        Assert.IsFalse(SplashScreen.BackToLobby(true, false), "a session not started from the lobby was sent to it");
    }

    /// <summary>
    /// A run the ADDRESS started is a lobby run too (2026-09-16 14:24). PLAY leaves the round's link with
    /// `play=1`; opened again, auto-play starts the run on the fourth frame, before the first lobby poll, and on
    /// 0.0.1386 that run ended on "RUN STOPPED - the core said DELIVERED" with no lobby ever coming back.
    /// </summary>
    /// <summary>
    /// EXIT from SPECTATE is the way back to the lobby (2026-09-16 14:45). Measured on 0.0.1391: EXIT closed
    /// the free camera and the lobby stayed hidden 15 s later, over a locked truck.
    /// </summary>
    /// <summary>
    /// "0:00 LEFT" IS THE TICK THE CORE ENDS THE RUN ON (2026-09-16 15:36: "when time hits zero the round does
    /// not end"). The HUD read a Unity stopwatch from scene load; the core ends a run MISSED after its block's own
    /// ticks from roll-out. With a core the clock is the core's count.
    ///
    /// THE LENGTH IS NO LONGER WRITTEN HERE, and that is the 2026-09-20 16:21 letter. This test pinned 9000 in
    /// five places. The core moved to 10800 in c01cc655 ("a round is three minutes") and nothing here moved with
    /// it, so a green test went on describing a round that had not existed for days while the HUD counted down
    /// to 0:00 thirty seconds early and the run went on - the same symptom as 09-16, from the same cause a layer
    /// down. Every assertion below means exactly what it meant; only the duplicated number is gone.
    /// </summary>
    [Test]
    public void TheRunClockIsTheCoresOwnCount()
    {
        const int block = Arena.Layout.BLOCK_TICKS;
        Assert.AreEqual(block * 1092f / 65536f, BlockClock.CoreSecondsLeft(0), 1e-3f, "a run that has not rolled out has all of it");
        Assert.AreEqual(179.96f, BlockClock.CoreSecondsLeft(0), 0.01f, "10800 ticks at 65536/1092 a second - three minutes");
        Assert.AreEqual(0f, BlockClock.CoreSecondsLeft(block), "the tick the core says MISSED shows 0:00");
        Assert.AreEqual(0f, BlockClock.CoreSecondsLeft(block + 500), "never below zero");
        Assert.AreEqual(1092f / 65536f * 60f, BlockClock.CoreSecondsLeft(block - 60), 1e-3f, "sixty ticks before the end is a second");
    }

    /// <summary>
    /// WASTED, THEN THE LOBBY (2026-09-16 17:00). A wreck ends the run in its own tick; the lobby waits for the
    /// burn.
    /// </summary>
    [Test]
    public void AWreckShowsWastedBeforeTheLobby()
    {
        Assert.IsFalse(SplashScreen.BackToLobby(true, true, wrecked: true, sinceWreck: 0f, hold: 5f),
            "the lobby came up in the frame the truck blew and covered WASTED");
        Assert.IsFalse(SplashScreen.BackToLobby(true, true, wrecked: true, sinceWreck: 4.9f, hold: 5f), "WASTED cut short");
        Assert.IsTrue(SplashScreen.BackToLobby(true, true, wrecked: true, sinceWreck: 5f, hold: 5f), "after WASTED, the lobby");
        Assert.IsTrue(SplashScreen.BackToLobby(true, true, wrecked: false, sinceWreck: 0f, hold: 5f),
            "a delivery or a miss still goes straight back");
        Assert.IsFalse(SplashScreen.BackToLobby(false, true, wrecked: true, sinceWreck: 9f, hold: 5f), "a run still going");
    }

    [Test]
    public void ExitFromSpectateComesBackToTheLobby()
    {
        Assert.IsTrue(SplashScreen.BackFromSpectating(spectating: true, cameraActive: false),
            "EXIT closed the free camera and the player was left with no lobby and no PLAY");
        Assert.IsFalse(SplashScreen.BackFromSpectating(spectating: true, cameraActive: true), "still flying: the lobby waits");
        Assert.IsFalse(SplashScreen.BackFromSpectating(spectating: false, cameraActive: false),
            "a run started with PLAY is not spectating and must not be sent back to the lobby");
    }

    [Test]
    public void ARunTheAddressStartedAlsoComesBackToTheLobby()
    {
        Assert.IsTrue(SplashScreen.StartedFromLobby(lobbyPolled: false, fromAddress: true),
            "auto-play fired before the first lobby poll, and its run was left on the banner");
        Assert.IsTrue(SplashScreen.StartedFromLobby(lobbyPolled: true, fromAddress: false), "PLAY in the lobby");
        Assert.IsFalse(SplashScreen.StartedFromLobby(lobbyPolled: false, fromAddress: false),
            "the offline title screen's PLAY has no lobby to go back to");
    }
}
