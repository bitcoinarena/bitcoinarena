// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using System.Collections.Generic;
using L = Arena.Layout;

/// <summary>
/// WHAT THE WAR IS DOING, IN WORDS (2026-09-20 16:22 and 16:26: "assaults are not perceptible. the owner
/// cannot see them").
///
/// THE CLOCK IS NOT THE PROBLEM. Measured over eight seeds and a whole block each, the core declared 21
/// assaults - two to eight events a block, both sides, ending in both CONSOLIDATE and IDLE - so there is
/// something to announce every round. What the client did with it was one faint tinted column and the word
/// "ASSAULT" inside the small chart panel, with no objective, no start, no end and no sound. A player watching
/// the battlefield never looked at it.
///
/// This turns the core's own two assault words into the three moments a player can follow:
///   BULLS ASSAULT HIGH     when the push is declared, with a sound
///   HIGH TAKEN             when it ends in CONSOLIDATE
///   ASSAULT ON HIGH FAILS  when it ends back in IDLE
/// and keeps the last few with the wall clock on them for the desktop log under the HUD.
///
/// IT DECIDES NOTHING. Every word here is read from `CH_ASSAULT` - the phase and the target objective the core
/// put in the chart view. The client does not choose a target, does not time a push and does not say who won;
/// it is input and pictures, and this is pictures.
///
/// Pure and instantiable so the wording and the transitions can be driven from a test without a scene, which is
/// what `AssaultsAreVisibleTests` does.
/// </summary>
public sealed class AssaultWatch
{
    /// <summary>How many lines the desktop log keeps. Six is about 40 s of a busy block.</summary>
    public const int Keep = 6;

    /// <summary>How long a banner stands before it goes. Long enough to read across a battlefield.</summary>
    public const float BannerSeconds = 4.5f;

    public struct Line
    {
        public string Text;     // "[13:00:43] BULLS FAIL ON HIGH"
        public int Side;        // 0 bulls, 1 bears - the log colours by side
    }

    readonly int[] _phase = { L.ASSAULT_IDLE, L.ASSAULT_IDLE };
    readonly int[] _target = { -1, -1 };
    int _tick = -1;
    readonly List<Line> _log = new List<Line>();

    /// <summary>The last few lines, oldest first.</summary>
    public List<Line> Log { get { return _log; } }

    /// <summary>The banner on screen now, or null. <see cref="BannerAt"/> is the unscaled time it was raised.</summary>
    public string Banner { get; private set; }
    public int BannerSide { get; private set; }
    public float BannerAt { get; private set; }

    /// <summary>How many times a sound has been asked for. The HUD plays one per increment; a test counts them.</summary>
    public int Chimes { get; private set; }

    /// <summary>Bumped on every line. The page is only told when this changes, so nothing is built per frame.</summary>
    public int Revision { get; private set; }

    public AssaultWatch() { Banner = null; BannerAt = -999f; }

    public bool BannerShowing(float now)
        => Banner != null && now - BannerAt <= BannerSeconds;

    /// <summary>Fades the banner out over its last second, so it leaves rather than blinking off.</summary>
    public float BannerAlpha(float now)
    {
        if (!BannerShowing(now)) return 0f;
        float left = BannerSeconds - (now - BannerAt);
        return left >= 1f ? 1f : (left < 0f ? 0f : left);
    }

    /// <summary>HIGH, LOW, OPEN - the client's own names, the same three <see cref="ChartHud.ObjectiveName"/> uses.</summary>
    public static string ObjectiveName(int objective)
        => objective == L.OBJ_HIGH ? "HIGH" : objective == L.OBJ_LOW ? "LOW" : objective == L.OBJ_OPEN ? "OPEN" : "?";

    public static string SideName(int side) => side == 0 ? "BULLS" : "BEARS";

    // THE BANNERS, in the owner's own words (16:22): "a banner BULLS ASSAULT HIGH and a sound when it starts ...
    // then HIGH TAKEN or ASSAULT ON HIGH FAILS".
    public static string StartBanner(int side, int objective) => SideName(side) + " ASSAULT " + ObjectiveName(objective);
    public static string TakenBanner(int objective) => ObjectiveName(objective) + " TAKEN";
    public static string FailedBanner(int objective) => "ASSAULT ON " + ObjectiveName(objective) + " FAILS";

    // THE LOG LINES carry the side on every line, because a log is read after the fact and "HIGH TAKEN" on its
    // own does not say by whom. the owner's example is "[13:00:00] Bulls attack high" / "... failed".
    public static string StartLog(int side, int objective) => SideName(side) + " ASSAULT " + ObjectiveName(objective);
    public static string TakenLog(int side, int objective) => SideName(side) + " TAKE " + ObjectiveName(objective);
    public static string FailedLog(int side, int objective) => SideName(side) + " FAIL ON " + ObjectiveName(objective);

    /// <summary>"[13:00:43] BULLS FAIL ON HIGH" - the wall clock, because that is what the owner reads it against.</summary>
    public static string LogLine(DateTime wall, string words)
        => "[" + wall.ToString("HH:mm:ss") + "] " + words;

    /// <summary>
    /// One frame of the core's chart view. `wall` stamps the line, `now` is unscaled time for the banner's life.
    ///
    /// `tick` is the core's own, and a tick that has gone BACKWARDS is a new round: the phases are forgotten
    /// without a word. A round that ends while a side is still pushing leaves PUSH in this memory, and the next
    /// round opens at IDLE - which would read as that push failing, and put "BULLS FAIL ON HIGH" on screen in
    /// the first second of a round where nothing had happened yet. The LOG is kept, because it is a log.
    ///
    /// Safe to call more than once a frame: a phase that has not changed says nothing.
    /// </summary>
    public void Observe(int[] view, DateTime wall, float now) => Observe(view, wall, now, _tick);

    public void Observe(int[] view, DateTime wall, float now, int tick)
    {
        if (view == null || view.Length < L.CH_ASSAULT + 2 * L.CH_ASSAULT_WORDS) return;
        if (tick < _tick) { _phase[0] = _phase[1] = L.ASSAULT_IDLE; _target[0] = _target[1] = -1; }
        _tick = tick;
        for (int s = 0; s < 2; s++)
        {
            int b = L.CH_ASSAULT + s * L.CH_ASSAULT_WORDS;
            int phase = view[b], target = view[b + 1], was = _phase[s];
            if (phase == was)
            {
                if (phase == L.ASSAULT_PUSH) _target[s] = target;     // the target cannot change mid-push, but read it anyway
                continue;
            }
            _phase[s] = phase;
            if (phase == L.ASSAULT_PUSH)
            {
                _target[s] = target;
                Raise(s, StartBanner(s, target), StartLog(s, target), wall, now, true);
            }
            else if (was == L.ASSAULT_PUSH)
            {
                // THE OBJECTIVE IS THE ONE THAT WAS ATTACKED, not whatever the word holds now: the core clears
                // the target when the next assault is armed, and a line saying the wrong hill is worse than none.
                int o = _target[s] >= 0 ? _target[s] : target;
                bool took = phase == L.ASSAULT_CONSOLIDATE;
                Raise(s, took ? TakenBanner(o) : FailedBanner(o),
                         took ? TakenLog(s, o) : FailedLog(s, o), wall, now, false);
            }
            // CONSOLIDATE -> IDLE is the end of holding what was already announced as TAKEN. Nothing to say.
        }
    }

    void Raise(int side, string banner, string log, DateTime wall, float now, bool chime)
    {
        Banner = banner; BannerSide = side; BannerAt = now;
        if (chime) Chimes++;
        _log.Add(new Line { Text = LogLine(wall, log), Side = side });
        while (_log.Count > Keep) _log.RemoveAt(0);
        Revision++;
    }

    /// <summary>
    /// WHAT THE WAR SAID, for whoever measures the page - the same idea as the lobby's own `Shown`.
    ///
    /// "the owner cannot see them" can only be answered by asking a real browser what it drew, so the banner, the
    /// log and the sound count go to the page. Built by hand because these strings are the client's own words -
    /// side names, objective names, digits and colons - and carry nothing to escape.
    /// </summary>
    public string AsJson()
    {
        var b = new System.Text.StringBuilder();
        b.Append("{\"banner\":");
        if (Banner == null) b.Append("null"); else b.Append('"').Append(Banner).Append('"');
        b.Append(",\"side\":").Append(BannerSide);
        b.Append(",\"chimes\":").Append(Chimes);
        b.Append(",\"revision\":").Append(Revision);
        b.Append(",\"lines\":[");
        for (int i = 0; i < _log.Count; i++)
        {
            if (i > 0) b.Append(',');
            b.Append('"').Append(_log[i].Text).Append('"');
        }
        b.Append("]}");
        return b.ToString();
    }
}
