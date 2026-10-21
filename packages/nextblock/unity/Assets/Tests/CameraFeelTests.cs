// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// How the driving FEELS is mostly the camera, and none of it is visible in
/// the code being correct. These check the three things that carry it: the
/// lens opening up with speed, the camera leaning into a corner, and an
/// impact actually throwing it about.
/// </summary>
public class CameraFeelTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    GameObject _boot;
    TruckController _truck;
    ChaseCamera _chase;
    Camera _cam;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return null;

        // Flat ground. The terrain is the live fee histogram, so how fast the
        // truck gets going and how hard it turns depends on the slope it
        // happens to spawn on - which is what made this read 6 degrees of lean
        // one run and 0.5 the next. These test the camera, not the mempool.
        var ground = Object.FindFirstObjectByType<MempoolTerrain>();
        if (ground != null)
        {
            ground.feeHeight = 0f;
            ground.baseRelief = 0f;
            ground.Build();
        }

        yield return new WaitForSeconds(1.5f);


        // past the title screen: it holds the truck and the ramp until PLAY

        var splash0 = Object.FindFirstObjectByType<SplashScreen>();

        if (splash0 != null && splash0.Showing) splash0.Play();

        yield return null;

        var panel = Object.FindFirstObjectByType<LoadoutPanel>();
        panel.Auto();
        panel.Confirm();

        // Clear the battlefield, for the same reason the tyre tests do.
        //
        // The solo bay is in the MIDDLE of the post office now, so the run out
        // of it goes straight through the war instead of along the empty edge
        // of the map - which is the point, and which means a truck driven at
        // full throttle for six seconds in a camera test gets shot. A wrecked
        // truck stops yawing, the camera stops leaning, and the test reports a
        // camera fault. These check the camera, not the armies.
        foreach (var army in Object.FindObjectsByType<ArmyRenderer>(FindObjectsSortMode.None))
            army.gameObject.SetActive(false);

        _truck = Object.FindFirstObjectByType<TruckController>();
        _chase = Object.FindFirstObjectByType<ChaseCamera>();
        _cam = _chase.GetComponent<Camera>();
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        Time.timeScale = 1f;
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    [UnityTest]
    public IEnumerator TheLensOpensUpWithSpeed()
    {
        yield return new WaitForSeconds(0.5f);
        float parked = _cam.fieldOfView;

        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(6f);
        float moving = _cam.fieldOfView;
        _truck.useExternalInput = false;

        Assert.Greater(moving, parked + 3f,
            $"das Sichtfeld bleibt bei {moving:0.0}° stehen (stand: {parked:0.0}°) - " +
            "ohne das wirkt jede Geschwindigkeit gleich");
        Assert.Less(moving, 90f, "das Sichtfeld reisst auf");
    }

    [UnityTest]
    public IEnumerator AnImpactThrowsTheCameraAndItSettlesAgain()
    {
        yield return new WaitForSeconds(0.3f);
        var before = _chase.transform.position;

        _chase.Shake(1.5f);
        yield return null;
        Assert.Greater(_chase.ShakeAmount, 0.5f, "der Stoss kommt nicht an");

        float moved = 0f;
        for (int i = 0; i < 10; i++)
        {
            moved = Mathf.Max(moved, Vector3.Distance(before, _chase.transform.position));
            yield return null;
        }
        Assert.Greater(moved, 0.15f, "die Kamera bewegt sich beim Stoss nicht");

        yield return new WaitForSeconds(1.5f);
        Assert.AreEqual(0f, _chase.ShakeAmount, 0.001f,
            "die Erschuetterung klingt nicht ab - das liest sich als Kamerafehler");
    }

    /// <summary>
    /// THE HORIZON STAYS LEVEL WHILE STEERING.
    ///
    /// This test used to require the opposite - a lean of at least 1.2 degrees
    /// into the corner - and the camera obliged with 5.4 degrees, measured on a
    /// slalom in a real player. The requirement was reversed on 2026-09-05:
    /// on a phone the tilted horizon is what takes the road away from the
    /// driver, and the core has nothing to tilt with. Its truck is thirteen
    /// integer words - x, z, heading, vx, vz, angular velocity, hp, cargo,
    /// flags, wheel, throttle, steer, impact - and not one of them is a roll,
    /// a bank or a pitch. The lean was a renderer flourish with no pose behind
    /// it, so it is gone rather than tuned.
    ///
    /// The bound is 0.5 degrees, not "anything under twenty". The change
    /// measured 0.0000009 degrees, so half a degree is room for arithmetic
    /// noise and nothing else. An IMPACT may still roll the frame - that is
    /// deliberate and it decays in a third of a second - so this drives on
    /// open ground and asserts across the steering window only.
    /// </summary>
    [UnityTest]
    public IEnumerator TheHorizonStaysLevelInACorner()
    {
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(5f);

        var body = _truck.GetComponent<Rigidbody>();
        Assert.Greater(body.linearVelocity.magnitude, 6f,
            "der Truck faehrt nicht - ohne Fahrt gibt es keine Kurve zu messen");

        float straight = _chase.transform.eulerAngles.z;
        _truck.externalSteer = 1f;

        // The WORST reading over the corner, not one at the end: the old lean
        // was eased in and already coming back by the time the window closed,
        // which is how an earlier cut of this read 0.03 degrees while the
        // camera was visibly over at 6.
        float roll = 0f;
        for (float t = 0f; t < 1.5f; t += 0.1f)
        {
            yield return new WaitForSeconds(0.1f);
            roll = Mathf.Max(roll,
                Mathf.Abs(Mathf.DeltaAngle(straight, _chase.transform.eulerAngles.z)));
        }
        _truck.useExternalInput = false;

        Assert.Less(roll, 0.5f,
            $"die Kamera kippt den Horizont mit {roll:0.00}° in der Kurve");
    }

    [UnityTest]
    public IEnumerator RidingSomebodyDownIsFelt()
    {
        var field = Object.FindFirstObjectByType<Battlefield>();
        Assert.IsNotNull(field.chase,
            "das Schlachtfeld kennt die Kamera nicht - Ueberfahren bliebe unbemerkt");
        yield return null;
    }
}

/// <summary>
/// LOOKING AROUND, and coming back.
///
/// The driver may swing the view off the truck for a few seconds and it must
/// return on its own, or looking costs the run. Two things were wrong with
/// that on a phone: every touch outside a driving pad became a look the
/// instant it landed - so a tap on the way to a button swung the view and the
/// road went with it - and nothing here measured the coming back at all.
///
/// Driven through `useExternalPointer`, the same shape `TruckController` uses
/// for its inputs. A look that can only be measured through a browser is
/// measured once and never again.
/// </summary>
public class CameraLookTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    GameObject _boot;
    ChaseCamera _chase;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return null;
        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();
        yield return null;

        _chase = Object.FindFirstObjectByType<ChaseCamera>();
        Assert.IsNotNull(_chase, "no chase camera");
        _chase.useExternalPointer = true;
        _chase.externalPointerHeld = false;
        yield return null;
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        if (_chase != null) _chase.useExternalPointer = false;
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    /// <summary>Somewhere in the open, clear of the driving pads.</summary>
    Vector3 Clear() => new Vector3(Screen.width * 0.5f, Screen.height * 0.6f, 0f);

    IEnumerator Point(Vector3 at, bool held)
    {
        _chase.externalPointerAt = at;
        _chase.externalPointerHeld = held;
        yield return null;
    }

    [UnityTest]
    public IEnumerator ATapDoesNotStealTheDriveView()
    {
        float yaw = _chase.OrbitYaw, pitch = _chase.OrbitPitch;
        var at = Clear();

        // TWO PIXELS, an absolute number and not a multiple of the dead zone.
        // The first cut of this wandered by 0.9 dead zones, so setting the
        // dead zone to nothing made the tap a zero-movement tap and the test
        // passed while proving nothing. A finger on the way to a button moves
        // a couple of pixels whatever the camera thinks.
        const float jitter = 2f;
        Assert.Less(jitter, _chase.DeadZonePixels,
            "the fixture's jitter has to be inside the dead zone to be a tap");

        yield return Point(at, true);
        yield return Point(at + new Vector3(jitter, 0f, 0f), true);
        yield return Point(at + new Vector3(jitter, 0f, 0f), false);

        Assert.AreEqual(yaw, _chase.OrbitYaw, 0.0001f,
            $"a tap moved the view by {_chase.OrbitYaw - yaw:0.000} degrees of yaw");
        Assert.AreEqual(pitch, _chase.OrbitPitch, 0.0001f, "a tap tilted the view");
    }

    [UnityTest]
    public IEnumerator ARealDragStillLooksAround()
    {
        var at = Clear();
        yield return Point(at, true);
        // well past the dead zone: a quarter of the screen
        yield return Point(at + new Vector3(Screen.width * 0.25f, 0f, 0f), true);

        Assert.Greater(Mathf.Abs(_chase.OrbitYaw), 5f,
            $"a real drag only moved the view {_chase.OrbitYaw:0.0} degrees");
        yield return Point(at, false);
    }

    [UnityTest]
    public IEnumerator TheDeadZoneIsOneDegreeOfAim()
    {
        // Derived, not chosen: dragYaw degrees across a screen width means a
        // degree costs width/dragYaw pixels.
        Assert.AreEqual(Screen.width / _chase.dragYaw, _chase.DeadZonePixels, 0.001f);

        var at = Clear();
        yield return Point(at, true);
        yield return Point(at + new Vector3(_chase.DeadZonePixels * 4f, 0f, 0f), true);
        // the dead zone is spent getting there, not charged to the aim as well
        float expected = _chase.DeadZonePixels * 3f / Screen.width * _chase.dragYaw;
        Assert.AreEqual(expected, _chase.OrbitYaw, 0.2f);
        yield return Point(at, false);
    }

    [UnityTest]
    public IEnumerator TheViewEasesBackToForwardOnItsOwn()
    {
        var at = Clear();
        yield return Point(at, true);
        yield return Point(at + new Vector3(Screen.width * 0.25f, 0f, 0f), true);
        float looked = _chase.OrbitYaw;
        Assert.Greater(Mathf.Abs(looked), 5f, "nothing to come back from");
        yield return Point(at, false);

        // it must NOT start coming back immediately - the look is held first
        yield return new WaitForSeconds(_chase.recentreAfter * 0.5f);
        Assert.AreEqual(looked, _chase.OrbitYaw, 0.5f,
            "the view started drifting back before the hold was up");

        float began = Time.unscaledTime;
        float back = -1f;
        while (Time.unscaledTime - began < 12f)
        {
            if (Mathf.Abs(_chase.OrbitYaw) < 0.5f) { back = Time.unscaledTime - began; break; }
            yield return null;
        }
        Assert.GreaterOrEqual(back, 0f,
            $"the view never came back - still {_chase.OrbitYaw:0.0} degrees off");
        Debug.Log($"[look] {looked:0.0} deg -> under 0.5 deg in {back:0.00} s "
                  + $"after a {_chase.recentreAfter:0.0} s hold, dead zone "
                  + $"{_chase.DeadZonePixels:0.0} px of {Screen.width}");
    }

    [UnityTest]
    public IEnumerator ADragOnADrivingPadSteersAndDoesNotLook()
    {
        // The pads are the controls on a phone; a thumb sliding on one must
        // not take the view with it.
        float yaw = _chase.OrbitYaw;
        var onPad = new Vector3(Screen.width * 0.1f, Screen.height * 0.12f, 0f);
        Assert.IsTrue(ChaseCamera.OverAPad(onPad), "the fixture is not on a pad");

        yield return Point(onPad, true);
        yield return Point(onPad + new Vector3(Screen.width * 0.25f, 0f, 0f), true);
        Assert.AreEqual(yaw, _chase.OrbitYaw, 0.0001f, "a thumb on a pad panned the view");
        yield return Point(onPad, false);
    }
}
