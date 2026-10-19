// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// BUY ADD-ONS INSIDE UNITY: the page's add-ons view read, a purchase confirmed once and only once, the banner saying
/// from which round the item plays, the item's button, and the truck's morph curve.
/// </summary>
public class AddonsPanelTests
{
    const string View = "{\"shop\":true,\"game\":\"nextblock\",\"read\":true,\"busy\":\"\",\"said\":\"\",\"bad\":false,\"seq\":0,\"bought\":null," +
        "\"items\":[{\"id\":\"large-truck\",\"name\":\"Large truck\",\"what\":\"30 % more cargo room, quicker off the line\",\"priceSat\":500,\"owned\":false,\"use\":true}]}";

    [Test]
    public void ThePagesViewIsRead_AndNothingReadableIsNull()
    {
        var s = AddonsPanel.Parse(View);
        Assert.IsTrue(s.shop);
        Assert.AreEqual(1, s.items.Length);
        Assert.AreEqual("large-truck", s.items[0].id);
        Assert.AreEqual(500, s.items[0].priceSat);
        Assert.IsFalse(s.items[0].owned);
        Assert.IsNull(AddonsPanel.Parse(""));
        Assert.IsNull(AddonsPanel.Parse("not json"));
        var none = AddonsPanel.Parse("{\"shop\":false}");
        Assert.IsFalse(none.shop);
        Assert.IsNotNull(none.items, "no items is an empty list, never null");
    }

    [Test]
    public void APurchaseIsConfirmedOnce_AndNotOnTheFirstReading()
    {
        var first = AddonsPanel.Parse("{\"shop\":true,\"seq\":2,\"bought\":{\"seq\":2,\"id\":\"large-truck\",\"name\":\"Large truck\",\"from\":\"next\"}}");
        Assert.IsFalse(AddonsPanel.IsNewPurchase(-1, first), "the first reading only sets the count - an earlier purchase is not confirmed again");
        Assert.IsFalse(AddonsPanel.IsNewPurchase(2, first), "already seen");
        var next = AddonsPanel.Parse("{\"shop\":true,\"seq\":3,\"bought\":{\"seq\":3,\"id\":\"large-truck\",\"name\":\"Large truck\",\"from\":\"after-next\"}}");
        Assert.IsTrue(AddonsPanel.IsNewPurchase(2, next));
        Assert.IsFalse(AddonsPanel.IsNewPurchase(3, next));
    }

    [Test]
    public void TheBannerNamesTheItem_AndFromWhichRoundItPlays()
    {
        var b = new AddonBought { seq = 1, id = "large-truck", name = "Large truck", from = "next" };
        Assert.AreEqual("LARGE TRUCK BOUGHT", AddonsPanel.BannerTitle(b));
        Assert.AreEqual("Yours for good. It plays from your next round.", AddonsPanel.BannerLine(b));
        b.from = "after-next";
        Assert.AreEqual("Yours for good. Your next round is already entered - it plays from the round after.", AddonsPanel.BannerLine(b));
        Assert.AreEqual("ADD-ON BOUGHT", AddonsPanel.BannerTitle(new AddonBought()));
    }

    [Test]
    public void TheItemsButton_PriceThenPayingThenOwned()
    {
        var it = new AddonItem { id = "large-truck", name = "Large truck", priceSat = 500 };
        Assert.AreEqual("BUY · 500 sat", AddonsPanel.ButtonLabel(it, ""));
        Assert.AreEqual("PAYING ...", AddonsPanel.ButtonLabel(it, "large-truck"));
        Assert.AreEqual("BUY · 500 sat", AddonsPanel.ButtonLabel(it, "other-item"));
        it.owned = true;
        Assert.AreEqual("OWNED", AddonsPanel.ButtonLabel(it, ""));
    }

    [Test]
    public void TheMorph_StartsAtTheOldTruck_OvershootsAboutTenPercent_SettlesOnTheNew()
    {
        Assert.AreEqual(0f, LargeTruckView.MorphCurve(0f), 1e-5f);
        Assert.AreEqual(1f, LargeTruckView.MorphCurve(1f), 1e-5f);
        float peak = 0f;
        for (int i = 0; i <= 100; i++) peak = UnityEngine.Mathf.Max(peak, LargeTruckView.MorphCurve(i / 100f));
        Assert.That(peak, Is.InRange(1.08f, 1.12f), "the bed reaches past its new length and springs back");
        Assert.AreEqual(0f, LargeTruckView.PulseAt(0f));
        Assert.AreEqual(0f, LargeTruckView.PulseAt(1f));
        Assert.Greater(LargeTruckView.PulseAt(0.3f), 4f, "the pulse is bright early in the morph");
    }
}
