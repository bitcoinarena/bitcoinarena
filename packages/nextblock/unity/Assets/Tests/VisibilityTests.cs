// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// Renders the scene into a texture and counts pixels.
///
/// Three separate "I can't see it" reports in this port were all invisibility
/// bugs - a back-faced road, culled instances - that every logic test passed
/// straight through. Geometry being CORRECT and geometry being VISIBLE are
/// different claims, and only this checks the second one.
/// </summary>
public class VisibilityTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    const int W = 320, H = 200;

    /// <summary>
    /// Scenes must not leak between tests. Without this the second test builds
    /// a SECOND world, and GameObject.Find hands back the first one's roads -
    /// so disabling them changes nothing and the test reads 0% either way.
    /// </summary>
    [UnityTearDown]
    public IEnumerator TearDown()
    {
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    /// <summary>Render a camera into a texture and return its pixels.</summary>
    static Color32[] Shoot(Camera cam)
    {
        var rt = new RenderTexture(W, H, 24) { antiAliasing = 1 };
        var prev = cam.targetTexture;
        cam.targetTexture = rt;
        cam.Render();

        var active = RenderTexture.active;
        RenderTexture.active = rt;
        var tex = new Texture2D(W, H, TextureFormat.RGBA32, false);
        tex.ReadPixels(new Rect(0, 0, W, H), 0, 0);
        tex.Apply();
        RenderTexture.active = active;

        cam.targetTexture = prev;
        var px = tex.GetPixels32();
        Object.DestroyImmediate(tex);
        rt.Release();
        Object.DestroyImmediate(rt);
        return px;
    }

    static int Differences(Color32[] a, Color32[] b, int threshold = 14)
    {
        int n = 0;
        for (int i = 0; i < a.Length; i++)
            if (Mathf.Abs(a[i].r - b[i].r) + Mathf.Abs(a[i].g - b[i].g) + Mathf.Abs(a[i].b - b[i].b) > threshold) n++;
        return n;
    }

    [UnityTest]
    public IEnumerator ArmiesAreActuallyDrawn()
    {
        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(2.5f);

        var field = Object.FindFirstObjectByType<Battlefield>();
        var renderer = Object.FindFirstObjectByType<ArmyRenderer>();
        Assert.IsNotNull(field?.Army, "keine Armee");
        Assert.IsNotNull(renderer, "kein Renderer");

        // look down at the seam from above, where the fighting is
        var camGo = new GameObject("Probe");
        var cam = camGo.AddComponent<Camera>();
        cam.transform.position = new Vector3(0f, 70f, -70f);
        cam.transform.LookAt(new Vector3(0f, 0f, 0f));
        cam.fieldOfView = 60f;
        cam.farClipPlane = 900f;

        // submit and render in the same frame: batch mode never fires
        // WaitForEndOfFrame, so a submission cannot be caught any other way
        yield return null;
        renderer.Submit();
        var withArmies = Shoot(cam);

        var armour = new System.Collections.Generic.List<Army.Unit>(field.Army.Armour);
        var infantry = new System.Collections.Generic.List<Army.Unit>(field.Army.Infantry);
        field.Army.Armour.Clear();
        field.Army.Infantry.Clear();
        yield return null;
        renderer.Submit();
        var without = Shoot(cam);

        field.Army.Armour.AddRange(armour);
        field.Army.Infantry.AddRange(infantry);

        int changed = Differences(withArmies, without);
        float pct = 100f * changed / withArmies.Length;
        Debug.Log($"[VisibilityTests] Einheiten belegen {pct:0.0}% des Bildes ({changed} Pixel)");

        Assert.Greater(pct, 0.4f,
            $"die Armeen veraendern nur {pct:0.00}% des Bildes - sie werden nicht gezeichnet");
        Object.DestroyImmediate(camGo);
    }

    [UnityTest]
    public IEnumerator RoadsAreActuallyDrawn()
    {
        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(2.5f);

        var roads = Object.FindFirstObjectByType<RoadNetwork>();
        Assert.IsNotNull(roads);

        var camGo = new GameObject("Probe");
        var cam = camGo.AddComponent<Camera>();
        cam.transform.position = new Vector3(0f, 90f, -60f);
        cam.transform.LookAt(new Vector3(0f, 0f, 20f));
        cam.farClipPlane = 900f;

        yield return null;
        var withRoads = Shoot(cam);

        foreach (var lane in RoadModel.Order)
            GameObject.Find($"Road_{lane}").GetComponent<MeshRenderer>().enabled = false;
        yield return null;
        var without = Shoot(cam);

        int changed = Differences(withRoads, without);
        float pct = 100f * changed / withRoads.Length;
        Debug.Log($"[VisibilityTests] Strassen belegen {pct:0.0}% des Bildes ({changed} Pixel)");
        Assert.Greater(pct, 1f, $"die Strassen veraendern nur {pct:0.00}% des Bildes");
        Object.DestroyImmediate(camGo);
    }
}
