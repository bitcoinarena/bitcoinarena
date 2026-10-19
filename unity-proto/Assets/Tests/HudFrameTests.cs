// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.IO;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// A FRAME, NOT ARITHMETIC.
///
/// Everything else about this HUD is rectangles checked against rectangles.
/// That catches a box on a box and it cannot catch a box that is empty, a
/// glyph the font does not have, or text that runs out of a box the right
/// size. This renders the thing and writes the pixels out.
///
/// It needs a graphics device, so it is Explicit: the suite runs headless with
/// `-nographics` and captures nothing there. Run it deliberately, WITHOUT
/// `-nographics` and with `-screen-width` / `-screen-height` set to the shape
/// being checked. This machine has an X server on :0 and Unity brings up an
/// OpenGL 4.6 device on it - an earlier note in TASKBOOK said otherwise and
/// was out of date.
///
/// The blank-frame trap is guarded: a RenderTexture under `-nographics` wrote
/// a uniform grey PNG once in this project and it was nearly reported as a
/// still. A capture with no variance is a failure here, not a picture.
/// </summary>
public class HudFrameTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    [UnityTest]
    [Explicit("Needs a graphics device. Run without -nographics.")]
    public IEnumerator CaptureTheDrivingHud()
    {
        // ASK FOR THE SHAPE. `-screen-width` / `-screen-height` are player
        // arguments; in the editor the Game view decides its own size and
        // ignores them, which is why the first capture came back 733x293 when
        // 844x390 was asked for. `Screen.SetResolution` is the runtime request
        // - whether the editor honours it is measured below, not assumed.
        string want = System.Environment.GetEnvironmentVariable("HUD_SHOT_SIZE");
        if (!string.IsNullOrEmpty(want))
        {
            var parts = want.Split('x');
            if (parts.Length == 2 && int.TryParse(parts[0], out int ww)
                                  && int.TryParse(parts[1], out int hh))
            {
                Screen.SetResolution(ww, hh, false);
                for (int i = 0; i < 30; i++) yield return null;
                Debug.Log($"[frame] asked for {ww}x{hh}, screen reports "
                          + $"{Screen.width}x{Screen.height}");
            }
        }

        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        yield return null;
        yield return new WaitForSeconds(1.5f);

        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();
        yield return null;

        // A load aboard, so the wanted row, the condition bar and the danger
        // meter all have something to say.
        var panel = Object.FindFirstObjectByType<LoadoutPanel>();
        if (panel != null) { panel.Auto(); panel.Confirm(); }
        yield return new WaitForSeconds(1.5f);

        var hud = Object.FindFirstObjectByType<DriveHud>();
        Assert.IsNotNull(hud, "no HUD to photograph");

        // `WaitForEndOfFrame` is never evoked in batchmode, and
        // `CaptureScreenshotAsTexture` has to be called there - so the file
        // route is used instead: `CaptureScreenshot` writes after the next
        // frame is presented, and the picture is read back off the disk.
        string outDir = System.Environment.GetEnvironmentVariable("HUD_SHOT_DIR");
        if (string.IsNullOrEmpty(outDir)) outDir = Application.temporaryCachePath;
        Directory.CreateDirectory(outDir);
        string file = Path.Combine(outDir, $"hud-{Screen.width}x{Screen.height}.png");
        if (File.Exists(file)) File.Delete(file);

        ScreenCapture.CaptureScreenshot(file);
        for (int i = 0; i < 240 && !File.Exists(file); i++) yield return null;
        Assert.IsTrue(File.Exists(file), "the capture never landed on disk");
        yield return null;

        var shot = new Texture2D(2, 2);
        Assert.IsTrue(shot.LoadImage(File.ReadAllBytes(file)), "the capture is not a PNG");

        int w = shot.width, h = shot.height;
        var px = shot.GetPixels32();

        // NOT A BLANK: count how many distinct 5-bit colours are in it and how
        // far the brightest is from the darkest. A grey rectangle scores one
        // and zero.
        var seen = new System.Collections.Generic.HashSet<int>();
        int min = 255, max = 0;
        foreach (var p in px)
        {
            seen.Add(((p.r >> 3) << 10) | ((p.g >> 3) << 5) | (p.b >> 3));
            int lum = (p.r * 30 + p.g * 59 + p.b * 11) / 100;
            if (lum < min) min = lum;
            if (lum > max) max = lum;
        }

        string path = file;
        Debug.Log($"[frame] {w}x{h} written to {path}: {seen.Count} distinct colours, "
                  + $"luminance {min}..{max}");

        Assert.Greater(seen.Count, 200,
            $"only {seen.Count} distinct colours - this is a blank, not a frame");
        Assert.Greater(max - min, 60,
            $"luminance runs {min}..{max} - this is a flat fill, not a frame");
    }
}
