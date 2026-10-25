# ARENA NODE ON WINDOWS: THE SMALL WINDOW (2026-10-19: "for windows we want an exe ... That also includes a small gui
# version of the installer that launches the browser etc"). The Start menu's "Arena Node" and the end of ArenaNodeSetup.exe open it:
#   no node yet      the installer runs (hidden), its one-time link opens in the browser, its lines show here; Stop ends it
#   a node installed `arenanode status` here, with Owner page / Restart / Doctor / Refresh
# Built-in parts only (WinForms in Windows PowerShell): nothing more to install.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$release = Get-ChildItem $here -Directory -Filter '*arena-node-*' | Sort-Object Name | Select-Object -Last 1
$nodeHome = Join-Path $env:USERPROFILE '.arena-node'
$command = Join-Path $nodeHome 'bin\arenanode.cmd'
$version = if ($release) { (Get-Content (Join-Path $release.FullName 'VERSION') -ErrorAction SilentlyContinue) } else { '?' }

$form = New-Object System.Windows.Forms.Form
$form.Text = "Bitcoin Arena $version"; $form.Width = 720; $form.Height = 520; $form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$title = New-Object System.Windows.Forms.Label
$title.AutoSize = $false; $title.Left = 14; $title.Top = 12; $title.Width = 680; $title.Height = 66
$form.Controls.Add($title)
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'; $box.Left = 14; $box.Top = 82; $box.Width = 676; $box.Height = 322
$box.Font = New-Object System.Drawing.Font('Consolas', 9); $box.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($box)
$buttons = @{}
$x = 14
foreach ($b in 'Open in browser', 'Owner page', 'Restart', 'Doctor', 'Refresh', 'Stop', 'Close') {
  $btn = New-Object System.Windows.Forms.Button
  $btn.Text = $b; $btn.Left = $x; $btn.Top = 418; $btn.Width = 92; $btn.Height = 32; $btn.Visible = $false
  $form.Controls.Add($btn); $buttons[$b] = $btn; $x += 97
}
$buttons['Close'].Visible = $true
$buttons['Close'].Add_Click({ $form.Close() })

# a command's output, shown in the box (arenanode: status, doctor, restart)
function Show-Command([string]$what) {
  $form.Cursor = 'WaitCursor'; $box.Text = "arenanode $what ..."; $form.Refresh()
  # arenanode writes UTF-8 (its check marks): the console page set to it, and read as it (measured in the Windows VM: mojibake for the check mark)
  $was = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $out = & cmd /c "chcp 65001 >nul & `"$command`" $what 2>&1"
  [Console]::OutputEncoding = $was
  $box.Text = ($out -join "`r`n"); $box.SelectionStart = 0; $box.SelectionLength = 0; $form.Cursor = 'Default'
}
function Show-Installed {
  $title.Text = "Your Bitcoin Arena node is installed. Its services, as 'arenanode status' shows them (also in a new console: arenanode help):"
  foreach ($b in 'Open in browser', 'Stop') { $buttons[$b].Visible = $false }
  foreach ($b in 'Owner page', 'Restart', 'Doctor', 'Refresh') { $buttons[$b].Visible = $true }
  Show-Command 'status'
}
$buttons['Owner page'].Add_Click({ & cmd /c "`"$command`" open" | Out-Null })
$buttons['Restart'].Add_Click({ Show-Command 'restart' })
$buttons['Doctor'].Add_Click({ Show-Command 'doctor' })
$buttons['Refresh'].Add_Click({ Show-Command 'status' })

if ((Test-Path $command) -and (Test-Path (Join-Path $nodeHome 'arena.conf'))) {
  Show-Installed
} elseif (-not $release) {
  $title.Text = "The Bitcoin Arena release is missing next to this window ($here). Run the Bitcoin Arena setup again."
} else {
  # THE INSTALLER, HIDDEN: its lines go to a log file beside this window, read by a timer (an event handler cannot run while the
  # window holds the PowerShell thread)
  $title.Text = "The installer runs. Its setup page opens in your browser (the link works once, for 30 minutes). Keep this window open until the page says Done. If Windows Firewall asks about cloudflared, choose Cancel: the tunnel only connects out."
  $log = Join-Path $here 'installer.log'
  Set-Content -Path $log -Value '' -Encoding ascii
  $node = Join-Path $release.FullName 'runtime\node.exe'
  $mjs = Join-Path $release.FullName 'packages\arena-installer\bin\arena-install.mjs'
  $env:ARENA_CLOUDFLARED = Join-Path $release.FullName 'runtime\cloudflared.exe'
  $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"`"$node`" `"$mjs`" >> `"$log`" 2>&1`"" -WorkingDirectory $release.FullName -WindowStyle Hidden -PassThru
  $script:read = 0
  $script:link = $null
  # the installer is cmd.exe's child: ended with its whole tree
  function Stop-Installer { if (-not $proc.HasExited) { & taskkill /PID $proc.Id /T /F | Out-Null } }
  $buttons['Stop'].Visible = $true
  $buttons['Open in browser'].Add_Click({ if ($script:link) { Start-Process $script:link } })
  $buttons['Stop'].Add_Click({ Stop-Installer; $title.Text = 'The installer was stopped. Open Bitcoin Arena from the Start menu to start it again.'; $buttons['Stop'].Visible = $false })
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 300
  $timer.Add_Tick({
    $text = ''
    try { $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); $fs.Seek($script:read, 'Begin') | Out-Null; $sr = New-Object System.IO.StreamReader($fs); $text = $sr.ReadToEnd(); $script:read = $fs.Position; $sr.Close() } catch { }
    foreach ($l in ($text -split "`r?`n")) {
      if ($l -eq '') { continue }
      $box.AppendText($l + "`r`n")
      if (-not $script:link -and $l -match '(https?://\S+\?t=[A-Za-z0-9_-]+)') {
        $script:link = $Matches[1]; $buttons['Open in browser'].Visible = $true; Start-Process $script:link
      }
      if ($l -match '^Done\. Your node runs') { $timer.Stop(); Start-Sleep -Seconds 2; Show-Installed; return }
    }
    if ($proc.HasExited) { $timer.Stop(); if (Test-Path $command) { Show-Installed } else { $title.Text = "The installer ended. Its lines are below." } }
  })
  $timer.Start()
  $form.Add_FormClosing({ Stop-Installer })
}
[void]$form.ShowDialog()
