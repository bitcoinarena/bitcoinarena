// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.IO;
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// ONLY THE LOBBY AFTER THE LOADING SCREEN (2026-09-25 21:11/21:13, phone, btc-logistics-core.pages.dev: the old
/// splash - BTC LOGISTICS WAR, LOAD / DRIVE / DELIVER, SPECTATE - came up under "the node refused the entry: the round is
/// closed". "That splash must not draw. A closed round is not a reason to show it").
/// </summary>
public class OnlyTheLobbyTests
{
    [Test]
    public void InAPageNoLobbyYetIsTheLobbyBeingReadNotTheTitle()
    {
        var reading = SplashScreen.LobbyOrReading(null, inAPage: true);
        Assert.IsNotNull(reading, "a page with no lobby handed over yet got the title screen");
        Assert.AreEqual("lobby", reading.mode);
        Assert.AreEqual(SplashScreen.Reading, reading.from);
        Assert.AreEqual(0, reading.rows.Length);
    }

    [Test]
    public void APolledLobbyIsKeptAndNoPageKeepsTheTitle()
    {
        var polled = new Blwp.LobbyState { mode = "lobby", from = "daily.json" };
        Assert.AreSame(polled, SplashScreen.LobbyOrReading(polled, inAPage: true));
        Assert.IsNull(SplashScreen.LobbyOrReading(null, inAPage: false), "the editor and a page-less build keep their title");
    }

    [Test]
    public void OnGuiMakesTheLobbyBeforeItDrawsAnything()
    {
        string src = File.ReadAllText(Path.Combine(Application.dataPath, "Scripts/SplashScreen.cs"));
        int gui = src.IndexOf("void OnGUI()");
        int made = src.IndexOf("_lobby = LobbyOrReading(_lobby, Blwp.DailyLobby.Compiled);", gui);
        int depth = src.IndexOf("GUI.depth = -200", gui);
        Assert.IsTrue(gui >= 0 && made > gui && made < depth, "OnGUI can draw the title before the lobby is made");
    }

    // THE 21:13 CASE (2026-09-26, measured live): a closed round's link with play=1 - the node refuses the entry
    // after the join, and the lobby must come back with the run stopped.
    [Test]
    public void ARefusedEntryBeforeTheRunIsLiveGoesBackToTheLobby()
    {
        Assert.IsTrue(SplashScreen.JoinRefusedBeforeLive("refused", sessionLive: false, atTheRamp: true));
        Assert.IsFalse(SplashScreen.JoinRefusedBeforeLive("refused", sessionLive: true, atTheRamp: true), "a live run is not taken away");
        Assert.IsFalse(SplashScreen.JoinRefusedBeforeLive("refused", sessionLive: false, atTheRamp: false), "a rolled-out truck is not taken away");
        Assert.IsFalse(SplashScreen.JoinRefusedBeforeLive("joined", sessionLive: false, atTheRamp: true));
        Assert.IsFalse(SplashScreen.JoinRefusedBeforeLive("", sessionLive: false, atTheRamp: true), "no page lobby, no refusal");
        string lib = File.ReadAllText(Path.Combine(Application.dataPath, "Plugins/WebGL/blwp.jslib"));
        StringAssert.Contains("window.BLWP_ENTRY_REFUSED(net.error)", lib);
        StringAssert.Contains("if (n && !n.client && n.state === 'error') return 1;", lib);
        string page = File.ReadAllText(Path.Combine(Application.dataPath, "WebGLTemplates/NextBlock/index.html"));
        StringAssert.Contains("window.BLWP_ENTRY_REFUSED = async (why) =>", page);
    }

    // THE NODE STRIP IS NOT ON THE CARGO PANEL, AND IT CUTS NO NAME (2026-09-26 14:02): hidden while the panel is
    // open; nodes are A and B by their place in the page's list, and no host is cut with an ellipsis.
    [Test]
    public void TheNodeStripHidesDuringLoadoutAndCutsNoName()
    {
        string panel = File.ReadAllText(Path.Combine(Application.dataPath, "Scripts/Cargo/LoadoutPanel.cs"));
        StringAssert.Contains("if (_isOpen != value) Blwp.BlwpCore.LoadoutOpen(value);", panel);
        string lib = File.ReadAllText(Path.Combine(Application.dataPath, "Plugins/WebGL/blwp.jslib"));
        StringAssert.Contains("window.BLWP_LOADOUT_OPEN = open !== 0;", lib);
        string page = File.ReadAllText(Path.Combine(Application.dataPath, "WebGLTemplates/NextBlock/index.html"));
        // and the Console is told the strip is gone (427bab76, the console collapse: the strip lives behind its button)
        StringAssert.Contains("|| window.BLWP_LOADOUT_OPEN) { el.style.display = 'none'; consoleHas('players', false); return; }", page);
        int a = page.IndexOf("const nodeHealth = {};"), b = page.IndexOf("function paintPlayers()");
        int c = page.IndexOf("const ab = ['A', 'B']");
        string strip = page.Substring(a, b - a) + page.Substring(c, page.IndexOf('\n', c) - c);
        StringAssert.DoesNotContain("\\u2026", strip, "a node's name is cut with an ellipsis again");
        StringAssert.DoesNotContain("\u2026", strip, "a node's name is cut with an ellipsis again");
    }

    // HEALTH, NOT CONDITION (2026-09-26 14:14): the word condition is on no screen of the game.
    [Test]
    public void TheTrucksBarIsCalledHealth()
    {
        string hud = File.ReadAllText(Path.Combine(Application.dataPath, "Scripts/DriveHud.cs"));
        StringAssert.Contains("$\"HEALTH {Mathf.CeilToInt(health.Fraction * 100f)}%\"", hud);
        StringAssert.DoesNotContain("\"CONDITION", hud);
        StringAssert.DoesNotContain("$\"CONDITION", hud);
    }

    // THE SECOND PLAY STARTS ITS RUN (2026-09-26 14:08, measured): while the cargo panel is open the core's word is
    // the run before's, so it does not send the lobby back over the panel.
    [Test]
    public void TheRunBeforesWordDoesNotEndTheNextRunAtTheRamp()
    {
        Assert.AreEqual(0, SplashScreen.RunStateOfThisRun(1, loadoutOpen: true), "DELIVERED from the run before ended this run at the ramp");
        Assert.AreEqual(2, SplashScreen.RunStateOfThisRun(2, loadoutOpen: false));
        Assert.IsFalse(SplashScreen.ShouldReturnToLobby(true, SplashScreen.RunStateOfThisRun(1, true), false, true, false, 0f, 5f, 99f),
            "a finished run before sends the lobby back over the next run's cargo panel");
    }
}

