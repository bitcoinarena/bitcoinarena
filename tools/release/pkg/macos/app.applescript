-- SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
-- Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
-- "Bitcoin Arena.app": a stay-open applet (osacompile -s, package-mac.sh). While its installer runs it stays open, in the Dock with the
-- running dot (kanban #635, the owner's playtest 2026-10-25: "doesn't stay open, doesn't have an icon that indicates that it is running").
-- A click on its Dock icon shows the dialog again; Quit asks whether the installer keeps running. When the installer is done it says so
-- and quits. A node already set up: its status, with Owner page / Restart / Close. Each step is the helper arena-node-app beside it.
property helper : ""
property installing : false

on sh(args)
	return do shell script helper & " " & args
end sh

on run
	set helper to quoted form of (POSIX path of (path to me) & "Contents/Resources/arena-node-app")
	try
		set r to sh("start")
	on error msg
		display dialog msg with title "Bitcoin Arena" buttons {"OK"} default button 1 with icon stop
		quit
		return
	end try
	if r is "installed" then
		statusDialog()
		quit
		return
	end if
	set installing to true
	if r starts with "started " then open location (text 9 thru -1 of r)
	installerDialog()
end run

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

on statusDialog()
	repeat
		set b to button returned of (display dialog sh("status") with title "Bitcoin Arena" buttons {"Restart", "Close", "Owner page"} default button "Owner page")
		if b is "Owner page" then
			sh("owner")
		else if b is "Restart" then
			sh("restart")
		else
			exit repeat
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
