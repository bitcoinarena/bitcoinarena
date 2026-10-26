# BITCOIN ARENA ON WINDOWS: THE SMALL WINDOW (2026-10-19: "for windows we want an exe ... That also includes a small gui
# version of the installer that launches the browser etc"). The Start menu's "Bitcoin Arena" and the end of the setup exe open it:
#   no node yet      the installer runs (hidden), its one-time link opens in the browser, its lines show here; Stop ends it
#   a node installed "Server running" or "Server stopped" (bitcoinarena state) and its services, with Dashboard / Owner page / Stop node or
#                    Start node / Doctor / Refresh (kanban #658, 2026-10-25: "show when it's installed \"Server running\" with options to
#                    Stop Node, Start Node, Doctor" - "And also \"Dashboard\" that opens the browser with the dashboard")
# Built-in parts only (WinForms in Windows PowerShell): nothing more to install.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$release = Get-ChildItem $here -Directory -Filter '*arena-node-*' | Sort-Object Name | Select-Object -Last 1
# THE NAMES SINCE 2026.1.9.8 (kanban #688, 2026-10-26: "Rename the directories and binaries to bitcoinarena, not arenanode everywhere in the
# installer, the packages etc."): the node in %USERPROFILE%\.bitcoinarena, the command bitcoinarena.cmd. A node set up before stays in
# .arena-node and is found there, its command arenanode.cmd until its update writes bitcoinarena.cmd (instance.js homeDefault)
function Test-Node([string]$d) { (Test-Path (Join-Path $d 'state.json')) -or (Test-Path (Join-Path $d 'arena.conf')) }
$nodeHome = Join-Path $env:USERPROFILE '.bitcoinarena'
$oldHome = Join-Path $env:USERPROFILE '.arena-node'
if (-not (Test-Node $nodeHome) -and (Test-Node $oldHome)) { $nodeHome = $oldHome }
# the node's command carries its instance (arena.conf instance=4: bitcoinarena-4.cmd) - the macOS app looked for the bare name (playtest 2026-10-25)
$inst = ''
try { $m = Select-String -Path (Join-Path $nodeHome 'arena.conf') -Pattern '^instance=(.+)$' -ErrorAction Stop | Select-Object -First 1; if ($m) { $inst = '-' + $m.Matches[0].Groups[1].Value.Trim() } } catch { }
$command = Join-Path $nodeHome ("bin\bitcoinarena" + $inst + ".cmd")
$oldCommand = Join-Path $nodeHome ("bin\arenanode" + $inst + ".cmd")
if (-not (Test-Path $command) -and (Test-Path $oldCommand)) { $command = $oldCommand }
$version = if ($release) { (Get-Content (Join-Path $release.FullName 'VERSION') -ErrorAction SilentlyContinue) } else { '?' }

# THE WINDOW (the owner's playtest 2026-10-25: "make this more pretty ... It should look like a real app with the options" - "Also on
# windows"): the name and version on top, the node's state as a coloured dot and a line, what is not running under it, big buttons two by
# two, and the text box only when there is something to read (Doctor's report, the installer's lines)
$dark = [System.Drawing.Color]::FromArgb(32, 33, 36); $card = [System.Drawing.Color]::FromArgb(48, 49, 54)
$fg = [System.Drawing.Color]::FromArgb(236, 238, 241); $dim = [System.Drawing.Color]::FromArgb(150, 156, 166)
$blue = [System.Drawing.Color]::FromArgb(47, 129, 247)
$form = New-Object System.Windows.Forms.Form
$form.Text = "Bitcoin Arena"; $form.ClientSize = New-Object System.Drawing.Size(560, 330); $form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'; $form.MaximizeBox = $false; $form.BackColor = $dark; $form.ForeColor = $fg
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Join-Path $here 'ArenaNode.exe')) } catch { }
$name = New-Object System.Windows.Forms.Label
$name.Text = 'Bitcoin Arena'; $name.Font = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$name.AutoSize = $true; $name.Left = 24; $name.Top = 18; $form.Controls.Add($name)
$ver = New-Object System.Windows.Forms.Label
$ver.Text = "Node $version"; $ver.ForeColor = $dim; $ver.AutoSize = $true; $ver.Left = 27; $ver.Top = 56; $form.Controls.Add($ver)
$dot = New-Object System.Windows.Forms.Label
$dot.Text = [string][char]0x25CF; $dot.Font = New-Object System.Drawing.Font('Segoe UI', 14); $dot.ForeColor = $dim
$dot.AutoSize = $true; $dot.Left = 22; $dot.Top = 88; $form.Controls.Add($dot)
$title = New-Object System.Windows.Forms.Label
$title.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold); $title.Text = 'Starting Bitcoin Arena...'
$title.AutoSize = $false; $title.Left = 48; $title.Top = 90; $title.Width = 490; $title.Height = 28; $form.Controls.Add($title)
$sub = New-Object System.Windows.Forms.Label
$sub.ForeColor = $dim; $sub.AutoSize = $false; $sub.Left = 26; $sub.Top = 122; $sub.Width = 510; $sub.Height = 42; $form.Controls.Add($sub)
# an update's real progress, 0 to 100 % (kanban #706): shown only while the node is updated
$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Minimum = 0; $bar.Maximum = 100; $bar.Style = 'Continuous'; $bar.Left = 26; $bar.Top = 164; $bar.Width = 510; $bar.Height = 8; $bar.Visible = $false
$form.Controls.Add($bar)
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'; $box.Left = 24; $box.Width = 512; $box.Height = 150; $box.Visible = $false
$box.Font = New-Object System.Drawing.Font('Consolas', 9); $box.BackColor = $card; $box.ForeColor = $fg; $box.BorderStyle = 'None'
$form.Controls.Add($box)
$buttons = @{}
$order = 'Open in browser', 'Dashboard', 'Owner page', 'Stop node', 'Start node', 'Doctor', 'All nodes', 'Add nodes', 'Refresh', 'Stop', 'Close'
$labels = @{ 'Open in browser' = 'Open setup page'; 'Dashboard' = 'Open Dashboard'; 'Stop' = 'Stop installer' }
foreach ($b in $order) {
  $btn = New-Object System.Windows.Forms.Button
  $btn.Text = $(if ($labels.ContainsKey($b)) { $labels[$b] } else { $b }); $btn.Width = 248; $btn.Height = 44; $btn.Visible = $false
  $btn.FlatStyle = 'Flat'; $btn.FlatAppearance.BorderSize = 0; $btn.BackColor = $card; $btn.ForeColor = $fg; $btn.Cursor = 'Hand'
  $btn.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $form.Controls.Add($btn); $buttons[$b] = $btn
}
# the shown buttons two by two in their order, the first one blue; the text box under them when it holds something
function Set-Buttons([string[]]$shown) {
  $i = 0
  foreach ($b in $order) {
    $on = $shown -contains $b; $buttons[$b].Visible = $on
    if ($on) {
      $buttons[$b].Left = 24 + ($i % 2) * 264; $buttons[$b].Top = 176 + [math]::Floor($i / 2) * 54
      $buttons[$b].BackColor = $(if ($i -eq 0) { $blue } else { $card }); $i++
    }
  }
  $rows = [math]::Ceiling($i / 2); $box.Top = 176 + $rows * 54 + 6
  $h = $(if ($box.Visible) { $box.Top + $box.Height + 20 } else { 176 + $rows * 54 + 12 })
  $form.ClientSize = New-Object System.Drawing.Size(560, [math]::Max(250, $h))
}
function Set-State([string]$heading, [string]$line, [System.Drawing.Color]$color) {
  $title.Text = $heading; $sub.Text = $line; $dot.ForeColor = $color
}
Set-Buttons @('Close')
$buttons['Close'].Add_Click({ $form.Close() })

# a command's output, shown in the box (bitcoinarena: status, doctor, restart)
function Show-Command([string]$what) {
  $form.Cursor = 'WaitCursor'; $box.Visible = $true; $box.Text = "bitcoinarena $what ..."; $form.Refresh()
  # bitcoinarena writes UTF-8 (its check marks): the console page set to it, and read as it (measured in the Windows VM: mojibake for the check mark)
  $was = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $out = & cmd /c "chcp 65001 >nul & `"$command`" $what 2>&1"
  [Console]::OutputEncoding = $was
  $box.Text = ($out -join "`r`n"); $box.SelectionStart = 0; $box.SelectionLength = 0; $form.Cursor = 'Default'
}
function Show-Installed {
  $was = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $state = (& cmd /c "chcp 65001 >nul & `"$command`" state 2>&1" | Select-Object -First 1)
  [Console]::OutputEncoding = $was
  $running = "$state" -like 'running*'
  $green = [System.Drawing.Color]::FromArgb(63, 185, 80); $red = [System.Drawing.Color]::FromArgb(248, 81, 73)
  $line = $(if ($running) { 'Your node runs and serves the network.' } else { 'Your node does not run.' })
  if ("$state" -match 'not running: (.+)$') { $line = 'Not running: ' + $Matches[1] } elseif ("$state" -match '^stopped: (.+)$') { $line = 'Stopped: ' + $Matches[1] }
  Set-State $(if ($running) { 'Server running' } else { 'Server stopped' }) $line $(if ($running) { $green } else { $red })
  $box.Visible = $false; $bar.Visible = $false
  Set-Buttons @('Dashboard', 'Owner page', $(if ($running) { 'Stop node' } else { 'Start node' }), 'Doctor', 'All nodes', 'Add nodes')
}

# EVERY NODE ON THIS PC (kanban #713, 2026-10-26: "The App shows the status of ALL OF OUR nodes in a grid with links to all owners
# dashboards. I must be logged into all of them with my seed"): bitcoinarena nodes --json, one card each with its Dashboard and Owner page
# (each node's own command in its home, so its owner page is signed in with its own key), and every owner page signed in at once
function Command-Of([string]$nodeHome) {
  $inst = (Get-Content (Join-Path $nodeHome 'arena.conf') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^instance=(.+)$' } | ForEach-Object { $Matches[1] } | Select-Object -First 1)
  $c = Join-Path $nodeHome ("bin\bitcoinarena" + $(if ($inst) { "-$inst" } else { '' }) + ".cmd")
  if (Test-Path $c) { return $c }
  return Join-Path $nodeHome ("bin\arenanode" + $(if ($inst) { "-$inst" } else { '' }) + ".cmd")
}
function Show-Nodes {
  $json = (& cmd /c "`"$command`" nodes --json 2>nul") -join ''
  $nodes = @(); try { $nodes = @($json | ConvertFrom-Json) } catch { $nodes = @() }
  $script:shownNodes = $nodes
  $w = New-Object System.Windows.Forms.Form
  $w.Text = 'Your nodes'; $w.BackColor = $dark; $w.ForeColor = $fg; $w.StartPosition = 'CenterParent'; $w.FormBorderStyle = 'FixedDialog'; $w.MaximizeBox = $false
  $w.Font = New-Object System.Drawing.Font('Segoe UI', 10)
  $up = @($nodes | Where-Object { $_.running }).Count
  $head = New-Object System.Windows.Forms.Label; $head.Text = "$($nodes.Count) node(s) on this PC, $up running."; $head.Left = 20; $head.Top = 14; $head.AutoSize = $true
  $head.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold); $w.Controls.Add($head)
  $i = 0
  foreach ($n in $nodes) {
    $x = 20 + ($i % 2) * 290; $y = 52 + [math]::Floor($i / 2) * 104
    $p = New-Object System.Windows.Forms.Panel; $p.Left = $x; $p.Top = $y; $p.Width = 276; $p.Height = 94; $p.BackColor = $card
    $l = New-Object System.Windows.Forms.Label; $l.Left = 10; $l.Top = 8; $l.AutoSize = $true
    $l.Text = $(if ($n.instance) { "Node $($n.instance)" } else { 'Node 1' }); $l.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
    $l.ForeColor = $(if ($n.running) { [System.Drawing.Color]::FromArgb(63, 185, 80) } else { [System.Drawing.Color]::FromArgb(248, 81, 73) })
    $d = New-Object System.Windows.Forms.Label; $d.Left = 10; $d.Top = 32; $d.AutoSize = $true
    $d.Text = "$(if ($n.running) { 'Running' } else { 'Stopped' }) - $($n.version) - port $($n.port)"
    $p.Controls.Add($l); $p.Controls.Add($d)
    foreach ($what in @('Dashboard', 'Owner page')) {
      $b = New-Object System.Windows.Forms.Button; $b.Text = $what; $b.Width = 124; $b.Height = 30; $b.Top = 56; $b.Left = $(if ($what -eq 'Dashboard') { 10 } else { 142 })
      $b.FlatStyle = 'Flat'; $b.BackColor = $blue; $b.ForeColor = $fg; $b.Tag = "$($n.home)|$(if ($what -eq 'Dashboard') { 'dashboard' } else { 'open' })"
      $b.Add_Click({ $t = "$($this.Tag)".Split('|'); & cmd /c "`"$(Command-Of $t[0])`" $($t[1])" | Out-Null })
      $p.Controls.Add($b)
    }
    $w.Controls.Add($p); $i++
  }
  $rows = [math]::Ceiling([math]::Max($i, 1) / 2)
  $all = New-Object System.Windows.Forms.Button; $all.Text = 'Sign in to all owner pages'; $all.Width = 276; $all.Height = 36; $all.Left = 20; $all.Top = 52 + $rows * 104
  $all.FlatStyle = 'Flat'; $all.BackColor = $card; $all.ForeColor = $fg
  # one hand-over for every node's key ("You need to store credentials for *all* owner pages where its needed and provide links"), the links shown
  $all.Add_Click({ $out = & cmd /c "`"$command`" sign-in-all 2>&1"; [void][System.Windows.Forms.MessageBox]::Show((($out | Where-Object { $_ -match 'https://' -and $_ -notmatch '^Signing' }) -join "`r`n"), 'Your owner pages') })
  $w.Controls.Add($all)
  $w.ClientSize = New-Object System.Drawing.Size(600, (52 + $rows * 104 + 56))
  [void]$w.ShowDialog($form)
}
# MORE NODES ON THIS PC (kanban #713, testnet4): how many, and Fedimint on a RAM disk; bitcoinarena add-nodes runs the installer for them,
# each one's setup page opening in the browser in turn
function Add-Nodes {
  Add-Type -AssemblyName Microsoft.VisualBasic
  $n = [Microsoft.VisualBasic.Interaction]::InputBox("How many more nodes on this PC? Testnet4 only. Each gets its own seed, owner key and bond, paid from your first node's wallet; their setup pages open in your browser one after another.", 'Add nodes', '1')
  if ($n -notmatch '^[1-9][0-9]?$') { return }
  $ram = [System.Windows.Forms.MessageBox]::Show('Fedimint on a RAM disk?', 'Add nodes', 'YesNo') -eq 'Yes'
  $alog = Join-Path $here 'adding.log'
  Set-State "Adding $n node(s)..." 'Each new node''s setup page opens in your browser, one after another. Keep this window open.' ([System.Drawing.Color]::FromArgb(210, 153, 34))
  $script:adding = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"`"$command`" add-nodes $n $(if ($ram) { '--ram' } else { '--no-ram' }) >> `"$alog`" 2>&1`"" -WindowStyle Hidden -PassThru
  $atimer = New-Object System.Windows.Forms.Timer; $atimer.Interval = 5000
  $atimer.Add_Tick({ if ($script:adding.HasExited) { $this.Stop(); Show-Installed; & cmd /c "`"$command`" sign-in-all" | Out-Null; Show-Nodes } })
  $atimer.Start()
}
$buttons['All nodes'].Add_Click({ Show-Nodes })
$buttons['Add nodes'].Add_Click({ Add-Nodes })
$buttons['Dashboard'].Add_Click({ & cmd /c "`"$command`" dashboard" | Out-Null })
$buttons['Owner page'].Add_Click({ & cmd /c "`"$command`" open" | Out-Null })
$buttons['Stop node'].Add_Click({
  if ([System.Windows.Forms.MessageBox]::Show('Stop your node? It stops serving rounds until you start it again.', 'Bitcoin Arena', 'OKCancel') -eq 'OK') { Show-Command 'stop'; Show-Installed }
})
$buttons['Start node'].Add_Click({ Show-Command 'start'; Show-Installed })
$buttons['Doctor'].Add_Click({ Show-Command 'doctor' })
$buttons['Refresh'].Add_Click({ Show-Installed })

if ((Test-Path $command) -and (Test-Path (Join-Path $nodeHome 'arena.conf'))) {
  # THIS SETUP'S RELEASE OVER AN OLDER NODE (the owner's playtest 2026-10-25: "When I execute 2.9.2 it doesn't update the node, it just
  # starts the 1.9.1"): arena-install --update-self moves the node to the release beside this window when it is newer, hidden, its line
  # read by a timer; then the node's status as before
  if ($release) {
    Set-State 'Checking your node...' "If it runs an older release than $version, it is updated now. This takes a minute or two." [System.Drawing.Color]::FromArgb(210, 153, 34)
    $ulog = Join-Path $here 'update.log'
    Set-Content -Path $ulog -Value '' -Encoding ascii
    $unode = Join-Path $release.FullName 'runtime\node.exe'
    $umjs = Join-Path $release.FullName 'packages\arena-installer\bin\arena-install.mjs'
    $script:up = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"`"$unode`" `"$umjs`" --update-self >> `"$ulog`" 2>&1`"" -WorkingDirectory $release.FullName -WindowStyle Hidden -PassThru
    $utimer = New-Object System.Windows.Forms.Timer
    $utimer.Interval = 1000
    $utimer.Add_Tick({
      # THE UPDATE'S PROGRESS LINES (kanban #706): "[#####-----]  45 %  Unpacking 2026.1.9.9" - the last one moves the bar and says the step
      $p = Get-Content $ulog -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\[[#-]+\]\s+\d{1,3} %  ' } | Select-Object -Last 1
      if ($p -and $p -match '^\[[#-]+\]\s+(\d{1,3}) %  (.*)$') {
        $title.Text = "Updating your node to $version..."; $bar.Value = [math]::Min(100, [int]$Matches[1]); $bar.Visible = $true
        $sub.Text = "$($Matches[1]) %  $($Matches[2])"
      }
      if (-not $script:up.HasExited) { return }
      $utimer.Stop()
      $line = Get-Content $ulog -ErrorAction SilentlyContinue | Where-Object { $_ -match '^(Updated|Up to date|Rolled back|Not updated)' } | Select-Object -Last 1
      Show-Installed
      if ($line -and $line -notmatch '^Up to date') { $sub.Text = "$line`r`n" + $sub.Text }
      # THE OWNER PAGE SIGNED IN ONCE AFTER THE UPDATE (2026-10-26: "The updater MUST fix my credentials in the browser so it works")
      if ($line -match '^Updated') { & cmd /c "`"$command`" sign-in-once" | Out-Null }
      # more nodes: the Add nodes button, never a dialog of its own (2026-10-26: "It automatically opens the modal, don't do that")
    })
    $utimer.Start()
  } else { Show-Installed }
} elseif (-not $release) {
  Set-State 'The release is missing' "Run the Bitcoin Arena setup again (nothing beside $here)." ([System.Drawing.Color]::FromArgb(248, 81, 73))
} else {
  # THE INSTALLER, HIDDEN: its lines go to a log file beside this window, read by a timer (an event handler cannot run while the
  # window holds the PowerShell thread)
  Set-State 'The installer runs' 'Its setup page opens in your browser. Keep this window open until the page says Done. If Windows Firewall asks about cloudflared, choose Cancel.' [System.Drawing.Color]::FromArgb(210, 153, 34)
  $box.Visible = $true
  $log = Join-Path $here 'installer.log'
  Set-Content -Path $log -Value '' -Encoding ascii
  $node = Join-Path $release.FullName 'runtime\node.exe'
  $mjs = Join-Path $release.FullName 'packages\arena-installer\bin\arena-install.mjs'
  $env:ARENA_CLOUDFLARED = Join-Path $release.FullName 'runtime\cloudflared.exe'
  $env:ARENA_NO_BROWSER = '1'   # this window opens the link itself (kanban #635: two browser windows)
  $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"`"$node`" `"$mjs`" >> `"$log`" 2>&1`"" -WorkingDirectory $release.FullName -WindowStyle Hidden -PassThru
  $script:read = 0
  $script:link = $null
  # the installer is cmd.exe's child: ended with its whole tree
  function Stop-Installer { if (-not $proc.HasExited) { & taskkill /PID $proc.Id /T /F | Out-Null } }
  Set-Buttons @('Stop', 'Close')
  $buttons['Open in browser'].Add_Click({ if ($script:link) { Start-Process $script:link } })
  $buttons['Stop'].Add_Click({ Stop-Installer; Set-State 'The installer was stopped' 'Open Bitcoin Arena from the Start menu to start it again.' $dim; Set-Buttons @('Close') })
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 300
  $timer.Add_Tick({
    $text = ''
    try { $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); $fs.Seek($script:read, 'Begin') | Out-Null; $sr = New-Object System.IO.StreamReader($fs); $text = $sr.ReadToEnd(); $script:read = $fs.Position; $sr.Close() } catch { }
    foreach ($l in ($text -split "`r?`n")) {
      if ($l -eq '') { continue }
      $box.AppendText($l + "`r`n")
      if (-not $script:link -and $l -match '(https?://\S+\?t=[A-Za-z0-9_-]+)') {
        $script:link = $Matches[1]; Set-Buttons @('Open in browser', 'Stop', 'Close'); Start-Process $script:link
      }
      if ($l -match '^Done\. Your node runs') { $timer.Stop(); Start-Sleep -Seconds 2; Show-Installed; return }
    }
    if ($proc.HasExited) { $timer.Stop(); if (Test-Path $command) { Show-Installed } else { Set-State 'The installer ended' 'Its lines are below.' ([System.Drawing.Color]::FromArgb(248, 81, 73)) } }
  })
  $timer.Start()
  $form.Add_FormClosing({ Stop-Installer })
}
[void]$form.ShowDialog()
