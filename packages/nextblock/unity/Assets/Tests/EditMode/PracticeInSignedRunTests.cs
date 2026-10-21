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
        bool was = Arena.PracticeMode.On;
        try
        {
            Arena.PracticeMode.On = true;
            Assert.AreEqual(0, Arena.PracticeMode.InputFor(true));
            Assert.AreEqual(Arena.ArenaCore.ONE, Arena.PracticeMode.InputFor(false), "outside a signed run the switch rules");
            Arena.PracticeMode.On = false;
            Assert.AreEqual(0, Arena.PracticeMode.InputFor(true));
            Assert.AreEqual(0, Arena.PracticeMode.InputFor(false));
        }
        finally { Arena.PracticeMode.On = was; }
    }

    [Test]
    public void ThePracticeBoxSaysLiveFireInASignedRun()
    {
        Assert.AreEqual("live fire  ·  in a signed run", Arena.PracticeMode.Words(true, true));
        Assert.AreEqual("live fire  ·  in a signed run", Arena.PracticeMode.Words(false, true));
        Assert.AreEqual("no damage  ·  tap to arm", Arena.PracticeMode.Words(true, false));
        Assert.AreEqual("live fire  ·  tap for practice", Arena.PracticeMode.Words(false, false));
    }
}
