// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// SPECTATE AFTER THE RUN (2026-10-03): when a run ends WRECKED or DELIVERED the camera rises over about 3 s from
/// the chase view to a steep top-down view, and the keys or a swipe pan it, the wheel or a pinch zoom it. Here the end is
/// handed in (no core in the editor); the camera's part is what is measured.
/// </summary>
public class RunEndSpectateTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    RunEndSpectate _after;
    ChaseCamera _chase;
    Transform _truck;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);
        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();
        yield return null;
        _after = Object.FindFirstObjectByType<RunEndSpectate>();
        _chase = Object.FindFirstObjectByType<ChaseCamera>();
        _truck = Object.FindFirstObjectByType<TruckController>().transform;
        Assert.IsNotNull(_after, "Bootstrap put no RunEndSpectate on the camera");
        // the cargo panel PLAY opened would hand the view back at once: this test stands at the end of a run
        _after.loadout = null;
    }

    [UnityTest]
    public IEnumerator TheCameraRisesToTopDownOverThreeSecondsAndPanningMovesIt()
    {
        yield return null;
        var chaseAt = _after.transform.position;
        _after.Begin(_truck.position);
        Assert.IsTrue(_after.Active);
        Assert.IsFalse(_chase.enabled, "the chase camera still has the view");

        // half way up it is neither the chase view nor top-down
        _after.Steer(1.5f);
        Assert.Greater(_after.Rise, 0.4f); Assert.Less(_after.Rise, 0.6f);
        float halfPitch = _after.transform.eulerAngles.x;

        _after.Steer(1.6f);
        yield return null;
        Assert.AreEqual(1f, _after.Rise, 1e-4f, "not top-down after 3 s");
        float pitch = _after.transform.eulerAngles.x;
        Assert.AreEqual(_after.topPitch, pitch, 1.0f, "the view is not steep top-down");
        Assert.Less(halfPitch, pitch);
        float above = _after.transform.position.y - _truck.position.y;
        Assert.Greater(above, 0.8f * _after.startHeight, $"only {above:0} m above the truck");
        Assert.Greater(Vector3.Distance(chaseAt, _after.transform.position), 20f, "the camera did not leave the chase view");

        // PAN: a second of full stick to the right moves the camera, sideways, and leaves the height
        var before = _after.transform.position;
        _after.Pan(new Vector2(1f, 0f), 1f);
        _after.Steer(0f);
        var moved = _after.transform.position - before;
        Assert.Greater(new Vector2(moved.x, moved.z).magnitude, 0.5f * _after.startHeight * _after.panRate, $"panned {moved.magnitude:0.0} m");
        Assert.AreEqual(0f, moved.y, 0.01f, "panning changed the height");

        // ZOOM: closer is lower, clamped
        float h = _after.Height;
        _after.Zoom(2f);
        Assert.Less(_after.Height, h);
        _after.Zoom(-1000f);
        Assert.AreEqual(_after.maxHeight, _after.Height, 1e-3f);

        _after.Leave();
        Assert.IsTrue(_chase.enabled, "the chase camera did not get the view back");
    }

    [Test]
    public void TheTopPoseCentresTheFocus()
    {
        var focus = new Vector3(10f, 2f, -30f);
        var pose = RunEndSpectate.TopPose(focus, 90f, 80f, 78f);
        Assert.AreEqual(80f, pose.position.y - focus.y, 0.01f);
        // the centre of the screen is the focus
        var ray = pose.position + pose.rotation * Vector3.forward * (80f / Mathf.Sin(78f * Mathf.Deg2Rad));
        Assert.Less(Vector3.Distance(ray, focus), 0.01f);
        // up the screen at yaw 90 is +x
        var f = RunEndSpectate.Panned(focus, 90f, new Vector2(0f, 1f), 80f, 1f, 1f);
        Assert.Greater(f.x - focus.x, 79f);
    }
}
