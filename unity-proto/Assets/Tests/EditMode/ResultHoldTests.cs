using NUnit.Framework;

/// <summary>
/// A RESULT IS READ BEFORE THE LOBBY TAKES THE SCREEN (the owner 2026-09-18 19:30: "lobby comes back too fast when the
/// truck reaches the goal - the player cannot read the result. Hold the result at least 5 seconds before the lobby").
///
/// A run ends in the tick the core says DELIVERED and the page hands that word over in the same frame, so the lobby
/// came up on top of the outcome. The wreck already had this rule from the 17:00 report - WASTED first, then the
/// lobby - and a delivery is the same thing from the other end. `FINISH_WAIT_MS` is not this: 300 ms is how long the
/// last ticks have to reach the wire, a network drain that was never a screen.
/// </summary>
public class ResultHoldTests
{
    const float Wreck = 5f;      // TruckHealth.respawnSeconds in the scene this ships

    [Test]
    public void ADeliveredRunHoldsItsResultBeforeTheLobby()
    {
        // The frame the run ends in: nothing yet.
        Assert.IsFalse(SplashScreen.BackToLobby(true, true, false, 0f, Wreck, 0f),
            "the lobby came back in the frame the run ended");
        Assert.IsFalse(SplashScreen.BackToLobby(true, true, false, 0f, Wreck, 4.9f),
            "the lobby came back before the result had five seconds");
        Assert.IsTrue(SplashScreen.BackToLobby(true, true, false, 0f, Wreck, SplashScreen.ResultHoldSeconds),
            "the lobby never comes back after the result has been shown");
        Assert.GreaterOrEqual(SplashScreen.ResultHoldSeconds, 5f, "the result is held for less than five seconds");
    }

    [Test]
    public void AWreckStillWaitsForItsOwnBurnAsWell()
    {
        // The 17:00 rule stands: a wreck waits for the death sequence, and now also for the result's own five seconds.
        Assert.IsFalse(SplashScreen.BackToLobby(true, true, true, 1f, Wreck, 9f),
            "a wreck went back to the lobby before its burn had finished");
        Assert.IsTrue(SplashScreen.BackToLobby(true, true, true, Wreck, Wreck, SplashScreen.ResultHoldSeconds),
            "a wreck never goes back to the lobby");
    }

    [Test]
    public void ARunThatIsStillLiveNeverGoesBack()
    {
        Assert.IsFalse(SplashScreen.BackToLobby(false, true, false, 0f, Wreck, 60f),
            "a live run was sent back to the lobby");
        Assert.IsFalse(SplashScreen.BackToLobby(true, false, false, 0f, Wreck, 60f),
            "a run that did not start from the lobby was sent back to it");
    }
}
