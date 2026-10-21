// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Text;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// Measures how the ORIGINAL PhysX truck drives, so the deterministic core can
/// be matched to it rather than to a textbook.
///
/// The core's first steering model was derived from the bicycle equation and
/// was, in the strict sense, correct - and it destroyed the feel, because feel
/// was never a bicycle model. It came out of WheelCollider, tyre slip and a
/// tuned lock curve. So the reference is the thing itself: drive the PhysX
/// truck with scripted inputs, record what it does, and hold the core to that.
///
/// This does not assert. It prints a table, which is then read into
/// packages/nextblock as a fixture.
/// </summary>
public class PhysxReferenceTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    GameObject _boot;
    TruckController _truck;
    Rigidbody _rb;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        Arena.PracticeMode.On = true;               // nothing may shoot the subject
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);

        _truck = Object.FindFirstObjectByType<TruckController>();
        Assert.IsNotNull(_truck, "kein Truck");

        // PhysX drives, not the core - this is the reference, not the copy.
        var core = _truck.GetComponent<Arena.CoreDrivenTruck>();
        if (core != null) { core.enabled = false; _truck.externallyDriven = false; }

        _rb = _truck.GetComponent<Rigidbody>();
        _rb.isKinematic = false;
        _truck.useExternalInput = true;
        _truck.controlsLocked = false;

        // Everything that can interrupt a measurement gets switched off. The
        // first run drove into the battle, was written off, respawned, and the
        // bay reopened and locked the controls - so the table read 27 m/s and
        // then thirty seconds of zero.
        var loadout = Object.FindFirstObjectByType<LoadoutPanel>();
        if (loadout != null) { loadout.Auto(); loadout.Confirm(); loadout.enabled = false; }

        var health = Object.FindFirstObjectByType<TruckHealth>();
        if (health != null) health.enabled = false;

        foreach (var f in Object.FindObjectsByType<Battlefield>(FindObjectsSortMode.None))
            f.enabled = false;
        yield return new WaitForSeconds(0.5f);
    }

    [TearDown] public void TearDown() { if (_boot != null) Object.Destroy(_boot); }

    void Drive(float throttle, float steer)
    {
        // Re-cleared every call: the bay re-locks the controls whenever it
        // thinks the truck is empty, and a locked truck measures as a truck
        // that cannot accelerate.
        _truck.controlsLocked = false;
        _truck.condition = 1f;
        _truck.externalThrottle = throttle;
        _truck.externalSteer = steer;
        _truck.externalHandbrake = false;
    }

    /// <summary>Puts the truck back on flat open ground, pointing down the map.</summary>
    IEnumerator Reset()
    {
        Drive(0f, 0f);
        _rb.linearVelocity = Vector3.zero;
        _rb.angularVelocity = Vector3.zero;

        // The empty western end of the map, pointing up the long axis: nothing
        // to hit for 200 m, which a turning circle needs.
        var terrain = Object.FindFirstObjectByType<MempoolTerrain>();
        float y = terrain != null ? terrain.SampleSurface(-150f, -110f) : 0f;
        _rb.position = new Vector3(-150f, y + 1.5f, -110f);
        _rb.rotation = Quaternion.Euler(0f, 0f, 0f);
        yield return new WaitForSeconds(1.5f);
    }

    /// <summary>Lets the truck fall onto the ground and stop bouncing.</summary>
    IEnumerator Settle()
    {
        for (float w = 0f; w < 3f; w += Time.deltaTime)
        {
            Drive(0f, 0f);
            yield return null;
            if (w > 1f && _rb.linearVelocity.magnitude < 0.3f) break;
        }
    }

    [UnityTest]
    [Explicit("Measurement, not an assertion: it drives for two minutes and " +
              "prints a table. Run it deliberately when the PhysX truck's " +
              "tuning changes, then paste the PHYSXREF lines into " +
              "packages/nextblock/test/vectors/physx-reference.json.")]
    public IEnumerator MeasureThePhysxTruck()
    {
        var sb = new StringBuilder();
        sb.AppendLine("PHYSXREF BEGIN");

        // --- straight line ---
        yield return Reset();
        yield return Settle();
        float t = 0f;
        for (int i = 0; i < 16; i++)
        {
            float target = t + 1f;
            while (t < target) { t += Time.deltaTime; Drive(1f, 0f); yield return null; }
            sb.AppendLine($"PHYSXREF accel {t:0.0} {_rb.linearVelocity.magnitude:0.000}");
        }

        // --- steady turns ---
        foreach (float steer in new[] { 0.25f, 0.5f, 1.0f })
        {
            yield return Reset();
            yield return Settle();
            for (float w = 0f; w < 8f; w += Time.deltaTime) { Drive(1f, 0f); yield return null; }
            for (float w = 0f; w < 5f; w += Time.deltaTime) { Drive(1f, steer); yield return null; }

            float prev = _truck.transform.eulerAngles.y, turned = 0f, dur = 0f;
            float vsum = 0f, slipsum = 0f, steersum = 0f; int n = 0;
            while (dur < 5f)
            {
                Drive(1f, steer);
                yield return null;
                dur += Time.deltaTime;
                float y = _truck.transform.eulerAngles.y;
                turned += Mathf.DeltaAngle(prev, y); prev = y;

                var vel = _rb.linearVelocity; vel.y = 0f;
                vsum += vel.magnitude;
                if (vel.magnitude > 1f)
                    slipsum += Vector3.SignedAngle(_truck.transform.forward, vel, Vector3.up);
                steersum += _truck.SteerAngle;
                n++;
            }
            float v = vsum / n, yaw = turned / dur;
            float radius = Mathf.Abs(yaw) > 0.01f ? v / (Mathf.Abs(yaw) * Mathf.Deg2Rad) : 9999f;
            sb.AppendLine($"PHYSXREF turn {steer:0.00} v={v:0.00} yaw={yaw:0.00} radius={radius:0.0} " +
                          $"slip={slipsum / n:0.00} steer={steersum / n:0.00}");
        }

        // --- how quickly the yaw builds when the wheel goes over ---
        yield return Reset();
        yield return Settle();
        for (float w = 0f; w < 8f; w += Time.deltaTime) { Drive(1f, 0f); yield return null; }
        float p2 = _truck.transform.eulerAngles.y, acc = 0f, el = 0f, mark = 0.25f;
        float vEntry = _rb.linearVelocity.magnitude;
        sb.AppendLine($"PHYSXREF transient entry v={vEntry:0.00}");
        while (el < 3f)
        {
            Drive(1f, 1f);
            yield return null;
            el += Time.deltaTime;
            float y = _truck.transform.eulerAngles.y;
            acc += Mathf.DeltaAngle(p2, y); p2 = y;
            if (el >= mark)
            {
                sb.AppendLine($"PHYSXREF transient {el:0.00} turned={acc:0.0} " +
                              $"steer={_truck.SteerAngle:0.0} v={_rb.linearVelocity.magnitude:0.00}");
                mark += 0.25f;
            }
        }

        sb.AppendLine("PHYSXREF END");
        Debug.Log(sb.ToString());
        yield return null;
    }

    /// <summary>
    /// What a hill does to the truck.
    ///
    /// The core is flat: it has the mempool relief ported but never reads it,
    /// so a climb costs nothing and a descent gives nothing back. This records
    /// what PhysX actually does, sampling the gradient under the truck against
    /// the acceleration it produced, so the core can be given the same law.
    /// </summary>
    [UnityTest]
    [Explicit("Measurement, not an assertion. See MeasureThePhysxTruck.")]
    public IEnumerator MeasureThePhysxHills()
    {
        var terrain = Object.FindFirstObjectByType<MempoolTerrain>();
        Assert.IsNotNull(terrain, "kein Terrain");

        var sb = new StringBuilder();
        sb.AppendLine("PHYSXHILL BEGIN");

        // One straight crossing of the map, recorded as the height under the
        // truck against the speed it was doing. That pairing is the whole
        // reference: replay the same relief and the same throttle in the core
        // and the two speed traces have to lie on top of each other.
        const float lane = -20f;

        // The same crossing is driven TWICE: once over the map's own relief,
        // and once with the relief switched off.
        //
        // The pair is the point. Comparing a hilly PhysX run against a hilly
        // core run measures the hill response and every other difference at
        // once, and the core is a little quick off the mark - so the bias from
        // that leaked into the hill number and made it unreadable. With a flat
        // control on both sides the hill response can be isolated: what the
        // relief did to Unity, against what it did to the core.
        for (int pass = 0; pass < 2; pass++)
        {
            bool flat = pass == 1;
            if (flat) { terrain.feeHeight = 0f; terrain.baseRelief = 0f; terrain.Build(); }
            yield return new WaitForSeconds(0.5f);
            sb.AppendLine(flat ? "PHYSXHILL PASS flat" : "PHYSXHILL PASS relief");
            yield return Crossing(terrain, lane, sb);
        }

        sb.AppendLine("PHYSXHILL END");
        Debug.Log(sb.ToString());
        yield return null;
    }

    /// <summary>One full-throttle crossing of the map, recorded.</summary>
    IEnumerator Crossing(MempoolTerrain terrain, float lane, StringBuilder sb)
    {
        Drive(0f, 0f);
        _rb.linearVelocity = Vector3.zero;
        _rb.angularVelocity = Vector3.zero;
        _rb.position = new Vector3(-120f, terrain.SampleSurface(-120f, lane) + 1.5f, lane);
        _rb.rotation = Quaternion.Euler(0f, 90f, 0f);          // straight up +X
        yield return Settle();

        // The relief along the line, sampled every metre, so the core can be
        // given exactly the ground PhysX drove over.
        var prof = new StringBuilder();
        for (int x = -125; x <= 125; x++)
            prof.Append(terrain.SampleSurface(x, lane).ToString("0.000")).Append(' ');
        sb.AppendLine("PHYSXHILL profile " + prof.ToString().Trim());
        sb.AppendLine($"PHYSXHILL lane {lane} startx -120");

        float el = 0f, mark = 0.25f;
        while (el < 20f && _rb.position.x < 120f)
        {
            Drive(1f, 0f);
            yield return null;
            el += Time.deltaTime;
            if (el < mark) continue;
            mark += 0.25f;

            int down = 0;
            foreach (var a in _truck.axles)
            {
                if (a == null) continue;
                if (a.left != null && a.left.isGrounded) down++;
                if (a.right != null && a.right.isGrounded) down++;
            }
            sb.AppendLine($"PHYSXHILL t={el:0.00} x={_rb.position.x:0.000} " +
                          $"v={_rb.linearVelocity.magnitude:0.000} grounded={down}");
        }

        yield return null;
    }

    /// <summary>
    /// Where a wall stops the PhysX truck.
    ///
    /// The core has to put it in the same place. This drives full throttle at
    /// the post office frontage and records the gap left between the truck's
    /// nose and the face of the wall it hit - which is the number the core's
    /// own collision has to reproduce.
    /// </summary>
    [UnityTest]
    [Explicit("Measurement, not an assertion. See MeasureThePhysxTruck.")]
    public IEnumerator MeasureThePhysxWall()
    {
        var sb = new StringBuilder();
        sb.AppendLine("PHYSXWALL BEGIN");

        // The frontage: every static box the world is made of, as the core
        // will see it.
        var boxes = Arena.WorldSolids.Gather(_truck.transform, out int n);
        sb.AppendLine($"PHYSXWALL solids {n}");

        // Find the nearest wall face straight down +X from the spawn, which is
        // the post office frontage the truck is parked against.
        var post = Object.FindFirstObjectByType<PostOffice>();
        Assert.IsNotNull(post, "kein Post Office");

        float lane = post.BayPosition.z;
        float bestFace = float.NegativeInfinity;
        for (int i = 0; i < n; i++)
        {
            float cx = boxes[i * 6] / 65536f, cz = boxes[i * 6 + 1] / 65536f;
            float hx = boxes[i * 6 + 2] / 65536f, hz = boxes[i * 6 + 3] / 65536f;
            float yLow = boxes[i * 6 + 4] / 65536f;
            if (Mathf.Abs(cz - lane) > hz) continue;        // not in this lane
            if (yLow > post.BayPosition.y + 2f) continue;   // a lintel, not a wall
            if (cx + hx > post.BayPosition.x) continue;     // behind the truck
            bestFace = Mathf.Max(bestFace, cx + hx);
        }
        sb.AppendLine($"PHYSXWALL face {bestFace:0.000} lane {lane:0.00}");

        // Reverse into it: the wall is BEHIND the truck on the apron.
        Drive(0f, 0f);
        _rb.linearVelocity = Vector3.zero;
        _rb.position = post.BayPosition;
        _rb.rotation = Quaternion.Euler(0f, 90f, 0f);
        yield return Settle();

        float el = 0f;
        while (el < 8f) { Drive(-1f, 0f); yield return null; el += Time.deltaTime; }

        float rear = _rb.position.x - 3.2f;               // the tail of a 6.4 m chassis
        sb.AppendLine($"PHYSXWALL rest x={_rb.position.x:0.000} rear={rear:0.000} " +
                      $"gap={(rear - bestFace):0.000} v={_rb.linearVelocity.magnitude:0.00}");
        sb.AppendLine("PHYSXWALL END");
        Debug.Log(sb.ToString());
        yield return null;
    }
}
