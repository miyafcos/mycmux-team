# Set up MSVC environment
$vsPath = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# Import vcvarsall environment
$output = cmd /c "`"$vsPath`" x64 && set" 2>&1
foreach ($line in $output) {
    if ($line -match "^([^=]+)=(.*)$") {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
}

Set-Location C:\Users\miyaz\cmux-for-linux-dev
npm run tauri build
