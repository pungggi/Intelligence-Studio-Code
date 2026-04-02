# This script regenerates the vendored xterm.js bundle for Windows/PowerShell users.
# Version tracking and checksums are provided in src/app/src/lib/xterm/VERSION.

$XTERM_VERSION = "5.3.0"
$FIT_VERSION = "0.8.0"

$LIB_DIR = "src/app/src/lib/xterm"

if (-Not (Test-Path $LIB_DIR)) {
    Write-Error "$LIB_DIR not found. Please run from project root."
    return
}

Write-Host "Regenerating xterm.js ($XTERM_VERSION) & xterm-addon-fit ($FIT_VERSION)..."

$Downloads = @(
    @{ Uri = "https://unpkg.com/xterm@$XTERM_VERSION/lib/xterm.js";               Out = "$LIB_DIR/xterm.js" },
    @{ Uri = "https://unpkg.com/xterm@$XTERM_VERSION/lib/xterm.js.map";            Out = "$LIB_DIR/xterm.js.map" },
    @{ Uri = "https://unpkg.com/xterm@$XTERM_VERSION/css/xterm.css";               Out = "$LIB_DIR/xterm.css" },
    @{ Uri = "https://unpkg.com/xterm-addon-fit@$FIT_VERSION/lib/xterm-addon-fit.js";     Out = "$LIB_DIR/addon-fit.js" },
    @{ Uri = "https://unpkg.com/xterm-addon-fit@$FIT_VERSION/lib/xterm-addon-fit.js.map"; Out = "$LIB_DIR/xterm-addon-fit.js.map" }
)

try {
    foreach ($dl in $Downloads) {
        Invoke-WebRequest -Uri $dl.Uri -OutFile $dl.Out -ErrorAction Stop
    }
} catch {
    Write-Error "Download failed for '$($dl.Uri)': $($_.Exception.Message)"
    foreach ($dl in $Downloads) {
        if (Test-Path $dl.Out) { Remove-Item $dl.Out -Force -ErrorAction SilentlyContinue }
    }
    exit 1
}

# Add version comment
$FitContent = Get-Content -Path "$LIB_DIR/addon-fit.js" -Raw
Set-Content -Path "$LIB_DIR/addon-fit.js" -Value "/* xterm-addon-fit v$FIT_VERSION */`n$FitContent"

# Create NOTICE file
$Notice = @"
Xterm.js and its standard addons are licensed under the MIT License.
Copyright (c) 2014-2023 The xterm.js authors.
https://github.com/xtermjs/xterm.js

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
"@
$Notice | Out-File -FilePath "$LIB_DIR/NOTICE" -Encoding UTF8

# Generate VERSION file with metadata and checksums
$GeneratedDate = (Get-Date).ToUniversalTime().ToString("u")
$XtermHash = (Get-FileHash "$LIB_DIR/xterm.js" -Algorithm SHA256).Hash
$CssHash = (Get-FileHash "$LIB_DIR/xterm.css" -Algorithm SHA256).Hash
$FitHash = (Get-FileHash "$LIB_DIR/addon-fit.js" -Algorithm SHA256).Hash
$XtermMapHash = (Get-FileHash "$LIB_DIR/xterm.js.map" -Algorithm SHA256).Hash
$FitMapHash = (Get-FileHash "$LIB_DIR/xterm-addon-fit.js.map" -Algorithm SHA256).Hash

$VersionContent = @"
UPSTREAM_VERSION_XTERM=$XTERM_VERSION
UPSTREAM_VERSION_FIT=$FIT_VERSION
GENERATED_DATE=$GeneratedDate
--- SHA256 Checksums ---
$XtermHash xterm.js
$XtermMapHash xterm.js.map
$CssHash xterm.css
$FitHash addon-fit.js
$FitMapHash xterm-addon-fit.js.map
"@

$VersionContent | Out-File -FilePath "$LIB_DIR/VERSION" -Encoding UTF8

Write-Host "Successfully regenerated assets in $LIB_DIR"
