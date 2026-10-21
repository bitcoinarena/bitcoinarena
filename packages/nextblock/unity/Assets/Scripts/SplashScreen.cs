// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;
using System.Collections.Generic;
#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

/// <summary>
/// The title screen: what the game is, how it is played, and a PLAY button.
///
/// It is not decoration. Browsers refuse to start audio until the page has
/// been clicked, so without a button to press the first run was silent - and
/// the loading ramp opened on a player who had not been told what any of it
/// was for.
///
/// The battlefield runs behind it from the god view, which is where the old
/// VIEW button went: the whole field on show while the rules are being read
/// is worth more than a button nobody pressed twice.
/// </summary>
public class SplashScreen : MonoBehaviour
{
    public ChaseCamera chase;
    public LoadoutPanel loadout;
    public TruckController truck;
    public GameAudio audioSource;

    /// <summary>True until the player has pressed PLAY.</summary>
    public bool Showing { get; private set; } = true;

    Texture2D _flat;
    GUIStyle _title, _sub, _body, _btn;

    // THE DAILY'S LOBBY (M3.3-34, 2026-09-12 22:11-22:16): this screen is
    // the lobby when the page is one - the rounds, who you are, PLAY and
    // SPECTATE. Null when the page is not a lobby (offline, or a round).
    Arena.LobbyState _lobby;
    float _polledAt = -10f, _shownAt = -10f;
    // _pickId: the round PLAY joins now. _tapId: the round the player tapped, if any - only a tap is
    // kept across refreshes; with none, PLAY's target is worked out afresh, a free round first.
    string _pickId = "", _tapId = "", _nameWhy = "";
    int _offset;
    bool _joining, _autoPlay, _hiddenTold;
    float _autoPlayAskedAt = -1f;
    string _adoptedRound = "";
    /// <summary>An adopted next round is being joined: stepped until it plays or is refused, lobby or countdown or neither.</summary>
    bool _nextJoin;
    string _joinWhy = "";
    float _joinedAt = -1f;
    // the owner's four how-to panels (2026-09-14 07:55), loaded once, and where they were drawn
    Texture2D _howToWhole;
    bool _howToAsked;
    Rect _lastHowTo;
    Rect[] _lastHowToCells;
    // A phone upright turns pages (2026-09-15 11:57): which one, its arrows, what was drawn
    int _howToPage;
    bool _lastHowToCarousel;
    Rect _lastHowToPrev, _lastHowToNext;
    readonly System.Collections.Generic.List<int> _howToShown = new System.Collections.Generic.List<int>();
    Rect _lastName, _lastKey, _lastMore, _lastBalance;
    string _lastNotice = "";
    /// <summary>The collect lines this frame drew - text, kind, rect, font size - for the lobby report.</summary>
    readonly List<(string text, string kind, Rect rect, int size)> _lastCollect = new List<(string, string, Rect, int)>();
    string _lastSilent = "";
    Rect _lastSilentRect;
    string _lastHint = "";
    readonly System.Collections.Generic.List<(Arena.LobbyRow row, Rect rect, string words)> _drawnRows =
        new System.Collections.Generic.List<(Arena.LobbyRow row, Rect rect, string words)>();

    void Awake()
    {
        _flat = new Texture2D(1, 1);
        _flat.SetPixel(0, 0, Color.white);
        _flat.Apply();

        // Silence until the button is pressed. A browser would refuse to play
        // it anyway, and starting muted means the first thing heard is the
        // engine rather than half a second of clipped noise.
        AudioListener.volume = 0f;
    }

    void Start()
    {
        if (chase == null) chase = FindFirstObjectByType<ChaseCamera>();
        if (loadout == null) loadout = FindFirstObjectByType<LoadoutPanel>();
        if (truck == null) truck = FindFirstObjectByType<TruckController>();
        if (audioSource == null) audioSource = FindFirstObjectByType<GameAudio>();

        // the whole field, from above, while the rules are being read
        if (chase != null && chase.View != ChaseCamera.Mode.God) chase.Toggle();

        // SENT HERE BY PLAY IN THE LOBBY: the round starts, with no second PLAY.
        _autoPlay = Arena.DailyLobby.AutoPlay();
    }

    void Update()
    {
        // WASTED FIRST, THEN THE LOBBY (2026-09-16 17:00). A wreck ends the run in the same tick, so the lobby
        // came up in the frame the truck blew and covered the whole death sequence.
        // WHILE THE CARGO IS CHOSEN THE CORE STILL HOLDS THE RUN BEFORE (2026-09-26 14:08, measured: after a finished
        // run the next PLAY opened the cargo panel and the lobby came straight back over it - the core's word, left from
        // the run before until roll-out restarts it, read as this run's end and its hold long spent; a WRECKED before read
        // as this run's wreck). Until roll-out this run has no core word of its own; its session's end still counts.
        int runStateNow = RunStateOfThisRun(Arena.ArenaCore.RunState, loadout != null && loadout.IsOpen);
        bool wrecked = Arena.ArenaCore.Available && runStateNow == 2;       // RUN_WRECKED
        if (!wrecked) _wreckedAt = -1f;
        else if (_wreckedAt < 0f) _wreckedAt = Time.unscaledTime;
        if (_health == null) _health = FindFirstObjectByType<TruckHealth>();
        float hold = _health != null ? _health.respawnSeconds : 5f;
        // WHEN THE CORE NAMED THE OUTCOME - the same instant the result card is drawn from, not the later one when
        // the client has finished draining the wire.
        bool ended = RunHasEnded(Arena.ArenaCore.Available, runStateNow, Arena.ArenaNet.Ended);
        if (!ended) { _endedRawAt = -1f; _endedAt = -1f; }
        else
        {
            if (_endedRawAt < 0f) _endedRawAt = Time.unscaledTime;
            if (_endedAt < 0f)
            {
                bool coreNamed = Arena.ArenaCore.Available && runStateNow != 0;
                bool haveReason = !coreNamed && !string.IsNullOrEmpty(Arena.ArenaNet.Ending());
                if (HoldMayStart(coreNamed, haveReason, Time.unscaledTime - _endedRawAt))
                    _endedAt = Time.unscaledTime;
            }
        }
        if (_hud == null) _hud = FindFirstObjectByType<DriveHud>();
        // THE NEXT ROUND IS COMING, SO THE LOBBY IS NOT (2026-09-29 21:58, SPECTATE-2158): while the page takes the
        // player to the next round - its countdown up, from the run's end until "exit game" or that round's start - no
        // PLAY, no round list, no banner: the result card, or WASTED, stays and the camera is the player's.
        if (!Showing && Time.unscaledTime - _continuingPolledAt > 0.5f)
        {
            _continuingPolledAt = Time.unscaledTime;
            var page = Arena.DailyLobby.Poll();
            Continuing = page != null && page.continuing;
            NextBoxTop = page != null ? page.nextBoxTop : 0f;
            if (FollowsThePage(Continuing, _nextJoin) && page != null) _lobby = page;
        }
        if (Showing) Continuing = false;
        // AND WHILE THE RESULT SUMMARY HOLDS (2026-10-04): on a wreck too, which draws no card - the page's hold to the
        // round's close + 20 s (DriveHud.ResultHolding), so the signed names stand on WASTED as on the card
        bool cardUp = _hud != null && (_hud.ArrivalShowing || _hud.ResultHolding);
        if (!Showing && MayReturnToLobby(Continuing, _nextJoin) && LobbyMayCover(cardUp) && ShouldReturnToLobby(Arena.ArenaCore.Available, runStateNow, Arena.ArenaNet.Ended,
                                           _fromLobby, wrecked,
                                           _wreckedAt < 0f ? 0f : Time.unscaledTime - _wreckedAt, hold,
                                           _endedAt < 0f ? 0f : Time.unscaledTime - _endedAt)) ShowLobbyAgain();
        if (!Showing && !Continuing && BackFromSpectating(_spectating, _spectator != null && _spectator.Active)) ShowLobbyAgain();
        // AND THE NEXT ROUND'S JOIN IS TAKEN HERE, lobby or not: held by the page to its start, then played.
        if (!Showing && FollowsThePage(Continuing, _nextJoin)) { AdoptNextJoin(); if (StepJoin()) return; }
        // A NODE REFUSED THE ENTRY BEFORE THE RUN WAS LIVE (2026-09-26, the 21:13 case): the page has taken the
        // join fallback and reports the join refused; with no live session and the truck still at the ramp, this round is
        // not played - the chooser closes and the lobby comes back, its "Not joined" line the page's.
        if (!Showing && Time.unscaledTime - _refusedPolledAt > 0.5f)
        {
            _refusedPolledAt = Time.unscaledTime;
            var page = Arena.DailyLobby.Poll();
            if (JoinRefusedBeforeLive(page != null && page.join != null ? page.join.state : "", Arena.ArenaNet.Live,
                                      loadout != null && loadout.IsOpen))
            {
                if (loadout != null) loadout.Dismiss();
                ShowLobbyAgain();
                _lobby = page;
                _joinWhy = page.join.why;
            }
        }
        if (!Showing)
        {
            if (!_hiddenTold && Arena.DailyLobby.Compiled) { _hiddenTold = true; Arena.DailyLobby.Shown("{\"showing\":false}"); }
            return;
        }
        // held here, whatever else thinks it should be driveable
        if (truck != null) truck.controlsLocked = true;
        // ON THE PAGE'S WORD: a round link held to its start does not drive on its play=1
        if (_autoPlay && Time.frameCount > 3)
        {
            if (_autoPlayAskedAt < 0f) _autoPlayAskedAt = Time.realtimeSinceStartup;
            string step = Arena.DailyLobby.LinkAutoPlayStep(Arena.DailyLobby.LinkAutoPlay(), Time.realtimeSinceStartup - _autoPlayAskedAt);
            if (step == "play") { _autoPlay = false; Play(fromAddress: true); return; }
            if (step == "no") { _autoPlay = false; Debug.Log("[SplashScreen] the round link is held to its start: no drive on play=1"); }
        }

        // The page's lobby, asked again every 0.75 s (it asks the signer nodes every 5 s).
        if (Time.unscaledTime - _polledAt > 0.75f)
        {
            _polledAt = Time.unscaledTime;
            _lobby = LobbyOrReading(Arena.DailyLobby.Poll(), Arena.DailyLobby.Compiled);
            // A ROUND LINK THE PAGE COULD NOT JOIN comes back to this lobby with its reason (the page's ARENA_JOIN).
            if (_lobby != null && !_joining && string.IsNullOrEmpty(_joinWhy) && _lobby.join.state == "refused")
                _joinWhy = _lobby.join.why;
            if (_lobby != null)
            {
                // THE PLAYER'S TAP IS KEPT, A DEFAULT IS NOT (2026-09-15, free first): keeping
                // the last default made a paying round picked once stay picked through every rollover.
                int k = Arena.DailyLobby.Keep(_lobby.rows, _tapId);
                _pickId = k >= 0 ? _lobby.rows[k].id : "";
            }
        }

        AdoptNextJoin();
        StepJoin();
    }

    /// <summary>True while the page is taking the player to the next round (SPECTATE-2158); DriveHud keeps the card up.</summary>
    public static bool Continuing { get; private set; }
    /// <summary>Where the page's next-round box starts, a fraction of the canvas from its top (0 while it is not up): the result card's floor.</summary>
    public static float NextBoxTop { get; private set; }

    /// <summary>
    /// THE NEXT ROUND IS PLAYED, NOT THE LOBBY (2026-09-30 09:39, item 2: "After the countdown the lobby comes back and
    /// the player must join by hand. Wrong. The next round starts by itself"). At the next round's start the page says, in
    /// the same repaint, that its join is "joined" and that it is no longer continuing. A poll that read both at once left
    /// the adopted join unread and unstepped - it was stepped and the page read only while continuing - and the last run's
    /// ended word, its hold long spent, brought the lobby back and dropped the join. An adopted join is followed until it
    /// plays or is refused, continuing or not.
    /// </summary>
    public static bool FollowsThePage(bool continuing, bool nextJoinGoing) => continuing || nextJoinGoing;

    /// <summary>The end of the last run goes back to the lobby only while no next round is coming or being joined.</summary>
    public static bool MayReturnToLobby(bool continuing, bool nextJoinGoing) => !continuing && !nextJoinGoing;
    float _continuingPolledAt = -10f;

    /// <summary>
    /// THE NEXT ROUND THE PAGE ENTERED IS PLAYED LIKE ONE PLAY JOINED (2026-09-28, option 1 of A: continuing is the
    /// default). The page enters round i+1 after a run and holds it until its start; Unity takes that join as its own,
    /// once per round, and starts the run when it says joined - at the round's start, with everybody.
    /// </summary>
    void AdoptNextJoin()
    {
        if (!_joining && _lobby != null && _lobby.join != null && _lobby.join.next && !string.IsNullOrEmpty(_lobby.join.round)
            && _lobby.join.round != _adoptedRound && (_lobby.join.state == "joining" || _lobby.join.state == "joined"))
        {
            _adoptedRound = _lobby.join.round;
            _joining = true; _nextJoin = true; _joinedAt = -1f; _joinWhy = "";
        }
    }

    /// <summary>
    /// PLAY IN THE LOBBY JOINS IN THIS PAGE (2026-09-13 07:11): no reload, so no second loading screen - the round
    /// starts here once the page has joined it. True when the run was started.
    /// </summary>
    bool StepJoin()
    {
        if (!_joining || _lobby == null) return false;
        if (_lobby.join.state == "joined" && _joinedAt < 0f) _joinedAt = Time.unscaledTime;
        string next = Arena.DailyLobby.AfterJoin(_lobby, Arena.ArenaNet.Live,
                                                _joinedAt < 0f ? 0f : Time.unscaledTime - _joinedAt);
        if (next == "play") { _joining = false; _nextJoin = false; Continuing = false; Play(); return true; }
        if (next == "refused") { _joining = false; _nextJoin = false; _joinWhy = _lobby.join.why; _polledAt = -10f; }
        return false;
    }

    /// <summary>Free camera, without starting the round.</summary>
    public void Spectate()
    {
        WakeAudio();
        var cam = Object.FindFirstObjectByType<SpectatorCamera>();
        if (cam != null) cam.Enter();
        _spectator = cam;
        _spectating = true;
        Showing = false;
    }

    /// <summary>SPECTATE hid the lobby, and the free camera it opened.</summary>
    bool _spectating;
    SpectatorCamera _spectator;

    /// <summary>
    /// EXIT FROM SPECTATE GOES BACK TO THE LOBBY (2026-09-16 14:45). SPECTATE hides the lobby and opens the
    /// free camera; EXIT only closed the camera, so the player was left over a locked truck with no PLAY - measured
    /// on 0.0.1391, the lobby still not showing 1, 5 and 15 s after EXIT. The lobby comes back once the camera
    /// SPECTATE opened is no longer flying.
    /// </summary>
    public static bool BackFromSpectating(bool spectating, bool cameraActive) => spectating && !cameraActive;

#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")] static extern void UnlockAudio();
    [DllImport("__Internal")] static extern void ArenaBenchmark();
#endif

    /// <summary>
    /// Wakes the browser's audio, from inside the gesture that asked for it.
    ///
    /// A phone browser will not start an AudioContext outside a user gesture,
    /// and iOS additionally wants something PLAYED inside that same gesture
    /// before it will believe the context is in use - which is why the game
    /// was silent on a phone while being perfectly audible on a desktop, where
    /// Unity's own one-shot resume is enough.
    /// </summary>
    public static void WakeAudio()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        try { UnlockAudio(); } catch (System.Exception e) { Debug.LogWarning(e.Message); }
#endif
    }

    /// <summary>A round was started from the lobby, so its end comes back here.</summary>
    bool _fromLobby;

    /// <summary>
    /// BACK TO THE LOBBY WHEN THE RUN IS OVER (2026-09-15 16:14: a live drive into the
    /// mouth ends and the player is back in the lobby). The page says the run ended - the core's
    /// DELIVERED finished it, or a VOID did - and a round PLAY started from this lobby comes back
    /// to it, instead of leaving the player on a truck that can no longer be driven.
    /// </summary>
    public static bool BackToLobby(bool runEnded, bool fromLobby) => runEnded && fromLobby;

    /// <summary>
    /// AND A WRECK IS SHOWN BEFORE IT (2026-09-16 17:00: "when he dies the WASTED screen is missing and the
    /// lobby comes first. Show WASTED, then lobby"). A run the core ended WRECKED goes back only once the death
    /// sequence has had `hold` unscaled seconds - the truck's own burn, `TruckHealth.respawnSeconds`.
    /// </summary>
    public static bool BackToLobby(bool runEnded, bool fromLobby, bool wrecked, float sinceWreck, float hold) =>
        BackToLobby(runEnded, fromLobby) && (!wrecked || sinceWreck >= hold);

    /// <summary>
    /// AND EVERY RESULT IS READ BEFORE THE LOBBY TAKES THE SCREEN (2026-09-18 19:30: "lobby comes back too
    /// fast when the truck reaches the goal - the player cannot read the result. Hold the result at least 5 seconds").
    ///
    /// A run ends in the tick the core says DELIVERED, and the page hands that word over in the same frame, so the
    /// lobby came up on top of the outcome the player had just earned. The wreck already had this rule since the
    /// 17:00 report - WASTED first, then the lobby - and a delivery is the same thing from the other end.
    ///
    /// `FINISH_WAIT_MS` in the client is not this: 300 ms is how long the last ticks have to reach the wire, which is
    /// a network drain and was never a screen.
    /// </summary>
    /// <summary>
    /// HAS THE RUN ENDED - whoever named it.
    ///
    /// The core names DELIVERED, WRECKED or MISSED and that is the usual instant. But a run can end without the
    /// core ever naming one, and that case had no clock at all. MEASURED 2026-09-20, two reproductions on the
    /// Daily at 0.0.1812 with two real browser tabs: one tab fell about 2000 ticks - 33 s - behind the other,
    /// kept playing after its round had closed, and the node ANSWERED and refused those inputs ("the node refuses
    /// this run's inputs at tick 8576: error the round is closed, and it still refused after resyncing"). The
    /// client ended that run VOID while the core's word stayed 0 for ever, because the core never reached an
    /// outcome.
    ///
    /// The old test was `core available AND RunState != 0`, with a second line for a page that has NO core. A
    /// VOID is neither: the core is there and it is silent. So `_endedAt` was reset every frame, `sinceOutcome`
    /// stayed 0, `BackToLobby` could never come true, and that tab sat on a dead screen - truck locked, nothing
    /// to press - while the other player was already in the lobby choosing round two. That is why round two had
    /// one invisible truck: the missing player never left round one.
    ///
    /// Nothing about settlement changes here and VOID is not made an escape hatch: the run is already over and
    /// already VOID by the time this is asked, this only decides when the screen may be given back.
    /// </summary>
    public static bool RunHasEnded(bool coreAvailable, int runState, bool netEnded)
        => (coreAvailable && runState != 0) || netEnded;

    /// <summary>
    /// THE WHOLE RETURN-TO-LOBBY DECISION, in one place so it can be tested as one.
    ///
    /// THE TIMER MUST END THE ROUND (2026-09-20 16:21: "when the round timer hits 0 the game must end and
    /// return to the lobby by itself. It used to. It no longer does."). The core does its half: measured, a run
    /// braked from the start reaches RUN_MISSED at elapsed 10800 - `gate.js` returns RUN_MISSED once
    /// `tickInBlock >= BLOCK_TICKS`. What failed was the client's half, and it was an asymmetry left here
    /// earlier the same day: the hold CLOCK was started from `RunHasEnded` - the core's word OR the client's -
    /// while this gate was still handed `ArenaNet.Ended` alone. So a round the CORE had ended, with no session
    /// word to go with it, started its five seconds and then never took them: the truck sat in a finished world.
    ///
    /// Both halves now ask the same question. The result hold is unchanged and still separate, so a run that ends
    /// is still read before the lobby takes the screen.
    /// </summary>
    public static bool ShouldReturnToLobby(bool coreAvailable, int runState, bool netEnded, bool fromLobby,
                                           bool wrecked, float sinceWreck, float hold, float sinceOutcome)
        => BackToLobby(RunHasEnded(coreAvailable, runState, netEnded), fromLobby, wrecked, sinceWreck, hold, sinceOutcome);

    /// <summary>How long a run with no core word waits for its reason before the hold starts without one.</summary>
    public const float ReasonWaitSeconds = 2f;

    /// <summary>
    /// WHEN THE RESULT HOLD MAY START TICKING.
    ///
    /// For a run the core named, the instant it named it - unchanged. For a run that ended without a core word,
    /// the instant the REASON is known, and this was measured the hard way. `ArenaNet.Ended` flips when the client
    /// gives up, but the line that says why only arrives after it has resynced and been refused again. Timed from
    /// the flip, the whole hold is spent before there is anything to show: in the BAY the gap between the VOID
    /// and the lobby was 0.6 s, against a 0.5 s reason poll, so whether the player was told depended on which
    /// landed first - bay-04.png has the line, bayok-27.png is the same state with nothing on screen.
    ///
    /// `sinceEnded` is the guard and it is the half that must never regress: a reason that never comes must NOT
    /// hold the screen, because a stranded tab is the fault the behind-client fix closed. After
    /// ReasonWaitSeconds the hold starts anyway - back to the lobby with no reason beats not going back.
    /// </summary>
    public static bool HoldMayStart(bool coreNamed, bool haveReason, float sinceEnded)
        => coreNamed || haveReason || sinceEnded >= ReasonWaitSeconds;

    /// <summary>The page reports the join refused, no session is live, and the truck is still at the ramp: back to the lobby.</summary>
    public static bool JoinRefusedBeforeLive(string joinState, bool sessionLive, bool atTheRamp) =>
        joinState == "refused" && !sessionLive && atTheRamp;

    float _refusedPolledAt = -10f;

    public const float ResultHoldSeconds = DriveHud.ArrivalHoldSeconds;   // 8 s (2026-09-25 21:53), the card's own

    /// <summary>
    /// ONLY THE LOBBY AFTER THE LOADING SCREEN (2026-09-25 21:11/21:13, phone, btc-logistics-core.pages.dev: "the
    /// old splash is still there ... That splash must not draw. A closed round is not a reason to show it").
    ///
    /// In a browser build this screen is the lobby and nothing else: while the page has no lobby to hand over - before its
    /// first read, or a round link it could not join on its way back to the lobby - it is the lobby still being read, not
    /// the title screen (LOAD / DRIVE / DELIVER), which is left for the editor and a build with no page.
    /// </summary>
    public static Arena.LobbyState LobbyOrReading(Arena.LobbyState polled, bool inAPage) =>
        polled != null || !inAPage ? polled : new Arena.LobbyState { mode = "lobby", from = Reading };

    /// <summary>The lobby's `from` while the page has none to hand over yet.</summary>
    public const string Reading = "reading";

    /// <summary>
    /// THE LOBBY IS NOT DRAWN OVER THE RESULT CARD (2026-09-25, playtest 18:39 follow-up: "while the result card
    /// is up, the lobby is not drawn over it ... The check is coverage, not the clock").
    ///
    /// The card (DriveHud.ArrivalShowing) and the lobby's hold (ResultHoldSeconds) are both five seconds, but on two
    /// clocks started a frame apart - the gate's MissedAt / delivery and this screen's _endedAt - so on a slow frame the
    /// lobby could come up while the card was still drawn, over its "copy game replay" button. The lobby now waits for
    /// the card itself: it neither comes back nor draws while the card is up. Once the card is down it draws as before.
    /// </summary>
    public static bool LobbyMayCover(bool resultCardUp) => !resultCardUp;

    DriveHud _hud;

    /// <summary>
    /// AND THE HOLD IS TIMED FROM THE OUTCOME ITSELF, not from the wire (2026-09-18 20:00: "one clock").
    ///
    /// `sinceOutcome` is measured from the instant the CORE named the run - RUN_DELIVERED, WRECKED or MISSED - which
    /// is the same instant `DriveHud` starts its result card from. Timing this from the client's `Ended` instead put
    /// the two on different clocks: the card fades five seconds after the delivery and the lobby arrived five
    /// seconds after `finish()` had drained the wire, so the player got a strip of plain world in between.
    /// `FINISH_WAIT_MS` is that drain and is not a screen.
    /// </summary>
    public static bool BackToLobby(bool runEnded, bool fromLobby, bool wrecked, float sinceWreck, float hold,
                                   float sinceOutcome) =>
        BackToLobby(runEnded, fromLobby, wrecked, sinceWreck, hold) && sinceOutcome >= ResultHoldSeconds;

    float _wreckedAt = -1f;
    float _endedAt = -1f;
    float _endedRawAt = -1f;
    TruckHealth _health;

    /// <summary>The core's run word as this run's: none while the cargo panel is open - the core holds the run before.</summary>
    public static int RunStateOfThisRun(int coreRunState, bool loadoutOpen) => loadoutOpen ? 0 : coreRunState;

    void ShowLobbyAgain()
    {
        // a run that ends at the ramp takes its open cargo panel with it
        if (loadout != null && loadout.IsOpen) loadout.Dismiss();
        _spectating = false;
        _fromLobby = false;
        _joining = false;
        _nextJoin = false;
        _joinedAt = -1f;
        _joinWhy = "";
        _hiddenTold = false;
        _polledAt = -10f;
        Showing = true;
    }

    public void Play() => Play(fromAddress: false);

    /// <summary>
    /// WHETHER THE END OF THIS RUN GOES BACK TO THE LOBBY. PLAY pressed in the lobby does; so does a run the
    /// page's address started (`play=1`, what PLAY leaves behind and a reload brings back). That one used
    /// to be decided by whether a lobby poll had landed yet - auto-play fires on the fourth frame, before
    /// the first poll - so it never came back (2026-09-16 14:24, measured on 0.0.1386).
    /// </summary>
    public static bool StartedFromLobby(bool lobbyPolled, bool fromAddress) => lobbyPolled || fromAddress;

    void Play(bool fromAddress)
    {
        // Fly in from over the middle of the field.
        //
        // A cut straight to the tailgate shows neither the fighting nor the
        // building the freight comes out of, which are the two things worth
        // seeing before a run. It starts high over the battlefield looking at
        // the post office and swings onto the truck as it arrives.
        var chase = FindFirstObjectByType<ChaseCamera>();
        var post = FindFirstObjectByType<PostOffice>();
        if (chase != null)
            chase.FlyIn(new Vector3(0f, 52f, 0f),
                        post != null ? post.BayPosition + Vector3.up * 18f
                                     : new Vector3(-114f, 20f, 0f),
                        4.2f);

        // THE LAST ROUND'S WRECK GOES NOW, behind the lobby as it closes (2026-09-27 13:25): in a live round it
        // was held under WASTED rather than brought back into the bay
        var wreck = FindFirstObjectByType<TruckHealth>();
        if (wreck != null) wreck.Revive();
        _spectating = false;                      // a run is not spectating, whatever the camera does later
        _fromLobby = StartedFromLobby(_lobby != null, fromAddress);
        Showing = false;
        WakeAudio();
        AudioListener.volume = 1f;
        if (chase != null && chase.View == ChaseCamera.Mode.God) chase.Toggle();
        if (loadout != null) loadout.Open();      // straight to the ramp
    }

    void Styles(int sw, int sh)
    {
        int min = Mathf.Min(sw, sh);
        if (_title == null)
        {
            _title = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontStyle = FontStyle.Bold };
            // wrapped, because the standfirst and the footnote are sentences,
            // and a centred style that cannot wrap runs straight off the panel
            _sub = new GUIStyle(GUI.skin.label)
                { alignment = TextAnchor.MiddleCenter, wordWrap = true };
            _body = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperLeft, wordWrap = true };
            // No skin box: the gradient and border underneath are the button,
            // and Unity's default grey would sit on top of them.
            _btn = new GUIStyle(GUI.skin.label)
                { alignment = TextAnchor.MiddleCenter, fontStyle = FontStyle.Bold };
        }
        _title.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.070f, 30f, 68f));
        _sub.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.028f, 14f, 24f));
        _body.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.026f, 13f, 22f));
        _btn.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.040f, 18f, 34f));
    }

    /// <summary>
    /// Every rectangle on the screen, in one place.
    ///
    /// The layout is arithmetic and nothing else, which is what lets it be
    /// checked by measurement rather than by looking at it. That matters here:
    /// OnGUI never runs in batch mode, so a title screen can only be tested at
    /// all if its geometry can be asked for without drawing it - and the
    /// version of this screen that drew its hint line inside its own second
    /// button looked perfectly fine on the one window it was written for.
    /// </summary>
    public struct Frame
    {
        public Rect panel, head, copy, hint, play, spectate, build;
        public float pad;
    }

    /// <summary>
    /// Lays the screen out from the bottom up: the buttons take their room
    /// first, the hint takes a line above them, and the copy gets whatever is
    /// left over. Nothing in here can land on anything else, at any size.
    /// </summary>
    public static Frame Measure(float w, float h, float subFont, float btnFont)
    {
        float pw = Mathf.Min(w * 0.86f, 900f);
        float ph = Mathf.Min(h * 0.88f, 760f);
        var panel = new Rect((w - pw) * 0.5f, (h - ph) * 0.5f, pw, ph);
        var head = new Rect(panel.x, panel.y, panel.width, Mathf.Clamp(ph * 0.13f, 44f, 96f));

        float pad = pw * 0.07f;
        // AND NO MORE THAN 7% OF THE HEIGHT, up and down. The pad is the width's,
        // and on a phone held sideways that is a wide margin on a short screen:
        // measured, at 800x360 the lobby had 55 px for its rounds - one row
        // (LobbyScreenTests). Across, the pad stays the width's.
        float padV = Mathf.Min(pad, ph * 0.07f);
        float inner = panel.width - pad * 2f;
        float bh = Mathf.Max(30f, btnFont * 2.0f);
        float gap = Mathf.Max(8f, padV * 0.35f);

        // one row, one baseline, one height - the primary takes half because it is the one to press; SPECTATE the other half
        // (BENCHMARK is in the page's Settings since, 2026-10-16: "Remove the benchmark button and have that in
        // the settings instead")
        float row = panel.yMax - padV * 0.6f - bh;
        float wide = (inner - gap) * 0.5f;
        var play = new Rect(panel.x + pad, row, wide, bh);
        var spectate = new Rect(play.xMax + gap, row, inner - wide - gap, bh);

        float hintHigh = subFont * 1.5f;
        var hint = new Rect(panel.x + pad, row - gap - hintHigh, inner, hintHigh);

        // WHICH BUILD THIS IS, on its own line under the title bar.
        //
        // A row of its own rather than tucked into a corner of another one:
        // twice in one session a measured fix "changed nothing on the phone"
        // and both times the page was serving an older build than the one
        // being argued about. It is only useful if it cannot be drawn over.
        var build = new Rect(panel.x + pad, head.yMax + ph * 0.008f,
                             inner, Mathf.Max(12f, subFont * 1.3f));

        float top = build.yMax + ph * 0.02f;
        var copy = new Rect(panel.x + pad, top, inner,
                            Mathf.Max(0f, hint.y - padV * 0.25f - top));

        return new Frame { panel = panel, head = head, copy = copy, hint = hint,
                           play = play, spectate = spectate, pad = pad, build = build };
    }

    void OnGUI()
    {
        // NOTHING ON THE FIRST FRAME (2026-10-08): the first OnGUI's text layout and font-atlas fill were
        // 320 ms inside Unity's 2.2 s start-up hold at 10x CPU as an Android phone (named profile, DriveHud.OnGUI first draw);
        // drawn from the next frame on, that work leaves the hold.
        if (FirstGuiFrame.Now()) return;
        if (!Showing) return;
        _lobby = LobbyOrReading(_lobby, Arena.DailyLobby.Compiled);     // never the title screen in a page, not even a frame
        if (!LobbyMayCover(_hud != null && _hud.ArrivalShowing)) return;   // the result card is up: not over it
        // LAID OUT IN CSS PIXELS, DRAWN AT THE SCREEN'S SCALE. A phone's canvas is
        // 2-3x its CSS size, and a title screen laid out in device pixels showed an
        // iPhone text about 8 points high (measured, M3.3-34). IMGUI's matrix
        // scales the drawing and the touches alike.
        float scale = Arena.DailyLobby.UiScale();
        var screenMatrix = GUI.matrix;
        GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1f));
        int w = Mathf.RoundToInt(Screen.width / scale), h = Mathf.RoundToInt(Screen.height / scale);
        Styles(w, h);
        GUI.depth = -200;                          // in front of everything


        // A wash rather than a curtain: the battle behind this is the best
        // argument the game has, and it is running whether anyone watches or
        // not.
        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.62f);
        GUI.DrawTexture(new Rect(0, 0, w, h), _flat);
        GUI.color = Color.white;

        // The copy is given the space that is left, and set smaller until it
        // fits in it. A hard floor under the text is the only thing that makes
        // "the buttons are clear of it" true on a window nobody tried - a
        // phone in landscape has about a third of the height this was drawn
        // for.
        var f = Measure(w, h, _sub.fontSize, _btn.fontSize);
        bool lobby = _lobby != null;
        for (int guard = 0; !lobby && guard < 8 && _body.fontSize > 10; guard++)
        {
            if (Copy(f.copy.width, false, 0f, 0f) <= f.copy.height) break;
            Shrink(0.92f);
            f = Measure(w, h, _sub.fontSize, _btn.fontSize);
        }

        var panel = f.panel;
        var head = f.head;
        float pw = panel.width, ph = panel.height, pad = f.pad;

        PanelSkin.Glow(panel, PanelSkin.Gold, 6, 0.34f);
        PanelSkin.Body(panel);
        PanelSkin.Border(panel, new Color(PanelSkin.Gold.r, PanelSkin.Gold.g, PanelSkin.Gold.b, 0.85f));
        PanelSkin.Scan(panel, PanelSkin.Cyan, 5.5f);

        float tape = Mathf.Clamp(pw * 0.011f, 9f, 17f);
        PanelSkin.Hazard(new Rect(panel.x + 2f, head.yMax, tape, panel.yMax - head.yMax - 2f),
                         PanelSkin.Gold);
        PanelSkin.Hazard(new Rect(panel.xMax - tape - 2f, head.yMax, tape, panel.yMax - head.yMax - 2f),
                         PanelSkin.Gold);

        PanelSkin.Gradient(head, new Color(0.17f, 0.14f, 0.07f, 0.98f),
                                 new Color(0.07f, 0.065f, 0.05f, 0.98f));
        PanelSkin.Rule(new Rect(head.x, head.yMax - 3f, head.width, 3f), PanelSkin.Gold);

        // THE NAME ON ONE LINE WITH THE GAME'S MARK BESIDE IT: "TICK TOCK, NEXT BLOCK" is longer than the old
        // title and wrapped to two lines on a phone, under the backup banner. The icon and the name are centred together in
        // the bar, and set smaller until both fit on one line.
        _title.wordWrap = false;
        Vector2 need = _title.CalcSize(new GUIContent(Title));
        float mark = 0f, gap = 0f;
        for (int guard = 0; guard < 24; guard++)
        {
            need = _title.CalcSize(new GUIContent(Title));
            mark = NextBlockMark.Icon != null ? Mathf.Min(head.height * 0.78f, need.y * 1.15f) : 0f;
            gap = mark > 0f ? Mathf.Max(6f, mark * 0.25f) : 0f;
            if ((need.x + mark + gap + 24f <= head.width && need.y <= head.height) || _title.fontSize <= 12) break;
            _title.fontSize = Mathf.Max(12, Mathf.RoundToInt(_title.fontSize * 0.92f));
        }
        float shift = (mark + gap) * 0.5f;                     // the name moves right by half the mark: the pair is centred
        var name = new Rect(head.x + shift, head.y, head.width, head.height);
        _title.normal.textColor = new Color(0f, 0f, 0f, 0.6f);
        GUI.Label(new Rect(name.x + 3f, name.y + 4f, name.width, name.height), Title, _title);
        _title.normal.textColor = PanelSkin.Gold;
        GUI.Label(name, Title, _title);
        if (mark > 0f)
            NextBlockMark.DrawIcon(new Rect(name.center.x - need.x * 0.5f - gap - mark, head.center.y - mark * 0.5f, mark, mark));

        // The build, right-aligned on its own row under the title bar.
        var stamp = new GUIStyle(_sub)
        {
            alignment = TextAnchor.MiddleRight,
            fontSize = Mathf.Max(10, Mathf.RoundToInt(_sub.fontSize * 0.8f)),
        };
        stamp.normal.textColor = new Color(1f, 1f, 1f, 0.5f);
        GUI.Label(f.build, $"build {BuildStamp.Current}", stamp);

        if (lobby) Lobby(f.copy); else Copy(f.copy.width, true, f.copy.x, f.copy.y);
        Buttons(f);

        PanelSkin.Corners(panel, PanelSkin.Gold, 4f);
        Report(w, h, f);
        GUI.matrix = screenMatrix;
    }

    // ------------------------------------------------------------ the lobby

    /// <summary>
    /// The lobby in the copy area: who you are with NAME and KEY, then the
    /// rounds - each with its signer nodes' word - and the one PLAY will join picked
    /// out. Laid out by `DailyLobby.MeasureLobby`, which is measured on every
    /// phone shape (LobbyScreenTests). Every word comes from the page.
    /// </summary>
    void Lobby(Rect copy)
    {
        float font = _sub.fontSize;
        var l = Arena.DailyLobby.MeasureLobby(copy, font, Screen.height > Screen.width);
        _lastName = l.name; _lastKey = l.key; _lastMore = l.more; _lastHowTo = l.howTo; _lastHowToCells = l.howToCells;
        _lastHowToCarousel = l.howToCarousel; _lastHowToPrev = l.howToPrev; _lastHowToNext = l.howToNext;
        var you = _lobby.you;

        // THE OWNER'S HOW-TO, FOUR PANELS, EACH WHOLE (2026-09-14 07:55): load
        // mempool TXs, cross the front (closer = more points), deliver to miners,
        // stake sats and win. 1-2-3-4 in a row on a desktop, 1-2 over 3-4 on a
        // phone; drawn with their alpha, so the knocked-out white shows the panel.
        // EACH FROM THE OWNER'S WHOLE, BY ITS OWN BOX: the tiles that came with it
        // were cut at half height and split panels 1 and 2 (measured, 1280x800).
        // A cell is exactly its panel's shape, so nothing is stretched.
        if (!_howToAsked) { _howToAsked = true; _howToWhole = Resources.Load<Texture2D>(Arena.DailyLobby.HowToWhole); }
        // A PHONE UPRIGHT TURNS PAGES (2026-09-15 11:57, option B): only the page shown is
        // drawn - one panel, 1 to 4 - and the arrows turn back and on, round.
        _howToShown.Clear();
        if (_howToWhole != null && l.howToCells != null)
            for (int i = 0; i < l.howToCells.Length; i++)
            {
                if (l.howToCarousel && Arena.DailyLobby.HowToPageOf(i) != _howToPage) continue;
                var cell = l.howToCells[i];
                if (cell.width <= 0f || cell.height <= 0f) continue;
                GUI.DrawTextureWithTexCoords(cell, _howToWhole, Arena.DailyLobby.PanelUv(i));
                _howToShown.Add(i + 1);
            }
        if (l.howToCarousel)
        {
            var arrow = new GUIStyle(GUI.skin.button) { fontSize = Mathf.RoundToInt(font * 1.6f), alignment = TextAnchor.MiddleCenter };
            int pages = Arena.DailyLobby.HowToPages;
            if (GUI.Button(l.howToPrev, "<", arrow)) _howToPage = (_howToPage + pages - 1) % pages;
            if (GUI.Button(l.howToNext, ">", arrow)) _howToPage = (_howToPage + 1) % pages;
        }

        var youStyle = new GUIStyle(_body)
            { fontSize = Mathf.RoundToInt(font), wordWrap = true, richText = true, alignment = TextAnchor.MiddleLeft };
        youStyle.normal.textColor = Color.white;
        // A WITHDRAWAL AVAILABLE (2026-09-14) takes the key's line until it is withdrawn;
        // a name the page refused still comes first, and KEY still shows the key.
        _lastNotice = Arena.DailyLobby.WithdrawNotice(_lobby);
        string second = !string.IsNullOrEmpty(_nameWhy) ? $"<color=#ff7b72>{Escape(_nameWhy)}</color>"
            : !string.IsNullOrEmpty(_lastNotice) ? $"<color=#3fb950><b>{Escape(_lastNotice)}</b></color>"
            : $"<color=#9fb3c8>key {Escape(you.fingerprint)}</color>";
        // SET SMALLER UNTIL IT FITS ITS BOX. Measured on an iPhone (390x844 at 3x):
        // the name wrapped to a third line in a two-line box, and the box clipped
        // "You are" at the top and the key at the bottom (the owner 22:16: every
        // element fully visible).
        // NO NAME AND NO KEY IN THE LOBBY (2026-09-29 12:47, SETTINGS-1254: "Remove the name and the key from the lobby.
        // The name lives in settings only"). The page's strip over the lobby shows the balance; this box keeps only a
        // withdrawal that is waiting, or why a name was refused.
        // AND THE BALANCE WHERE THEY WERE (2026-09-29: "display balances on top of lobby in the modal"): the row NAME
        // and KEY stood in, above the rounds, is reported as `balance`; the page draws confirmed and pending there, with
        // their icons, over this panel.
        _lastBalance = Rect.MinMaxRect(Mathf.Min(l.name.xMin, l.key.xMin), Mathf.Min(l.name.yMin, l.key.yMin),
                                       Mathf.Max(l.name.xMax, l.key.xMax), Mathf.Max(l.name.yMax, l.key.yMax));
        _lastName = new Rect(); _lastKey = new Rect();
        if (!string.IsNullOrEmpty(_nameWhy) || !string.IsNullOrEmpty(_lastNotice))
        {
            var youText = new GUIContent(second);
            while (youStyle.fontSize > 10 && youStyle.CalcHeight(youText, l.you.width) > l.you.height) youStyle.fontSize--;
            GUI.Label(l.you, youText, youStyle);
        }

        var rows = _lobby.rows;
        var head = new GUIStyle(_body)
            { fontSize = Mathf.RoundToInt(font), fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleLeft, wordWrap = false };
        head.normal.textColor = PanelSkin.Gold;
        // each kind listed with its own signer numbers, from its rows (follow-up) - no fixed 2
        GUI.Label(l.head, FitWords(head, Arena.DailyLobby.HeaderWordings(rows), l.head.width), head);   // the longest that fits
        if (_offset >= rows.Length) _offset = 0;
        if (l.rows > 0 && rows.Length > l.rows)
        {
            int pages = (rows.Length + l.rows - 1) / l.rows;
            if (SmallButton(l.more, $"{_offset / l.rows + 1}/{pages} >")) _offset = (_offset + l.rows) % rows.Length;
        }
        else _offset = 0;

        _drawnRows.Clear();
        var rowStyle = new GUIStyle(_body)
            { fontSize = Mathf.RoundToInt(font), alignment = TextAnchor.MiddleLeft, wordWrap = false, clipping = TextClipping.Clip };
        // WHILE A REFUSAL NAMES A ROUND, EVERY ROW SAYS ITS OWN NAME (2026-09-26 16:56): the next paid round read exactly
        // as the closed one had, under "the round is closed".
        bool namedRows = !_joining && !string.IsNullOrEmpty(_joinWhy) && _lobby.join != null && !string.IsNullOrEmpty(_lobby.join.round);
        for (int i = 0; i < l.rows && _offset + i < rows.Length; i++)
        {
            var r = rows[_offset + i];
            var rect = new Rect(l.list.x, l.list.y + i * l.rowH, l.list.width, l.rowH - 4f);
            bool picked = r.joinable && r.id == _pickId;
            PanelSkin.Gradient(rect,
                r.joinable ? new Color(0.13f, 0.12f, 0.07f, 0.95f) : new Color(0.08f, 0.09f, 0.10f, 0.90f),
                r.joinable ? new Color(0.08f, 0.075f, 0.05f, 0.95f) : new Color(0.06f, 0.065f, 0.075f, 0.90f));
            PanelSkin.Border(rect, picked ? PanelSkin.Gold : new Color(1f, 1f, 1f, r.joinable ? 0.35f : 0.15f));
            rowStyle.fontSize = Mathf.RoundToInt(font);
            rowStyle.normal.textColor = r.joinable ? (picked ? PanelSkin.Gold : Color.white) : new Color(1f, 1f, 1f, 0.5f);
            var inner = new Rect(rect.x + 8f, rect.y, rect.width - 16f, rect.height);
            string words = FitWords(rowStyle, Arena.DailyLobby.RowWords(r, namedRows), inner.width);
            GUI.Label(inner, words, rowStyle);
            if (r.joinable && GUI.Button(rect, GUIContent.none, GUIStyle.none)) { _tapId = r.id; _pickId = r.id; }
            _drawnRows.Add((r, rect, words));
        }
        // A SILENT SIGNER NODE IS SAID HERE, ON THE LIST THE PLAYER IS READING, in red and bold - under the rows it has, or in
        // place of "No round is open" when it has none. Not the hint line's grey.
        _lastSilent = Arena.DailyLobby.LobbyError(_lobby, _joining ? "" : _joinWhy);
        _lastSilentRect = new Rect();
        if (!string.IsNullOrEmpty(_lastSilent) && l.list.height > 0)
        {
            int drawn = Mathf.Clamp(rows.Length - _offset, 0, l.rows);
            var red = new GUIStyle(_body) { fontSize = Mathf.RoundToInt(font), fontStyle = FontStyle.Bold, wordWrap = true, alignment = TextAnchor.MiddleLeft };
            red.normal.textColor = new Color(1f, 0.50f, 0.46f);
            var said = new GUIContent(_lastSilent);
            float inner = l.list.width - 20f;
            float top = l.list.y + drawn * l.rowH;
            // UNDER THE ROWS, NEVER OVER ONE (2026-09-26 16:56: "Covering the row is not removing the offer"): set smaller
            // until it fits the list below its rows, and past the list's foot rather than on a row when even 10 does not.
            float room = Mathf.Max(l.list.yMax - top, 0f);
            while (red.fontSize > 10 && red.CalcHeight(said, inner) + 12f > room) red.fontSize--;
            float height = red.CalcHeight(said, inner) + 12f;
            _lastSilentRect = new Rect(l.list.x, top, l.list.width, height);
            PanelSkin.Gradient(_lastSilentRect, new Color(0.24f, 0.05f, 0.05f, 0.96f), new Color(0.16f, 0.03f, 0.03f, 0.96f));
            PanelSkin.Border(_lastSilentRect, new Color(1f, 0.42f, 0.42f, 0.9f));
            GUI.Label(new Rect(_lastSilentRect.x + 10f, _lastSilentRect.y + 6f, inner, height - 12f), said, red);
        }
        // THE COLLECT'S OWN LINES (2026-10-07): under the last round row - and under the red box when there is
        // one - inside the list, each set smaller until it fits its width, never past the list's foot (so never over the hint,
        // PLAY or SPECTATE); nothing when the page wrote none. The words and their kind are the page's.
        _lastCollect.Clear();
        var collectLines = Arena.DailyLobby.CollectLines(_lobby);
        if (collectLines.Length > 0 && l.list.height > 0)
        {
            int drawnRows = Mathf.Clamp(rows.Length - _offset, 0, l.rows);
            float top = Mathf.Max(l.list.y + drawnRows * l.rowH, _lastSilentRect.height > 0f ? _lastSilentRect.yMax + 4f : 0f);
            if (rows.Length == 0 && string.IsNullOrEmpty(_lastSilent)) top = l.list.y + l.rowH;   // under "No round is open"
            var cs = new GUIStyle(_body) { alignment = TextAnchor.MiddleLeft, wordWrap = false, clipping = TextClipping.Clip };
            float lineH = Mathf.Max(l.rowH * 0.62f, 14f);
            foreach (var c in collectLines)
            {
                if (top + lineH > l.list.yMax) break;
                var rect = new Rect(l.list.x + 8f, top, l.list.width - 16f, lineH);
                var said = new GUIContent(c.text);
                cs.fontSize = Mathf.RoundToInt(font * 0.85f);
                while (cs.fontSize > 9 && cs.CalcSize(said).x > rect.width) cs.fontSize--;
                cs.normal.textColor = Arena.DailyLobby.CollectColour(c.kind);
                GUI.Label(rect, said, cs);
                _lastCollect.Add((c.text, c.kind, rect, cs.fontSize));
                top += lineH;
            }
        }
        if (rows.Length == 0 && l.list.height > 0 && string.IsNullOrEmpty(_lastSilent))
        {
            var none = new GUIStyle(_body) { fontSize = Mathf.RoundToInt(font), wordWrap = true };
            none.normal.textColor = new Color(1f, 1f, 1f, 0.7f);
            GUI.Label(l.list, _lobby.from == Reading ? "Reading the rounds from the signer nodes …"
                : Arena.DailyLobby.EmptyListLine(_lobby), none);   // none reached is said so
        }
    }

    /// <summary>A refused join that only the hint line can say: the list drew no red box for it.</summary>
    bool RefusalHere => !_joining && !string.IsNullOrEmpty(_joinWhy) && _lastSilentRect.width <= 0f;

    /// <summary>What PLAY will do, on the hint line - short enough for a phone.</summary>
    string LobbyHint()
    {
        if (_joining) return string.IsNullOrEmpty(_lobby.join.stage) ? "joining the round …" : $"joining the round - {_lobby.join.stage} …";
        // SAID ONCE (2026-09-26 16:56: "The same sentence is repeated under the card"): a refusal the red box on the
        // list says is not said again here - this line says what PLAY does now.
        if (RefusalHere) return $"not joined: {_joinWhy}";
        int k = Arena.DailyLobby.Keep(_lobby.rows, _pickId);
        // the round PLAY joins, in its row's words; or what PLAY waits for (follow-up)
        return Arena.DailyLobby.HintWords(k >= 0 ? _lobby.rows[k] : null, _lobby.rows.Length);
    }

    /// <summary>The line under the rows, longest first: shorter wordings of the round PLAY joins for a phone.</summary>
    string[] LobbyHintWordings()
    {
        string full = LobbyHint();
        int k = Arena.DailyLobby.Keep(_lobby.rows, _pickId);
        var r = k >= 0 ? _lobby.rows[k] : null;
        return full == Arena.DailyLobby.HintWords(r, _lobby.rows.Length) ? Arena.DailyLobby.HintWordings(r, _lobby.rows.Length) : new[] { full };
    }

    void JoinPicked()
    {
        WakeAudio();
        _joinWhy = "";
        _joinedAt = -1f;
        _joining = Arena.DailyLobby.Join(_pickId);
        // the last poll still holds the press before this one: it is not this join's answer
        if (_joining && _lobby != null) _lobby.join = new Arena.LobbyJoin { state = "joining" };
        _polledAt = -10f;
    }

    bool SmallButton(Rect r, string label)
    {
        PanelSkin.Gradient(r, new Color(0.10f, 0.14f, 0.20f, 0.95f), new Color(0.06f, 0.09f, 0.13f, 0.95f));
        PanelSkin.Border(r, new Color(0.55f, 0.75f, 1f, 0.75f));
        var s = new GUIStyle(_btn) { fontSize = Mathf.RoundToInt(Mathf.Min(_btn.fontSize, _sub.fontSize * 1.1f)) };
        s.normal.textColor = new Color(0.70f, 0.85f, 1f);
        Shrink(s, label, r);
        return GUI.Button(r, label, s);
    }

    static string Fit(GUIStyle style, string text, float width)
    {
        var c = new GUIContent(text);
        while (style.fontSize > 10 && style.CalcSize(c).x > width) style.fontSize--;
        return text;
    }

    /// <summary>The longest of the wordings that fits; the shortest, smaller, when none does.</summary>
    static string FitWords(GUIStyle style, string[] words, float width)
    {
        foreach (var w in words)
            if (style.CalcSize(new GUIContent(w)).x <= width) return w;
        return Fit(style, words[words.Length - 1], width);
    }

    static string Escape(string s) => (s ?? "").Replace("<", "‹").Replace(">", "›");
    static string R(Rect r) => string.Format(System.Globalization.CultureInfo.InvariantCulture,
        "[{0:0},{1:0},{2:0},{3:0}]", r.x, r.y, r.width, r.height);
    static string J(string s) => "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    /// <summary>
    /// WHAT WAS DRAWN, told to the page twice a second: the rows as shown, the
    /// buttons and where they are, and whether PLAY can be pressed. OnGUI
    /// cannot be read from outside, so without this "the lobby is visible" is
    /// an assumption; with it a probe measures it and presses the real buttons.
    /// </summary>
    void Report(int w, int h, Frame f)
    {
        if (!Arena.DailyLobby.Compiled || Event.current.type != EventType.Repaint) return;
        if (Time.unscaledTime - _shownAt < 0.5f) return;
        _shownAt = Time.unscaledTime;
        var sb = new System.Text.StringBuilder();
        sb.Append("{\"showing\":true,\"lobby\":").Append(_lobby != null ? "true" : "false");
        sb.Append(",\"screen\":[").Append(w).Append(',').Append(h).Append(']');
        sb.Append(",\"panel\":").Append(R(f.panel));
        sb.Append(",\"play\":").Append(R(f.play)).Append(",\"playEnabled\":")
          .Append(_lobby == null || (!_joining && !string.IsNullOrEmpty(_pickId)) ? "true" : "false");
        sb.Append(",\"spectate\":").Append(R(f.spectate)).Append(",\"hint\":").Append(R(f.hint));
        if (_lobby != null)
        {
            sb.Append(",\"you\":").Append(J(_lobby.you.name)).Append(",\"withdrawNotice\":").Append(J(_lastNotice)).Append(",\"name\":").Append(R(_lastName))
              .Append(",\"key\":").Append(R(_lastKey)).Append(",\"balance\":").Append(R(_lastBalance)).Append(",\"howTo\":").Append(R(_lastHowTo))
              .Append(",\"howToCells\":[").Append(_lastHowToCells == null ? "" : string.Join(",", System.Array.ConvertAll(_lastHowToCells, R))).Append(']')
              .Append(",\"howToDrawn\":").Append(_howToWhole != null ? _howToShown.Count : 0)
              .Append(",\"howToShown\":[").Append(string.Join(",", _howToShown)).Append(']')
              .Append(",\"howToCarousel\":").Append(_lastHowToCarousel ? "true" : "false").Append(",\"howToPage\":").Append(_howToPage)
              .Append(",\"howToPrev\":").Append(R(_lastHowToPrev)).Append(",\"howToNext\":").Append(R(_lastHowToNext))
              .Append(",\"silent\":").Append(J(_lastSilent)).Append(",\"hintText\":").Append(J(_lastHint)).Append(",\"silentRect\":").Append(R(_lastSilentRect))
              .Append(",\"picked\":").Append(J(_pickId))
              .Append(",\"collect\":[").Append(string.Join(",", _lastCollect.ConvertAll((c) => "{\"text\":" + J(c.text) + ",\"kind\":" + J(c.kind) + ",\"rect\":" + R(c.rect) + ",\"size\":" + c.size + "}"))).Append(']')
              .Append(",\"listed\":").Append(_lobby.rows.Length).Append(",\"rows\":[");
            for (int i = 0; i < _drawnRows.Count; i++)
            {
                var (row, rect, words) = _drawnRows[i];
                if (i > 0) sb.Append(',');
                sb.Append("{\"id\":").Append(J(row.id)).Append(",\"joinable\":").Append(row.joinable ? "true" : "false")
                  .Append(",\"agree\":").Append(row.agree).Append(",\"needed\":").Append(row.needed)
                  .Append(",\"rect\":").Append(R(rect))
                  // THE WORDS THIS ROW WAS DRAWN WITH, so what the player reads is measured, not inferred.
                  .Append(",\"words\":").Append(J(words)).Append('}');
            }
            sb.Append(']');
        }
        sb.Append('}');
        Arena.DailyLobby.Shown(sb.ToString());
    }

    public const string Title = NextBlockMark.Name;
    public const string PlayLabel = "▶  PLAY";
    public const string SpectateLabel = "SPECTATE";

    const string Standfirst = "HAUL REAL MEMPOOL FREIGHT THROUGH A LIVE BATTLEFIELD";
    const string Footnote = "One Bitcoin block is one round - and every fee, block and " +
                            "transaction on this map is the live chain, right now.";
    const string Hint = "sound starts when you press play";

    static readonly string[] Steps = { "1 · LOAD", "2 · DRIVE", "3 · DELIVER" };
    static readonly string[] Says =
    {
        "Take transactions off the ramp at the post office. A full bed is worth " +
        "more at the far end - and pulls both armies onto you on the way there.",
        "W A S D, or the pads on a touchscreen. The points are in the fighting: " +
        "a run down the quiet edge of the map scores almost nothing, however " +
        "much freight it is carrying.",
        "Reach the miner before the block closes. The run scores cargo times " +
        "exposure times speed - and a load that misses the block scores zero, " +
        "however well it was driven.",
    };

    /// <summary>
    /// Draws the copy, or measures it - one routine for both, because a layout
    /// measured by one and drawn by another comes apart the first time either
    /// is edited.
    /// </summary>
    float Copy(float width, bool draw, float x, float y)
    {
        float top = y;

        _sub.normal.textColor = PanelSkin.Cyan;
        y += Line(_sub, Standfirst, x, y, width, draw) + _sub.fontSize * 0.9f;

        var stepHead = new GUIStyle(_body) { fontStyle = FontStyle.Bold };
        stepHead.normal.textColor = PanelSkin.Gold;
        for (int i = 0; i < Steps.Length; i++)
        {
            float high = Line(stepHead, Steps[i], x, y, width, draw);
            if (draw) PanelSkin.Rule(new Rect(x, y + high, width * 0.10f, 2f), PanelSkin.Gold);
            y += high + _body.fontSize * 0.55f;

            _body.normal.textColor = new Color(1f, 1f, 1f, 0.88f);
            y += Line(_body, Says[i], x, y, width, draw) + _body.fontSize * 0.85f;
        }

        _sub.normal.textColor = new Color(1f, 1f, 1f, 0.62f);
        y += Line(_sub, Footnote, x, y, width, draw);
        return y - top;
    }

    /// <summary>Sets one block of text and returns how tall it turned out.</summary>
    static float Line(GUIStyle style, string what, float x, float y, float width, bool draw)
    {
        var content = new GUIContent(what);
        float height = style.CalcHeight(content, width);
        if (draw) GUI.Label(new Rect(x, y, width, height), content, style);
        return height;
    }

    void Shrink(float by)
    {
        _sub.fontSize = Mathf.Max(10, Mathf.RoundToInt(_sub.fontSize * by));
        _body.fontSize = Mathf.Max(10, Mathf.RoundToInt(_body.fontSize * by));
    }

    /// <summary>
    /// PLAY and the spectator camera, side by side on one baseline.
    ///
    /// They used to be stacked in two different heights with the hint line
    /// drawn across the lower one, and the second was labelled INSPECT, which
    /// says nothing about what it is for. It is a debug camera and it now says
    /// so.
    /// </summary>
    void Buttons(Frame f)
    {
        _sub.normal.textColor = new Color(1f, 1f, 1f, 0.42f);
        if (_lobby != null)
        {
            var hint = new GUIStyle(_sub) { wordWrap = false };
            hint.normal.textColor = new Color(1f, 1f, 1f, 0.6f);
            // A REFUSED JOIN IS AN ERROR AND READS AS ONE: red and bold on the line above PLAY, not the hint's grey (2026-09-17,
            // "the tiny grey fetch line is not enough").
            if (RefusalHere) { hint.normal.textColor = new Color(1f, 0.50f, 0.46f); hint.fontStyle = FontStyle.Bold; }
            _lastHint = FitWords(hint, LobbyHintWordings(), f.hint.width);   // the longest that fits
            GUI.Label(f.hint, _lastHint, hint);
        }
        else GUI.Label(f.hint, Hint, _sub);

        // IN THE LOBBY, PLAY JOINS THE PICKED ROUND - and there is nothing to
        // press until a round has both of its signer nodes' word (M3.3-34).
        bool canPlay = _lobby == null || (!_joining && !string.IsNullOrEmpty(_pickId));
        // the button breathes, so the eye finds it
        float pulse = 0.5f + 0.5f * Mathf.Sin(Time.unscaledTime * 2.4f);
        if (canPlay) PanelSkin.Glow(f.play, PanelSkin.Gold, 4, 0.18f + 0.22f * pulse);
        PanelSkin.Gradient(f.play, canPlay ? new Color(0.30f, 0.24f, 0.06f, 0.95f) : new Color(0.14f, 0.14f, 0.14f, 0.9f),
                                   canPlay ? new Color(0.16f, 0.13f, 0.04f, 0.95f) : new Color(0.09f, 0.09f, 0.09f, 0.9f));
        PanelSkin.Border(f.play, canPlay ? PanelSkin.Gold : new Color(1f, 1f, 1f, 0.25f));
        var gold = new GUIStyle(_btn);
        gold.normal.textColor = canPlay ? PanelSkin.Gold : new Color(1f, 1f, 1f, 0.35f);
        Shrink(gold, PlayLabel, f.play);
        if (GUI.Button(f.play, PlayLabel, gold) && canPlay)
        {
            if (_lobby != null) JoinPicked(); else Play();
        }

        // A free camera, offered before the run rather than hidden behind a
        // key. The two buildings are the most expensive things in the project
        // and are normally only ever seen from behind a truck at windscreen
        // height; flying round them is how you find out whether they are
        // actually right.
        PanelSkin.Gradient(f.spectate, new Color(0.10f, 0.14f, 0.20f, 0.95f),
                                       new Color(0.06f, 0.09f, 0.13f, 0.95f));
        PanelSkin.Border(f.spectate, new Color(0.55f, 0.75f, 1f, 0.75f));
        var blue = new GUIStyle(_btn);
        blue.normal.textColor = new Color(0.70f, 0.85f, 1f);
        Shrink(blue, SpectateLabel, f.spectate);
        if (GUI.Button(f.spectate, SpectateLabel, blue)) Spectate();
    }

    /// <summary>
    /// SPECTATE, and the page's frame-rate test once the camera has settled - started from the page's Settings
    /// (SendMessage("Bootstrap", "Benchmark")), no longer from a lobby button.
    /// </summary>
    public void Benchmark()
    {
        Spectate();
#if UNITY_WEBGL && !UNITY_EDITOR
        ArenaBenchmark();
#endif
    }

    /// <summary>
    /// Sets a button's label to fit inside the button.
    ///
    /// GUI.Button clips rather than wraps, and DEBUG SPECTATE is twice the
    /// word PLAY - on a phone the secondary would otherwise read "DEBUG SPE".
    /// </summary>
    static void Shrink(GUIStyle style, string label, Rect into)
    {
        var content = new GUIContent(label);
        while (style.fontSize > 9 && style.CalcSize(content).x > into.width - 10f)
            style.fontSize--;
    }
}
