#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/open "$SCRIPT_DIR/releases/v2.2.3/Music Factory-darwin-arm64/Music Factory.app"
