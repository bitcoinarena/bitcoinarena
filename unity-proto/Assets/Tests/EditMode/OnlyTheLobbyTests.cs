using System.IO;
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// ONLY THE LOBBY AFTER THE LOADING SCREEN (the owner 2026-09-25 21:11/21:13, phone, btc-logistics-core.pages.dev: the old
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
}
