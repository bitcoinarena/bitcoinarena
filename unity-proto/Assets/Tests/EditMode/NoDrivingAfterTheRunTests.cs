// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// NO DRIVING AFTER THE RUN (2026-09-27 13:25, phone, block 968830: after WASTED "WASD steers it ... the drive
/// sound plays", and after a delivery the same). Once the core has named the run - the words latch in S_STATE - or the
/// session says it ended, DriveInput answers nothing: no throttle, no steer, no handbrake, for the core's inputs, the
/// wheels and the engine note alike.
/// </summary>
public class NoDrivingAfterTheRunTests
{
    [Test]
    public void EveryEndingOfTheCoreAndTheSessionsEndStopTheInputs()
    {
        Assert.IsFalse(DriveInput.RunIsOver(true, 0, false), "a live run drives");
        Assert.IsTrue(DriveInput.RunIsOver(true, 1, false), "DELIVERED");
        Assert.IsTrue(DriveInput.RunIsOver(true, 2, false), "WRECKED - the WASTED screen");
        Assert.IsTrue(DriveInput.RunIsOver(true, 3, false), "MISSED - the timer");
        Assert.IsTrue(DriveInput.RunIsOver(true, 0, true), "the session ended it (VOID)");
        Assert.IsTrue(DriveInput.RunIsOver(false, 0, true), "no core, the session ended it");
        Assert.IsFalse(DriveInput.RunIsOver(false, 2, false), "no core answering: no core word to read");
    }
}
