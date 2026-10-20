// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// A ROUND THAT CANNOT BE SETTLED IS NOT DRIVEN ON.
///
/// The client ends a run when its hold has filled and no transcript from there
/// can be replayed. The first version of that stop handed the truck back to
/// the physics controller EXACTLY as `OnDisable` does - so the core stopped
/// stepping, the client published nothing, and the player carried on driving
/// the round under PhysX with nothing on screen to say why. The core stopping
/// was never the point.
///
/// So this drives the real scene rather than a rig, and watches the rigidbody.
/// `ArenaNet` is a stub outside a WebGL player and will never answer `true`,
/// which is why the effect is exercised directly: `HandBack(lockControls:
/// true)` is what `StopDriving` does, and what is measured here is what that
/// does to a truck the player is holding the throttle down on.
/// </summary>
public class RunStoppedTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    GameObject _boot;
    TruckController _truck;
    Arena.CoreDrivenTruck _core;
    Rigidbody _rb;
    Vector3 _spawn;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        Arena.PracticeMode.On = false;
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return null;

        // A deterministic floor, for the same reason the vehicle tests use one:
        // the terrain is the live fee histogram, so otherwise every run starts
        // the truck on a different slope and "it did not move" is luck.
        var ground = Object.FindFirstObjectByType<MempoolTerrain>();
        if (ground != null) { ground.feeHeight = 0f; ground.baseRelief = 0f; ground.Build(); }

        yield return new WaitForSeconds(1.5f);
        LoadAndRelease();
        _truck = Object.FindFirstObjectByType<TruckController>();
        _core = Object.FindFirstObjectByType<Arena.CoreDrivenTruck>();
        _rb = _truck != null ? _truck.GetComponent<Rigidbody>() : null;
        _spawn = _rb != null ? _rb.position : Vector3.zero;
    }

    /// <summary>
    /// Drives the truck the way every other PlayMode test does. A keyboard is
    /// not pressed in a batch-mode run, and `TouchControls` writes the touch
    /// fields every frame - measured: the first version of this held
    /// `TouchThrottle` down for two seconds and the truck did not move at all,
    /// so "it did not move once stopped" was proving nothing.
    /// </summary>
    void Throttle(float v)
    {
        _truck.useExternalInput = true;
        _truck.externalThrottle = v;
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        if (_truck != null) { _truck.useExternalInput = false; _truck.externalThrottle = 0f; }
        Time.timeScale = 1f;
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    /// <summary>
    /// The control measurement first, or "it did not move" says nothing: the
    /// throttle has to be reaching PhysX before its being ignored is evidence.
    /// </summary>
    [UnityTest]
    public IEnumerator ThrottleMovesTheTruckWhileTheRunIsAlive()
    {
        Assert.IsNotNull(_rb, "no truck in the scene to drive");
        Assert.IsFalse(_truck.controlsLocked, "the bay should have released it");

        Vector3 from = _rb.position;
        Throttle(1f);
        yield return new WaitForSeconds(2f);
        float moved = Vector3.Distance(from, _rb.position);

        Assert.Greater(moved, 1f, $"the throttle never reached the wheels: {moved:F2} m");
    }

    /// <summary>
    /// And with the run stopped it does not, with the same throttle held down.
    /// </summary>
    [UnityTest]
    public IEnumerator AStoppedRunLocksTheTruckAndItDoesNotMove()
    {
        Assert.IsNotNull(_rb, "no truck in the scene to drive");
        Assert.IsNotNull(_core, "no core-driven truck to stop");

        // The throttle is held down for the whole test, including after the
        // stop: what is measured is the truck ignoring it, not nobody asking.
        Throttle(1f);
        yield return new WaitForSeconds(1f);
        Assert.Greater(Vector3.Distance(_rb.position, _spawn), 1f,
            "the truck was not moving before the stop, so stopping proves nothing");

        // What `StopDriving` does when the client says the run is over.
        _core.HandBack(lockControls: true);

        Assert.IsTrue(_truck.controlsLocked,
            "the player can still steer a round that cannot be settled");
        Assert.IsFalse(_truck.externallyDriven,
            "and the truck is back with the physics controller, not held by the core");

        // COASTING TO A HALT IS NOT DRIVING, and the first version of this
        // could not tell them apart: it recorded a starting point half a
        // second after the lock and called the 3.75 m a moving truck still
        // takes to stop a failure. What the lock has to produce is a truck at
        // REST that stays there with the throttle held down - so it is given
        // the time a loaded truck needs to stop, and then watched.
        yield return new WaitForSeconds(3f);
        Assert.Less(_rb.linearVelocity.magnitude, 0.5f,
            $"the truck never came to rest: {_rb.linearVelocity.magnitude:F2} m/s");

        Vector3 from = _rb.position;
        yield return new WaitForSeconds(2f);
        float moved = Vector3.Distance(from, _rb.position);

        Assert.Less(moved, 0.5f,
            $"the truck drove {moved:F2} m on a stopped round with the throttle down");
        Assert.Less(_rb.linearVelocity.magnitude, 0.5f, "and it started rolling again");
    }

    /// <summary>
    /// Disabling the component is a HANDOVER, not an ending: the truck goes
    /// back to the player. One function does both, so the two cannot drift -
    /// they were three duplicated lines, and that is how the lock went missing.
    /// </summary>
    [UnityTest]
    public IEnumerator AnOrdinaryHandoverLeavesThePlayerDriving()
    {
        Assert.IsNotNull(_core, "no core-driven truck to hand back");
        _core.HandBack(lockControls: false);
        Assert.IsFalse(_truck.controlsLocked,
            "an ordinary handover must not lock a player out of their own truck");
        yield return null;
    }

    /// <summary>
    /// Get through the loading bay. The truck is held at the ramp until
    /// freight is aboard, so anything that drives has to load first.
    /// </summary>
    static void LoadAndRelease()
    {
        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();

        var panel = Object.FindFirstObjectByType<LoadoutPanel>();
        if (panel == null) return;

        var feed = Object.FindFirstObjectByType<MempoolFeed>();
        if (feed != null && feed.Offers.Count == 0)
            feed.Offers = new System.Collections.Generic.List<MempoolFeed.Tx>
            {
                new MempoolFeed.Tx
                {
                    txid = "testfreight0000000000000000000000",
                    feeSats = 2400, vsize = 300, valueSats = 25_000_000,
                },
            };

        panel.Auto();
        panel.Confirm();
    }
}
