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
/// `BlwpCore.Available` is false - the core is a stub outside a WebGL build -
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
        // `PostOfficeTests.TheGogglesAnimate` red after the seating fixture:
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
        Vector3 v = Blwp.BlwpCore.Available
                  ? Blwp.BlwpCore.Velocity
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
    /// <summary>
    /// AND ON A PHONE-SHAPED FRAME, which is the shape that matters.
    ///
    /// The batchmode frame is 640x480 - four by three - and a phone in
    /// landscape is about 2.16 to 1: much shorter for its width. The thing
    /// just fixed is a VERTICAL fit, and a shorter frame is the unkind case
    /// for it, so twenty metres being enough at 4:3 says nothing about the
    /// screen the game is played on. The camera's aspect is forced here and
    /// the same reading taken.
    /// </summary>
    [UnityTest]
    [Explicit("Measurement, not an assertion. Read the [aspect] lines.")]
    public IEnumerator MeasureTheRoadOnAPhoneShapedFrame()
    {
        yield return UpToSpeed(3f);
        _truck.externalThrottle = 0f;
        yield return new WaitForSeconds(1f);
        var theatre = Object.FindFirstObjectByType<Blwp.StrikeTheatre>();
        var cam = _chase.GetComponent<Camera>();

        foreach (float aspect in new[] { 4f / 3f, 16f / 9f, 844f / 390f })
        {
            cam.aspect = aspect;
            theatre.RaiseColumn(_truck.transform.position
                                + _truck.transform.forward * 60f
                                + _truck.transform.right * 45f);
            float settle = Time.time;
            while (Time.time - settle < 1.5f) { theatre.StepCloud(Time.deltaTime); yield return null; }

            int frames = 0, offBottom = 0, capOff = 0;
            float lowRoad = 1f, lowCap = 1f, highCap = 0f;
            float from = Time.time;
            while (Time.time - from < 2f)
            {
                theatre.StepCloud(Time.deltaTime);
                yield return null;
                var cap = Blwp.StrikeTheatre.CapCentre;
                if (!cap.HasValue) continue;
                frames++;
                float ry = NoseUpScreen();
                lowRoad = Mathf.Min(lowRoad, ry);
                if (ry < 0f) offBottom++;
                var cf = Frame(cap.Value);
                if (cf.HasValue) { lowCap = Mathf.Min(lowCap, cf.Value.y); highCap = Mathf.Max(highCap, cf.Value.y); if (cf.Value.y > 1f) capOff++; }
                else capOff++;
            }
            Debug.Log($"[aspect] {aspect:F2}:1 - road lowest {lowRoad:F2}, below the edge "
                      + $"{offBottom}/{frames}, cap {lowCap:F2}..{highCap:F2}, off the top "
                      + $"{capOff}, pull-back {_chase.cloudPullBack:F0} m");
        }
        cam.ResetAspect();
    }

    [UnityTest]
    [Explicit("Measurement, not an assertion. Read the [ladder] lines.")]
    public IEnumerator MeasureHowFarBackFramesBoth()
    {
        yield return UpToSpeed(3f);
        _truck.externalThrottle = 0f;
        yield return new WaitForSeconds(1f);
        var theatre = Object.FindFirstObjectByType<Blwp.StrikeTheatre>();
        Assert.IsNotNull(theatre);

        foreach (var rung in new[] { (0f, 0f), (10f, 0f), (20f, 0f), (30f, 0f),
                                     (45f, 0f), (60f, 0f), (20f, 6f), (30f, 8f) })
        {
            _chase.cloudPullBack = rung.Item1;
            _chase.cloudLift = rung.Item2;
            theatre.RaiseColumn(_truck.transform.position
                                + _truck.transform.forward * 60f
                                + _truck.transform.right * 45f);

            float settle = Time.time;
            // ON THE REAL CLOCK. The first cut stepped the cloud with dt 0 to
            // "hold it at full height" and held it at NO height instead: the
            // cap never grew, the tilt never engaged, and every rung reported
            // a road at 0.47 and an aim of -3.8 degrees - a strike that had
            // not happened. Rise is 3 s and Gone is 8, so a fresh column and
            // 3.5 s of stepping is a cloud at full height with life to spare.
            while (Time.time - settle < 1.5f) { theatre.StepCloud(Time.deltaTime); yield return null; }

            int frames = 0, offBottom = 0, capOff = 0;
            float lowRoad = 1f, lowCap = 1f, highCap = 0f, px = 99999f;
            float from = Time.time;
            while (Time.time - from < 2f)
            {
                theatre.StepCloud(Time.deltaTime);
                yield return null;
                var cap = Blwp.StrikeTheatre.CapCentre;
                if (!cap.HasValue) continue;
                frames++;
                float ry = NoseUpScreen();
                lowRoad = Mathf.Min(lowRoad, ry);
                if (ry < 0f) offBottom++;
                var cf = Frame(cap.Value);
                if (cf.HasValue) { lowCap = Mathf.Min(lowCap, cf.Value.y); highCap = Mathf.Max(highCap, cf.Value.y); if (cf.Value.y > 1f) capOff++; }
                else capOff++;
                px = Mathf.Min(px, TruckPixels());
            }
            Debug.Log($"[ladder] pull-back {rung.Item1:F0} m lift {rung.Item2:F0} m: road "
                      + $"lowest {lowRoad:F2}, below the edge {offBottom}/{frames}, cap "
                      + $"{lowCap:F2}..{highCap:F2}, cap off the top {capOff}, truck "
                      + $"{px:F0} px, aim {Pitch():F1} deg");
        }
        _chase.cloudPullBack = 0f; _chase.cloudLift = 0f;
    }

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
        var theatre = Object.FindFirstObjectByType<Blwp.StrikeTheatre>();
        Assert.IsNotNull(theatre, "no StrikeTheatre");
        theatre.RaiseColumn(_truck.transform.position + _truck.transform.forward * 60f);
        for (int i = 0; i < 30; i++) { theatre.StepCloud(1f / 60f); yield return null; }
        Assert.IsTrue(Blwp.StrikeTheatre.CapCentre.HasValue,
            "no cap stood, so there is nothing to leave behind");

        Object.DestroyImmediate(theatre.gameObject);
        yield return null;

        Assert.IsFalse(Blwp.StrikeTheatre.CapCentre.HasValue,
            $"the theatre is gone and the cap is still published at "
            + $"{Blwp.StrikeTheatre.CapCentre} - every camera after this tilts at a ghost");
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
        yield return new WaitForSeconds(seconds);
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
        Assert.Less(Mathf.Abs(_chase.OrbitYaw), 0.5f,
            $"the view held {_chase.OrbitYaw:F1} degrees of the look "
            + $"{w.Window:F1} s after the finger came off");
        Assert.IsFalse(w.NeverSettled,
            $"the view never came back to the nose - still {OffNose():F1} degrees off "
            + $"{w.Window:F1} s after the look was released");
        Assert.GreaterOrEqual(NoseOnScreen(), Margin, "the road is off the left of the frame");
        Assert.LessOrEqual(NoseOnScreen(), 1f - Margin, "the road is off the right of the frame");
    }

    // ------------------------------------------------------------ the strike

    /// <summary>
    /// M1.a14 bullet 2, measured rather than argued: WHEN THE BOMB FALLS THE
    /// VIEW MUST NOT SNAP TO IT.
    ///
    /// The only thing that moves the view during a strike is the cloud tilt at
    /// `ChaseCamera.cs:468`, and it changes PITCH alone - it re-aims at the
    /// same distance and never touches `_yaw`. So a reparent or a look-at the
    /// bomb would show up here as yaw moving, and an ease shows up as small,
    /// even pitch steps under the 26-degree clamp. Both are asserted, so if
    /// anyone ever does point the camera at the bomb, this goes red.
    /// </summary>
    [UnityTest]
    public IEnumerator AStrikeTiltsTheViewAndDoesNotSwingIt()
    {
        yield return UpToSpeed(3f);
        _truck.externalThrottle = 0f;
        yield return new WaitForSeconds(1f);

        var theatre = Object.FindFirstObjectByType<Blwp.StrikeTheatre>();
        Assert.IsNotNull(theatre, "no StrikeTheatre - this would measure nothing");

        // OFF TO ONE SIDE, and this is the whole fixture. The first cut put the
        // cloud 60 m dead ahead, and a mutant that aimed the camera AT the
        // cloud - yaw and all, the snap this test exists to forbid - passed it,
        // because pointing at something straight in front of you needs no yaw.
        // Forty-five metres to the right of the road makes the difference
        // between a tilt and a swing visible.
        theatre.RaiseColumn(_truck.transform.position
                            + _truck.transform.forward * 60f
                            + _truck.transform.right * 45f);

        float worstPitch = 0f, worstPitchStep = 0f, worstYawStep = 0f, worstNose = 0f;
        float worstRoadLeft = 1f, worstRoadRight = 0f, worstPitchRate = 0f;
        float roadLowest = 1f, roadHighest = 0f;
        float capLowest = 1f, capHighest = 0f;
        float truckPxLeast = 99999f;
        int frames = 0, offTheBottom = 0, capOffTheTop = 0;
        float lastPitch = Pitch(), lastYaw = _chase.transform.eulerAngles.y;
        int stood = 0;
        float from = Time.time;
        while (Time.time - from < 6f)
        {
            theatre.StepCloud(Time.deltaTime);
            yield return null;
            var cap = Blwp.StrikeTheatre.CapCentre;
            if (!cap.HasValue) continue;
            stood++;
            float p = Pitch(), y = _chase.transform.eulerAngles.y;
            worstPitch = Mathf.Max(worstPitch, p);
            worstPitchStep = Mathf.Max(worstPitchStep, Mathf.Abs(p - lastPitch));
            if (Time.deltaTime > 0.0001f)
                worstPitchRate = Mathf.Max(worstPitchRate,
                                           Mathf.Abs(p - lastPitch) / Time.deltaTime);
            worstYawStep = Mathf.Max(worstYawStep, Mathf.Abs(Mathf.DeltaAngle(lastYaw, y)));
            worstNose = Mathf.Max(worstNose, OffNose());

            float rx = NoseOnScreen(), ry = NoseUpScreen();
            worstRoadLeft = Mathf.Min(worstRoadLeft, rx);
            worstRoadRight = Mathf.Max(worstRoadRight, rx);
            roadLowest = Mathf.Min(roadLowest, ry);
            roadHighest = Mathf.Max(roadHighest, ry);
            frames++;
            if (ry < 0f) offTheBottom++;

            // THE CAP HAS TO STAY A MUSHROOM. Pulling back to save the road is
            // only a fix if the head is still in the picture at the end of it.
            var cf = Frame(cap.Value);
            if (cf.HasValue)
            {
                capLowest = Mathf.Min(capLowest, cf.Value.y);
                capHighest = Mathf.Max(capHighest, cf.Value.y);
                if (cf.Value.y > 1f) capOffTheTop++;
            }
            else capOffTheTop++;

            truckPxLeast = Mathf.Min(truckPxLeast, TruckPixels());
            lastPitch = p; lastYaw = y;
        }
        Debug.Log($"[a14] strike: cap stood {stood} frames, view pitch up to {worstPitch:F1} deg "
                  + $"of a {_chase.cloudLookUp:F0} deg clamp, worst pitch step "
                  + $"{worstPitchStep:F2} deg/frame ({worstPitchRate:F1} deg/s), worst yaw "
                  + $"step {worstYawStep:F2} deg/frame, worst off-nose {worstNose:F1} deg, "
                  + $"road across the frame {worstRoadLeft:F2}..{worstRoadRight:F2}, up the "
                  + $"frame {roadLowest:F2}..{roadHighest:F2}, off the bottom for "
                  + $"{offTheBottom} of {frames} frames "
                  + $"({(frames > 0 ? 100f * offTheBottom / frames : 0f):F1}%), cap up the "
                  + $"frame {capLowest:F2}..{capHighest:F2}, cap off the top for "
                  + $"{capOffTheTop} frames, truck at least {truckPxLeast:F0} px tall, "
                  + $"pull-back {_chase.cloudPullBack:F0} m, lift {_chase.cloudLift:F0} m, "
                  + $"frame {Screen.width}x{Screen.height}");

        Assert.Greater(stood, 0, "no cloud ever stood, so nothing here is a measurement");

        // THE HARD FLOOR: the road stays in the picture for the WHOLE cloud.
        //
        // Not a bound I chose - it is the requirement in its own words, and it
        // is the one this letter closed bullet 1 without checking. Before the
        // pull-back the road was under the bottom edge for 1250 of 1304 frames
        // of a standing cloud; the measured ladder is in TASKBOOK.
        Assert.AreEqual(0, offTheBottom,
            $"the road was below the bottom of the frame for {offTheBottom} of {frames} "
            + $"frames while a cloud stood - lowest {roadLowest:F2} up the picture");

        // AND THE CAP IS STILL A MUSHROOM. Saving the road by cropping the
        // head would be the same trade in the other direction.
        Assert.AreEqual(0, capOffTheTop,
            $"the cap left the top of the frame for {capOffTheTop} frames - it ran "
            + $"{capLowest:F2}..{capHighest:F2} up the picture");
        Assert.Greater(worstPitch, 1f,
            "the view never tilted at all, so this measured nothing about the tilt");
        Assert.Less(worstYawStep, 1f,
            $"the view swung {worstYawStep:F2} degrees of yaw in a frame during a strike - "
            + "the camera is being pointed at the bomb");
        Assert.GreaterOrEqual(worstRoadLeft, Margin,
            $"a strike took the road to {worstRoadLeft:F2} across the frame, "
            + $"{worstNose:F1} degrees off the nose");
        Assert.LessOrEqual(worstRoadRight, 1f - Margin,
            $"a strike took the road to {worstRoadRight:F2} across the frame, "
            + $"{worstNose:F1} degrees off the nose");
        Assert.LessOrEqual(worstPitch, _chase.cloudLookUp + 0.5f,
            $"the view tilted {worstPitch:F1} degrees up, past its own clamp");
    }
}
