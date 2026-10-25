; ARENA NODE SETUP FOR WINDOWS (2026-10-19: "for windows we want an exe"): ArenaNodeSetup-<version>-windows-x64.exe.
; No administrator: the release goes to %LOCALAPPDATA%\ArenaNode (the node's services run it from there), the Start menu and the desktop
; get "Bitcoin Arena" (the small window, ArenaNode.ps1), and the window opens at the end - it runs the installer and opens the browser.
; makensis -DVERSION=<v> -DSTAGE=<unpacked release dir> -DOUT=<exe> arena-node.nsi   (tools/release/package.sh)
Unicode true
SetCompressor /SOLID lzma
!include "MUI2.nsh"

Name "Bitcoin Arena ${VERSION}"
OutFile "${OUT}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\ArenaNode"
BrandingText "Bitcoin Arena ${VERSION} (testnet4)"

; the brand mark (kanban #635, the owner's playtest: "It has no logo")
!define MUI_ICON "bitcoin-arena.ico"
!define MUI_UNICON "bitcoin-arena.ico"
!define MUI_WELCOMEPAGE_TITLE "Bitcoin Arena ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This sets up a Bitcoin Arena node on testnet4.$\r$\n$\r$\nIt copies the node to your user folder (no administrator needed). Then a small Bitcoin Arena window opens and starts the installer, and the setup page opens in your browser, where you choose what your node does.$\r$\n$\r$\nLater, start Bitcoin Arena from the Start menu."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Bitcoin Arena now (starts the setup in your browser)"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenWindow
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!define WINDOW '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\ArenaNode.ps1"'

Section "Bitcoin Arena"
  SetOutPath "$INSTDIR\${RELEASE}"
  File /r "${STAGE}\*.*"
  SetOutPath "$INSTDIR"
  File "ArenaNode.ps1"
  CreateDirectory "$SMPROGRAMS\Bitcoin Arena"
  CreateShortcut "$SMPROGRAMS\Bitcoin Arena\Bitcoin Arena.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\ArenaNode.ps1"' "$INSTDIR\${RELEASE}\runtime\node.exe" 0
  CreateShortcut "$DESKTOP\Bitcoin Arena.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\ArenaNode.ps1"' "$INSTDIR\${RELEASE}\runtime\node.exe" 0
  CreateShortcut "$SMPROGRAMS\Bitcoin Arena\Uninstall Bitcoin Arena setup.lnk" "$INSTDIR\uninstall.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Function OpenWindow
  Exec '${WINDOW}'
FunctionEnd

; the uninstaller takes away what the setup copied; the node itself (its home, %USERPROFILE%\.arena-node, its services and its bond) is
; the user's and stays - a node is taken down from its owner page (leave) first
Function un.onInit
  IfFileExists "$PROFILE\.arena-node\arena.conf" 0 done
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "An Arena node is installed in $PROFILE\.arena-node and may run from these files. Removing them stops it from starting again.$\r$\n$\r$\nRemove anyway? (Stop the node first: arenanode stop)" IDYES done
    Abort
  done:
FunctionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR\${RELEASE}"
  Delete "$INSTDIR\ArenaNode.ps1"
  Delete "$INSTDIR\installer.log"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\Bitcoin Arena.lnk"
  RMDir /r "$SMPROGRAMS\Bitcoin Arena"
  Delete "$DESKTOP\Arena Node.lnk"
  RMDir /r "$SMPROGRAMS\Arena Node"
SectionEnd
