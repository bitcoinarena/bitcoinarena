// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

/// <summary>
/// The block is the round.
///
/// This exists to close a hole in the game: with no clock, the best strategy
/// was to load the smallest, safest freight and drive it back and forth
/// forever. Nothing could kill you and nothing stopped you, so a risk-free
/// trickle beat every brave run given enough time.
///
/// A block gives time a price. Whatever is delivered before it closes is
/// confirmed and scored; the clock then resets and the next block begins. A
/// timid run that banks 52 sat has spent the same block a bold one used to
/// bank four thousand, and the leaderboard compares blocks, not lifetimes.
/// </summary>
public class BlockClock : MonoBehaviour
{
    [Tooltip("Unused - see MempoolHosts. Kept so an existing scene reference " +
             "does not break.")]
    public string mempoolApi = "https://mempool.space/api";

    [Tooltip("Seconds in a round. Bitcoin averages ten minutes; that is far " +
             "too long to wait for a score, so a round is a compressed block.")]
    public float blockSeconds = 150f;

    public DeliveryGate gate;
    public GameAudio audioSource;

    /// <summary>Height of the block being mined, or 0 before the first fetch.</summary>
    public int Height { get; private set; }

    [Tooltip("Live chain state. When it is present the height comes from " +
             "there - it is fed by mempool.space's socket and knows about a " +
             "new block within a second of it being found.")]
    public ChainStats stats;

    /// <summary>
    /// The ticks a core run lasts before it is MISSED - the core's own `BLOCK_TICKS`, GENERATED into
    /// `Arena.Layout` rather than written here.
    ///
    /// IT WAS WRITTEN HERE, AND IT DRIFTED. This was a hand-typed 9000 while `packages/nextblock/src/rules/gate.js`
    /// had moved to 10800 (c01cc655, "a round is three minutes"). Nothing threw: the HUD clock simply counted
    /// down to 0:00 at elapsed 9000 and the run went on for another 1800 ticks - thirty seconds of a round with
    /// a timer showing nothing left. That is 2026-09-20 16:21 report, and it is the SECOND time this
    /// clock has told him the round should be over when it was not (2026-09-16 15:36, the comment below).
    /// A number both engines need is not a number either of them may type.
    /// </summary>
    /// SINCE THE 82/90 FORK (2026-10-01) the run's own length, from the core running it - its round's blockTicks -
    /// not the generated constant, which is now only the default a run with no round gets.
    public static int RunTicks => Arena.ArenaCore.RunTicks;

    /// <summary>
    /// Seconds of a core run left after `elapsed` of its ticks, at the core's own rate - 65536/1092 ticks a second
    /// (packages/nextblock/src/tick.js) - never below zero.
    /// </summary>
    public static float CoreSecondsLeft(int elapsed) => Mathf.Max(0, RunTicks - elapsed) * 1092f / 65536f;

    /// <summary>Seconds left in this round.</summary>
    public float Remaining { get; private set; }

    /// <summary>True while the joined round has not started: Remaining is then the time until its start.</summary>
    public bool StartsIn { get; private set; }

    public float Fraction => blockSeconds > 0f ? Mathf.Clamp01(Remaining / blockSeconds) : 0f;

    /// <summary>Sats banked into the block currently being mined.</summary>
    public long PendingSats { get; private set; }

    /// <summary>BTC value moved into the block currently being mined.</summary>
    public double PendingBtc { get; private set; }

    public int PendingRuns { get; private set; }

    /// <summary>A block that was seen through, best first.</summary>
    public class Mined
    {
        public int height;
        public long sats;
        public double btc;
        public int runs;
    }

    /// <summary>Finished blocks, best paying first.</summary>
    public List<Mined> Board { get; } = new List<Mined>();

    /// <summary>Best block so far, or null.</summary>
    public Mined Best => Board.Count > 0 ? Board[0] : null;

    /// <summary>Raised when the block is sealed. A run still out there has lost.</summary>
    public System.Action BlockClosed;

    void Start()
    {
        Remaining = blockSeconds;
        if (gate != null) gate.Delivered += Bank;
        StartCoroutine(PollHeight());
    }

    void OnDestroy()
    {
        if (gate != null) gate.Delivered -= Bank;
    }

    void Bank(long sats)
    {
        PendingSats += sats;
        PendingRuns++;
        if (gate != null) PendingBtc += gate.LastBtc;
    }

    void Update()
    {
        // The block being mined is the one after the tip, and the tip is
        // whatever the chain says it is - over the socket, so a new block
        // shows up here within a second of being found.
        if (stats != null && stats.Recent.Count > 0)
        {
            int mining = stats.Recent[0].height + 1;
            if (mining > Height) Height = mining;
        }

        // A CORE'S RUN IS TIMED BY THE CORE (2026-09-16 15:36: "when time hits zero the round does not
        // end"). This clock was a Unity stopwatch from scene load, looping every 150 s through the lobby too,
        // while the core ends a run at MISSED after `RunTicks` of its own ticks from roll-out - and drops ticks
        // on a slow page. So the HUD read 0:00 while the core still had seconds, or minutes, left, and the run
        // went on. With a core, "left" is the core's own count, and 0:00 is the tick the run ends on.
        // BEFORE A JOINED ROUND STARTS, THE ROUND'S OWN COUNTDOWN (measured 2026-10-04 11:36Z: two devices in one
        // paid round read 107 s and 119 s left at the same instant - the core then is the lobby's practice run, counted from
        // each page's load). The start is the contract's, so every device shows the same.
        int startsIn = Arena.ArenaCore.RoundStartsInMs();
        StartsIn = startsIn > 0;
        if (StartsIn) { Remaining = startsIn / 1000f; return; }
        if (Arena.ArenaCore.Available)
        {
            Remaining = CoreSecondsLeft(Arena.ArenaCore.State[Arena.Layout.O_SCORE + Arena.Layout.S_ELAPSED]);
            return;
        }

        Remaining -= Time.deltaTime;
        if (Remaining > 0f) return;

        Close();
        Remaining = blockSeconds;
    }

    /// <summary>Seal the block and put it on the board.</summary>
    public void Close()
    {
        Board.Add(new Mined
        {
            height = Height,
            sats = PendingSats,
            btc = PendingBtc,
            runs = PendingRuns,
        });
        Board.Sort((a, b) => b.sats.CompareTo(a.sats));
        if (Board.Count > 8) Board.RemoveRange(8, Board.Count - 8);

        // The block closing is the round ending, and a run still on the road
        // when it does has missed it. Announced here so the gate can throw the
        // freight away and start the next one: without this the clock counted
        // down for two minutes and then did nothing at all, which taught the
        // player that time does not matter - and time is the only thing
        // stopping a risk-free trickle from being the best play.
        BlockClosed?.Invoke();

        PendingSats = 0;
        PendingBtc = 0;
        PendingRuns = 0;

        // The height is NOT incremented here any more.
        //
        // A round is compressed - it runs in a fraction of the ten minutes a
        // real block takes - so counting a block per round walked the number
        // away from the chain at several blocks an hour, and the poll below
        // could never correct it because it only ever moved the number
        // forward. The HUD ended up naming a block that did not exist while
        // the post office, reading the same chain from a different endpoint,
        // named the real one two rows away. One source, and it is the chain.
    }

    IEnumerator PollHeight()
    {
        while (true)
        {
            // Only while the socket is not carrying it: this is the fallback
            // for a blocked WebSocket, not a second opinion.
            if (stats == null || stats.Recent.Count == 0)
                yield return MempoolHosts.Get("/blocks/tip/height", 10f, text =>
                {
                    if (text != null &&
                        int.TryParse(text.Trim(), out int tip) && tip > 0)
                    {
                        // the tip is the last block FOUND; the round is the
                        // one being mined on top of it
                        if (tip + 1 > Height) Height = tip + 1;
                    }
                    else if (Height == 0) Height = 900000;   // plausible offline
                });
            yield return new WaitForSeconds(30f);
        }
    }
}
