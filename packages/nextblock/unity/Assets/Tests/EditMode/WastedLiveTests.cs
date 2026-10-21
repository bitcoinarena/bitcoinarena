// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// KANBAN (2026-10-04 15:16: "Remove the WASTED text after a few seconds. Spectate stays"): in a live round the
/// WASTED band holds 3 s from the wreck and fades out over 0.5 s - it no longer holds until the lobby.
/// </summary>
public class WastedLiveTests
{
    const float In = 0.7f, Hold = 3f, Out = 0.5f;
    static float K(float t) => WastedSequence.LiveIntensity(t, In, Hold, Out);

    [Test]
    public void TheBandComesUpThenHoldsThreeSecondsThenFadesOverHalfASecond()
    {
        Assert.AreEqual(0f, K(0f), 1e-4f, "up at once instead of over the fade-in");
        Assert.AreEqual(1f, K(1f), 1e-4f, "not up one second after the wreck");
        Assert.AreEqual(1f, K(3f), 1e-4f, "gone before the 3 s hold is over");
        Assert.AreEqual(0.5f, K(3.25f), 1e-4f, "not half way out half way through the fade");
        Assert.AreEqual(0f, K(3.5f), 1e-4f, "still up after hold and fade");
        Assert.AreEqual(0f, K(30f), 1e-4f, "back up long after: it held until the lobby");
    }

    [Test]
    public void TheDefaultsAreTheRuledOnes()
    {
        var go = new UnityEngine.GameObject("w");
        try
        {
            var w = go.AddComponent<WastedSequence>();
            Assert.AreEqual(3f, w.holdSeconds, 1e-4f);
            Assert.AreEqual(0.5f, w.fadeOutSeconds, 1e-4f);
        }
        finally { UnityEngine.Object.DestroyImmediate(go); }
    }
}
