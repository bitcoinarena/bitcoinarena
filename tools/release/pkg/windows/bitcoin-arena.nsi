; BITCOIN ARENA SETUP FOR WINDOWS (2026-10-19: "for windows we want an exe"): bitcoin-arena-node-setup-<version>-windows-x64.exe.
; No administrator: the release goes to %LOCALAPPDATA%\BitcoinArena (the node's services run it from there), the Start menu and the desktop
; get "Bitcoin Arena" (the small window, BitcoinArena.ps1), and the window opens at the end - it runs the installer and opens the browser.
; makensis -DVERSION=<v> -DSTAGE=<unpacked release dir> -DOUT=<exe> bitcoin-arena.nsi   (tools/release/package.sh)
; THE NAMES SINCE 2026.1.9.8 (kanban #688, 2026-10-26: "Rename the directories and binaries to bitcoinarena, not arenanode everywhere in the
; installer, the packages etc."): a setup from before put its releases in %LOCALAPPDATA%\ArenaNode, and a node's services may still run
; one from there - this setup then goes into that folder too (.onInit), and only the window's script takes its new name.
Unicode true
SetCompressor /SOLID lzma
!include "MUI2.nsh"

Name "Bitcoin Arena ${VERSION}"
OutFile "${OUT}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\BitcoinArena"
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

!define WINDOW '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\BitcoinArena.ps1"'

Function .onInit
  IfFileExists "$LOCALAPPDATA\ArenaNode\*.*" 0 +2
    StrCpy $INSTDIR "$LOCALAPPDATA\ArenaNode"
FunctionEnd

Section "Bitcoin Arena"
  SetOutPath "$INSTDIR\${RELEASE}"
  File /r "${STAGE}\*.*"
  SetOutPath "$INSTDIR"
  File "BitcoinArena.ps1"
  Delete "$INSTDIR\ArenaNode.ps1"
  CreateDirectory "$SMPROGRAMS\Bitcoin Arena"
  CreateShortcut "$SMPROGRAMS\Bitcoin Arena\Bitcoin Arena.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\BitcoinArena.ps1"' "$INSTDIR\${RELEASE}\runtime\node.exe" 0
  CreateShortcut "$DESKTOP\Bitcoin Arena.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\BitcoinArena.ps1"' "$INSTDIR\${RELEASE}\runtime\node.exe" 0
  CreateShortcut "$SMPROGRAMS\Bitcoin Arena\Uninstall Bitcoin Arena setup.lnk" "$INSTDIR\uninstall.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Function OpenWindow
  Exec '${WINDOW}'
FunctionEnd

; the uninstaller takes away what the setup copied; the node itself (its home, %USERPROFILE%\.bitcoinarena - or .arena-node, set up before
; 2026.1.9.8 - its services and its bond) is the user's and stays - a node is taken down from its owner page (leave) first
Function un.onInit
  StrCpy $0 "$PROFILE\.bitcoinarena"
  IfFileExists "$0\arena.conf" ask 0
  StrCpy $0 "$PROFILE\.arena-node"
  IfFileExists "$0\arena.conf" ask done
  ask:
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "A Bitcoin Arena node is installed in $0 and may run from these files. Removing them stops it from starting again.$\r$\n$\r$\nRemove anyway? (Stop the node first: bitcoinarena stop)" IDYES done
    Abort
  done:
FunctionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR\${RELEASE}"
  Delete "$INSTDIR\BitcoinArena.ps1"
  Delete "$INSTDIR\ArenaNode.ps1"
  Delete "$INSTDIR\installer.log"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\Bitcoin Arena.lnk"
  RMDir /r "$SMPROGRAMS\Bitcoin Arena"
  Delete "$DESKTOP\Arena Node.lnk"
  RMDir /r "$SMPROGRAMS\Arena Node"
SectionEnd
