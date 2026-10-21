// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// BUY ADD-ONS IN THE RUNNING GAME: Bootstrap gives the game an AddonsPanel; with the page's view standing in
/// (AddonsPanel.TestState) the cargo screen offers BUY ADD-ONS, the panel opens and buys through the page, and a purchase the page
/// reports is confirmed by the banner - once.
/// </summary>
public class AddonsPanelPlayTests
{
    GameObject _boot;
    const string Shop = "{\"shop\":true,\"game\":\"nextblock\",\"read\":true,\"busy\":\"\",\"said\":\"\",\"bad\":false,\"seq\":SEQ,BOUGHT" +
        "\"items\":[{\"id\":\"large-truck\",\"name\":\"Large truck\",\"what\":\"30 % more cargo room, quicker off the line\",\"priceSat\":500,\"owned\":OWNED,\"use\":true}]}";
    static string View(int seq, bool owned, string from = null) => Shop.Replace("SEQ", seq.ToString()).Replace("OWNED", owned ? "true" : "false")
        .Replace("BOUGHT", from == null ? "\"bought\":null," : "\"bought\":{\"seq\":" + seq + ",\"id\":\"large-truck\",\"name\":\"Large truck\",\"txid\":\"ab\",\"from\":\"" + from + "\"},");

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        Arena.PracticeMode.On = false;
        AddonsPanel.TestState = View(0, false);
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        AddonsPanel.TestState = null; AddonsPanel.Bought = null;
        if (_boot != null) Object.Destroy(_boot);
        yield return null;
        TestWorld.TearDown();
    }

    [UnityTest]
    public IEnumerator TheCargoScreenOffersAddOns_ThePanelBuys_TheBannerConfirmsOnce()
    {
        var panel = AddonsPanel.Instance;
        Assert.IsNotNull(panel, "Bootstrap gives the game an AddonsPanel");
        yield return new WaitForSecondsRealtime(1.7f);
        Assert.IsTrue(panel.ShopAvailable, "the page's game sells something: BUY ADD-ONS is offered");
        Assert.IsFalse(panel.IsOpen);
        panel.OpenAddons();
        Assert.IsTrue(panel.IsOpen);
        string asked = null; AddonsPanel.Bought = (id) => asked = id;
        // the panel's Buy asks the page (the jslib's stand-in here) for the item
        var m = typeof(AddonsPanel).GetMethod("ArenaAddonsBuy", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        m.Invoke(null, new object[] { "large-truck" });
        Assert.AreEqual("large-truck", asked);
        // THE PAGE REPORTS THE PURCHASE: the banner, once
        AddonsPanel.TestState = View(1, true, "after-next");
        yield return new WaitForSecondsRealtime(0.7f);
        Assert.IsTrue(panel.BannerShowing, "the purchase is confirmed on screen");
        Assert.IsTrue(panel.State.items[0].owned);
        panel.Close();
        yield return new WaitForSecondsRealtime(AddonsPanel.BannerS + 0.3f);
        Assert.IsFalse(panel.BannerShowing, "and goes after BannerS");
        yield return new WaitForSecondsRealtime(1.7f);
        Assert.IsFalse(panel.BannerShowing, "the same purchase is not confirmed twice");
    }
}
