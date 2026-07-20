!include nsDialogs.nsh
!include LogicLib.nsh

!ifdef APP_EXECUTABLE_FILENAME
Var CreateDesktopShortcutCheckbox
Var CreateDesktopShortcutState

!macro customFinishPage
  Page custom CreateDesktopShortcutPageCreate CreateDesktopShortcutPageLeave
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend
!endif

!ifdef APP_EXECUTABLE_FILENAME
Function CreateDesktopShortcutPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "快捷方式"
  Pop $0
  ${NSD_CreateCheckbox} 0 34u 100% 14u "创建桌面快捷方式"
  Pop $CreateDesktopShortcutCheckbox
  ${NSD_Check} $CreateDesktopShortcutCheckbox
  nsDialogs::Show
FunctionEnd
!endif

!ifdef APP_EXECUTABLE_FILENAME
Function CreateDesktopShortcutPageLeave
  ${NSD_GetState} $CreateDesktopShortcutCheckbox $CreateDesktopShortcutState
  ${If} $CreateDesktopShortcutState == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\Meeting-Monster.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
FunctionEnd
!endif

!macro customUnInstall
  Delete "$DESKTOP\Meeting-Monster.lnk"
!macroend
