!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "mycmux.markdown"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "mycmux.markdown"
  DeleteRegValue HKCU "Software\Classes\.html\OpenWithProgids" "mycmux.html"
  DeleteRegValue HKCU "Software\Classes\.htm\OpenWithProgids" "mycmux.html"
  DeleteRegKey /ifempty HKCU "Software\Classes\.md\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.markdown\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.html\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.htm\OpenWithProgids"
  DeleteRegKey HKCU "Software\Classes\mycmux.markdown"
  DeleteRegKey HKCU "Software\Classes\mycmux.html"
  DeleteRegKey HKCU "Software\Classes\Applications\mycmux.exe"
!macroend
