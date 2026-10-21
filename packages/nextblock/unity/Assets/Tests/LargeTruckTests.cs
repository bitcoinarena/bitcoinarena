// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Collections.Generic;
using System.IO;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// THE LARGER TRUCK, AS DRAWN: when the core drives the larger truck's bed (255590 = 3.9 m, 1.3 x the standard
/// 196608), the bay is 3.9 m from the same front, 30 % more crates fit, and the body is 0.9 m longer with the cab where it was;
/// back to the standard truck, all of it is as before. The core's answer is stood in for by ArenaCore.TruckBedOverride (the editor
/// has no core). Each state is rendered from the side into ARENA_SHOT_DIR when that is set.
/// </summary>
public class LargeTruckTests
{
    [TearDown] public void ClearTheWorld() { Arena.ArenaCore.TruckBedOverride = 0; LargeTruckView.MorphInEditor = false; LargeTruckView.CoreInEditor = false; TestWorld.TearDown(); }
    [SetUp] public void PracticeOff() => Arena.PracticeMode.On = false;

    const int LargeBedQ16 = 255590;   // frozen/f0cc7b7b/items.js LARGE_TRUCK.bedLength

    GameObject _boot;
    CargoBay _bay;
    LargeTruckView _view;
    Transform _truck;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);
        var splash0 = Object.FindFirstObjectByType<SplashScreen>();
        if (splash0 != null && splash0.Showing) splash0.Play();
        yield return null;
        _bay = Object.FindFirstObjectByType<CargoBay>();
        _view = Object.FindFirstObjectByType<LargeTruckView>();
        _truck = _bay.transform;
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        Time.timeScale = 1f;
        if (_boot != null) Object.Destroy(_boot);
        yield return null;
    }

    static MempoolFeed.Tx Small(int i) => new MempoolFeed.Tx { txid = $"{i:x8}aaaaaaaabbbbbbbbccccccccdddddddd", feeSats = 300, vsize = 200, valueSats = 1_000_000 };

    /// <summary>How many 0.55 m crates the bed takes, from empty.</summary>
    int CratesThatFit()
    {
        _bay.Clear();
        int n = 0;
        for (int i = 0; i < 60; i++) { if (!_bay.TryAdd(Small(i))) break; n++; }
        return n;
    }

    /// <summary>The body's extent along the truck, in the truck's own frame: (rear z, front z).</summary>
    (float rear, float front) BodySpan()
    {
        float lo = float.MaxValue, hi = float.MinValue;
        var body = _truck.Find("Body") ?? _truck.Find("BodyProxy");
        foreach (var mf in body.GetComponentsInChildren<MeshFilter>(true))
        {
            if (mf.sharedMesh == null) continue;
            Assert.IsTrue(mf.sharedMesh.isReadable, $"the truck's mesh {mf.sharedMesh.name} is readable, so its bed can be drawn longer");
            var m = _truck.worldToLocalMatrix * mf.transform.localToWorldMatrix;
            foreach (var v in mf.sharedMesh.vertices) { float z = m.MultiplyPoint3x4(v).z; lo = Mathf.Min(lo, z); hi = Mathf.Max(hi, z); }
        }
        return (lo, hi);
    }

    /// <summary>True when any material of the body carries a property block (the morph's glow).</summary>
    bool BodyTinted()
    {
        var block = new MaterialPropertyBlock();
        foreach (var r in (_truck.Find("Body") ?? _truck.Find("BodyProxy")).GetComponentsInChildren<Renderer>(true))
            for (int i = 0; i < r.sharedMaterials.Length; i++) { r.GetPropertyBlock(block, i); if (!block.isEmpty) return true; }
        return false;
    }

    void Shot(string name)
    {
        string dir = System.Environment.GetEnvironmentVariable("ARENA_SHOT_DIR");
        if (string.IsNullOrEmpty(dir)) return;
        // ONLY THE TRUCK AND THE GROUND: whatever stands around it (the loading bay's frame) is hidden for the picture and shown again
        var hidden = new List<Renderer>();
        var at = _truck.position;
        foreach (var r in Object.FindObjectsByType<Renderer>(FindObjectsSortMode.None))
        {
            if (r == null || !r.enabled) continue;
            string n = r.transform.name.ToLowerInvariant();
            if (n.Contains("wheel") || n.Contains("tire") || n.Contains("tyre")) continue;      // the model's wheels left the body
            // the stand-in box, when the model has streamed in beside it in the editor, would hide the model
            bool proxy = r.transform.name == "BodyProxy" && _truck.Find("Body") != null;
            if (r.transform.IsChildOf(_truck) && !proxy) continue;
            var b = r.bounds;
            if (b.size.x > 60f || b.size.z > 60f) continue;                          // the ground and the terrain stay
            var c = b.center; c.y = at.y;
            if (proxy || ((c - at).magnitude < 9f && b.max.y > at.y + 0.3f)) { r.enabled = false; hidden.Add(r); }
        }
        var go = new GameObject("ShotCam");
        var cam = go.AddComponent<Camera>();
        cam.fieldOfView = 32f;
        var centre = _truck.TransformPoint(new Vector3(0f, 1.0f, -0.6f));
        go.transform.position = centre + _truck.right * 13f + Vector3.up * 3.2f;
        go.transform.LookAt(centre);
        var rt = new RenderTexture(1280, 720, 24);
        cam.targetTexture = rt;
        cam.Render();
        RenderTexture.active = rt;
        var tex = new Texture2D(1280, 720, TextureFormat.RGB24, false);
        tex.ReadPixels(new Rect(0, 0, 1280, 720), 0, 0);
        tex.Apply();
        RenderTexture.active = null;
        Directory.CreateDirectory(dir);
        File.WriteAllBytes(Path.Combine(dir, name + ".png"), tex.EncodeToPNG());
        cam.targetTexture = null;
        Object.Destroy(rt); Object.Destroy(tex); Object.Destroy(go);
        foreach (var r in hidden) if (r != null) r.enabled = true;
        Debug.Log($"[LargeTruckTests] shot {name}: {hidden.Count} renderer(s) around the truck hidden for it");
    }

    [UnityTest]
    public IEnumerator TheLargerTruckIsDrawnAtTheCoresBedAndBackAgain()
    {
        Assert.IsNotNull(_view, "the truck carries no LargeTruckView");
        // THE STANDARD TRUCK
        Arena.ArenaCore.TruckBedOverride = 0;
        yield return null;
        float front0 = _bay.bedFloor.z + _bay.bedLength * 0.5f;
        Assert.AreEqual(3.0f, _bay.bedLength, 1e-4f);
        var span0 = BodySpan();
        int fit0 = CratesThatFit();
        Shot("truck-standard");

        // THE LARGER TRUCK: the core drives a 3.9 m bed
        Arena.ArenaCore.TruckBedOverride = LargeBedQ16;
        yield return null; yield return null;
        float bed = LargeBedQ16 / 65536f;
        Assert.AreEqual(bed, _bay.bedLength, 1e-5f, "the bay is the core's bed");
        Assert.AreEqual(1.3f, _bay.bedLength / 3.0f, 1e-4f, "1.3 times the standard bed");
        Assert.AreEqual(front0, _bay.bedFloor.z + _bay.bedLength * 0.5f, 1e-4f, "the bed starts where it did, behind the cab");
        var span1 = BodySpan();
        Assert.AreEqual(span0.front, span1.front, 1e-3f, "the cab is where it was");
        Assert.AreEqual(span0.rear - (bed - 3.0f), span1.rear, 2e-3f, "the truck is the bed's 0.9 m longer");
        int fit1 = CratesThatFit();
        Assert.GreaterOrEqual(fit1, Mathf.FloorToInt(fit0 * 1.3f), $"{fit1} crates on the larger bed against {fit0}");
        Shot("truck-large");
        Debug.Log($"[LargeTruckTests] FACTS standard bed 3.000 m, body z {span0.rear:0.000}..{span0.front:0.000} ({span0.front - span0.rear:0.000} m), {fit0} crates of 0.55 m"
                  + $" | larger bed {_bay.bedLength:0.0000} m (x{_bay.bedLength / 3.0f:0.0000}), body z {span1.rear:0.000}..{span1.front:0.000} ({span1.front - span1.rear:0.000} m), {fit1} crates");

        // BACK TO THE STANDARD TRUCK
        Arena.ArenaCore.TruckBedOverride = 0;
        yield return null; yield return null;
        Assert.AreEqual(3.0f, _bay.bedLength, 1e-4f);
        var span2 = BodySpan();
        Assert.AreEqual(span0.rear, span2.rear, 1e-3f, "the original body again");
        Assert.AreEqual(fit0, CratesThatFit());
    }

    /// <summary>
    /// THE MORPH WAITS FOR THE RUN (measured 2026-10-18 on live UI 221: a joined round's core starts with the entry's
    /// unlocks while the lobby's splash still shows; the 3.9 m bed was drawn at once and no player saw the morph). With a core
    /// (CoreInEditor stands in for one), a new bed behind the lobby is held - the old truck kept - through PLAY's fly-in, and morphs
    /// once the camera is at the truck.
    /// </summary>
    [UnityTest]
    public IEnumerator ABedChangedBehindTheLobbyMorphsOnceTheRunIsInView()
    {
        Arena.ArenaCore.TruckBedOverride = 0;
        yield return null;
        var splash = Object.FindFirstObjectByType<SplashScreen>();
        var chase = Object.FindFirstObjectByType<ChaseCamera>();
        Assert.IsNotNull(splash); Assert.IsNotNull(chase);
        typeof(SplashScreen).GetMethod("ShowLobbyAgain", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance).Invoke(splash, null);
        yield return null;
        Assert.IsTrue(splash.Showing, "back in the lobby");
        LargeTruckView.CoreInEditor = true;
        Arena.ArenaCore.TruckBedOverride = LargeBedQ16;   // the joined round's core starts with the larger truck
        for (int i = 0; i < 10; i++) yield return null;
        Assert.IsFalse(_view.Morphing, "behind the lobby: no morph yet");
        Assert.AreEqual(3.0f, _view.AppliedBed, 1e-4f, "the old truck is kept while the lobby shows");
        splash.Play();                                   // the run starts: the splash hides, the camera flies in
        yield return null;
        Assert.IsFalse(splash.Showing);
        Assert.IsTrue(chase.Flying, "PLAY's fly-in");
        int heldFrames = 0;
        while (chase.Flying) { Assert.IsFalse(_view.Morphing, "held while the camera flies in"); heldFrames++; yield return null; }
        Assert.AreEqual(3.0f, _view.AppliedBed, 1e-4f, "still the old truck when the camera arrives");
        yield return null; yield return null;
        Assert.IsTrue(_view.Morphing, "the morph starts once the run is in view");
        float t0 = Time.unscaledTime;
        while (_view.Morphing && Time.unscaledTime - t0 < LargeTruckView.MorphS + 1f) yield return null;
        Assert.AreEqual(LargeBedQ16 / 65536f, _view.AppliedBed, 1e-4f, "it rests at the core's bed");
        Debug.Log($"[LargeTruckTests] FACTS held {heldFrames} frames through the fly-in, then morphed to {_view.AppliedBed:0.000} m");
    }

    /// <summary>
    /// THE MORPH (2026-10-16: "While the round is active there is an effect that the truck morphes from old to
    /// new"): in a live round the bay takes the core's new bed at once, and the body grows from the standard truck to the larger one
    /// over LargeTruckView.MorphS - past its new length and back - with the pulse light on, then rests at 3.9 m with the light off.
    /// The editor has no core, so MorphInEditor stands in for the live round. Shots at the start, mid-way and the end.
    /// </summary>
    [UnityTest]
    public IEnumerator InALiveRoundTheTruckMorphsFromOldToNew()
    {
        Arena.ArenaCore.TruckBedOverride = 0;
        yield return null;
        var span0 = BodySpan();
        LargeTruckView.MorphInEditor = true;
        Arena.ArenaCore.TruckBedOverride = LargeBedQ16;
        float bed = LargeBedQ16 / 65536f, t0 = Time.unscaledTime;
        yield return null;
        Assert.IsTrue(_view.Morphing, "the change in a live round starts a morph");
        Assert.AreEqual(bed, _bay.bedLength, 1e-5f, "the bay takes the core's bed at once");
        Assert.Less(_view.AppliedBed, 3.2f, "the body starts at the old truck");
        // no picture while it is timed: a 1280x720 shot takes longer than the morph in batch mode
        float peak = 0f; var seen = new List<float>(); bool lit = false, glowed = false;
        while (_view.Morphing && Time.unscaledTime - t0 < LargeTruckView.MorphS + 1f)
        {
            peak = Mathf.Max(peak, _view.AppliedBed); seen.Add(_view.AppliedBed);
            var pulse = _truck.Find("MorphPulse");
            if (pulse != null && pulse.GetComponent<Light>().enabled && pulse.GetComponent<Light>().intensity > 1f) lit = true;
            if (BodyTinted()) glowed = true;
            yield return null;
        }
        Assert.IsFalse(_view.Morphing, "the morph ends");
        Assert.LessOrEqual(Time.unscaledTime - t0, LargeTruckView.MorphS + 0.5f, "in about MorphS");
        Assert.Greater(seen.Count, 5, "drawn over many frames, not at once");
        Assert.Greater(peak, bed + 0.03f, $"the bed reached past {bed:0.000} m (peak {peak:0.000})");
        Assert.IsTrue(lit, "the pulse light shone over the bed");
        Assert.IsTrue(glowed, "the body glowed orange while it morphed");
        Assert.IsFalse(BodyTinted(), "the glow is gone once the morph ends");
        Assert.AreEqual(bed, _view.AppliedBed, 1e-4f, "it rests at the core's bed");
        var span1 = BodySpan();
        Assert.AreEqual(span0.rear - (bed - 3.0f), span1.rear, 2e-3f, "the body is the larger truck's at the end");
        var light = _truck.Find("MorphPulse");
        Assert.IsTrue(light == null || !light.GetComponent<Light>().enabled, "the light off again");
        Debug.Log($"[LargeTruckTests] FACTS morph {seen.Count} frames, peak {peak:0.000} m, rest {_view.AppliedBed:0.000} m, {Time.unscaledTime - t0:0.00} s");

        // THE PICTURES, from a second morph: back to the standard truck, then old -> new again, shot at its start, a third in, the end
        Arena.ArenaCore.TruckBedOverride = 0;
        for (int i = 0; i < 400 && (_view.Morphing || _view.AppliedBed > 3.001f); i++) yield return null;
        Arena.ArenaCore.TruckBedOverride = LargeBedQ16;
        yield return null;
        Shot("truck-morph-start");
        float t1 = Time.unscaledTime;
        while (_view.Morphing && Time.unscaledTime - t1 < LargeTruckView.MorphS * 0.3f) yield return null;
        Shot("truck-morph-mid");
        Debug.Log($"[LargeTruckTests] FACTS mid shot at bed {_view.AppliedBed:0.000} m");
        for (int i = 0; i < 400 && _view.Morphing; i++) yield return null;
        Shot("truck-morph-end");
    }
}
