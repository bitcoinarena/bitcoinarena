// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// M1.a14 bullet 1: THE DIRECTION THE TRUCK DRIVES MUST NOT LEAVE THE VIEW.
///
/// a13 measured one case - a keyboard slalom - and took the worst off-nose
/// from 8.7 degrees down to 3.8. One slalom is not "never". The cases that
/// could still break it are the ones a slalom does not contain: driving
/// backwards, a slide where the truck is not going where it points, the frame
/// being thrown by an impact, and the moment a deliberate look lets go.
///
/// ONE CASE PER TEST, each from a fresh scene. The first cut of this ran all
/// four on one truck in sequence and the numbers were worthless: the impact
/// case inherited the spin-out's slide - 73 degrees of slip while it was
/// supposed to be driving straight - and by the fourth case the truck was not
/// moving at all, so a released look was measured over a parked lorry.
///
/// TWO ANGLES, not one, because the bullet says "the direction the truck
/// DRIVES" and that is not always the nose:
///
///   off-nose    camera forward against the hull's forward. This is what the
///               camera is built to hold: `ChaseCamera` settles behind
///               `target.eulerAngles.y` with `yawDamp` of lag.
///   off-travel  camera forward against the velocity vector. In reverse this
///               is 180 degrees BY DESIGN - the driver looks over the bonnet
///               while the truck backs up - so it is recorded and not
///               asserted. Turning the camera round in reverse is a decision,
///               not a fault to fix quietly.
///
/// Velocity is read the way `ChaseCamera.cs:380` reads it: the core when a
/// core is answering, the kinematic body only as its fallback. In the editor
/// `ArenaCore.Available` is false - the core is a stub outside a WebGL build -
/// so this measures the renderer's geometry with the PhysX velocity standing
/// in for the core's. The geometry does not branch on where the vector came
/// from; nothing here writes truck, army or core state.
/// </summary>
public class CameraNoseTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    /// <summary>
    /// THE BOUND IS NOT AN ANGLE I PICKED.
    ///
    /// The first cut of this asserted degrees off the nose and I had to invent
    /// the number - twelve, three times a13's slalom - which is exactly the
    /// tuning this letter is not allowed to do. The measurement then said the
    /// camera swings 25.3 degrees in a handbrake spin and 16.4 under an
    /// impact, and that BOTH are still on screen: the driving lens is 58
    /// degrees vertical, which at this aspect is about 44 degrees from the
    /// middle of the frame to its edge.
    ///
    /// So the bullet is asserted as what it says - the direction the truck
    /// drives is IN THE VIEW - by projecting a point down the road ahead into
    /// the camera and requiring it on screen. The margin is a tenth of the
    /// frame at each edge, so "on screen" does not mean "clinging to the
    /// border". Nothing here depends on a degree count staying where it is
    /// today; a change that swings the camera further is fine until it takes
    /// the road off the picture, which is the player-facing fact.
    /// </summary>
    const float Margin = 0.1f;

    /// <summary>Where "the road is in front of me again" is called.</summary>
    const float Back = 2f;

    /// <summary>
    /// Where the road ahead lands on the screen, across the frame: 0 is the
    /// left edge, 1 the right, and anything outside that is the driver not
    /// being shown where he is going. Negative depth - the point behind the
    /// camera - is reported as a hard miss rather than a wrapped number.
    /// </summary>
    float NoseOnScreen()
    {
        var cam = _chase.GetComponent<Camera>();
        var ahead = _truck.transform.position + _truck.transform.forward * 20f
                  + Vector3.up * 1.2f;
        var vp = cam.WorldToViewportPoint(ahead);
        return vp.z <= 0f ? -1f : vp.x;
    }

    /// <summary>
    /// The same point UP the frame: 0 is the bottom edge, 1 the top.
    ///
    /// Recorded because the horizontal place alone cannot see the one thing
    /// the strike tilt could plausibly break - pitching the view up pushes
    /// the road DOWN the picture, and a road that leaves under the bottom
    /// edge is as gone as one that leaves at the side.
    /// </summary>
    float NoseUpScreen()
    {
        var cam = _chase.GetComponent<Camera>();
        var ahead = _truck.transform.position + _truck.transform.forward * 20f
                  + Vector3.up * 1.2f;
        var vp = cam.WorldToViewportPoint(ahead);
        return vp.z <= 0f ? -1f : vp.y;
    }

    GameObject _boot;
    TruckController _truck;
    ChaseCamera _chase;
    Rigidbody _body;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return null;

        // Flat ground, for the reason CameraFeelTests gives: the terrain is
        // the live fee histogram, so the slope the truck spawns on decides how
        // fast it gets going and how hard it turns.
        var ground = Object.FindFirstObjectByType<MempoolTerrain>();
        if (ground != null)
        {
            ground.feeHeight = 0f;
            ground.baseRelief = 0f;
            ground.Build();
        }

        yield return new WaitForSeconds(1.5f);

        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();
        yield return null;

        var panel = Object.FindFirstObjectByType<LoadoutPanel>();
        panel.Auto();
        panel.Confirm();

        // The armies go, again for CameraFeelTests' reason: the solo bay is in
        // the middle of the post office, so a truck driven flat out for six
        // seconds gets shot, and a wrecked truck stops yawing.
        foreach (var army in Object.FindObjectsByType<ArmyRenderer>(FindObjectsSortMode.None))
            army.gameObject.SetActive(false);

        _truck = Object.FindFirstObjectByType<TruckController>();
        _chase = Object.FindFirstObjectByType<ChaseCamera>();
        _body = _truck.GetComponent<Rigidbody>();
        _chase.useExternalPointer = true;
        _chase.externalPointerHeld = false;
        _truck.useExternalInput = true;
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        Time.timeScale = 1f;
        if (_truck != null) _truck.useExternalInput = false;
        if (_chase != null) _chase.useExternalPointer = false;
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;

        // Put the scene back. Leaving an empty world behind is what turned
        // `PostOfficeTests.TheGogglesAnimate` red after the resting fixture:
        // green alone, red after a fixture that destroyed every root.
        UnityEngine.SceneManagement.SceneManager.LoadScene(
            0, UnityEngine.SceneManagement.LoadSceneMode.Single);
        yield return null;
    }

    /// <summary>
    /// The same vector `ChaseCamera` steers by, from the same place, so the
    /// probe cannot disagree with the thing it measures.
    /// </summary>
    Vector3 Velocity()
    {
        Vector3 v = Arena.ArenaCore.Available
                  ? Arena.ArenaCore.Velocity
                  : (_body != null ? _body.linearVelocity : Vector3.zero);
        v.y = 0f;
        return v;
    }

    static float Flat(Vector3 a, Vector3 b) =>
        Vector3.Angle(Vector3.ProjectOnPlane(a, Vector3.up),
                      Vector3.ProjectOnPlane(b, Vector3.up));

    float OffNose() => Flat(_chase.transform.forward, _truck.transform.forward);

    float OffTravel()
    {
        var v = Velocity();
        return v.magnitude < 1f ? 0f : Flat(_chase.transform.forward, v);
    }

    float Slip()
    {
        var v = Velocity();
        return v.magnitude < 1f ? 0f
             : Mathf.Abs(Mathf.DeltaAngle(Mathf.Atan2(v.x, v.z) * Mathf.Rad2Deg,
                                          _truck.transform.eulerAngles.y));
    }

    /// <summary>
    /// HOW FAR BACK IS FAR ENOUGH, and what it costs the truck.
    ///
    /// The pick was "pull back and frame both", so this walks the pull-back
    /// and reports the two things that decide it: how much of the cloud's
    /// life the road spends below the bottom edge, and how many pixels tall
    /// the truck still draws. A rung that saves the road by turning the truck
    /// into a speck is not a fix, and the number is here so that is not a
    /// matter of opinion.
    ///
    /// One fresh cloud per rung, because a cloud is gone after eight seconds,
    /// and a second and a half to let the position damp settle before the
    /// sampling starts - otherwise the rung measures the camera travelling
    /// rather than where it arrived.
    ///
    /// Explicit: a measurement, not an assertion.
    /// </summary>
    // THE TWO LADDER HARNESSES ARE GONE with the ladder they measured.
    // `MeasureTheRoadOnAPhoneShapedFrame` and `MeasureHowFarBackFramesBoth`
    // existed to pick a pull-back and a lift for the view to take while a
    // mushroom stands. The view does not move for a mushroom any more
    // (2026-09-07 07:39), so there is no rung to choose.

    /// <summary>
    /// THE CAP MUST BE FORGOTTEN WHEN THE THEATRE GOES.
    ///
    /// Found by the strike probe above, not looked for: its tilt showed up in
    /// the NEXT test's log, on a camera whose scene had been reloaded and
    /// whose cloud did not exist. `StrikeTheatre.CapCentre` is static and is
    /// only cleared where `Column` reaches `Gone`, so a theatre destroyed
    /// while a cloud stands - a restart, a scene change, a round ending on a
    /// strike - leaves the last cap's world position published forever, and
    /// every driving camera afterwards pitches up at nothing.
    /// </summary>
    [UnityTest]
    public IEnumerator TheCapIsForgottenWhenTheTheatreGoes()
    {
        var theatre = Object.FindFirstObjectByType<Arena.StrikeTheatre>();
        Assert.IsNotNull(theatre, "no StrikeTheatre");
        theatre.RaiseColumn(_truck.transform.position + _truck.transform.forward * 60f);
        for (int i = 0; i < 30; i++) { theatre.StepCloud(1f / 60f); yield return null; }
        Assert.IsTrue(Arena.StrikeTheatre.CapCentre.HasValue,
            "no cap stood, so there is nothing to leave behind");

        Object.DestroyImmediate(theatre.gameObject);
        yield return null;

        Assert.IsFalse(Arena.StrikeTheatre.CapCentre.HasValue,
            $"the theatre is gone and the cap is still published at "
            + $"{Arena.StrikeTheatre.CapCentre} - every camera after this tilts at a ghost");
    }

    /// <summary>Where a world point lands in the frame, or null behind the camera.</summary>
    Vector3? Frame(Vector3 world)
    {
        var vp = _chase.GetComponent<Camera>().WorldToViewportPoint(world);
        return vp.z <= 0f ? (Vector3?)null : vp;
    }

    /// <summary>
    /// How tall the truck draws, in pixels of a 3 m body. This is the price of
    /// pulling back and it has to be a number, not a feeling: "the truck is a
    /// speck" is a claim about pixels.
    /// </summary>
    float TruckPixels()
    {
        var cam = _chase.GetComponent<Camera>();
        var a = cam.WorldToScreenPoint(_truck.transform.position);
        var b = cam.WorldToScreenPoint(_truck.transform.position + Vector3.up * 3f);
        return a.z <= 0f ? 0f : Mathf.Abs(b.y - a.y);
    }

    /// <summary>How far above the horizontal the view is aimed.</summary>
    float Pitch()
    {
        var f = _chase.transform.forward;
        return Mathf.Atan2(f.y, new Vector2(f.x, f.z).magnitude) * Mathf.Rad2Deg;
    }

    /// <summary>Roll forward until the truck is actually moving.</summary>
    IEnumerator UpToSpeed(float seconds = 5f)
    {
        _truck.externalThrottle = 1f;
        _truck.externalSteer = 0f;
        _truck.externalHandbrake = false;

        // DRIVE UNTIL IT IS MOVING, not for a fixed count of seconds.
        //
        // Five seconds of throttle got the truck to 14.0 m/s alone and to 5.3
        // under load - the whole suite, a browser and two builds sharing the
        // machine - and the case guard then refused the case, correctly, as a
        // measurement of nothing. The guard is not the thing to relax: it is
        // the only reason a camera test on a stationary truck cannot pass. So
        // the fixture waits for the speed instead, and still gives up rather
        // than pretend.
        float began = Time.time;
        while (Time.time - began < seconds * 4f)
        {
            yield return null;
            if (Velocity().magnitude >= 12f) break;
        }
        yield return new WaitForSeconds(0.25f);
    }

    /// <summary>
    /// The worst of a window, sampled every frame, and the moment it settles.
    ///
    /// SETTLED IS THE LAST FRAME ABOVE THE THRESHOLD, not the first one under
    /// it. The first cut recorded the first frame under, which is frame one in
    /// every case - before the disturbance has even developed - and printed a
    /// confident 0.00 s for a camera that was about to swing 43 degrees.
    /// </summary>
    class Worst
    {
        public float OffNose, OffTravel, Slip, Speed;
        public float NoseLeft = 1f, NoseRight = 0f;
        public float LastAbove = -1f;
        public float Window;
        public float Settled => LastAbove < 0f ? 0f : LastAbove;
        public bool NeverSettled => LastAbove >= Window - 0.05f;
    }

    IEnumerator Sample(Worst w, float seconds)
    {
        // THE CLOCK CARRIES ON between calls. The spin-out samples twice - the
        // slide, then the settle - and with `began` restarting each time it
        // reported the camera back on the nose after 0.01 s while it was 25
        // degrees off.
        float began = Time.time, base_ = w.Window;
        while (Time.time - began < seconds)
        {
            yield return null;
            float t = base_ + (Time.time - began);
            float on = OffNose();
            w.OffNose = Mathf.Max(w.OffNose, on);
            w.OffTravel = Mathf.Max(w.OffTravel, OffTravel());
            w.Slip = Mathf.Max(w.Slip, Slip());
            w.Speed = Mathf.Max(w.Speed, Velocity().magnitude);
            float x = NoseOnScreen();
            w.NoseLeft = Mathf.Min(w.NoseLeft, x);
            w.NoseRight = Mathf.Max(w.NoseRight, x);
            if (on >= Back) w.LastAbove = t;
        }
        w.Window += seconds;
    }

    void Say(string what, Worst w)
    {
        Debug.Log($"[a14] {what}: worst off-nose {w.OffNose:F1} deg, off-travel "
                  + $"{w.OffTravel:F1}, slip {w.Slip:F1}, speed {w.Speed:F1} m/s, "
                  + $"road across the frame {w.NoseLeft:F2}..{w.NoseRight:F2}, "
                  + $"under {Back:F0} deg after {w.Settled:F2} s"
                  + (w.NeverSettled ? " - NEVER SETTLED in the window" : ""));
    }

    /// <summary>
    /// Guards the case itself. A camera test on a truck that never moved is
    /// green and worthless; the fourth case of the first cut was exactly that.
    /// </summary>
    void OnScreenThroughout(Worst w, string what)
    {
        Assert.GreaterOrEqual(w.NoseLeft, Margin,
            $"{what} took the road off the LEFT of the frame: it reached "
            + $"{w.NoseLeft:F2} across the picture, {w.OffNose:F1} degrees off the nose");
        Assert.LessOrEqual(w.NoseRight, 1f - Margin,
            $"{what} took the road off the RIGHT of the frame: it reached "
            + $"{w.NoseRight:F2} across the picture, {w.OffNose:F1} degrees off the nose");
    }

    void ItActuallyDrove(Worst w, float least = 6f) =>
        Assert.Greater(w.Speed, least,
            $"the truck only reached {w.Speed:F1} m/s, so this case measured nothing");

    // ---------------------------------------------------------------- 1 of 4

    [UnityTest]
    public IEnumerator ReversingKeepsTheNoseInTheView()
    {
        yield return UpToSpeed();
        var w = new Worst();
        _truck.externalThrottle = -1f;
        yield return Sample(w, 6f);
        Say("stop and reverse", w);
        ItActuallyDrove(w);

        OnScreenThroughout(w, "reversing");
    }

    // ---------------------------------------------------------------- 2 of 4

    [UnityTest]
    public IEnumerator ASpinOutDoesNotTakeTheRoadOffTheFrame()
    {
        yield return UpToSpeed();
        var w = new Worst();
        _truck.externalSteer = 1f;
        _truck.externalHandbrake = true;
        yield return Sample(w, 3f);
        _truck.externalHandbrake = false;
        _truck.externalSteer = 0f;
        yield return Sample(w, 2f);          // and the settle, where the lag shows
        Say("spin-out", w);
        ItActuallyDrove(w);
        Assert.Greater(w.Slip, 5f,
            $"only {w.Slip:F1} degrees of slip - that is not a spin-out to measure");

        OnScreenThroughout(w, "a spin-out");
    }

    // ---------------------------------------------------------------- 3 of 4

    [UnityTest]
    public IEnumerator AnImpactDoesNotLeaveTheNoseOffTheFrame()
    {
        yield return UpToSpeed();
        var w = new Worst();
        _chase.Shake(1.5f);
        yield return Sample(w, 2.5f);
        Say("impact throw", w);
        ItActuallyDrove(w);
        Assert.Less(_chase.ShakeAmount, 0.001f, "the throw had not decayed inside the window");

        OnScreenThroughout(w, "an impact");
    }

    // ---------------------------------------------------------------- 4 of 4

    [UnityTest]
    public IEnumerator TheViewComesBackToTheNoseAfterALook()
    {
        yield return UpToSpeed();

        var at = new Vector3(Screen.width * 0.5f, Screen.height * 0.6f, 0f);
        _chase.externalPointerAt = at;
        _chase.externalPointerHeld = true;
        yield return null;
        _chase.externalPointerAt = at + new Vector3(Screen.width * 0.25f, 0f, 0f);
        yield return null;
        float looked = _chase.OrbitYaw;
        Assert.Greater(Mathf.Abs(looked), 5f, "nothing to come back from");
        _chase.externalPointerHeld = false;

        // OFF THE THROTTLE, and this is not tidying the case up to make it
        // pass. The first cut held it flat out for eight and a half seconds
        // after the look was released; the truck covered 170 m of a 260 m map,
        // hit something and ended up travelling BACKWARDS - slip 174.8
        // degrees - and the probe then reported "the view never came back"
        // while the residual was the truck spinning, not the look. The look is
        // what this case is about, so the truck coasts while it returns.
        _truck.externalThrottle = 0.15f;

        var w = new Worst();
        yield return Sample(w, _chase.recentreAfter + 6f);
        Debug.Log($"[a14] the look itself was {looked:F1} deg of orbit yaw, "
                  + $"{_chase.OrbitYaw:F2} deg left at the end");
        Say("look released", w);
        ItActuallyDrove(w, 3f);
        Assert.Less(w.Slip, 20f,
            $"the truck slid {w.Slip:F1} degrees during the return, so this case is "
            + "measuring the driving and not the look coming back");

        // The swing itself is the DRIVER'S and it is allowed - he asked for
        // it, and the bullet says "unless the owner explicitly looks around". The
        // case is about whether it comes back, so the assert is on the return.

        // IN THE TOP-DOWN THE SWIPE HOLDS (2026-09-27, the 11:31 letter over the look-return ruling): after the
        // finger lifts, the dragged angle stays and the miner's mouth is not pulled back - here well past the 2.5 s the
        // look behind the truck waits. Behind the truck the look comes back to the nose, as before. Either way the road
        // stays on screen (below).
        if (_chase.View == ChaseCamera.Mode.Overhead)
        {
            Assert.AreEqual(looked, _chase.OrbitYaw, 0.5f,
                $"the top-down let go of the swipe: {_chase.OrbitYaw:F1} of {looked:F1} degrees {w.Window:F1} s after the finger came off");
            Assert.IsFalse(_chase.DestinationInFocus, "the miner was pulled back into frame after the swipe");
        }
        else
        {
            Assert.Less(Mathf.Abs(_chase.OrbitYaw), 0.5f,
                $"the view held {_chase.OrbitYaw:F1} degrees of the look "
                + $"{w.Window:F1} s after the finger came off");
            Assert.IsFalse(w.NeverSettled,
                $"the view never came back to the nose - still {OffNose():F1} degrees off "
                + $"{w.Window:F1} s after the look was released");
        }
        Assert.GreaterOrEqual(NoseOnScreen(), Margin, "the road is off the left of the frame");
        Assert.LessOrEqual(NoseOnScreen(), 1f - Margin, "the road is off the right of the frame");
    }

    // ------------------------------------------------------------ the strike

    /// <summary>
    /// A STRIKE DOES NOT TOUCH THE VIEW.
    ///
    /// The camera used to tilt up at the mushroom and stand further off to fit
    /// it in, and it was measured doing so. 2026-09-07 07:39: "when the
    /// atom bomb comes the camera is still ripped from his hands. That must
    /// not happen. View stays unchanged." So the rule is reversed and this is
    /// the test of the new one.
    ///
    /// It is a COMPARISON, not a bound: the same drive is run twice from the
    /// same pose, once with a cloud standing and once without, and the camera
    /// has to end up in the same place looking the same way. A tolerance
    /// rather than an equality because the truck is under PhysX and two runs
    /// do not tread identically; 0.25 m and 0.5 degrees is far below the
    /// 20 m pull-back and 26 degrees of tilt that were there before.
    /// </summary>
    [UnityTest]
    public IEnumerator AStrikeLeavesTheViewWhereThePlayerHadIt()
    {
        var theatre = Object.FindFirstObjectByType<Arena.StrikeTheatre>();
        Assert.IsNotNull(theatre, "no StrikeTheatre in the scene");

        // WITHOUT a cloud first, from a pose that is put back exactly.
        var pose = _truck.transform.position;
        var facing = _truck.transform.rotation;

        yield return Settle();
        var quietPos = _chase.transform.position;
        var quietAim = _chase.transform.rotation;

        // ...and now the same six seconds with a mushroom standing 45 m off
        // the road, which is where the old tilt was largest.
        _truck.transform.SetPositionAndRotation(pose, facing);
        theatre.RaiseColumn(pose + facing * Vector3.forward * 60f
                                 + facing * Vector3.right * 45f);

        int stood = 0;
        float worstMove = 0f, worstTurn = 0f;
        float from = Time.time;
        while (Time.time - from < 6f)
        {
            theatre.StepCloud(Time.deltaTime);
            yield return null;
            if (!Arena.StrikeTheatre.CapCentre.HasValue) continue;
            stood++;
            worstMove = Mathf.Max(worstMove,
                Vector3.Distance(_chase.transform.position, quietPos));
            worstTurn = Mathf.Max(worstTurn,
                Quaternion.Angle(_chase.transform.rotation, quietAim));
        }

        Debug.Log($"[a14] strike: cap stood {stood} frames, the view moved at most "
                  + $"{worstMove:F2} m and turned at most {worstTurn:F2} deg");

        Assert.Greater(stood, 0, "no cloud ever stood, so nothing here is a measurement");
        Assert.Less(worstMove, 0.25f,
            $"the strike moved the camera {worstMove:F2} m - the view is the player's");
        Assert.Less(worstTurn, 0.5f,
            $"the strike turned the camera {worstTurn:F2} deg - the view is the player's");
    }

    /// <summary>Holds the truck still and lets the camera come to rest on it.</summary>
    System.Collections.IEnumerator Settle()
    {
        float from = Time.time;
        while (Time.time - from < 6f) yield return null;
    }
}
