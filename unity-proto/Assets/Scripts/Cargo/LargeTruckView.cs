// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// THE LARGER TRUCK, DRAWN (the first in-game item; 2026-10-15: "a larger truck for 500 satoshis. It can load
/// 30% more packages and is slightly faster").
///
/// The core decides the truck: a run whose entry plays with the item is started with its unlock and drives a bed of 255590
/// (3.9 m, 1.3 x the standard 196608) - and its own drive acceleration, which reaches the screen by itself, since the view
/// follows the core's pose. What is left to draw is the length. Read off the core every frame
/// (<see cref="Arena.ArenaCore.TruckBedMeters"/>), never chosen here:
///
///   - THE BAY takes the core's bed: the same front (behind the cab), the bed 0.9 m longer towards the tail, so 30 % more room
///     and the crates packed over all of it;
///   - THE BODY stretches only its bed: every vertex between the bed's front and its tail (the bay's own span, 3.0 m) is
///     spread over 3.9 m, everything behind it moves back the 0.9 m - the cab is untouched and the truck is 0.9 m longer.
///     The wheels left the body when it was dressed (Bootstrap.NormaliseTruckModel), so they are not stretched.
///
/// Back to the standard truck, every mesh is its original again. A body swapped in later (the model streaming in) is measured
/// and stretched afresh.
///
/// THE MORPH (2026-10-16: "While the round is active there is an effect that the truck morphes from old to new"):
/// when the core's bed changes in a live round - the run that plays with the larger truck starting - the bay takes the new bed at
/// once (the core decides what fits), and the body grows from the old length to the new one over <see cref="MorphS"/> with a little
/// overshoot, an orange light pulsing over the bed as it does. In the lobby, and in the editor's tests, it is drawn at once as before.
/// </summary>
[RequireComponent(typeof(CargoBay))]
public class LargeTruckView : MonoBehaviour
{
    /// <summary>The standard bed (CargoBay.bedLength, the core's BED_LENGTH 196608 / 65536).</summary>
    public const float StandardBed = 3.0f;

    /// <summary>How long the body takes to grow from the old truck to the new one, in seconds.</summary>
    public const float MorphS = 1.6f;
    /// <summary>A test's switch: morph in the editor too, where no core runs.</summary>
    public static bool MorphInEditor;
    /// <summary>A test's switch: act as if a core ran (ArenaCore.Available), so the hold behind the lobby and the fly-in is tested.</summary>
    public static bool CoreInEditor;

    CargoBay _bay;
    Vector3 _floor0;
    Transform _body;
    readonly List<(MeshFilter mf, Mesh original, Mesh work)> _meshes = new List<(MeshFilter, Mesh, Mesh)>();
    float _applied = StandardBed;   // the body's bed drawn now
    float _target = StandardBed;    // the core's bed
    float _from = StandardBed;
    float _morphAt = -1f;
    Light _pulse;
    SplashScreen _splash;
    ChaseCamera _chase;
    MaterialPropertyBlock _tint;
    static readonly Color MorphGlow = new Color(1f, 0.55f, 0.12f);

    /// <summary>The bed length drawn now, in metres.</summary>
    public float AppliedBed => _applied;
    /// <summary>True while the body grows from the old truck to the new.</summary>
    public bool Morphing => _morphAt >= 0f;

    /// <summary>
    /// The morph's progress at `t` (0..1 of <see cref="MorphS"/>): an ease-out with an overshoot of about 10 % that settles on 1 -
    /// the bed reaches past its new length and springs back.
    /// </summary>
    public static float MorphCurve(float t)
    {
        t = Mathf.Clamp01(t);
        const float c1 = 1.70158f, c3 = c1 + 1f;
        float u = t - 1f;
        return 1f + c3 * u * u * u + c1 * u * u;
    }

    /// <summary>The orange pulse over the bed while it morphs: up fast, down slow, 0 at both ends.</summary>
    public static float PulseAt(float t) => t <= 0f || t >= 1f ? 0f : Mathf.Sin(Mathf.PI * Mathf.Pow(t, 0.6f)) * 6f;

    void Awake()
    {
        _bay = GetComponent<CargoBay>();
        _floor0 = _bay.bedFloor;
    }

    void Update()
    {
        float want = Arena.ArenaCore.TruckBedMeters;
        if (want <= 0f) want = StandardBed;
        var body = transform.Find("Body") ?? transform.Find("BodyProxy");   // the model, or the box before it streams in
        if (body != _body) { Restore(); _body = body; _meshes.Clear(); _applied = StandardBed; _target = StandardBed; _morphAt = -1f; }
        if (Mathf.Abs(want - _target) > 0.0005f)
        {
            if (_splash == null) _splash = FindFirstObjectByType<SplashScreen>();
            // THE MORPH WAITS FOR THE RUN (measured 2026-10-18 on live UI 221: a joined round's core starts with the
            // entry's unlocks while the lobby's splash still shows, so the 3.9 m bed was drawn at once - "[LargeTruckView] bed 3.900 m
            // drawn" - and no player ever saw the morph): a real core's new bed while the splash shows is held, the old truck kept,
            // and it morphs once the splash has hidden and PLAY's 4.2 s fly-in has brought the camera to the truck - in view. Without
            // a core (the editor's tests) - at once, as before.
            if (_chase == null) _chase = FindFirstObjectByType<ChaseCamera>();
            bool core = Arena.ArenaCore.Available || CoreInEditor;
            bool held = !MorphInEditor && core && _splash != null && _body != null && Mathf.Abs(want - _applied) > 0.05f
                && (_splash.Showing || (_chase != null && _chase.Flying));
            if (!held)
            {
                bool live = MorphInEditor || (core && _splash != null && !_splash.Showing);
                if (live && Mathf.Abs(want - _applied) > 0.05f && _body != null) StartMorph(want);
                else Apply(want);
            }
        }
        if (_morphAt >= 0f)
        {
            float t = (Time.unscaledTime - _morphAt) / MorphS;
            if (t >= 1f) { ApplyBody(_target); _morphAt = -1f; SetPulse(0f); Tint(0f); Debug.Log($"[LargeTruckView] morph done: bed {_target:0.000} m"); }
            else { ApplyBody(Mathf.LerpUnclamped(_from, _target, MorphCurve(t))); SetPulse(PulseAt(t)); Tint(PulseAt(t) / 6f * 0.75f); }
        }
    }

    /// <summary>Draw a bed `bed` metres long (the core's), the front where the standard one starts - at once.</summary>
    public void Apply(float bed)
    {
        if (_morphAt >= 0f) Tint(0f);
        _morphAt = -1f; SetPulse(0f);
        ApplyBay(bed);
        ApplyBody(bed);
        Debug.Log($"[LargeTruckView] bed {bed:0.000} m drawn ({(bed > StandardBed + 0.0005f ? "the larger truck" : "the standard truck")})");
    }

    /// <summary>The morph to the core's new bed: the bay at once, the body from the length drawn now.</summary>
    void StartMorph(float bed)
    {
        ApplyBay(bed);
        _from = _applied;
        _morphAt = Time.unscaledTime;
        Debug.Log($"[LargeTruckView] morph: bed {_from:0.000} -> {bed:0.000} m over {MorphS:0.0} s");
    }

    /// <summary>THE BAY: same front, the core's length; its crates repacked over it.</summary>
    void ApplyBay(float bed)
    {
        float front = _floor0.z + StandardBed * 0.5f;
        _bay.bedLength = bed;
        _bay.bedFloor = new Vector3(_floor0.x, _floor0.y, front - bed * 0.5f);
        _bay.ReflowForNewBed();
        _target = bed;
    }

    /// <summary>
    /// THE BODY: its bed section spread over `bed` metres, the tail moved back - from the original vertices every time, into one
    /// working mesh per part (a morph draws it every frame).
    /// </summary>
    void ApplyBody(float bed)
    {
        float front = _floor0.z + StandardBed * 0.5f, rear = _floor0.z - StandardBed * 0.5f;
        float extra = bed - StandardBed;
        if (_body != null)
        {
            if (_meshes.Count == 0)
                foreach (var mf in _body.GetComponentsInChildren<MeshFilter>(true))
                {
                    if (mf.sharedMesh == null) continue;
                    // the model's mesh is imported Read/Write (SmallTruck_1.FBX.meta isReadable), else it cannot be stretched
                    if (!mf.sharedMesh.isReadable) { Debug.LogWarning($"[LargeTruckView] mesh {mf.sharedMesh.name} is not readable: its bed is not drawn longer"); continue; }
                    _meshes.Add((mf, mf.sharedMesh, null));
                }
            float k = bed / StandardBed;
            for (int j = 0; j < _meshes.Count; j++)
            {
                var (mf, original, work) = _meshes[j];
                if (mf == null) continue;
                if (Mathf.Abs(extra) < 0.0005f) { mf.sharedMesh = original; continue; }
                var src = original.vertices;
                var dst = new Vector3[src.Length];
                // the vertex in the truck's frame, stretched there, and back into the mesh's own
                var toTruck = transform.worldToLocalMatrix * mf.transform.localToWorldMatrix;
                var toMesh = toTruck.inverse;
                for (int i = 0; i < src.Length; i++)
                {
                    var p = toTruck.MultiplyPoint3x4(src[i]);
                    if (p.z < front && p.z >= rear) p.z = front - (front - p.z) * k;
                    else if (p.z < rear) p.z -= extra;
                    dst[i] = toMesh.MultiplyPoint3x4(p);
                }
                if (work == null) { work = Instantiate(original); work.name = original.name + " (larger truck)"; _meshes[j] = (mf, original, work); }
                work.vertices = dst;
                work.RecalculateBounds();
                mf.sharedMesh = work;
            }
        }
        _applied = bed;
    }

    /// <summary>
    /// THE BODY GLOWS ORANGE WHILE IT MORPHS (a light alone was lost in daylight, measured on the editor's shots): each material's
    /// own base colour toward orange by `k` (0..1), through a property block - 0 hands the materials back untouched.
    /// </summary>
    void Tint(float k)
    {
        if (_body == null) return;
        if (_tint == null) _tint = new MaterialPropertyBlock();
        foreach (var r in _body.GetComponentsInChildren<Renderer>(true))
        {
            var mats = r.sharedMaterials;
            for (int i = 0; i < mats.Length; i++)
            {
                if (k <= 0f || mats[i] == null || !mats[i].HasProperty("_BaseColor")) { r.SetPropertyBlock(null, i); continue; }
                _tint.Clear();
                _tint.SetColor("_BaseColor", Color.Lerp(mats[i].GetColor("_BaseColor"), MorphGlow, Mathf.Clamp01(k)));
                r.SetPropertyBlock(_tint, i);
            }
        }
    }

    /// <summary>The orange light over the bed while it morphs (intensity 0 switches it off).</summary>
    void SetPulse(float intensity)
    {
        if (intensity <= 0f) { if (_pulse != null) _pulse.enabled = false; return; }
        if (_pulse == null)
        {
            var go = new GameObject("MorphPulse");
            go.transform.SetParent(transform, false);
            _pulse = go.AddComponent<Light>();
            _pulse.type = LightType.Point;
            _pulse.color = new Color(1f, 0.58f, 0.10f);
            _pulse.range = 9f;
        }
        _pulse.transform.localPosition = new Vector3(_floor0.x, _floor0.y + 2.2f, _floor0.z - (_target - StandardBed) * 0.5f);
        _pulse.enabled = true;
        _pulse.intensity = intensity;
    }

    void Restore()
    {
        foreach (var (mf, original, _) in _meshes) if (mf != null) mf.sharedMesh = original;
        if (_bay != null) { _bay.bedLength = StandardBed; _bay.bedFloor = _floor0; }
    }
}
