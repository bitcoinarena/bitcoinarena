// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// THE FIRST LINK of the strike's voice: the clip itself.
///
/// `a11` says the voice is built and has never been heard. Before anything is
/// blamed on the browser, the audio context or a missing listener, the clip has
/// to be shown to contain something - and it cannot be looked at, because it is
/// synthesised in `Detonation()` rather than imported. So it is measured.
///
/// PlayMode, not EditMode: `GameAudio` builds every clip in `Awake`, and Edit
/// Mode never calls it. The first cut of this ran in EditMode and read a null
/// clip, which said nothing about the sound and everything about the harness.
/// </summary>
public class StrikeVoiceTests
{
    [UnityTearDown]
    public IEnumerator TearDown()
    {
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    [UnityTest]
    public IEnumerator TheDetonationIsNotSilence()
    {
        var a = new GameObject("audio").AddComponent<GameAudio>();
        yield return null;

        var clip = a.StrikeClip;
        Assert.IsNotNull(clip, "kein Detonationsclip");

        var data = new float[clip.samples * clip.channels];
        Assert.IsTrue(clip.GetData(data, 0), "die Sampledaten sind nicht lesbar");

        float peak = 0f, sum = 0f;
        for (int i = 0; i < data.Length; i++)
        {
            float v = data[i] < 0f ? -data[i] : data[i];
            if (v > peak) peak = v;
            sum += data[i] * data[i];
        }
        float rms = Mathf.Sqrt(sum / data.Length);

        Debug.Log($"[voice] detonation {clip.length:F2} s, {clip.channels} ch, " +
                  $"{clip.frequency} Hz, {clip.samples} samples, peak {peak:F4}, rms {rms:F4}");

        // Measured first, then the bar put well under it: peak 0.2495 and rms
        // 0.0452 over 4.50 s, 1 channel, 44100 Hz, 198450 samples. The bar is
        // there to catch a synthesis that collapses to silence, not to record
        // today's exact number.
        Assert.AreEqual(4.5f, clip.length, 0.01f, "die Detonation ist 4,5 s lang");
        Assert.Greater(peak, 0.10f, "der Clip ist so gut wie still");
        Assert.Greater(rms, 0.01f, "der Clip ist so gut wie still");
    }

    /// <summary>
    /// A shot fired while the detonation is still playing must not bend it.
    ///
    /// `pitch` belongs to the AudioSource, not to the one-shot, and `Shot` sets
    /// it before every PlayOneShot. The detonation runs for 4.5 s, so anything
    /// else played on the same source during those seconds re-pitched a sound
    /// that was already in the air - audible, and invisible to every test that
    /// only checks the clip and the trigger. The strike has its own source now.
    /// </summary>
    [UnityTest]
    public IEnumerator AShotDuringTheDetonationDoesNotBendIt()
    {
        var a = new GameObject("audio").AddComponent<GameAudio>();
        yield return null;

        a.Strike();
        float before = a.StrikePitch;
        Assert.AreNotEqual(0f, before, "die Schlagquelle fehlt");

        // everything else that goes through the effects source, at pitches
        // deliberately far from the strike's 0.94-1.02
        a.Pickup(true);          // 1.25
        a.Pickup(false);         // 0.85
        a.Thud();                // 0.9 - 1.2
        a.Delivered();           // 1.0
        a.Explosion();           // 0.85 - 1.1
        yield return null;

        Debug.Log($"[voice] pitch vor {before:F3} nach {a.StrikePitch:F3}");
        Assert.AreEqual(before, a.StrikePitch, 0.0001f,
                        "ein anderer Effekt hat die laufende Detonation verstimmt");
    }
}
