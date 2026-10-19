// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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

    /// <summary>
    /// The five the chrome is checked at: four that a player build presents
    /// and 733x293, the one the editor's Game view actually shows, so a
    /// captured frame and the arithmetic are talking about the same set.
    /// </summary>
    static readonly Vector2[] Five =
    {
        new Vector2(1920, 1080), new Vector2(1024, 768), new Vector2(844, 390),
        new Vector2(1000, 360),  new Vector2(733, 293),
    };

    /// <summary>The shapes it ships at: phones both ways up, laptops, desktops.</summary>
    static readonly Vector2[] Sizes =
    {
        new Vector2(1920, 1080), new Vector2(1600, 900), new Vector2(1366, 768),
        new Vector2(2560, 1440), new Vector2(844, 390),  new Vector2(390, 844),
        new Vector2(1024, 768),  new Vector2(640, 480),

        // A WIDE, SHORT BROWSER WINDOW, and it is here for a reason rather
        // than for a round number. The diagnostics panel is `min(320, w*0.34)`
        // and the practice switch is `min(w*0.52, 300)`, so above about 940 px
        // wide the panel is at its cap and the switch is at its own - and
        // their pads differ, one from the height and one from a floor. At a
        // short height the condition bar is then the widest thing in the
        // column by 18 px, which no other shape in this list shows.
        new Vector2(1000, 360),
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
            var warn = _hud.ExposureWarningBox(w, h);
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
            Apart(danger, warn, "the danger meter and its warning");
            Apart(warn, practice, "the exposure warning and the practice switch");
            Apart(warn, sim, "the exposure warning and the SIM switch");
            Apart(warn, block, "the exposure warning and the block board");
            Apart(warn, health, "the exposure warning and the condition bar");
            Apart(practice, sim, "the practice switch and the SIM switch");

            // and it runs DOWN the screen in that order, which is what makes
            // it a column rather than a pile that happens not to touch
            Assert.GreaterOrEqual(health.y, block.yMax, $"condition is not under the block {at}");
            Assert.GreaterOrEqual(danger.y, health.yMax, $"danger is not under condition {at}");
            Assert.GreaterOrEqual(warn.y, danger.yMax, $"the warning is not under danger {at}");
            Assert.GreaterOrEqual(practice.y, warn.yMax, $"practice is not under the warning {at}");
            Assert.AreEqual(health.x, warn.x, 0.01f, $"the warning left the column {at}");
            Assert.AreEqual(health.width, warn.width, 0.01f,
                $"the warning is not the column's width {at}");
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
            var sound = _hud.SettingsRect(TouchPad.Pad.Sound, w, h);
            var debug = _hud.SettingsRect(TouchPad.Pad.Debug, w, h);

            // EVERY box in the column, not the two widest-looking ones. The
            // condition bar inherits the diagnostics panel's fixed 320 px and
            // is the widest thing in the column on a narrow window - 329.6
            // against the practice switch's 312 at 640x480 - so a left edge
            // measured from the block board and the switch alone is short
            // exactly where the window is smallest.
            var health = _hud.HealthBox(w, h);
            var danger = _hud.ExposureBox(w, h);
            Assert.GreaterOrEqual(head.x, block.xMax, $"the headline reaches the block {at}");
            Assert.GreaterOrEqual(head.x, practice.xMax,
                $"the headline reaches the practice switch {at}");
            Assert.GreaterOrEqual(head.x, health.xMax,
                $"the headline reaches the condition bar {at}");
            Assert.GreaterOrEqual(head.x, danger.xMax,
                $"the headline reaches the danger meter {at}");
            Assert.LessOrEqual(head.xMax, sound.x, $"the headline reaches the settings {at}");
            Assert.LessOrEqual(head.xMax, debug.x, $"the headline reaches the settings {at}");
            // A gap or nothing, never a fiction.
            Assert.IsTrue(head.width == 0f || head.width >= DriveHud.UsableGap,
                $"the headline claims {head.width:0} px, which is neither a gap nor nothing {at}");
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

            var sound = _hud.SettingsRect(TouchPad.Pad.Sound, w, h);
            var debug = _hud.SettingsRect(TouchPad.Pad.Debug, w, h);
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
    /// The corners and the DEBUG column, printed so the fix is a table.
    /// Explicit: a measurement, not an assertion.
    /// </summary>
    [Test]
    [Explicit("Measurement, not an assertion. Read the [corner] and [debug] lines.")]
    public void MeasureTheCornersAndTheDebugColumn()
    {
        foreach (var size in Sizes)
        {
            int w = (int)size.x, h = (int)size.y;
            var wanted = _hud.WantedBox(w, h);
            var head = _hud.HeadlineBox(w, h);
            var fire = _hud.UnderFireBox(w, h);
            Debug.Log($"[corner] {w}x{h}: wanted before 0..{w - Mathf.Max(10f, h * 0.025f):0} "
                      + $"(the whole screen), now {wanted.x:0}..{wanted.xMax:0}; "
                      + $"UNDER FIRE before 0..{w} now {fire.x:0}..{fire.xMax:0}; "
                      + $"headline gap {head.x:0}..{head.xMax:0} ({head.width:0} px)");
        }

        foreach (var size in new[] { new Vector2(1920, 1080), new Vector2(1024, 768),
                                     new Vector2(844, 390),   new Vector2(1000, 360) })
        {
            int w = (int)size.x, h = (int)size.y;
            var liq = _hud.LiquidationBox(w, h);
            var clock = _hud.BlockTimerBox(w, h);
            var health = _hud.HealthBox(w, h);
            var wanted = _hud.WantedBox(w, h);
            var send = _hud.SendOffBox(w, h);
            var arrive = _hud.ArrivalBox(w, h);
            Debug.Log($"[liq] {w}x{h}: line {liq.x:0}..{liq.xMax:0} x {liq.y:0}..{liq.yMax:0}; "
                      + $"clear of the column by {liq.x - health.xMax:0} px, of the wanted row "
                      + $"by {wanted.x - liq.xMax:0} px, of the block clock by "
                      + $"{clock.y - liq.yMax:0} px");
            var man = _hud.ManifestBox(w, h);
            var wanted2 = _hud.WantedBox(w, h);
            var str2 = _hud.StreamingBox(w, h, 11);
            Debug.Log($"[stream] {w}x{h}: {str2.x:0}..{str2.xMax:0} x {str2.y:0}..{str2.yMax:0}; "
                      + $"below the block clock by {str2.y - _hud.BlockTimerBox(w, h).yMax:0} px, "
                      + $"left of the score column by {man.x - str2.xMax:0} px, bottom "
                      + $"{h - str2.yMax:0} px above the screen edge");
            Debug.Log($"[manifest] {w}x{h}: {man.x:0}..{man.xMax:0} x {man.y:0}..{man.yMax:0}; "
                      + $"width {man.width:0} px, SIM ends {_hud.SimBox(w, h).yMax:0}; "
                      + $"top clear of the screen edge by {man.y:0} px, of the wanted row by "
                      + $"{man.y - wanted2.yMax:0} px, of the block clock by "
                      + $"{man.y - _hud.BlockTimerBox(w, h).yMax:0} px");
            Debug.Log($"[cards] {w}x{h}: send-off {send.y:0}..{send.yMax:0}, arrival "
                      + $"{arrive.y:0}..{arrive.yMax:0}, they share "
                      + $"{Mathf.Max(0f, Mathf.Min(send.yMax, arrive.yMax) - Mathf.Max(send.y, arrive.y)):0}"
                      + $" px of height - gated, never both drawn");
        }

        _hud.showDiagnostics = true;
        try
        {
            foreach (var size in new[] { new Vector2(1920, 1080), new Vector2(1366, 768),
                                         new Vector2(844, 390), new Vector2(640, 480) })
            {
                int w = (int)size.x, h = (int)size.y;
                Debug.Log($"[debug] {w}x{h} with DEBUG on: diag ends {_hud.DiagnosticsBox(w, h).yMax:0}, "
                          + $"condition {_hud.HealthBox(w, h).y:0}, danger {_hud.ExposureBox(w, h).y:0}, "
                          + $"practice {_hud.PracticeBox(w, h).y:0}, SIM ends {_hud.SimBox(w, h).yMax:0} "
                          + $"of {h}");
            }
        }
        finally { _hud.showDiagnostics = false; }
    }

    /// <summary>
    /// THE REST OF THE HUD, which the first cut of this file could not see.
    ///
    /// The wanted row, the UNDER FIRE banner and the streaming list sit in the
    /// same corners the column and the headline do, and none of them had a
    /// rect anyone could ask for. The wanted row turned out to be the price's
    /// mistake again - `Rect(0, pad, w - pad, ...)`, the width of the screen
    /// with the text pushed right - so nothing could be checked against it.
    ///
    /// The two CARDS are deliberately in front of the game for a few seconds
    /// and are checked against each other and the screen, not against the
    /// column: a send-off that dodged the block board would be a worse card.
    /// </summary>
    [Test]
    public void TheCornersAndBannersClearTheColumn()
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
            var wanted = _hud.WantedBox(w, h);
            var fire = _hud.UnderFireBox(w, h);
            var stream = _hud.StreamingBox(w, h, 11);       // the full model list
            var head = _hud.HeadlineBox(w, h);

            void Apart(Rect a, Rect b, string what)
                => Assert.IsFalse(a.Overlaps(b), $"{what} overlap {at}: {a} / {b}");

            // the wanted row is a corner, and corners do not touch the column
            Apart(wanted, block, "the wanted row and the block board");
            Apart(wanted, health, "the wanted row and the condition bar");
            Apart(wanted, danger, "the wanted row and the danger meter");
            Apart(wanted, practice, "the wanted row and the practice switch");
            // Either there is a usable gap and the row clears it, or there is
            // no gap and the headline is not drawn - a phone held upright has
            // the practice switch taking 52% of its width, and the columns
            // meet in the middle.
            if (head.width > 0f)
                Assert.GreaterOrEqual(wanted.x, head.xMax,
                    $"the wanted row reaches into the headline {at}");
            else
                Assert.AreEqual(0f, head.width, 0.01f,
                    $"the headline claims room it has not got {at}");
            Assert.LessOrEqual(wanted.xMax, w, $"the wanted row is off the right edge {at}");

            // the streaming list is the other right-hand thing
            Apart(stream, block, "the streaming list and the block board");
            Apart(stream, health, "the streaming list and the condition bar");
            Apart(stream, danger, "the streaming list and the danger meter");
            Apart(stream, practice, "the streaming list and the practice switch");
            Apart(stream, wanted, "the streaming list and the wanted row");

            // UNDER FIRE is a banner across the middle. It may cross the
            // headline - that is the point of a banner - but it must not be
            // laid over the numbers the driver reads on the left.
            Apart(fire, block, "the UNDER FIRE banner and the block board");
            Apart(fire, health, "the UNDER FIRE banner and the condition bar");
            Apart(fire, danger, "the UNDER FIRE banner and the danger meter");

            // IRRADIATED is the same shape of banner and was the fourth
            // full-width box in the file. The WASTED scrim is not checked: it
            // is deliberately the width of the screen, behind a word the size
            // of the screen, on a run that has already ended.
            var rads = _hud.IrradiatedBox(w, h);
            Apart(rads, block, "the IRRADIATED banner and the block board");
            Apart(rads, health, "the IRRADIATED banner and the condition bar");
            Apart(rads, danger, "the IRRADIATED banner and the danger meter");
            Apart(rads, practice, "the IRRADIATED banner and the practice switch");

            // and the two cards never draw at the same instant as each other
            var send = _hud.SendOffBox(w, h);
            var arrive = _hud.ArrivalBox(w, h);
            Assert.LessOrEqual(send.xMax, w, $"the send-off card is off the edge {at}");
            Assert.LessOrEqual(arrive.yMax, h, $"the arrival card is off the bottom {at}");
            Assert.Greater(send.width, 60f, $"the send-off card has no width {at}");
        }
    }

    /// <summary>
    /// THE LIQUIDATION LINE, which is the last thing in the headline stack
    /// with no rect of its own.
    ///
    /// It reads "LIQUIDATED $12.4M · binance" and it is the line that tells
    /// the player what the crater in front of him was. It sits under the
    /// ticker, in the gap - so it has three neighbours to clear: the rows
    /// above and below it in its own stack, the column on the left, and the
    /// wanted row on the right.
    /// </summary>
    [Test]
    public void TheLiquidationLineClearsItsNeighbours()
    {
        foreach (var size in new[] { new Vector2(1920, 1080), new Vector2(1024, 768),
                                     new Vector2(844, 390),   new Vector2(1000, 360) })
        {
            int w = (int)size.x, h = (int)size.y;
            string at = $"at {w}x{h}";

            var liq = _hud.LiquidationBox(w, h);
            var clock = _hud.BlockTimerBox(w, h);
            var health = _hud.HealthBox(w, h);
            var danger = _hud.ExposureBox(w, h);
            var practice = _hud.PracticeBox(w, h);
            var wanted = _hud.WantedBox(w, h);
            var head = _hud.HeadlineBox(w, h);

            if (head.width <= 0f)
            {
                Assert.AreEqual(0f, liq.width, 0.01f,
                    $"there is no gap here, so the line must not claim one {at}");
                continue;
            }

            void Apart(Rect a, Rect b, string what)
                => Assert.IsFalse(a.Overlaps(b), $"{what} overlap {at}: {a} / {b}");

            Apart(liq, health, "the liquidation line and the condition bar");
            Apart(liq, danger, "the liquidation line and the danger meter");
            Apart(liq, practice, "the liquidation line and the practice switch");
            Apart(liq, wanted, "the liquidation line and the wanted row");
            Apart(liq, clock, "the liquidation line and the block clock");

            // its own stack: the ticker above it and the clock below
            float ticker = _hud.HeadlineRowY(w, h, 1);
            Assert.Greater(liq.y, ticker, $"the liquidation line is above the ticker {at}");
            Assert.Greater(clock.y, liq.y, $"the block clock is above the liquidation line {at}");
            Assert.LessOrEqual(liq.yMax, h, $"the liquidation line is off the bottom {at}");
            // and the row is tall enough for the line drawn in it
            float sub = Mathf.RoundToInt(Mathf.Min(w, h) * 0.045f);
            Assert.GreaterOrEqual(liq.height, sub,
                $"the liquidation row is shorter than the text in it {at}");
        }
    }

    /// <summary>
    /// EVERY COMBINATION OF THE TWO DEBUG PANELS against the numbers.
    ///
    /// There are two of them and they are independent: the F1 diagnostics box
    /// top left, and the readout that hangs from the debug icon top right. The
    /// condition bar stacks under the first and the score column under the
    /// second, so the four states are four different layouts and only two had
    /// ever been walked.
    /// </summary>
    [Test]
    public void NeitherDebugPanelEverCoversTheScoreOrTheClock()
    {
        foreach (var size in Five)
        {
            int w = (int)size.x, h = (int)size.y;
            foreach (bool dbg in new[] { false, true })
                foreach (bool f1 in new[] { false, true })
                {
                    GameSettings.Debug = dbg;
                    _hud.showDiagnostics = f1;
                    try
                    {
                        string at = $"at {w}x{h} debug={dbg} f1={f1}";
                        var man = _hud.ManifestBox(w, h);
                        var clock = _hud.BlockTimerBox(w, h);
                        var health = _hud.HealthBox(w, h);
                        var diag = _hud.DiagnosticsBox(w, h);
                        var read = _hud.DebugPanelBox(w, h, 8);

                        void Apart(Rect a, Rect b, string what)
                            => Assert.IsFalse(a.Overlaps(b), $"{what} overlap {at}: {a} / {b}");

                        Apart(health, man, "the condition bar and the score column");
                        Apart(health, clock, "the condition bar and the block clock");
                        if (f1)
                        {
                            Apart(diag, man, "the F1 panel and the score column");
                            Apart(diag, clock, "the F1 panel and the block clock");
                        }
                        // An empty rect means the readout is not drawn here at
                        // all - there was not room for it and the score both.
                        if (dbg && read.height > 0f)
                        {
                            Apart(read, man, "the corner readout and the score column");
                            Apart(read, clock, "the corner readout and the block clock");
                        }
                        Assert.LessOrEqual(man.yMax, h, $"the score column leaves the screen {at}");

                        if (w == 844 && h == 390)
                            Debug.Log($"[panels] debug={dbg} f1={f1}: F1 {diag.x:0},{diag.y:0} "
                                      + $"{diag.width:0}x{diag.height:0}; readout {read.x:0},"
                                      + $"{read.y:0} {read.width:0}x{read.height:0}; condition "
                                      + $"{health.x:0},{health.y:0} {health.width:0}x{health.height:0}; "
                                      + $"score {man.x:0},{man.y:0} {man.width:0}x{man.height:0}; "
                                      + $"clock {clock.x:0},{clock.y:0} {clock.width:0}x{clock.height:0}");
                    }
                    finally { GameSettings.Debug = false; _hud.showDiagnostics = false; }
                }
        }
    }

    /// <summary>
    /// THE LAST OF THE CHROME: the debug readout and the two cards, against
    /// every number the driver reads.
    ///
    /// The debug panel is the SECOND debug thing on this screen - the F1
    /// diagnostics box is top left and the condition bar already stacks under
    /// it; this one is gated on the debug icon and lands in the corner the
    /// score column was pushed into. The cards are deliberately in front of
    /// the game for a few seconds, so what matters is that they do not cover
    /// a CONTROL the player might be reaching for while they are up.
    /// </summary>
    [Test]
    public void TheDebugPanelAndTheCardsClearTheControlsAndTheNumbers()
    {
        foreach (var size in Five)
        {
            int w = (int)size.x, h = (int)size.y;
            string at = $"at {w}x{h}";

            var dbg = _hud.DebugPanelBox(w, h, 8);          // the core-driving case

            // TRY/FINALLY, because a failing assertion left this static set
            // and the next four tests measured a HUD with the debug readout up
            // that they never asked for - two of them went red for it.
            GameSettings.Debug = true;
            try
            {
            var man = _hud.ManifestBox(w, h);
            var wanted = _hud.WantedBox(w, h);
            var clock = _hud.BlockTimerBox(w, h);
            var liq = _hud.LiquidationBox(w, h);
            var list = _hud.StreamingBox(w, h, 11);
            var practice = _hud.PracticeBox(w, h);
            var sim = _hud.SimBox(w, h);
            var health = _hud.HealthBox(w, h);
            var warn = _hud.ExposureWarningBox(w, h);
            var send = _hud.SendOffBox(w, h);
            var arrive = _hud.ArrivalBox(w, h);

            void Apart(Rect a, Rect b, string what)
                => Assert.IsFalse(a.Overlaps(b), $"{what} overlap {at}: {a} / {b}");

            if (dbg.height > 0f) {
            Apart(dbg, man, "the debug readout and the score column");
            Apart(dbg, wanted, "the debug readout and the wanted row");
            Apart(dbg, clock, "the debug readout and the block clock");
            Apart(dbg, liq, "the debug readout and the liquidation line");
            Apart(dbg, list, "the debug readout and the model list");
            Apart(dbg, health, "the debug readout and the condition bar");
            Apart(dbg, practice, "the debug readout and the practice switch");
            Assert.LessOrEqual(dbg.yMax, h, $"the debug readout runs off the bottom {at}");
            }

            // THE ROWS FIT THE PANELS. The block board claimed 3.20 lines and
            // drew 3.77; both of these are built from a line count the same
            // way, so both are asked whether the box holds what goes in it.
            if (dbg.height > 0f)
                Assert.GreaterOrEqual(dbg.height, _hud.DebugPanelContentHeight(w, h, 8) - 0.01f,
                    $"the debug readout is drawn taller than its own box {at}");
            var f1 = _hud.DiagnosticsBox(w, h);
            Assert.GreaterOrEqual(f1.height, _hud.DiagnosticsContentHeight(w, h, 11) - 0.01f,
                $"the F1 panel is drawn taller than its own box {at}");

            // The cards may cover the SCENE - that is what a card is - but not
            // the controls, and not the two numbers that say whether the run
            // is still alive.
            // the model list stands aside while a card is up, so they are not
            // measured against each other - that is a gate, asserted below
            Apart(send, practice, "the send-off card and the practice switch");
            Apart(send, man, "the send-off card and the score column");
            Apart(send, wanted, "the send-off card and the wanted row");
            Apart(send, clock, "the send-off card and the block clock");
            Apart(send, liq, "the send-off card and the liquidation line");
            Apart(arrive, man, "the arrival card and the score column");
            Apart(arrive, wanted, "the arrival card and the wanted row");
            Apart(arrive, clock, "the arrival card and the block clock");
            Apart(arrive, liq, "the arrival card and the liquidation line");
            Apart(send, sim, "the send-off card and the SIM switch");
            Apart(send, health, "the send-off card and the condition bar");
            Apart(send, warn, "the send-off card and the exposure warning");
            Apart(arrive, practice, "the arrival card and the practice switch");
            Apart(arrive, sim, "the arrival card and the SIM switch");
            Apart(arrive, health, "the arrival card and the condition bar");
            Apart(arrive, warn, "the arrival card and the exposure warning");

            // THE CARDS HOLD WHAT IS DRAWN IN THEM. The box sized itself from
            // one head formula and the drawing used two others - 21.45 against
            // 23 at 844x390 - so the content was taller than the frame meant
            // to hold it, and nobody saw it because a card is up for three
            // seconds.
            Assert.GreaterOrEqual(send.height, _hud.CardContentHeight(w, h, false) - 0.01f,
                $"the send-off card is drawn taller than its own box {at}");
            Assert.GreaterOrEqual(arrive.height, _hud.CardContentHeight(w, h, true) - 0.01f,
                $"the arrival card is drawn taller than its own box {at}");
            Assert.Greater(send.width, 150f, $"the send-off card is too narrow to read {at}");
            Assert.Greater(arrive.width, 150f, $"the arrival card is too narrow to read {at}");
            }
            finally { GameSettings.Debug = false; }
        }
    }

    /// <summary>
    /// THE EXPOSURE WARNING, at the shape that actually presents as well as
    /// the four that only exist as arithmetic.
    ///
    /// 733x293 is the size the editor's Game view gives and the only one a
    /// frame can be taken at here, so it is checked with the rest: a later
    /// player build must not inherit an overlap that was never measured
    /// anywhere it could be seen.
    /// </summary>
    [Test]
    public void TheExposureWarningClearsWhatItUsedToCross()
    {
        foreach (var size in new[] { new Vector2(1920, 1080), new Vector2(1024, 768),
                                     new Vector2(844, 390),   new Vector2(1000, 360),
                                     new Vector2(733, 293) })
        {
            int w = (int)size.x, h = (int)size.y;
            string at = $"at {w}x{h}";

            var warn = _hud.ExposureWarningBox(w, h);
            var practice = _hud.PracticeBox(w, h);
            var man = _hud.ManifestBox(w, h);
            var wanted = _hud.WantedBox(w, h);
            var clock = _hud.BlockTimerBox(w, h);
            var liq = _hud.LiquidationBox(w, h);
            var list = _hud.StreamingBox(w, h, 11);

            void Apart(Rect a, Rect b, string what)
                => Assert.IsFalse(a.Overlaps(b), $"{what} overlap {at}: {a} / {b}");

            Apart(warn, practice, "the exposure warning and the practice switch");
            Apart(warn, man, "the exposure warning and the score column");
            Apart(warn, wanted, "the exposure warning and the wanted row");
            Apart(warn, clock, "the exposure warning and the block clock");
            Apart(warn, liq, "the exposure warning and the liquidation line");
            Apart(warn, list, "the exposure warning and the model list");

            Assert.GreaterOrEqual(warn.x, 0f, $"the warning runs off the left edge {at}");
            Assert.LessOrEqual(warn.yMax, h, $"the warning runs off the bottom {at}");
            Assert.Greater(warn.width, 60f, $"the warning has no width {at}");
        }
    }

    /// <summary>
    /// THE SCORE COLUMN AND THE STREAMING LIST, which the photograph caught
    /// and no rectangle had ever been asked about.
    ///
    /// The score column had no rect: its box was the full screen width and it
    /// grew upward off the top of a short window, with CARGO cut in half by
    /// the edge. The streaming list sat a third of the way down the right-hand
    /// side, which is where the block clock and the score column live, and was
    /// drawn straight across both.
    /// </summary>
    [Test]
    public void TheModelListAndHighLowNeverShareTheCentreColumnWhileModelsLoad()
    {
        // LIVE 0.0.1497 (probe screenshot on-12.png, 1280x656 with pads): HIGH / LOW (the owner 12:55, central, the run-stopped
        // row) and the "Loading models" list both stood in the headline gap under the block clock and were painted on each
        // other. HIGH / LOW stays central; the list starts under it, rows tightened to stay above the pads and the chart.
        // THE PLAQUE ITSELF IS GONE (2026-09-19 13:10, remove-world-high-low-1310.png): nothing draws those words
        // any more. HighLowBox and HighLowYieldsToModelList stay as the geometry of the row the model list must not run
        // into, and this walks that row - one box fewer on the screen cannot make the list fit worse.
        // Where eleven rows cannot fit under it, HIGH / LOW yields while the list is up (HighLowYieldsToModelList) - named
        // five asserted, and every shape the HUD tests use, with pads and without, measured and logged.
        // The HIGH / LOW box is asked with the widest text the row allows (HighLowBox clamps it) and the painter's row height.
        var named = new[] { (1280, 800, false, false, "desktop"), (1280, 800, false, true, "desktop+pads"),
                            (1280, 656, false, true, "touch 1280x656"), (390, 844, true, true, "phone portrait"),
                            (844, 390, true, true, "phone landscape") };
        var shapes = new System.Collections.Generic.List<(int, int, bool, bool, string)>(named);
        foreach (var size in Sizes) foreach (var pads in new[] { false, true })
            shapes.Add(((int)size.x, (int)size.y, size.y > size.x, pads, pads ? "sized+pads" : "sized"));
        foreach (var size in Five) foreach (var pads in new[] { false, true })
            shapes.Add(((int)size.x, (int)size.y, size.y > size.x, pads, pads ? "five+pads" : "five"));
        var fails = new System.Collections.Generic.List<string>();
        var yielding = new System.Collections.Generic.List<string>();
        var before = new System.Collections.Generic.List<string>();
        try
        {
            foreach (var (w, h, mobile, pads, name) in shapes)
            {
                DriveHud.MobileOverride = mobile; DriveHud.PadsOverride = pads;
                bool yields = _hud.HighLowYieldsToModelList(w, h, 11);
                if (yields) yielding.Add($"{name} {w}x{h}");
                var panel = _hud.HudChartPanel(w, h);
                // where HIGH / LOW yields while models load it is not painted then: nothing to share
                var hl = yields ? new Rect() : _hud.HighLowBox(w, h, w, ChartHud.RowHeight(panel.height) + 4f);
                var list = _hud.StreamingBox(w, h, 11);
                var cut = Rect.MinMaxRect(Mathf.Max(hl.xMin, list.xMin), Mathf.Max(hl.yMin, list.yMin), Mathf.Min(hl.xMax, list.xMax), Mathf.Min(hl.yMax, list.yMax));
                float shared = hl.width > 0f && hl.Overlaps(list) ? cut.width * cut.height : 0f;
                string padHit = "";
                if (pads)
                    foreach (var pad in new[] { TouchPad.Pad.Left, TouchPad.Pad.Right, TouchPad.Pad.Up, TouchPad.Pad.Down, TouchPad.Pad.Handbrake })
                        if (list.Overlaps(TouchPad.RectFor(pad, w, h))) padHit += $" {pad}{TouchPad.RectFor(pad, w, h)}";
                float row = _hud.StreamingLineHeight(w, h, 11), font = Mathf.Round(Mathf.Clamp(Mathf.Min(w, h) * 0.032f, 13f, 20f));
                bool chartHit = panel.width > 0f && list.Overlaps(panel);
                Debug.Log($"[loading-overlap] {name} {w}x{h}: highLow {(yields ? "yields while models load" : $"x={hl.x:0.0} y={hl.y:0.0} w={hl.width:0.0} h={hl.height:0.0}")}; "
                          + $"models x={list.x:0.0} y={list.y:0.0} w={list.width:0.0} h={list.height:0.0}; shared {shared:0} px; "
                          + $"row {row:0.0} (font {font}); bottom {list.yMax:0.0} of {h}{(padHit.Length > 0 ? "; on pads" + padHit : "")}{(chartHit ? $"; on the chart {panel}" : "")}");
                string at = $"{name} {w}x{h}";
                if (shared > 0f) fails.Add($"{at}: HIGH/LOW and the model list share {shared:0} px");
                if (!yields && padHit.Length > 0) fails.Add($"{at}: the model list under HIGH / LOW is on the pads{padHit}");
                if (!yields && chartHit) fails.Add($"{at}: the model list under HIGH / LOW is on the HUD chart {panel}");
                if (!yields && row < font) fails.Add($"{at}: rows {row:0.0} px under the {font} px font");
                if (!yields && list.yMax > h + 0.01f) fails.Add($"{at}: the model list runs {list.yMax - h:0.0} px off the bottom");
                // Where HIGH / LOW yields the list keeps the place it always had, and on the smallest windows that place was
                // already too short for eleven rows at the font's floor: not this overlap, listed (PRIORITIES) with the numbers.
                if (yields && (padHit.Length > 0 || chartHit || list.yMax > h + 0.01f))
                    before.Add($"{at}: bottom {list.yMax:0.0} of {h}{(padHit.Length > 0 ? ", on pads" + padHit : "")}{(chartHit ? $", on the chart {panel}" : "")}");
            }
            // the named five: HIGH / LOW yields only on a phone held upright
            foreach (var (w, h, mobile, pads, name) in named)
            {
                DriveHud.MobileOverride = mobile; DriveHud.PadsOverride = pads;
                Assert.AreEqual(name == "phone portrait", _hud.HighLowYieldsToModelList(w, h, 11), $"{name}: HIGH / LOW yields");
            }
            // a failure keeps the list up after loading: there it keeps the failed rows (ModelListRows), and two of them fit
            // under HIGH / LOW on the phone held upright, so HIGH / LOW comes back
            DriveHud.MobileOverride = true; DriveHud.PadsOverride = true;
            Assert.IsFalse(_hud.HighLowYieldsToModelList(390, 844, 2), "two failed rows do not fit under HIGH / LOW at 390x844");
            var hl2 = _hud.HighLowBox(390, 844, 390, ChartHud.RowHeight(_hud.HudChartPanel(390, 844).height) + 4f);
            var failedList = _hud.StreamingBox(390, 844, 2);
            Debug.Log($"[loading-overlap] phone portrait 390x844 settled on two failures: highLow x={hl2.x:0.0} y={hl2.y:0.0} w={hl2.width:0.0} h={hl2.height:0.0}; models x={failedList.x:0.0} y={failedList.y:0.0} w={failedList.width:0.0} h={failedList.height:0.0}");
            Assert.IsFalse(failedList.Overlaps(hl2), "the failed rows are on HIGH / LOW at 390x844");
            Assert.IsFalse(failedList.Overlaps(_hud.HudChartPanel(390, 844)), "the failed rows are on the chart at 390x844");
        }
        finally { DriveHud.MobileOverride = null; DriveHud.PadsOverride = null; }
        Debug.Log($"[loading-overlap] HIGH / LOW yields while models load at: {(yielding.Count == 0 ? "none" : string.Join(", ", yielding))}");
        Debug.Log($"[loading-overlap] the list's old place is already short there (not HIGH / LOW): {(before.Count == 0 ? "none" : string.Join("; ", before))}");
        Assert.IsEmpty(fails, string.Join("; ", fails));
    }

    [Test]
    public void TheScoreColumnAndTheModelListKeepOffEverything()
    {
        foreach (var size in new[] { new Vector2(1920, 1080), new Vector2(1024, 768),
                                     new Vector2(844, 390),   new Vector2(1000, 360) })
        {
            int w = (int)size.x, h = (int)size.y;
            string at = $"at {w}x{h}";
            float pad = Mathf.Max(10f, h * 0.025f);

            var man = _hud.ManifestBox(w, h);
            var list = _hud.StreamingBox(w, h, 11);
            var clock = _hud.BlockTimerBox(w, h);
            var liq = _hud.LiquidationBox(w, h);
            var wanted = _hud.WantedBox(w, h);
            var health = _hud.HealthBox(w, h);
            var practice = _hud.PracticeBox(w, h);

            void Apart(Rect a, Rect b, string what)
                => Assert.IsFalse(a.Overlaps(b), $"{what} overlap {at}: {a} / {b}");

            // THE FIRST LINE IS ON THE SCREEN. This is the fault in the photo.
            Assert.GreaterOrEqual(man.y, pad - 0.01f,
                $"the score column starts {man.y:0} px from the top - its first line is "
                + $"clipped by the edge {at}");
            Assert.LessOrEqual(man.yMax, h, $"the score column runs off the bottom {at}");
            Assert.Greater(man.width, 60f, $"the score column has no width left {at}");
            // the box holds the five rows drawn in it - the block board's
            // fault twice already, and once more here
            Assert.GreaterOrEqual(man.height, _hud.ManifestContentHeight(w, h) - 0.01f,
                $"the score column is drawn taller than its own box {at}");

            Apart(man, clock, "the score column and the block clock");
            Apart(man, liq, "the score column and the liquidation line");
            Apart(man, wanted, "the score column and the wanted row");
            Apart(man, health, "the score column and the condition bar");
            Apart(man, practice, "the score column and the practice switch");
            Apart(man, _hud.SettingsRect(TouchPad.Pad.Sound, w, h),
                  "the score column and the sound icon");
            Apart(man, _hud.SettingsRect(TouchPad.Pad.Debug, w, h),
                  "the score column and the debug icon");
            Apart(man, TouchPad.RectFor(TouchPad.Pad.View, w, h),
                  "the score column and the view toggle");

            // and the list keeps off the two things it was drawn across
            Apart(list, clock, "the model list and the block clock");
            Apart(list, liq, "the model list and the liquidation line");
            Apart(list, man, "the model list and the score column");
            Apart(list, health, "the model list and the condition bar");
            Apart(list, practice, "the model list and the practice switch");
            Assert.LessOrEqual(list.yMax, h, $"the model list runs off the bottom {at}");

            // a row is never tighter than the type in it
            Assert.GreaterOrEqual(_hud.StreamingLineHeight(w, h, 11),
                Mathf.Round(Mathf.Clamp(Mathf.Min(w, h) * 0.032f, 13f, 20f)),
                $"the model list rows are drawn into each other {at}");
        }
    }

    /// <summary>
    /// THE TWO CARDS, against each other rather than only against the screen.
    ///
    /// The send-off is up for 3.4 s from roll-out and the arrival card for 5 s
    /// from a delivery or a miss - two independent clocks, so nothing in the
    /// code stops both running at once: deliver, and confirm the next load
    /// inside five seconds, and both are drawn. They are 20% and 18% down the
    /// screen and taller than that gap, so they would be laid on each other.
    /// </summary>
    [Test]
    public void TheTwoCardsAreNeverUpTogether()
    {
        foreach (var size in new[] { new Vector2(1920, 1080), new Vector2(1024, 768),
                                     new Vector2(844, 390),   new Vector2(1000, 360) })
        {
            int w = (int)size.x, h = (int)size.y;
            string at = $"at {w}x{h}";
            var send = _hud.SendOffBox(w, h);
            var arrive = _hud.ArrivalBox(w, h);

            // They DO share pixels - that is the point, and it is why one of
            // them has to be gated out rather than moved: two cards side by
            // side on a phone would be two unreadable cards.
            Assert.IsTrue(send.Overlaps(arrive),
                $"the cards no longer share space {at}; if they were separated, "
                + "this test should be the overlap check instead of the gate");
            Assert.IsTrue(DriveHud.ArrivalIsHiddenBy(sendOffShowing: true),
                $"the arrival card is not gated on the send-off {at}");
            Assert.IsFalse(DriveHud.ArrivalIsHiddenBy(sendOffShowing: false),
                $"the arrival card is hidden with no send-off up {at}");
        }
    }

    /// <summary>
    /// THE ONE PIECE OF THE DRIVING HUD THAT SURVIVES INTO THE LOADOUT SCREEN.
    ///
    /// While the panel is open the HUD returns early and draws nothing else,
    /// so the loadout is a different screen and is not this letter. The
    /// exception is a price line in the corner, and whether it lands on the
    /// panel's own frame had never been measured. It does not - the panel
    /// starts at a tenth of the height and the line ends well above it - and
    /// this holds that.
    /// </summary>
    [Test]
    public void ThePriceInTheCornerKeepsOffTheLoadoutPanel()
    {
        var yard = Object.FindFirstObjectByType<PackageYard>();
        if (yard == null) Assert.Ignore("no yard in this fixture to measure the panel against");

        foreach (var size in new[] { new Vector2(1920, 1080), new Vector2(1024, 768),
                                     new Vector2(844, 390),   new Vector2(1000, 360) })
        {
            int w = (int)size.x, h = (int)size.y;
            var line = _hud.LoadingPriceBox(w, h);
            var panel = yard.PanelRect(w, h);
            Assert.IsFalse(line.Overlaps(panel),
                $"the price line is drawn on the loadout panel at {w}x{h}: {line} / {panel}");
            Assert.GreaterOrEqual(line.y, 0f, $"the price line is off the top at {w}x{h}");
            Assert.Less(line.yMax, panel.y, $"the price line reaches the panel at {w}x{h}");
        }
    }

    /// <summary>
    /// THE SAME COLUMN WITH THE DIAGNOSTICS PANEL UP, which is the state
    /// the owner drives in.
    ///
    /// `HealthBox` switches its top between the block board and the
    /// diagnostics box, and the danger meter, the practice switch and the SIM
    /// switch are all measured from it - so the whole stack moves when DEBUG
    /// is on and none of it was checked there.
    /// </summary>
    [Test]
    public void TheColumnStillStacksWithTheDiagnosticsPanelUp()
    {
        _hud.showDiagnostics = true;
        try
        {
            foreach (var size in new[] { new Vector2(1920, 1080), new Vector2(1366, 768),
                                         new Vector2(844, 390), new Vector2(640, 480) })
            {
                int w = (int)size.x, h = (int)size.y;
                string at = $"at {w}x{h} with DEBUG on";

                var diag = _hud.DiagnosticsBox(w, h);
                var health = _hud.HealthBox(w, h);
                var danger = _hud.ExposureBox(w, h);
                var practice = _hud.PracticeBox(w, h);
                var sim = _hud.SimBox(w, h);

                void Apart(Rect a, Rect b, string what)
                    => Assert.IsFalse(a.Overlaps(b), $"{what} overlap {at}: {a} / {b}");

                Apart(diag, health, "the diagnostics panel and the condition bar");
                Apart(diag, danger, "the diagnostics panel and the danger meter");
                Apart(diag, practice, "the diagnostics panel and the practice switch");
                Apart(diag, sim, "the diagnostics panel and the SIM switch");
                Apart(health, danger, "the condition bar and the danger meter");
                Apart(danger, practice, "the danger meter and the practice switch");
                Apart(practice, sim, "the practice switch and the SIM switch");

                Assert.GreaterOrEqual(health.y, diag.yMax,
                    $"the condition bar is not under the diagnostics panel {at}");
                Assert.Less(sim.yMax, h, $"the column runs off the bottom {at}");
            }
        }
        finally { _hud.showDiagnostics = false; }
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
