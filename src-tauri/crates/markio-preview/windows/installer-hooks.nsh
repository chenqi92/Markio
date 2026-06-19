; Tauri v2 NSIS 安装钩子：给 .md 家族文件注册右键"用 Markio 预览"。
; 在 tauri.conf.json 里通过 bundle.windows.nsis.installerHooks 引用本文件。
;
; SHCTX 由 Tauri NSIS 模板按安装模式设好（perMachine→HKLM / perUser→HKCU），
; 写到 Software\Classes\SystemFileAssociations 对两种模式都成立，且 perUser 免管理员。
; 预览器二进制需随包安装到 $INSTDIR\markio-preview.exe（见 README 的打包说明）。

!macro RegisterMarkioPreviewVerb EXT
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\MarkioPreview" "" "用 Markio 预览"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\MarkioPreview" "Icon" "$INSTDIR\markio-preview.exe,0"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\MarkioPreview\command" "" '"$INSTDIR\markio-preview.exe" "%1"'
!macroend

!macro UnregisterMarkioPreviewVerb EXT
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\MarkioPreview"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro RegisterMarkioPreviewVerb "md"
  !insertmacro RegisterMarkioPreviewVerb "markdown"
  !insertmacro RegisterMarkioPreviewVerb "mdown"
  !insertmacro RegisterMarkioPreviewVerb "mkd"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro UnregisterMarkioPreviewVerb "md"
  !insertmacro UnregisterMarkioPreviewVerb "markdown"
  !insertmacro UnregisterMarkioPreviewVerb "mdown"
  !insertmacro UnregisterMarkioPreviewVerb "mkd"
!macroend
