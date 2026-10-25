# ARENA NODE ON WINDOWS: THE SMALL WINDOW (2026-10-19: "for windows we want an exe ... That also includes a small gui
# version of the installer that launches the browser etc"). The Start menu's "Arena Node" and the end of ArenaNodeSetup.exe open it:
#   no node yet      the installer runs (hidden), its one-time link opens in the browser, its lines show here; Stop ends it
#   a node installed "Server running" or "Server stopped" (arenanode state) and its services, with Dashboard / Owner page / Stop node or
#                    Start node / Doctor / Refresh (kanban #658, 2026-10-25: "show when it's installed \"Server running\" with options to
#                    Stop Node, Start Node, Doctor" - "And also \"Dashboard\" that opens the browser with the dashboard")
# Built-in parts only (WinForms in Windows PowerShell): nothing more to install.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$release = Get-ChildItem $here -Directory -Filter '*arena-node-*' | Sort-Object Name | Select-Object -Last 1
$nodeHome = Join-Path $env:USERPROFILE '.arena-node'
# the node's command carries its instance (arena.conf instance=4: arenanode-4.cmd) - the macOS app looked for the bare name (playtest 2026-10-25)
$inst = ''
try { $m = Select-String -Path (Join-Path $nodeHome 'arena.conf') -Pattern '^instance=(.+)$' -ErrorAction Stop | Select-Object -First 1; if ($m) { $inst = '-' + $m.Matches[0].Groups[1].Value.Trim() } } catch { }
$command = Join-Path $nodeHome ("bin\arenanode" + $inst + ".cmd")
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
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'; $box.Left = 24; $box.Width = 512; $box.Height = 150; $box.Visible = $false
$box.Font = New-Object System.Drawing.Font('Consolas', 9); $box.BackColor = $card; $box.ForeColor = $fg; $box.BorderStyle = 'None'
$form.Controls.Add($box)
$buttons = @{}
$order = 'Open in browser', 'Dashboard', 'Owner page', 'Stop node', 'Start node', 'Doctor', 'Refresh', 'Stop', 'Close'
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

# a command's output, shown in the box (arenanode: status, doctor, restart)
function Show-Command([string]$what) {
  $form.Cursor = 'WaitCursor'; $box.Visible = $true; $box.Text = "arenanode $what ..."; $form.Refresh()
  # arenanode writes UTF-8 (its check marks): the console page set to it, and read as it (measured in the Windows VM: mojibake for the check mark)
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
  $box.Visible = $false
  Set-Buttons @('Dashboard', 'Owner page', $(if ($running) { 'Stop node' } else { 'Start node' }), 'Doctor')
}
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
      if (-not $script:up.HasExited) { return }
      $utimer.Stop()
      $line = Get-Content $ulog -ErrorAction SilentlyContinue | Where-Object { $_ -match '^(Updated|Up to date|Rolled back|Not updated)' } | Select-Object -Last 1
      Show-Installed
      if ($line -and $line -notmatch '^Up to date') { $sub.Text = "$line`r`n" + $sub.Text }
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
