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
            Assert.IsTrue(head.width == 0f || head.width > 50f,
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
            if (head.width >= 60f)
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

            if (head.width < 60f)
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
