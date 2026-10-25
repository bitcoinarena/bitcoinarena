-- SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
-- Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
-- "Bitcoin Arena.app": a stay-open applet (osacompile -s, package-mac.sh). While its installer runs it stays open, in the Dock with the
-- running dot (kanban #635, playtest 2026-10-25: "doesn't stay open, doesn't have an icon that indicates that it is running").
-- A click on its Dock icon shows the dialog again; Quit asks whether the installer keeps running. When the installer is done it says so
-- and quits. A node already set up: its status, with Owner page / Restart / Close. Each step is the helper arena-node-app beside it.
property helper : ""
property installing : false

on sh(args)
	return do shell script helper & " " & args
end sh

-- NEVER SILENT UNTIL THE BROWSER OPENS (the owner's playtest 2026-10-25: "Wenn ich BitcoinArena.App öffne passiert erstmal gar nichts bis
-- der Browser öffnet"): a progress window from the first moment - preparing (the first start copies the node out of the app), starting
-- the installer, waiting for its page - each step a call to the helper, the window updated between them
on run
	set helper to quoted form of (POSIX path of (path to me) & "Contents/Resources/arena-node-app")
	set progress total steps to 3
	set progress completed steps to 0
	set progress description to "Starting Bitcoin Arena…"
	set progress additional description to "Preparing your node. The first start copies it out of the app, which takes up to a minute."
	try
		set r to sh("prepare")
	on error msg
		fail(msg)
		return
	end try
	if r is "installed" then
		set progress completed steps to 3
		statusDialog()
		quit
		return
	end if
	set installing to true
	if r starts with "running " then
		set progress completed steps to 3
		set progress additional description to "The installer runs already. Opening its page…"
		open location (text 9 thru -1 of r)
		installerDialog()
		return
	end if
	set progress completed steps to 1
	set progress additional description to "Starting the installer…"
	try
		sh("launch")
		set pageLink to "waiting"
		repeat with i from 1 to 60
			set pageLink to sh("wait-link")
			if pageLink is not "waiting" then exit repeat
			set progress completed steps to 2
			set progress additional description to "Starting the installer… " & i & " s"
			delay 1
		end repeat
	on error msg
		set installing to false
		fail(msg)
		return
	end try
	if pageLink is "waiting" then
		sh("stop")
		set installing to false
		fail("The installer did not start within a minute. Open Bitcoin Arena again; if it happens again, run Doctor.")
		return
	end if
	set progress completed steps to 3
	set progress additional description to "Opening the setup page in your browser…"
	open location pageLink
	installerDialog()
end run

on fail(msg)
	display dialog msg with title "Bitcoin Arena" buttons {"OK"} default button 1 with icon stop
	quit
end fail

on reopen
	if installing then
		installerDialog()
	else
		statusDialog()
	end if
end reopen

on installerDialog()
	set b to button returned of (display dialog "The installer runs. Its setup page is open in your browser. Keep it running until the page says Done." & return & return & "Bitcoin Arena stays in the Dock while it runs: click it to see this again." with title "Bitcoin Arena" buttons {"Stop", "Open in browser", "Keep running"} default button "Keep running")
	if b is "Open in browser" then
		open location sh("link")
	else if b is "Stop" then
		sh("stop")
		set installing to false
		display notification "The installer was stopped. Open Bitcoin Arena again to start it." with title "Bitcoin Arena"
		quit
	end if
end installerDialog

-- A NODE INSTALLED (kanban #658, 2026-10-25: "show when it's installed \"Server running\" with options to Stop Node, Start Node,
-- Doctor" - "And also \"Dashboard\" that opens the browser with the dashboard"): the node in one line, then what to do with it
on statusDialog()
	repeat
		set nodeLine to sh("node")
		if nodeLine starts with "running" then
			set heading to "Server running"
			set toggle to "Stop node"
		else
			set heading to "Server stopped"
			set toggle to "Start node"
		end if
		set detail to ""
		if nodeLine contains ";" or nodeLine contains ":" then set detail to return & nodeLine
		set picked to choose from list {"Dashboard", "Owner page", toggle, "Doctor"} with title "Bitcoin Arena" with prompt (heading & detail) OK button name "Go" cancel button name "Close" default items {"Dashboard"}
		if picked is false then exit repeat
		set what to item 1 of picked
		if what is "Dashboard" then
			sh("dashboard")
		else if what is "Owner page" then
			sh("owner")
		else if what is "Stop node" then
			display dialog "Stop your node? It stops serving rounds until you start it again." with title "Bitcoin Arena" buttons {"Cancel", "Stop node"} default button "Stop node" cancel button "Cancel"
			sh("node-stop")
		else if what is "Start node" then
			sh("node-start")
		else if what is "Doctor" then
			display dialog sh("doctor") with title "Bitcoin Arena - Doctor" buttons {"OK"} default button 1
		end if
	end repeat
end statusDialog

on idle
	if installing then
		set s to sh("state")
		if s is "done" then
			set installing to false
			display notification "Your node runs. Open Bitcoin Arena to see its status." with title "Bitcoin Arena"
			quit
		else if s starts with "ended" then
			set installing to false
			display dialog "The installer ended: " & (text 7 thru -1 of (s & " ")) with title "Bitcoin Arena" buttons {"OK"} default button 1 with icon caution
			quit
		end if
	end if
	return 5
end idle

on quit
	if installing then
		set b to button returned of (display dialog "The installer still runs. Stop it, or let it finish in the background?" with title "Bitcoin Arena" buttons {"Cancel", "Stop it", "Keep it running"} default button "Keep it running" cancel button "Cancel")
		if b is "Stop it" then sh("stop")
		set installing to false
	end if
	continue quit
end quit
