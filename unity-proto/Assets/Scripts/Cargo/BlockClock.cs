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

    /// <summary>Seconds left in this round.</summary>
    public float Remaining { get; private set; }

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
        Height++;
    }

    IEnumerator PollHeight()
    {
        while (true)
        {
            yield return MempoolHosts.Get("/blocks/tip/height", 10f, text =>
            {
                if (text != null &&
                    int.TryParse(text.Trim(), out int tip) && tip > 0)
                {
                    // Only ever move forward. The round is compressed, so the
                    // local count runs ahead of the chain between fetches, and
                    // snapping back would make the height jump about.
                    if (tip > Height) Height = tip;
                }
                else if (Height == 0) Height = 900000;   // something plausible offline
            });
            yield return new WaitForSeconds(60f);
        }
    }
}
