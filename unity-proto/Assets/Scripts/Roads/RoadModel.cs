using System;
using System.Collections.Generic;
using UnityEngine;

public enum Lane { BullRear, Bull, Front, Bear, BearRear }

/// <summary>
/// The five routes and what shelling does to them. Pure logic - no meshes, no
/// MonoBehaviour - so the corridor geometry and the damage model can be tested
/// exhaustively without a scene.
///
/// Ported from src/world/roads.js.
/// </summary>
public class RoadModel
{
    public const float HalfWidth = 5.2f;
    /// <summary>Hard centre-to-centre minimum. A road is 10.4 wide, so anything less overlaps.</summary>
    public const float LaneGap = 13.5f;
    public const float GateX = 34f;
    public const float MergeSpan = 54f;

    /// <summary>How long a cut section stays impassable while engineers work it.</summary>
    public const float DamageSeconds = 60f;
    /// <summary>A stretch this long accumulates wear 0..1 before it fails.</summary>
    public const float WearSpan = 16f;
    /// <summary>Heals this fast if nothing else lands on it - roughly two minutes from fully worn.</summary>
    public const float WearHeal = 0.02f;

    public static readonly Lane[] Order =
        { Lane.BullRear, Lane.Bull, Lane.Front, Lane.Bear, Lane.BearRear };

    public float PlazaX = -118f;
    public float DepotX = 118f;

    /// <summary>Where the frontline runs. Only the Front lane follows it.</summary>
    public Func<float, float> FrontlineAt = _ => 0f;

    public class Cut { public Lane lane; public float x, span, t, total; }
    public class Wear { public Lane lane; public float x, span, wear; }

    public readonly List<Cut> Cuts = new List<Cut>();
    public readonly List<Wear> Wears = new List<Wear>();

    static float GateSlot(Lane lane) => lane switch
    {
        Lane.BullRear => -24f,
        Lane.Bull => -12f,
        Lane.Front => 0f,
        Lane.Bear => 12f,
        _ => 24f,
    };

    /// <summary>
    /// Cruising centreline of a flank road. Amplitudes are bounded so each
    /// route keeps to its own corridor - built infrastructure does not move
    /// because a battle line drifted over it.
    /// </summary>
    public static float BaseZ(Lane lane, float x) => lane switch
    {
        Lane.BullRear => -76f + Mathf.Sin(x * 0.0142f + 0.9f) * 4f + Mathf.Sin(x * 0.031f + 2.2f) * 2f,
        Lane.Bull => -48f + Mathf.Sin(x * 0.0195f) * 5f + Mathf.Sin(x * 0.041f + 1.7f) * 2.5f,
        Lane.Bear => 48f + Mathf.Sin(x * 0.017f + 2.4f) * 5f + Mathf.Sin(x * 0.037f + 0.3f) * 2.5f,
        Lane.BearRear => 76f + Mathf.Sin(x * 0.0128f + 3.1f) * 4f + Mathf.Sin(x * 0.027f + 1.2f) * 2f,
        _ => 0f,
    };

    static float Smoothstep(float t) => t * t * (3f - 2f * t);

    /// <summary>
    /// Centreline z at a world x. Every route is funnelled into its own slot in
    /// the compound gates by the time it reaches the walls - a route still off
    /// centre there drives a truck into a blast wall.
    /// </summary>
    public float CenterZ(Lane lane, float x)
    {
        float plazaGate = PlazaX + GateX;
        float depotGate = DepotX - GateX;
        float outOfPlaza = Smoothstep(Mathf.Clamp01((x - plazaGate) / MergeSpan));
        float intoGate = 1f - Smoothstep(Mathf.Clamp01((x - (depotGate - MergeSpan)) / MergeSpan));
        float open = Mathf.Min(outOfPlaza, intoGate);

        float cruise;
        if (lane == Lane.Front)
        {
            // held between the two inner flanks so it can never end up running
            // along one of them
            float lo = BaseZ(Lane.Bull, x) + LaneGap;
            float hi = BaseZ(Lane.Bear, x) - LaneGap;
            cruise = Mathf.Clamp(FrontlineAt(x), lo, hi);
        }
        else cruise = BaseZ(lane, x);

        return Mathf.Lerp(GateSlot(lane), cruise, open);
    }

    /// <summary>Which lane a world point sits on, or null if it is off-road.</summary>
    public Lane? LaneAt(float x, float z, float tolerance = HalfWidth)
    {
        Lane? best = null;
        float bestD = tolerance;
        foreach (var lane in Order)
        {
            float d = Mathf.Abs(z - CenterZ(lane, x));
            if (d < bestD) { bestD = d; best = lane; }
        }
        return best;
    }

    /* ------------------------------------------------------------- damage */

    /// <summary>Shell splash: accumulates surface wear, and cuts the road at 100%.</summary>
    public void WearAt(float x, float z, float radius, float amount)
    {
        foreach (var lane in Order)
        {
            if (lane == Lane.Front) continue;              // the frontline track can never be cut
            if (Mathf.Abs(z - CenterZ(lane, x)) > radius + HalfWidth) continue;

            float bucket = Mathf.Round(x / WearSpan) * WearSpan;
            var w = Wears.Find(e => e.lane == lane && Mathf.Abs(e.x - bucket) < 0.5f);
            if (w == null) { w = new Wear { lane = lane, x = bucket, span = WearSpan * 0.55f }; Wears.Add(w); }
            w.wear += amount;
            if (w.wear >= 1f) { Wears.Remove(w); AddCut(lane, bucket, WearSpan * 0.6f); }
        }
    }

    /// <summary>Direct hit: cuts the road outright.</summary>
    public void CutAt(float x, float z, float radius)
    {
        foreach (var lane in Order)
        {
            if (lane == Lane.Front) continue;
            if (Mathf.Abs(z - CenterZ(lane, x)) > radius + HalfWidth) continue;
            AddCut(lane, x, Mathf.Max(radius, WearSpan * 0.5f));
        }
    }

    void AddCut(Lane lane, float x, float span)
    {
        var existing = Cuts.Find(d => d.lane == lane && Mathf.Abs(d.x - x) < span);
        if (existing != null) { existing.t = Mathf.Max(existing.t, DamageSeconds); return; }
        Cuts.Add(new Cut { lane = lane, x = x, span = span, t = DamageSeconds, total = DamageSeconds });
    }

    /// <summary>How much a stretch slows a truck, 0..1.</summary>
    public float DamageFactor(Lane lane, float x)
    {
        foreach (var d in Cuts)
            if (d.lane == lane && Mathf.Abs(d.x - x) < d.span) return 1f - Mathf.Abs(d.x - x) / d.span;
        foreach (var w in Wears)
            if (w.lane == lane && Mathf.Abs(w.x - x) < w.span) return w.wear * 0.45f;
        return 0f;
    }

    /// <summary>
    /// How wrecked the road LOOKS, 0..1. Separate from DamageFactor because a
    /// cut has to read as destroyed across its whole span, not just at the
    /// centre - and repaired stretches visibly come good as engineers work.
    /// </summary>
    public float SeverityAt(Lane lane, float x)
    {
        float s = 0f;
        foreach (var d in Cuts)
        {
            if (d.lane != lane) continue;
            float k = Mathf.Abs(d.x - x) / d.span;
            if (k < 1f)
            {
                float repaired = 1f - d.t / d.total;
                s = Mathf.Max(s, (0.55f + 0.45f * (1f - k)) * (1f - repaired * 0.85f));
            }
        }
        foreach (var w in Wears)
            if (w.lane == lane && Mathf.Abs(w.x - x) < w.span) s = Mathf.Max(s, w.wear * 0.55f);
        return s;
    }

    /// <summary>Is a cut sitting between these two points? The frontline never is.</summary>
    public bool PathBlocked(Lane lane, float fromX, float toX)
    {
        if (lane == Lane.Front) return false;
        float lo = Mathf.Min(fromX, toX) - 2f, hi = Mathf.Max(fromX, toX) + 2f;
        return Cuts.Exists(d => d.lane == lane && d.x + d.span > lo && d.x - d.span < hi);
    }

    public bool IsCut(Lane lane) => Cuts.Exists(d => d.lane == lane);

    /// <summary>Seconds until this lane is passable again, or 0 if it already is.</summary>
    public float RepairEta(Lane lane)
    {
        float t = 0f;
        foreach (var d in Cuts) if (d.lane == lane) t = Mathf.Max(t, d.t);
        return t;
    }

    public List<Lane> OpenLanes()
    {
        var open = new List<Lane>();
        foreach (var l in Order) if (!IsCut(l)) open.Add(l);
        return open;
    }

    public float WearLevel(Lane lane)
    {
        float m = 0f;
        foreach (var w in Wears) if (w.lane == lane) m = Mathf.Max(m, w.wear);
        return m;
    }

    /// <summary>Engineers repair cuts; unshelled surfaces slowly recover.</summary>
    public void Tick(float dt)
    {
        for (int i = Cuts.Count - 1; i >= 0; i--)
        {
            Cuts[i].t -= dt;
            if (Cuts[i].t <= 0f) Cuts.RemoveAt(i);
        }
        for (int i = Wears.Count - 1; i >= 0; i--)
        {
            Wears[i].wear -= dt * WearHeal;
            if (Wears[i].wear <= 0f) Wears.RemoveAt(i);
        }
    }
}
