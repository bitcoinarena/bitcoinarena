// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

/// <summary>
/// THE CLEAN SCREEN'S KEY (no test named CleanHud.cs). Shift+H toggles `CleanHud.On`, read once a frame by
/// `CleanHud.Poll` through the Input System's `wasPressedThisFrame`. In plain edit mode the Input System counts no frames
/// (measured: the key state arrives, wasUpdatedThisFrame and wasPressedThisFrame stay false), so this runs on the Input
/// System's own test fixture, whose updates are player frames. Shift+H pressed and released twice: on, then off. H alone
/// and Shift alone do nothing, and a Shift+H held across frames toggles once.
/// </summary>
public class CleanHudTests : InputTestFixture
{
    Keyboard _kb;

    public override void Setup()
    {
        base.Setup();
        _kb = InputSystem.AddDevice<Keyboard>();
    }

    void Frame(params Key[] down)
    {
        InputSystem.QueueStateEvent(_kb, new KeyboardState(down));
        InputSystem.Update();
        CleanHud.Poll();
    }

    [Test]
    public void ShiftHTwiceTurnsTheCleanScreenOnThenOff()
    {
        Assert.IsFalse(CleanHud.On, "the clean screen is on before any key");
        Frame(Key.LeftShift, Key.H);
        Assert.IsTrue(CleanHud.On, "Shift+H did not turn it on");
        Frame();
        Frame(Key.LeftShift, Key.H);
        Assert.IsFalse(CleanHud.On, "Shift+H again did not turn it off");
        Frame();
    }

    [Test]
    public void HAloneShiftAloneAndAHeldKeyDoNotToggleIt()
    {
        bool was = CleanHud.On;
        Frame(Key.H);
        Assert.AreEqual(was, CleanHud.On, "H alone toggled it");
        Frame();
        Frame(Key.LeftShift);
        Assert.AreEqual(was, CleanHud.On, "Shift alone toggled it");
        Frame(Key.LeftShift, Key.H);
        Frame(Key.LeftShift, Key.H);                     // still held, the next frame
        Assert.AreEqual(!was, CleanHud.On, "a held Shift+H toggled more than once");
        Frame();
        Frame(Key.LeftShift, Key.H);                     // back as it was
        Frame();
        Assert.AreEqual(was, CleanHud.On);
    }
}
