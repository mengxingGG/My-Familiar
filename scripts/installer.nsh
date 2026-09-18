!macro customInstall
  ; 安装版把记忆放到用户数据目录，避免升级或卸载清理程序目录时丢失。
  FileOpen $0 "$INSTDIR\resources\familiar-installed" w
  FileWrite $0 "Familiar installed distribution"
  FileClose $0
!macroend
