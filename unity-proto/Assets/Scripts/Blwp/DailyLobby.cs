using System;
using UnityEngine;
#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace Blwp
{
    /// <summary>One round as the lobby lists it - every field the page's own, checked there.</summary>
    [Serializable]
    public class LobbyRow
    {
        public string id = "";
        public string line = "";
        public bool free;
        public int agree;
        public int needed;
        public bool joinable;
        public int leftS = -1;
        public int seated;
    }

    /// <summary>Who this tab is: the name and the identity key's fingerprint.</summary>
    [Serializable]
    public class LobbyYou
    {
        public string name = "";
        public bool custom;
        public string generated = "";
        public string fingerprint = "";
    }

    /// <summary>The seat PLAY asked for, as the page took it: "" before any press, then joining, joined or refused - and why, and the step it is on.</summary>
    [Serializable]
    public class LobbyJoin
    {
        public string state = "";
        public string why = "";
        public string stage = "";
    }

    /// <summary>What the page hands Unity to draw: the lobby, or nothing.</summary>
    /// <summary>What a kept round still owes this browser's player (the owner 2026-09-14): looked at by the page, never collected by looking.</summary>
    [Serializable]
    public class LobbyWithdraw
    {
        public bool available;
        public string msat = "";
        public bool elsewhere;
    }

    [Serializable]
    public class LobbyState
    {
        public string mode = "";
        public string from = "";
        public LobbyYou you = new LobbyYou();
        public LobbyRow[] rows = new LobbyRow[0];
        public string[] refused = new string[0];
        public int nodes;
        public LobbyJoin join = new LobbyJoin();
        public LobbyWithdraw withdraw = new LobbyWithdraw();
    }

    /// <summary>
    /// THE DAILY'S LOBBY, DRAWN BY UNITY (M3.3-34, the owner 2026-09-12 22:11-22:16).
    ///
    /// The lobby is the title screen: the rounds, who you are, PLAY and
    /// SPECTATE. What it shows is decided in the page and nowhere else - every
    /// round is fetched from the seats and checked against its own contract and
    /// both seats' signed listings before it is a row, and Join exists only when
    /// both seats of a 2-of-2 round say open and seated. Unity draws that and
    /// hands the player's press back; it decides nothing and holds no key.
    ///
    /// Outside a WebGL player there is no page, so every call answers nothing
    /// and the title screen is the offline one, exactly as before.
    /// </summary>
    public static class DailyLobby
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] static extern string BlwpLobbyState();
        [DllImport("__Internal")] static extern int BlwpLobbyJoin(string id);
        [DllImport("__Internal")] static extern string BlwpLobbyEditName();
        [DllImport("__Internal")] static extern void BlwpLobbyKeyBackup();
        [DllImport("__Internal")] static extern void BlwpLobbyShown(string json);
        [DllImport("__Internal")] static extern int BlwpQueryParam(IntPtr name, IntPtr outp, int cap);
        [DllImport("__Internal")] static extern float BlwpUiScale();
        public const bool Compiled = true;
#else
        static float BlwpUiScale() => 1f;
        static string BlwpLobbyState() => "";
        static int BlwpLobbyJoin(string id) => 0;
        static string BlwpLobbyEditName() => "";
        static void BlwpLobbyKeyBackup() { }
        static void BlwpLobbyShown(string json) { }
        static int BlwpQueryParam(IntPtr name, IntPtr outp, int cap) => 0;
        public const bool Compiled = false;
#endif

        /// <summary>The lobby the page holds now, or null when this page is not a lobby.</summary>
        public static LobbyState Poll()
        {
            if (!Compiled) return null;
            try { return Parse(BlwpLobbyState()); } catch (Exception e) { Debug.LogWarning($"[lobby] {e.Message}"); return null; }
        }

        /// <summary>The page's JSON as a lobby, or null: nothing, not a lobby, or not JSON.</summary>
        public static LobbyState Parse(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            LobbyState s;
            try { s = JsonUtility.FromJson<LobbyState>(json); } catch { return null; }
            if (s == null || s.mode != "lobby") return null;
            if (s.rows == null) s.rows = new LobbyRow[0];
            if (s.refused == null) s.refused = new string[0];
            if (s.you == null) s.you = new LobbyYou();
            if (s.join == null) s.join = new LobbyJoin();
            if (s.withdraw == null) s.withdraw = new LobbyWithdraw();
            return s;
        }

        /// <summary>
        /// A WITHDRAWAL AVAILABLE (the owner 2026-09-14): after start the page looks at every kept
        /// round, and while one still owes the player money the lobby says so, with the amount,
        /// until it is withdrawn. Nothing is collected by looking; the Withdraw is the page's.
        /// "" when there is none.
        /// </summary>
        public static string WithdrawNotice(LobbyState s)
        {
            if (s == null || s.withdraw == null || !s.withdraw.available) return "";
            if (s.withdraw.elsewhere) return "Withdrawal available - open in another tab of this browser";
            return long.TryParse(s.withdraw.msat, out var msat) && msat > 0
                ? $"Withdrawal available: {msat / 1000} sat - press Withdraw in the wallet panel"
                : "";
        }

        /// <summary>How long a joined seat waits for its session before the round starts anyway.</summary>
        public const float SessionPatienceS = 5f;

        /// <summary>
        /// WHAT PLAY DOES ONCE THE PAGE HAS THE SEAT (M3.3-34, the owner 2026-09-13
        /// 07:11: "after PLAY the loading screen must not come again. PLAY starts
        /// the round"). The seat is taken in THIS page - PLAY used to navigate to
        /// the round's link, the page reloaded and Unity loaded a second time. The
        /// round starts when the page says joined and the session has opened, or
        /// `SessionPatienceS` after joined without one. "refused" hands the page's
        /// reason back to the title screen; anything else waits.
        /// </summary>
        public static string AfterJoin(LobbyState s, bool sessionRunning, float joinedForS)
        {
            if (s == null || s.join == null) return "wait";
            if (s.join.state == "refused") return "refused";
            if (s.join.state != "joined") return "wait";
            return sessionRunning || joinedForS >= SessionPatienceS ? "play" : "wait";
        }

        /// <summary>
        /// The round PLAY joins when the player has picked none: the joinable one
        /// with the most entry time left, so a press never lands on a round that
        /// is about to close. -1 when no round can be joined.
        /// </summary>
        public static int PickDefault(LobbyRow[] rows)
        {
            int best = -1;
            for (int i = 0; rows != null && i < rows.Length; i++)
            {
                if (rows[i] == null || !rows[i].joinable) continue;
                if (best < 0 || rows[i].leftS > rows[best].leftS) best = i;
            }
            return best;
        }

        /// <summary>The picked round if it is still listed and joinable, else the default.</summary>
        public static int Keep(LobbyRow[] rows, string pickedId)
        {
            for (int i = 0; rows != null && i < rows.Length; i++)
                if (rows[i] != null && rows[i].joinable && rows[i].id == pickedId) return i;
            return PickDefault(rows);
        }

        /// <summary>Asks the page to join that round - the round's own link, so the seat is taken as a shared link takes it.</summary>
        public static bool Join(string id) => Compiled && !string.IsNullOrEmpty(id) && BlwpLobbyJoin(id) == 1;

        /// <summary>The page asks for the name (the browser's own prompt, which a phone keyboard can type into); answers why it was refused, or "".</summary>
        public static string EditName() => Compiled ? (BlwpLobbyEditName() ?? "") : "";

        /// <summary>The page shows this tab's private-key backup, where it can be copied.</summary>
        public static void KeyBackup() { if (Compiled) BlwpLobbyKeyBackup(); }

        /// <summary>What Unity drew, told back to the page - so what a player sees can be measured, not assumed.</summary>
        public static void Shown(string json) { if (Compiled) BlwpLobbyShown(json); }

        /// <summary>
        /// The screen's pixels per CSS pixel, 1 outside a page. The title screen
        /// is laid out in CSS pixels and drawn at this scale, so a phone at 3x
        /// shows it at the size a player reads - measured on an iPhone before:
        /// every element on screen, and the text about 8 points high.
        /// </summary>
        public static float UiScale()
        {
            if (!Compiled) return 1f;
            float s;
            try { s = BlwpUiScale(); } catch { return 1f; }
            return float.IsNaN(s) ? 1f : Mathf.Clamp(s, 1f, 4f);
        }

        /// <summary>True when the page was sent here by PLAY in the lobby: the round starts without a second PLAY.</summary>
        public static bool AutoPlay() => Query("play") == "1";

        static string Query(string name)
        {
            if (!Compiled) return "";
#if UNITY_WEBGL && !UNITY_EDITOR
            var nameBytes = System.Text.Encoding.UTF8.GetBytes(name + "\0");
            var outBytes = new byte[64];
            var nh = GCHandle.Alloc(nameBytes, GCHandleType.Pinned);
            var oh = GCHandle.Alloc(outBytes, GCHandleType.Pinned);
            try
            {
                int n = BlwpQueryParam(nh.AddrOfPinnedObject(), oh.AddrOfPinnedObject(), outBytes.Length);
                return n > 0 ? System.Text.Encoding.UTF8.GetString(outBytes, 0, n) : "";
            }
            finally { nh.Free(); oh.Free(); }
#else
            return "";
#endif
        }

        /// <summary>Every rectangle of the lobby inside the title screen's copy area.</summary>
        public struct Frame
        {
            public Rect you, name, key, head, more, list, howTo;
            public Rect[] howToCells;
            public bool howToGrid;
            /// <summary>A phone upright (the owner 2026-09-15 11:57): two pages in one box - panels 1 and 2
            /// (howToCells[0..1]), then 3 and 4 (howToCells[2..3]) - and the arrows that turn them.</summary>
            public bool howToCarousel;
            public Rect howToPrev, howToNext;
            public float rowH;
            public int rows;
            public bool narrow;
        }

        /// <summary>
        /// THE LOBBY'S LAYOUT, as arithmetic - because OnGUI never runs in batch
        /// mode, and "fully visible on iOS and Android" is only true if it can be
        /// measured on every phone shape without drawing it (the owner 22:16).
        ///
        /// Top down inside the copy area: who you are, with NAME and KEY beside
        /// it - or under it, on a screen too narrow for both on one line; the
        /// ROUNDS header with its page button; then as many round rows as fit.
        /// Every button is at least 34 px high, a finger's width on a phone.
        /// </summary>
        public static Frame MeasureLobby(Rect copy, float font, bool portrait = false, bool carousel = true)
        {
            float line = font * 1.45f;
            float btnH = Mathf.Max(font * 2.1f, 34f);
            float gap = Mathf.Max(4f, font * 0.4f);
            float btnW = Mathf.Max(font * 5.2f, 72f);

            // THE OWNER'S HOW-TO, FOUR PANELS (the owner 2026-09-14 07:55): load, cross
            // the front, deliver, stake and win - each panel whole, never
            // stretched. A desktop or any landscape copy area gets them as one
            // row, 1-2-3-4; a portrait one (a phone upright, a tablet) as two
            // rows, 1-2 over 3-4; a wide, short one (a phone held sideways) as the
            // same two rows in a column beside the rounds, where a strip would
            // take the height the rounds need. Shrunk to fit, never below
            // HowToMinCell high. WHICH OF THE TWO is whichever draws each panel
            // bigger in the room it has (a row on a tie): measured, a portrait
            // phone's copy area is wider than tall inside the title panel, and a
            // row there drew 64 px panels where two rows of two draw 127. Not by
            // pixels: a phone's canvas is 1170 px wide at 3x.
            // AND A PHONE HELD UPRIGHT IS ALWAYS 1-2 OVER 3-4 (the owner 07:55): its
            // copy area is wider than tall inside the title panel, so the shape of
            // the SCREEN is handed in - measured at 375x667, the bigger-panel rule
            // alone chose a row (101 px panels) over a grid capped at 42% (82 px).
            bool beside = copy.width >= copy.height * 2.2f;
            float cellGap = Mathf.Max(2f, gap * 0.5f);
            float gridCap = portrait ? 0.48f : 0.42f;
            // THE ROUNDS COME FIRST (the owner 22:16, "fully visible"): the panels take
            // only what leaves who-you-are, NAME and KEY, the header and two round
            // rows on screen. Measured at 375x667 2x: at 48% of the height the list
            // kept 75 px - one round.
            bool narrowHere = copy.width < btnW * 2f + gap + font * 16f;
            float reserved = (narrowHere ? line * 2f + gap + btnH + gap : Mathf.Max(btnH, line * 2f) + gap)
                           + Mathf.Max(line, btnH * 0.8f) + gap * 0.5f + 2f * Mathf.Max(font * 2.0f, 34f) + gap + 1f;
            float room = Mathf.Max(0f, copy.height - reserved);
            bool grid = beside || portrait || SmallestIn(true, copy.width, Mathf.Min(copy.height * gridCap, room), cellGap)
                                              > SmallestIn(false, copy.width, Mathf.Min(copy.height * 0.34f, room), cellGap) + 0.5f;
            // The box from one side, so every cell is exactly its panel's shape whatever the gaps.
            float WidthFor(float h) => BoxWidthFor(grid, h, cellGap);
            float HeightFor(float w) => BoxHeightFor(grid, w, cellGap);
            Rect howTo = default;
            Rect prev = default, next = default;
            Rect[] pages = null;
            // A PHONE ON ITS SIDE: 1-2 over 3-4 in a column at the right. Where the
            // rest can stay one line wide beside it, the column takes the FULL height
            // of the copy area (bigger panels); where it cannot - stacked, who-you-are,
            // NAME and KEY took the rounds' height: measured at 667x375 1x, a 58 px
            // list, one round - it sits beside the round list only, as before.
            // (1 px spare: measured, the left side landed a float hair under the
            // one-line width and stacked - 667x375 1x, a 58 px list.)
            float keepWide = copy.width - (btnW * 2f + gap + font * 16f) - gap - 1f;
            bool besideAll = beside && keepWide >= WidthFor(MinBoxHeight(grid, cellGap));
            if (besideAll)
            {
                float aw = Mathf.Min(copy.width * 0.45f, WidthFor(copy.height), keepWide);
                float ah = HeightFor(aw);
                howTo = new Rect(copy.xMax - aw, copy.y, aw, ah);
                copy = new Rect(copy.x, copy.y, Mathf.Max(0f, copy.width - aw - gap), copy.height);
            }
            else if (!beside)
            {
                float hh = Mathf.Min(HeightFor(copy.width), Mathf.Min(copy.height * (grid ? gridCap : 0.34f), room));
                hh = Mathf.Max(hh, Mathf.Min(room, MinBoxHeight(grid, cellGap)));
                float hw = WidthFor(hh);
                if (hw > copy.width) { hw = copy.width; hh = HeightFor(hw); }
                howTo = new Rect(copy.x + (copy.width - hw) * 0.5f, copy.y, hw, hh);
                // A PHONE UPRIGHT TURNS PAGES (the owner 2026-09-15 11:57): the four panels as 1-2 over 3-4
                // were hard to read and took too much of a phone. Panels 1 and 2 first, 15% taller than
                // this grid's top row; the arrows turn to 3 and 4. Its room is the grid's, so the
                // rounds still come first. `carousel: false` is that grid, kept as the measure.
                if (portrait && carousel)
                    (howTo, prev, next, pages) = CarouselOf(howTo, copy, room, btnH, gap, cellGap);
                copy = new Rect(copy.x, howTo.yMax + gap, copy.width, Mathf.Max(0f, copy.yMax - howTo.yMax - gap));
            }

            bool narrow = copy.width < btnW * 2f + gap + font * 16f;

            Rect you, name, key;
            float y = copy.y;
            if (narrow)
            {
                you = new Rect(copy.x, y, copy.width, line * 2f);
                y = you.yMax + gap;
                float half = (copy.width - gap) * 0.5f;
                name = new Rect(copy.x, y, half, btnH);
                key = new Rect(name.xMax + gap, y, copy.width - half - gap, btnH);
                y = name.yMax + gap;
            }
            else
            {
                float right = btnW * 2f + gap;
                you = new Rect(copy.x, y, copy.width - right - gap, Mathf.Max(btnH, line * 2f));
                name = new Rect(you.xMax + gap, y + (you.height - btnH) * 0.5f, btnW, btnH);
                key = new Rect(name.xMax + gap, name.y, btnW, btnH);
                y = you.yMax + gap;
            }

            float moreW = Mathf.Max(font * 4f, 56f);
            float headH = Mathf.Max(line, btnH * 0.8f);
            var head = new Rect(copy.x, y, copy.width - moreW - gap, headH);
            var more = new Rect(head.xMax + gap, y, moreW, headH);
            y = head.yMax + gap * 0.5f;

            float rowH = Mathf.Max(font * 2.0f, 34f);
            var list = new Rect(copy.x, y, copy.width, Mathf.Max(0f, copy.yMax - y));
            if (beside && !besideAll)
            {
                // the column beside the rounds: 1-2 over 3-4, from the rounds header
                // down, no wider than 45% of the list; the header, its page button and
                // the list give up its width. Measured beside the list only, with the
                // panels at their own shapes: panel 3 drew 37 px at 667x375 1x.
                float aw = Mathf.Min(list.width * 0.45f, WidthFor(copy.yMax - head.y));
                float ah = HeightFor(aw);
                howTo = new Rect(copy.xMax - aw, head.y, aw, ah);
                float cut = aw + gap;
                head = new Rect(head.x, head.y, Mathf.Max(0f, head.width - cut), head.height);
                more = new Rect(more.x - cut, more.y, more.width, more.height);
                list = new Rect(list.x, list.y, Mathf.Max(0f, list.width - cut), list.height);
            }
            int rows = Mathf.Max(0, Mathf.FloorToInt((list.height + 0.01f) / rowH));
            return new Frame { you = you, name = name, key = key, head = head, more = more, list = list,
                               howTo = howTo, howToCells = pages ?? HowToCells(howTo, grid, cellGap), howToGrid = grid,
                               howToCarousel = pages != null, howToPrev = prev, howToNext = next,
                               rowH = rowH, rows = rows, narrow = narrow };
        }

        /// <summary>How much taller panels 1 and 2 are on a phone's first page than in the grid's top row.</summary>
        public const float CarouselTaller = 1.15f;

        /// <summary>The carousel page panel `i` is on: 1 and 2 first, then 3 and 4.</summary>
        public static int HowToPageOf(int panel) => panel < 2 ? 0 : 1;

        /// <summary>
        /// THE TWO PAGES IN ONE BOX (the owner 2026-09-15 11:57), from the grid box a phone upright
        /// had: panels 1 and 2 side by side at one height, CarouselTaller times the grid's top
        /// row - never wider than the copy area beside the two arrows, never taller than the
        /// room the rounds leave; panels 3 and 4 on page two, as wide as page one, centred in the
        /// same box, so turning the page moves nothing else. Every cell its own panel's shape.
        /// </summary>
        static (Rect box, Rect prev, Rect next, Rect[] cells) CarouselOf(Rect grid, Rect copy, float room, float arrow, float gap, float g)
        {
            float a0 = PanelAspectOf(0), a1 = PanelAspectOf(1), a2 = PanelAspectOf(2), a3 = PanelAspectOf(3);
            float c = Mathf.Max(0f, (grid.width - g) * 0.5f);
            float want = CarouselTaller * c / Mathf.Min(a0, a1);
            float avail = Mathf.Max(0f, copy.width - 2f * (arrow + gap));
            float h = Mathf.Max(0f, Mathf.Min(want, Mathf.Min((avail - g) / (a0 + a1), room)));
            // ONLY WHERE IT IS THAT MUCH TALLER (the owner 2026-09-15, option A): where the width beside
            // the arrows, or the rounds' room, holds 1 and 2 under CarouselTaller x the grid's top row,
            // the grid stays - measured at 1x, 375x667: a 277 px copy area drew them at 76.9 px, under
            // the grid's own 111.4. Every phone at 2x to 3x and the tablet reach it.
            if (h < want - 0.01f) return (grid, default, default, null);
            float pageW = h * (a0 + a1) + g;
            float boxW = pageW + 2f * (arrow + gap);
            var box = new Rect(copy.x + (copy.width - boxW) * 0.5f, copy.y, boxW, h);
            var prev = new Rect(box.x, box.y, arrow, h);
            var next = new Rect(box.xMax - arrow, box.y, arrow, h);
            float x0 = prev.xMax + gap;
            float h2 = Mathf.Max(0f, pageW - g) / (a2 + a3);
            float y2 = box.y + (h - h2) * 0.5f;
            var cells = new[]
            {
                new Rect(x0, box.y, h * a0, h), new Rect(x0 + h * a0 + g, box.y, h * a1, h),
                new Rect(x0, y2, h2 * a2, h2), new Rect(x0 + h2 * a2 + g, y2, h2 * a3, h2),
            };
            return (box, prev, next, cells);
        }

        /// <summary>
        /// the owner's how-to, whole (2026-09-14 07:55), in Resources
        /// (Assets/Art/Resources/lobby-howto.png, 1448x1086), white knocked out for
        /// the dark UI: 1 load, 2 cross the front, 3 deliver, 4 stake and win.
        /// EVERY PANEL IS DRAWN FROM IT BY ITS OWN BOX: the four tiles that came with
        /// it were cut at half height (y 543), and the picture's rows really part at
        /// y 625-649 - tile 3 carried the bottom of panel 1 (the players, the truck),
        /// which showed as a sliver above 3 and 4 in one row (measured, 1280x800).
        /// </summary>
        public const string HowToWhole = "lobby-howto";
        const float WholeW = 1448f, WholeH = 1086f;

        /// <summary>Each panel's opaque box in the whole, x y w h from the top-left (tools/cut-howto.py).</summary>
        public static readonly Rect[] PanelBoxes =
        {
            new Rect(32f, 80f, 667f, 545f), new Rect(726f, 82f, 714f, 543f),
            new Rect(23f, 650f, 688f, 369f), new Rect(752f, 653f, 677f, 367f),
        };

        /// <summary>Width over height of panel `i` - they are not one shape: 1.22, 1.31, 1.86, 1.84.</summary>
        public static float PanelAspectOf(int i) => PanelBoxes[i].width / PanelBoxes[i].height;

        /// <summary>Panel `i`'s box as UVs in the whole (origin bottom-left).</summary>
        public static Rect PanelUv(int i)
        {
            var b = PanelBoxes[i];
            return new Rect(b.x / WholeW, 1f - (b.y + b.height) / WholeH, b.width / WholeW, b.height / WholeH);
        }

        static float SumAspect => PanelAspectOf(0) + PanelAspectOf(1) + PanelAspectOf(2) + PanelAspectOf(3);
        static float MaxAspect => Mathf.Max(Mathf.Max(PanelAspectOf(0), PanelAspectOf(1)), Mathf.Max(PanelAspectOf(2), PanelAspectOf(3)));
        // two columns of width c: the top row as tall as its taller panel, the bottom row too
        static float GridK => 1f / Mathf.Min(PanelAspectOf(0), PanelAspectOf(1)) + 1f / Mathf.Min(PanelAspectOf(2), PanelAspectOf(3));

        /// <summary>How tall the how-to box is at `w` wide: one row at one height, or 1-2 over 3-4 in two equal columns.</summary>
        public static float BoxHeightFor(bool grid, float w, float g)
            => grid ? Mathf.Max(0f, (w - g) * 0.5f) * GridK + g : Mathf.Max(0f, w - 3f * g) / SumAspect;

        /// <summary>How wide the how-to box is at `h` tall.</summary>
        public static float BoxWidthFor(bool grid, float h, float g)
            => grid ? 2f * Mathf.Max(0f, h - g) / GridK + g : h * SumAspect + 3f * g;

        /// <summary>The box height at which the smallest panel is HowToMinCell high.</summary>
        public static float MinBoxHeight(bool grid, float g) => grid ? HowToMinCell * MaxAspect * GridK + g : HowToMinCell;

        /// <summary>How high the smallest panel is drawn in the biggest box of that kind inside `w` x `capH`.</summary>
        public static float SmallestIn(bool grid, float w, float capH, float g)
        {
            float h = Mathf.Min(BoxHeightFor(grid, w, g), capH);
            float bw = BoxWidthFor(grid, h, g);
            return grid ? Mathf.Max(0f, (bw - g) * 0.5f) / MaxAspect : h;
        }

        /// <summary>
        /// The four panels inside the how-to box, each exactly its own shape: 1-2-3-4
        /// in a row at one height, or 1-2 over 3-4 in two equal columns, top-aligned.
        /// </summary>
        public static Rect[] HowToCells(Rect box, bool grid, float g)
        {
            var cells = new Rect[4];
            if (grid)
            {
                float c = Mathf.Max(0f, (box.width - g) * 0.5f);
                float top = c / Mathf.Min(PanelAspectOf(0), PanelAspectOf(1));
                for (int i = 0; i < 4; i++)
                    cells[i] = new Rect(box.x + (i % 2) * (c + g), box.y + (i < 2 ? 0f : top + g), c, c / PanelAspectOf(i));
            }
            else
            {
                float x = box.x;
                for (int i = 0; i < 4; i++)
                {
                    float w = box.height * PanelAspectOf(i);
                    cells[i] = new Rect(x, box.y, w, box.height);
                    x += w + g;
                }
            }
            return cells;
        }

        /// <summary>
        /// The smallest a panel is drawn, in layout px: the floor the 1-2-3-4 strip
        /// before it was held to (40). A phone draws at 2-3x, so that is 80-120
        /// device px; 60 could not be kept beside two rounds on a 667x375 screen
        /// at 1x - measured - and no phone draws at 1x.
        /// </summary>
        public const float HowToMinCell = 40f;

        /// <summary>One row's words, shortest first to go: the round id, then the seated count.</summary>
        public static string[] RowWords(LobbyRow r)
        {
            string left = r.leftS >= 0 ? $"closes {r.leftS / 60}:{r.leftS % 60:00}" : "entry open";
            string seats = r.joinable ? $"{r.agree} of {r.needed} seats" : $"{r.agree} of {r.needed} seats - waiting";
            string id = string.IsNullOrEmpty(r.id) ? "" : (r.id.Length > 8 ? r.id.Substring(0, 8) : r.id);
            return new[]
            {
                $"{(r.free ? "FREE" : "PAID")} · {left} · {seats} · {r.seated} seated · {id}",
                $"{(r.free ? "FREE" : "PAID")} · {left} · {seats} · {r.seated} seated",
                $"{(r.free ? "FREE" : "PAID")} · {left} · {seats}",
            };
        }
    }
}
