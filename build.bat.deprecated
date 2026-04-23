@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64
cd /d C:\Users\miyaz\cmux-for-linux-dev\src-tauri
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
cargo check 2>&1
