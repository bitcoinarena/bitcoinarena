using NUnit.Framework;

/// <summary>
/// THE SIM SWITCH DOES NOT WRITE THE CORE OF A SIGNED RUN (the owner 2026-09-15). Measured before on the
/// Daily (0.0.1356, round 8386f6f5): one SIM press at tick 192 put a simulated liquidation into the
/// page's core and nowhere else; the card read DELIVERED 222 at tick 2129, both signer nodes signed
/// FAILED 268, and the held transcript replayed alone gives the signed 268, still live at its end.
/// These are the two Unity rules; the run itself is measured on the Daily.
/// </summary>
public class SimLiquidationTests
{
    [Test]
    public void ASimulatedLiquidationIsNotOfferedToTheCoreOfASignedRun()
    {
        Assert.IsFalse(Bootstrap.SimMayWriteCore(true), "a simulated liquidation reached the core the signer nodes replay");
        Assert.IsTrue(Bootstrap.SimMayWriteCore(false), "outside a signed run the SIM switch stopped firing");
    }

    [Test]
    public void TheSwitchSaysItFiresNothingInASignedRun()
    {
        // Short enough for the switch's second line, which cut "practice only · not in a signed run"
        // at "signed" on the Daily's 1280-wide page (0.0.1357).
        Assert.AreEqual("off in a signed run", DriveHud.SimWords(true, true), "the switch says it fires in a signed run");
        Assert.AreEqual("off in a signed run", DriveHud.SimWords(false, true));
        Assert.AreEqual("firing liquidations  ·  tap to stop", DriveHud.SimWords(true, false));
        Assert.AreEqual("tap to fire liquidations", DriveHud.SimWords(false, false));
    }
}
