// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// The frontline IS the price chart. One sample per terrain column, mapped into
/// world depth through a window that auto-zooms to whatever range actually
/// exists - so a market that only moves cents still redraws the whole
/// battlefield instead of flatlining down the middle.
///
/// Ported from HISTORY / feedPrice / frontlineAt in the three.js build.
/// </summary>
public class PriceHistory
{
    public readonly int Columns;

    /// <summary>Seconds between samples; sized so the visible window stays ~35 s.</summary>
    public float SampleSeconds;
    public float EmaAlpha = 0.25f;
    public float WindowPad = 0.18f;

    /// <summary>
    /// Floor on the price window as a fraction of price. Deliberately tiny: it
    /// only exists to avoid dividing by zero on a perfectly frozen tape.
    /// </summary>
    public float MinSpanPct = 0.000004f;

    readonly double[] _ring;
    int _count;
    int _head;
    double _ema;
    float _acc;

    public double Lo { get; private set; }
    public double Hi { get; private set; }
    public bool Seeded { get; private set; }
    public double Ema => _ema;
    public int Count => _count;

    public PriceHistory(int columns, float visibleSeconds = 35f)
    {
        Columns = Mathf.Max(8, columns);
        _ring = new double[Columns];
        SampleSeconds = visibleSeconds / Columns;
    }

    /// <summary>Sample index 0 is the oldest still in the window.</summary>
    public double SampleAt(int i)
    {
        if (_count == 0) return 0;
        i = Mathf.Clamp(i, 0, _count - 1);
        int start = (_head - _count + Columns * 2) % Columns;
        return _ring[(start + i) % Columns];
    }

    void Push(double v)
    {
        _ring[_head] = v;
        _head = (_head + 1) % Columns;
        if (_count < Columns) _count++;
    }

    public void Feed(double price, float dt)
    {
        if (price <= 0) return;

        if (!Seeded)
        {
            // Seed with a plausible random walk so the terrain has history on
            // frame one rather than a suspiciously perfect flat line.
            double p = price, v = 0;
            var seed = new double[Columns];
            for (int i = 0; i < Columns; i++)
            {
                v = v * 0.86 + Random.Range(-1f, 1f) * price * 0.00006;
                p += v;
                seed[i] = p;
            }
            double drift = price - seed[Columns - 1];
            for (int i = 0; i < Columns; i++) Push(seed[i] + drift * (i / (double)(Columns - 1)));
            Lo = price * 0.997; Hi = price * 1.003;
            _ema = price;
            Seeded = true;
            return;
        }

        // Real ticks arrive as a step function - a flat stretch then a jump.
        // Smoothing turns that into a curve the terrain can actually follow.
        _ema += (price - _ema) * EmaAlpha;

        _acc += dt;
        if (_acc < SampleSeconds) return;
        _acc = 0f;
        Push(_ema);

        double lo = double.MaxValue, hi = double.MinValue;
        for (int i = 0; i < _count; i++)
        {
            double s = SampleAt(i);
            if (s < lo) lo = s;
            if (s > hi) hi = s;
        }
        double pad = System.Math.Max((hi - lo) * WindowPad, price * MinSpanPct);
        // eased so the horizon does not snap when a spike enters or leaves
        Lo += ((lo - pad) - Lo) * 0.28;
        Hi += ((hi + pad) - Hi) * 0.28;
    }

    /// <summary>Price at a column, mapped to 0 (bear low) .. 1 (bull high).</summary>
    public float Normalised(int column)
    {
        if (_count == 0 || Hi <= Lo) return 0.5f;
        double span = Hi - Lo;
        return Mathf.Clamp01((float)((SampleAt(column) - Lo) / span));
    }

    /// <summary>
    /// Frontline z at a world x. Oldest sample sits at the far -x end, so the
    /// chart reads left to right the way a chart should.
    /// </summary>
    public float FrontlineZ(float x, float worldWidth, float worldDepth)
    {
        if (_count == 0) return 0f;
        float t = Mathf.Clamp01(x / worldWidth + 0.5f) * (_count - 1);
        int i0 = Mathf.FloorToInt(t);
        int i1 = Mathf.Min(_count - 1, i0 + 1);
        float f = t - i0;
        float n = Mathf.Lerp(Normalised(i0), Normalised(i1), f);
        // high price pushes the line toward the bear side (+z), so bulls gain ground
        return (n - 0.5f) * worldDepth * 0.72f;
    }
}
