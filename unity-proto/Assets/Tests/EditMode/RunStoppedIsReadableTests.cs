// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE PLAYER IN THE BAY IS TOLD WHY, AND THE LAST WORDS SURVIVE (2026-09-20).
///
/// MEASURED on one build with a VOID forced by starving a tab until its round closed under it:
///   owner-screens/ring-11.png  the ROAD, run VOID, lobby still down - "RUN STOPPED - the node refuses this
///                               run's inputs at tick 7957: error the round" plainly on screen.
///   owner-screens/ring-28.png  the BAY, same build, same VOID - nothing on screen at all.
///
/// Two faults, both on the existing DrawRunStopped path:
///   1. `OnGUI` returned early on the loading branch - `if (loading) { DrawWasted(); return; }` - so in the bay
///      the row was never DRAWN. It was not covered, which is what the geometry first suggested; the call simply
///      never happened. A truck still choosing cargo when the block closes is the path that ends VOID, so the bay
///      is where the line matters most.
///   2. The box was `font * 2.8`. At 1280x800 that is 67 px and the copy wraps to three lines, about 83 px, so it
///      cut at "error the round" and lost "is closed" - the half that answers why.
///
/// These pin the geometry at the size the screenshots were taken at, so neither can go back quietly.
/// </summary>
public class RunStoppedIsReadableTests
{
    const int W = 1280, H = 800;

    /// <summary>The mempool panel's own band, from PackageYard's fractions: 0.10 to 0.51 of the height.</summary>
    const float PanelTop = 0.10f * H, PanelBottom = 0.51f * H;

    static DriveHud Hud(bool bayOpen)
    {
        var go = new GameObject("hud-under-test");
        var hud = go.AddComponent<DriveHud>();
        if (bayOpen)
        {
            var panel = new GameObject("loadout").AddComponent<LoadoutPanel>();
            panel.yard = new GameObject("yard").AddComponent<PackageYard>();
            panel.Open();
            hud.loadout = panel;
        }
        return hud;
    }

    [Test]
    public void OnTheRoadTheRowKeepsTheSpotTheScreenshotShows()
    {
        var hud = Hud(bayOpen: false);
        var box = hud.RunStoppedBox(W, H);
        Assert.Less(box.y, PanelBottom, "with no cargo panel open the row stays under the block clock, as ring-11 shows");
        Assert.Greater(box.y, 0f);
        Object.DestroyImmediate(hud.gameObject);
    }

    /// <summary>
    /// THE BAY CASE. The row must have somewhere to be that the cargo panel is not already using - the panel runs
    /// from 0.10 to 0.51 of the height, and the box used to sit at y 326..393, wholly inside it.
    /// </summary>
    [Test]
    public void InTheBayTheRowStepsClearOfTheCargoPanel()
    {
        var hud = Hud(bayOpen: true);
        var box = hud.RunStoppedBox(W, H);
        Assert.GreaterOrEqual(box.y, PanelBottom,
            $"the row starts at y {box.y:0} and the mempool panel ends at {PanelBottom:0} - it would be behind it");
        Assert.Less(box.yMax, H, "and it still has to be on the screen");
        Object.DestroyImmediate(hud.gameObject);
    }

    /// <summary>
    /// THE LAST WORDS. Three wrapped lines at this size need about 83 px; the box was 67. The copy is not
    /// shortened to fit - the box is the thing that gives.
    /// </summary>
    [Test]
    public void TheBoxHoldsTheWholeSentence()
    {
        var hud = Hud(bayOpen: false);
        float font = Mathf.RoundToInt(Mathf.Min(W, H) * 0.030f);
        float threeLines = font * 3f * 1.15f;
        Assert.GreaterOrEqual(hud.RunStoppedBox(W, H).height, threeLines,
            "the box must hold three wrapped lines, or the sentence dies at \"error the round\" and the player "
            + "never reads \"is closed\"");
        Object.DestroyImmediate(hud.gameObject);
    }

    /// <summary>
    /// AND THE REASON MUST OUTLAST THE POLL. Measured in the bay: 0.6 s between the VOID and the lobby, against a
    /// 0.5 s reason poll, so the row appeared or did not depending on which landed first - bay-04.png has the
    /// line, bayok-27.png is the same state with nothing on screen. The hold now starts when the reason is known.
    /// </summary>
    [Test]
    public void TheHoldWaitsForTheReasonSoTheRowHasTimeToBeRead()
    {
        Assert.IsFalse(SplashScreen.HoldMayStart(coreNamed: false, haveReason: false, sinceEnded: 0f),
            "starting the hold before the reason exists spends it on an empty string");
        Assert.IsTrue(SplashScreen.HoldMayStart(false, true, 0f), "with the reason known, the hold starts");
        Assert.IsTrue(SplashScreen.HoldMayStart(true, false, 0f), "a core-named outcome needs no wire reason");
    }

    /// <summary>The guard: a reason that never arrives must never strand the player on a dead screen.</summary>
    [Test]
    public void AReasonThatNeverComesStillLetsThePlayerGo()
    {
        Assert.IsFalse(SplashScreen.HoldMayStart(false, false, SplashScreen.ReasonWaitSeconds - 0.01f));
        Assert.IsTrue(SplashScreen.HoldMayStart(false, false, SplashScreen.ReasonWaitSeconds));
    }

    /// <summary>
    /// AND IT STILL FITS ON A PHONE, which is where the Daily is actually played.
    ///
    /// The box is no longer a fixed multiple of the font - `CalcHeight` sizes it from the sentence - so a long
    /// reason could in principle be pushed off the bottom of a small screen. At 390x844 the row starts at about
    /// y 169 on the road and y 438 in the bay (the mempool panel ends at 0.51 x 844 = 430), leaving 675 px and
    /// 406 px of screen under it, against the eight lines a long reason needs. This pins that room so a future
    /// change cannot quietly push the reason off a phone.
    /// </summary>
    [Test]
    public void OnAPhoneThereIsStillRoomForTheWholeReason()
    {
        const int PW = 390, PH = 844;
        float font = Mathf.RoundToInt(Mathf.Min(PW, PH) * 0.030f);
        foreach (var bay in new[] { false, true })
        {
            var hud = Hud(bayOpen: bay);
            var box = hud.RunStoppedBox(PW, PH);
            Assert.Less(box.y, PH, $"bay={bay}: the row starts off the bottom of the screen at y {box.y:0}");
            Assert.GreaterOrEqual(PH - box.y, font * 8f,
                $"bay={bay}: only {PH - box.y:0} px under the row at 390x844, and a long reason needs about "
                + $"{font * 8f:0} - the last words would fall off a phone");
            Object.DestroyImmediate(hud.gameObject);
        }
    }
}
