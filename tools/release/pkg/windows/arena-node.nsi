; ARENA NODE SETUP FOR WINDOWS (2026-10-19: "for windows we want an exe"): ArenaNodeSetup-<version>-windows-x64.exe.
; No administrator: the release goes to %LOCALAPPDATA%\ArenaNode (the node's services run it from there), the Start menu and the desktop
; get "Arena Node" (the small window, ArenaNode.ps1), and the window opens at the end - it runs the installer and opens the browser.
; makensis -DVERSION=<v> -DSTAGE=<unpacked release dir> -DOUT=<exe> arena-node.nsi   (tools/release/package.sh)
Unicode true
SetCompressor /SOLID lzma
!include "MUI2.nsh"

Name "Arena Node ${VERSION}"
OutFile "${OUT}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\ArenaNode"
BrandingText "Arena Node ${VERSION} (testnet4)"

!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_WELCOMEPAGE_TITLE "Arena Node ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This sets up an Arena node on testnet4.$\r$\n$\r$\nIt copies the node to your user folder (no administrator needed). Then a small Arena Node window opens and starts the installer, and the setup page opens in your browser, where you choose what your node does.$\r$\n$\r$\nLater, start Arena Node from the Start menu."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Arena Node now (starts the setup in your browser)"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenWindow
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!define WINDOW '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\ArenaNode.ps1"'

Section "Arena Node"
  SetOutPath "$INSTDIR\${RELEASE}"
  File /r "${STAGE}\*.*"
  SetOutPath "$INSTDIR"
  File "ArenaNode.ps1"
  CreateDirectory "$SMPROGRAMS\Arena Node"
  CreateShortcut "$SMPROGRAMS\Arena Node\Arena Node.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\ArenaNode.ps1"' "$INSTDIR\${RELEASE}\runtime\node.exe" 0
  CreateShortcut "$DESKTOP\Arena Node.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\ArenaNode.ps1"' "$INSTDIR\${RELEASE}\runtime\node.exe" 0
  CreateShortcut "$SMPROGRAMS\Arena Node\Uninstall Arena Node setup.lnk" "$INSTDIR\uninstall.exe"
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
  Delete "$DESKTOP\Arena Node.lnk"
  RMDir /r "$SMPROGRAMS\Arena Node"
SectionEnd
