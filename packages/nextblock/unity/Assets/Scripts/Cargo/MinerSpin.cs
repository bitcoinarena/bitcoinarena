// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// Turns the moving parts of the delivery miner: the cooling fans, the coin
/// under its dome, and the beacon on the uplink mast.
///
/// The model ships these as separately named nodes precisely so they can be
/// driven from here rather than baked into the building. Unscaled time, so the
/// machine keeps running through the death sequence's slow motion - a mining
/// rig does not care that the courier crashed.
/// </summary>
public class MinerSpin : MonoBehaviour
{
    public Transform[] fans;
    public Transform coin;
    public Transform beacon;
    public Renderer beaconLamp;

    [Tooltip("Fan revolutions per minute. Fast enough to blur, slow enough " +
             "not to strobe against the frame rate.")]
    public float fanRpm = 42f;

    [Tooltip("Blades on one fan. Used to keep the blade-passing frequency " +
             "below half the frame rate.")]
    public int bladeCount = 7;

    public float coinRpm = 9f;
    public float coinBobMetres = 1.6f;

    [Tooltip("How deep a fan may be along its axle, in metres. The housings " +
             "are 2.3 m deep and the blade discs are authored at 7.2, so the " +
             "blades otherwise stand proud of their rings on both sides.")]
    public float maxDepth = 3.2f;

    [Tooltip("Blade pitch from the plane of the fan, in degrees. The model " +
             "authors them at 80, which is very nearly feathered: edge-on to " +
             "the air and edge-on to the viewer. 45 is a fan.")]
    public float bladePitch = 45f;

    Vector3 _coinHome;
    Vector3[] _axles;
    Quaternion[] _rest;
    float _angle;
    MaterialPropertyBlock _block;

    void Start()
    {
        if (coin != null) _coinHome = coin.localPosition;
        _block = new MaterialPropertyBlock();

        int n = fans != null ? fans.Length : 0;
        _axles = new Vector3[n];
        _rest = new Quaternion[n];
        for (int i = 0; i < n; i++) TrueUp(i);

        // Slow enough that the blades never alias.
        //
        // At 140 rpm with seven blades a blade passes 16.3 times a second, and
        // on a phone rendering at 30 fps that is above Nyquist - so the fan
        // appears to crawl, stop, or run backwards. Held to a quarter of the
        // frame rate it always reads as turning forwards.
        float fps = Mathf.Max(24f, 1f / Mathf.Max(0.001f, Time.smoothDeltaTime));
        float maxRpm = fps * 0.25f / Mathf.Max(1, bladeCount) * 60f;
        fanRpm = Mathf.Min(fanRpm, maxRpm);
    }

    /// <summary>
    /// Everything a fan needs to run true: its axle, its rest pose, and where
    /// the centre of its blade disc actually is.
    ///
    /// The previous version squashed each fan in its own plane to make its
    /// BOUNDING BOX square, on the theory that a fan disc must measure the
    /// same across both in-plane axes. That premise is wrong and it is what
    /// the wobble was. Measured on the import, Fan_01's seven blades sit on a
    /// circle of radius 5.2 centred on the node - the disc is already true.
    /// Its box is 11.0 x 14.5 only because seven blades at 51.4 degrees apart
    /// have no four-fold symmetry, so the corners of the box catch different
    /// parts of different blades. Scaling that box square turned a round fan
    /// into a 31 percent ellipse, and a rotating ellipse is exactly what
    /// "eiernd" looks like.
    ///
    /// What is left is the part that was right: the disc is 7.2 m deep against
    /// a 2.3 m ring, so it is flattened ALONG THE AXLE. That scale commutes
    /// with the spin - it is uniform in the plane the rotation happens in - so
    /// it cannot deform anything as the fan turns.
    ///
    /// Nothing is done about the centre, deliberately. The blades sit on a
    /// circle of radius 5.2 about the node's own origin, so the origin IS the
    /// hub and rotating about it is exact. The bounding box's centre is 10 cm
    /// off it, but that is the asymmetry of seven plates rather than an
    /// eccentric - correcting to it would make a true fan orbit by 10 cm.
    /// </summary>
    void TrueUp(int i)
    {
        var fan = fans[i];
        if (fan == null) { _rest[i] = Quaternion.identity; _axles[i] = Vector3.forward; return; }

        if (!Blades(fan, out var box)) { _axles[i] = Vector3.forward; _rest[i] = fan.localRotation; return; }

        var s = box.size;
        var axle = s.x <= s.y && s.x <= s.z ? Vector3.right
                 : s.y <= s.x && s.y <= s.z ? Vector3.up : Vector3.forward;
        _axles[i] = axle;

        // Pitch and space the blades FIRST: re-pitching a blade changes how
        // deep the assembly is, and clamping a depth that is about to change
        // measures the wrong thing. At 45 degrees the disc is 5.2 m deep
        // rather than the authored 7.2, so it needs less flattening to sit in
        // its housing - and less flattening is a truer blade.
        Align(fan, axle);

        if (Blades(fan, out var box2))
        {
            float depth = Vector3.Dot(box2.size, axle);
            if (depth > maxDepth && depth > 0.01f)
            {
                float k = maxDepth / depth;
                fan.localScale = axle == Vector3.right ? new Vector3(k, 1f, 1f)
                               : axle == Vector3.up ? new Vector3(1f, k, 1f)
                               : new Vector3(1f, 1f, k);
            }
        }

        _rest[i] = fan.localRotation;
    }

    /// <summary>
    /// Makes the seven blades one blade, seven times.
    ///
    /// This is what was left of the wobble once the fan stopped being squashed,
    /// and it is in the model. The blades stand in the right places - a clean
    /// ring of seven at radius 5.2, exact to three decimals - but they are
    /// PITCHED about a fixed axis rather than about each blade's own radius.
    /// So only the blade at zero degrees is pitched correctly; the next is 27
    /// degrees out, the one after 49, the one after that 61. Measured on the
    /// import, blade 0 reaches from radius 5.00 to 6.24 while blade 2, cut
    /// from the identical mesh, sprawls from 3.59 to 7.25 - one blade nearly
    /// touching the hub while its neighbour sits well clear of it. Seven
    /// blades at seven different attitudes is not a fan, and no amount of
    /// turning it correctly makes it read as one.
    ///
    /// Every blade is the same mesh, so the fix is exact: take blade 0's pose
    /// as the blade, and put the others where that blade would be if it were
    /// turned by its share of a full circle. The result is congruent by
    /// construction and rigid afterwards - the assembly still spins as one
    /// piece.
    /// </summary>
    void Align(Transform fan, Vector3 axle)
    {
        var blades = new System.Collections.Generic.List<Transform>();
        foreach (Transform c in fan) if (c.name.Contains("blade")) blades.Add(c);
        if (blades.Count < 3) return;
        blades.Sort((a, b) => Index(a.name).CompareTo(Index(b.name)));

        var p0 = blades[0].localPosition;
        var q0 = Pitch(blades[0], axle);
        var s0 = blades[0].localScale;
        float step = 360f / blades.Count;
        blades[0].localRotation = q0;

        for (int k = 1; k < blades.Count; k++)
        {
            // Which way round is immaterial: the import mirrors x, so a
            // positive turn about the measured axle may fill the ring
            // backwards. Seven identical blades in seven slots is the same
            // fan whichever end it is counted from.
            var turn = Quaternion.AngleAxis(step * k, axle);
            blades[k].localPosition = turn * p0;
            blades[k].localRotation = turn * q0;
            blades[k].localScale = s0;
        }
    }

    /// <summary>
    /// Sets a blade to a pitch that reads as a blade.
    ///
    /// The model authors the plate at 80 degrees off the plane of the fan,
    /// which is a feathered blade: it presents its edge both to the air and to
    /// anyone looking at the fan, so the assembly reads as seven struts in a
    /// hoop. Measured on the import the plate is a 6.2 x 7.3 m rectangle, and
    /// at 80 degrees it reaches only from radius 5.0 to 6.2 - clear of the
    /// 2.4 m hub and clear of the 7.9 m ring, touching neither.
    ///
    /// The same plate at 45 degrees reaches 2.6 to 7.8: hub to rim, which is
    /// what a fan looks like. The depth that costs (5.2 m against a 2.3 m
    /// housing) is taken back by the flattening along the axle, which lands
    /// the blade at an effective 32 degrees - and that is a fan too.
    ///
    /// The turn is about the blade's SPAN - the tangent, the way its 6.2 m
    /// side runs - and not about its radius. A rotation about the radius
    /// cannot change how far the blade reaches along that radius, which is
    /// the one thing that has to change; it only spins the plate in place.
    /// About the tangent, the 7.3 m chord swings out of the axle and into the
    /// disc, which is what pitching a blade means.
    ///
    /// The blade keeps its slot and all seven stay congruent, so the assembly
    /// is still one rigid piece.
    /// </summary>
    Quaternion Pitch(Transform blade, Vector3 axle)
    {
        var mf = blade.GetComponent<MeshFilter>();
        var fan = blade.parent;
        if (mf == null || mf.sharedMesh == null || fan == null) return blade.localRotation;

        // the blade's own radius, in the fan's frame
        var at = blade.localPosition;
        var radial = at - axle * Vector3.Dot(at, axle);
        if (radial.sqrMagnitude < 0.01f) return blade.localRotation;
        radial.Normalize();
        var span = Vector3.Cross(axle, radial).normalized;

        var was = blade.localRotation;
        Vector2 Reach(Quaternion pose)
        {
            var mb = mf.sharedMesh.bounds;
            float axial = 0f, along = 0f;
            for (int c = 0; c < 8; c++)
            {
                var corner = new Vector3((c & 1) == 0 ? mb.min.x : mb.max.x,
                                         (c & 2) == 0 ? mb.min.y : mb.max.y,
                                         (c & 4) == 0 ? mb.min.z : mb.max.z);
                var v = pose * Vector3.Scale(blade.localScale, corner);
                axial = Mathf.Max(axial, Mathf.Abs(Vector3.Dot(v, axle)));
                along = Mathf.Max(along, Mathf.Abs(Vector3.Dot(v, radial)));
            }
            return new Vector2(along, axial);
        }

        var now = Reach(was);
        if (now.x < 0.01f && now.y < 0.01f) return was;
        float authored = Mathf.Atan2(now.y, now.x) * Mathf.Rad2Deg;
        float delta = authored - Mathf.Clamp(bladePitch, 5f, 89f);
        if (Mathf.Abs(delta) < 0.5f) return was;

        // Which way to turn is not knowable from the numbers - the import
        // mirrors x, so the sign of a rotation about the radius is not the
        // sign it was authored with. Both are tried and the one that actually
        // lowers the blade towards the plane of the fan is kept.
        var down = Quaternion.AngleAxis(-delta, span) * was;
        var up = Quaternion.AngleAxis(delta, span) * was;
        return Reach(down).y <= Reach(up).y ? down : up;
    }

    /// <summary>The number a blade's name ends in, or 0.</summary>
    static int Index(string name)
    {
        int at = name.LastIndexOf('_');
        return at >= 0 && at + 1 < name.Length
            && int.TryParse(name.Substring(at + 1), out int i) ? i : 0;
    }

    /// <summary>The blade assembly's extent, measured in the fan's own frame.</summary>
    static bool Blades(Transform fan, out Bounds box)
    {
        bool any = false;
        box = new Bounds();
        foreach (var r in fan.GetComponentsInChildren<Renderer>(true))
        {
            var mf = r.GetComponent<MeshFilter>();
            if (mf == null || mf.sharedMesh == null) continue;
            var mb = mf.sharedMesh.bounds;
            for (int c = 0; c < 8; c++)
            {
                var corner = new Vector3((c & 1) == 0 ? mb.min.x : mb.max.x,
                                         (c & 2) == 0 ? mb.min.y : mb.max.y,
                                         (c & 4) == 0 ? mb.min.z : mb.max.z);
                var local = fan.InverseTransformPoint(r.transform.TransformPoint(corner));
                if (!any) { box = new Bounds(local, Vector3.zero); any = true; }
                else box.Encapsulate(local);
            }
        }
        return any;
    }

    void Update()
    {
        float t = Time.unscaledTime;

        // Set from absolute time rather than integrated frame by frame: an
        // accumulated angle drifts with the frame rate, so two fans that
        // started together end the session out of step for no reason.
        _angle = Mathf.Repeat(t * fanRpm * 6f, 360f);
        if (fans != null)
            for (int i = 0; i < fans.Length; i++)
                if (fans[i] != null)
                    fans[i].localRotation = _rest[i] * Quaternion.AngleAxis(_angle, _axles[i]);

        if (coin != null)
        {
            coin.Rotate(Vector3.up, coinRpm * 6f * Time.unscaledDeltaTime, Space.Self);
            coin.localPosition = _coinHome + Vector3.up * (Mathf.Sin(t * 0.9f) * coinBobMetres);
        }

        // The beacon pulses rather than turns: a rotating point of light on a
        // 28 metre mast reads as a glitch, a pulsing one reads as a signal.
        if (beaconLamp != null)
        {
            float pulse = 0.45f + 0.55f * Mathf.Abs(Mathf.Sin(t * 1.6f));
            beaconLamp.GetPropertyBlock(_block);
            _block.SetColor("_EmissionColor", new Color(1f, 0.92f, 0.35f) * pulse * 3f);
            beaconLamp.SetPropertyBlock(_block);
        }
    }
}
