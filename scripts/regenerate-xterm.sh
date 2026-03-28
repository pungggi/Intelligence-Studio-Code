#!/usr/bin/env bash

# This script regenerates the vendored xterm.js bundle.
# Version tracking and checksums are provided in src/app/src/lib/xterm/VERSION.
# Requirement: curl, sha256sum

set -e

XTERM_VERSION="5.3.0"
FIT_VERSION="0.8.0"

# Target directory (relative to project root)
LIB_DIR="src/app/src/lib/xterm"

if [ ! -d "$LIB_DIR" ]; then
  echo "Error: $LIB_DIR not found. Please run from project root."
  exit 1
fi

echo "Regenerating xterm.js ($XTERM_VERSION) & xterm-addon-fit ($FIT_VERSION)..."

# 1. Download official minified assets from unpkg (which serves npm package content)
curl -L "https://unpkg.com/xterm@$XTERM_VERSION/lib/xterm.js" -o "$LIB_DIR/xterm.js"
curl -L "https://unpkg.com/xterm@$XTERM_VERSION/css/xterm.css" -o "$LIB_DIR/xterm.css"
curl -L "https://unpkg.com/xterm-addon-fit@$FIT_VERSION/lib/xterm-addon-fit.js" -o "$LIB_DIR/addon-fit.js"

# 2. Add xterm.js LICENSE/NOTICE
cat <<EOF > "$LIB_DIR/NOTICE"
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
EOF

# 3. Generate VERSION file for reproducibility
# Use sha256sum if available, otherwise just record versions
{
  echo "UPSTREAM_VERSION_XTERM=$XTERM_VERSION"
  echo "UPSTREAM_VERSION_FIT=$FIT_VERSION"
  echo "GENERATED_DATE=$(date -u)"
  
  if command -v sha256sum >/dev/null 2>&1; then
    echo "--- SHA256 Checksums ---"
    sha256sum "$LIB_DIR/xterm.js" | sed 's|src/app/src/lib/xterm/||'
    sha256sum "$LIB_DIR/xterm.css" | sed 's|src/app/src/lib/xterm/||'
    sha256sum "$LIB_DIR/addon-fit.js" | sed 's|src/app/src/lib/xterm/||'
  fi
} > "$LIB_DIR/VERSION"

echo "Successfully regenerated assets in $LIB_DIR"
