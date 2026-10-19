// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// A SIGNED RUN SENDS NO PRACTICE (2026-10-04): practice was on by default and its switch sat under the cargo panel
/// until ROLL OUT, so every staked run carried practice ticks. The input a run sends is 0 in a signed run whatever the
/// switch says; outside one the switch rules as before. The box says so.
/// </summary>
public class PracticeInSignedRunTests
{
    [Test]
    public void ASignedRunSendsNoPracticeWhateverTheSwitchSays()
    {
        bool was = Blwp.PracticeMode.On;
        try
        {
            Blwp.PracticeMode.On = true;
            Assert.AreEqual(0, Blwp.PracticeMode.InputFor(true));
            Assert.AreEqual(Blwp.BlwpCore.ONE, Blwp.PracticeMode.InputFor(false), "outside a signed run the switch rules");
            Blwp.PracticeMode.On = false;
            Assert.AreEqual(0, Blwp.PracticeMode.InputFor(true));
            Assert.AreEqual(0, Blwp.PracticeMode.InputFor(false));
        }
        finally { Blwp.PracticeMode.On = was; }
    }

    [Test]
    public void ThePracticeBoxSaysLiveFireInASignedRun()
    {
        Assert.AreEqual("live fire  ·  in a signed run", Blwp.PracticeMode.Words(true, true));
        Assert.AreEqual("live fire  ·  in a signed run", Blwp.PracticeMode.Words(false, true));
        Assert.AreEqual("no damage  ·  tap to arm", Blwp.PracticeMode.Words(true, false));
        Assert.AreEqual("live fire  ·  tap for practice", Blwp.PracticeMode.Words(false, false));
    }
}
