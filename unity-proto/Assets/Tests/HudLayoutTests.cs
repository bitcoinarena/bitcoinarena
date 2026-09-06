using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// NOTHING IN THE DRIVING HUD IS DRAWN ON TOP OF ANYTHING ELSE.
///
/// Photographed on an iPhone at 22:17 on 2026-09-06, four things at once: the
/// block board sat on the dollar sign of the price, the condition bar was laid
/// across the board's own last line, the practice switch was under the centred
/// "BLOCK 965,829 · 2:06", and MUTED and DEBUG were two word-buttons stacked
/// down the right edge.
///
/// There WAS an overlap test. It checked one pair - the condition bar against
/// the block board - at one size, 1600x900, which is neither a phone nor a
/// desktop anybody uses. It was green through all four faults. So this walks
/// every pair of top-level boxes across the shapes the game is actually played
/// at, the way the title screen has been checked since it was drawing over
/// itself.
///
/// The rects come from the same methods the drawing uses. A layout test that
/// recomputes the geometry is testing its own arithmetic.
/// </summary>
public class HudLayoutTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    DriveHud _hud;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        yield return null;
        yield return new WaitForSeconds(0.5f);
        _hud = Object.FindFirstObjectByType<DriveHud>();
        Assert.IsNotNull(_hud, "no HUD in the scene");
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
        UnityEngine.SceneManagement.SceneManager.LoadScene(
            0, UnityEngine.SceneManagement.LoadSceneMode.Single);
        yield return null;
    }

    /// <summary>The shapes it ships at: phones both ways up, laptops, desktops.</summary>
    static readonly Vector2[] Sizes =
    {
        new Vector2(1920, 1080), new Vector2(1600, 900), new Vector2(1366, 768),
        new Vector2(2560, 1440), new Vector2(844, 390),  new Vector2(390, 844),
        new Vector2(1024, 768),  new Vector2(640, 480),
    };

    [Test]
    public void TheLeftColumnIsAColumnAndNothingInItOverlaps()
    {
        foreach (var size in Sizes)
        {
            int w = (int)size.x, h = (int)size.y;
            string at = $"at {w}x{h}";

            float pad = Mathf.Max(10f, h * 0.022f);
            var block = new Rect(pad, pad, Mathf.Min(300f, w * 0.24f) + pad,
                                 _hud.BlockBoxHeight(w, h));
            var health = _hud.HealthBox(w, h);
            var danger = _hud.ExposureBox(w, h);
            var practice = _hud.PracticeBox(w, h);
            var sim = _hud.SimBox(w, h);

            Assert.Greater(block.height, 1f, $"the block board has no height {at}");

            // THE BOX HOLDS WHAT IS DRAWN IN IT. This is the fault the photo
            // showed and the one the old test could not see: the border said
            // 3.20 lines while `DrawBlock` laid out 3.77, so the last line was
            // outside its own frame and the condition bar was on top of it.
            Assert.GreaterOrEqual(block.height, _hud.BlockContentHeight(w, h),
                $"the block board is drawn taller than its own box {at}");

            void Apart(Rect a, Rect b, string what)
                => Assert.IsFalse(a.Overlaps(b), $"{what} overlap {at}: {a} / {b}");

            Apart(block, health, "the block board and the condition bar");
            Apart(block, danger, "the block board and the danger meter");
            Apart(block, practice, "the block board and the practice switch");
            Apart(health, danger, "the condition bar and the danger meter");
            Apart(health, practice, "the condition bar and the practice switch");
            Apart(danger, practice, "the danger meter and the practice switch");
            Apart(practice, sim, "the practice switch and the SIM switch");

            // and it runs DOWN the screen in that order, which is what makes
            // it a column rather than a pile that happens not to touch
            Assert.GreaterOrEqual(health.y, block.yMax, $"condition is not under the block {at}");
            Assert.GreaterOrEqual(danger.y, health.yMax, $"danger is not under condition {at}");
            Assert.GreaterOrEqual(practice.y, danger.yMax, $"practice is not under danger {at}");
        }
    }

    /// <summary>
    /// THE NUMBER THE FIX TURNS ON, printed rather than asserted.
    ///
    /// The old box height was `lh * (3.20 + (rows > 0 ? 1.20 + rows * 0.95 : 0))`
    /// - a pair of constants written next to the drawing rather than derived
    /// from it. This prints that formula beside what `DrawBlock` actually lays
    /// out and what the box claims now, so the shortfall is a figure in the
    /// log and not a story in a commit message.
    ///
    /// Explicit: a measurement, not an assertion.
    /// </summary>
    [Test]
    [Explicit("Measurement, not an assertion. Read the [box] lines.")]
    public void MeasureTheBlockBoxAgainstItsOwnRows()
    {
        foreach (var size in Sizes)
        {
            int w = (int)size.x, h = (int)size.y;
            // the same line height `DrawBlock` uses, from `SmallFont`
            float lh = Mathf.RoundToInt(Mathf.Clamp(Mathf.Min(w, h) * 0.032f, 13f, 20f)) * 1.55f;
            float before = lh * 3.20f;                 // no leaderboard in this fixture
            float content = _hud.BlockContentHeight(w, h);
            float after = _hud.BlockBoxHeight(w, h);
            Debug.Log($"[box] {w}x{h}: claimed before {before:0.0} px, content drawn "
                      + $"{content:0.0} px, short by {content - before:0.0} px "
                      + $"({(before > 0 ? 100f * (content - before) / content : 0f):0.0}% of it "
                      + $"outside the border), claimed now {after:0.0} px, "
                      + $"spare {after - content:0.0} px");
        }
    }

    /// <summary>
    /// The headline is centred in the GAP between the two columns, not across
    /// the whole screen. Centring in the screen is what put "$79,810" on the
    /// block board: on a desktop the columns are far apart and it looks fine,
    /// on a phone they are not.
    /// </summary>
    [Test]
    public void TheHeadlineNeverReachesEitherColumn()
    {
        foreach (var size in Sizes)
        {
            int w = (int)size.x, h = (int)size.y;
            string at = $"at {w}x{h}";

            float pad = Mathf.Max(10f, h * 0.022f);
            var block = new Rect(pad, pad, Mathf.Min(300f, w * 0.24f) + pad,
                                 _hud.BlockBoxHeight(w, h));
            var head = _hud.HeadlineBox(w, h);
            var practice = _hud.PracticeBox(w, h);
            var sound = TouchPad.RectFor(TouchPad.Pad.Sound, w, h);
            var debug = TouchPad.RectFor(TouchPad.Pad.Debug, w, h);

            Assert.GreaterOrEqual(head.x, block.xMax, $"the headline reaches the block {at}");
            Assert.GreaterOrEqual(head.x, practice.xMax,
                $"the headline reaches the practice switch {at}");
            Assert.LessOrEqual(head.xMax, sound.x, $"the headline reaches the settings {at}");
            Assert.LessOrEqual(head.xMax, debug.x, $"the headline reaches the settings {at}");
            Assert.Greater(head.width, 50f, $"the headline has no room left {at}");
        }
    }

    /// <summary>
    /// The two settings controls are icons side by side, not word-buttons
    /// stacked: one row, square, and inside the width the view toggle already
    /// claims, so the right column did not grow to hold them.
    /// </summary>
    [Test]
    public void TheSettingsAreTwoSquareIconsOnOneRow()
    {
        foreach (var size in Sizes)
        {
            int w = (int)size.x, h = (int)size.y;
            string at = $"at {w}x{h}";

            var sound = TouchPad.RectFor(TouchPad.Pad.Sound, w, h);
            var debug = TouchPad.RectFor(TouchPad.Pad.Debug, w, h);
            var view = TouchPad.RectFor(TouchPad.Pad.View, w, h);

            Assert.IsFalse(sound.Overlaps(debug), $"the two settings overlap {at}");
            Assert.IsFalse(sound.Overlaps(view), $"sound overlaps the view toggle {at}");
            Assert.IsFalse(debug.Overlaps(view), $"debug overlaps the view toggle {at}");

            Assert.AreEqual(sound.y, debug.y, 0.01f, $"the icons are not on one row {at}");
            Assert.AreEqual(sound.width, sound.height, 0.01f, $"the sound icon is not square {at}");
            Assert.AreEqual(debug.width, debug.height, 0.01f, $"the debug icon is not square {at}");
            Assert.LessOrEqual(debug.xMax, view.xMax + 0.01f,
                $"the settings row is wider than the view toggle above it {at}");
            Assert.LessOrEqual(sound.yMax, h, $"the settings fall off the bottom {at}");
        }
    }

    /// <summary>
    /// Nothing in the left column runs off the bottom of a short window, which
    /// is the failure a phone in landscape finds first: 390 points of height
    /// with four stacked boxes in it.
    /// </summary>
    [Test]
    public void TheLeftColumnFitsOnAPhoneInLandscape()
    {
        const int w = 844, h = 390;
        var sim = _hud.SimBox(w, h);
        Assert.Less(sim.yMax, h,
            $"the left column runs {sim.yMax - h:0} px off the bottom of an iPhone");

        // and it does not run into the steering pad down there either
        var pad = TouchPad.RectFor(TouchPad.Pad.Left, w, h);
        Assert.IsFalse(sim.Overlaps(pad), $"the SIM switch is on the steering pad: {sim} / {pad}");
    }
}
