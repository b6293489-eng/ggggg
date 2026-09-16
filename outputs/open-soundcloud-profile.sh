#!/usr/bin/env bash
# Opens a clean, separate Chrome profile for one SoundCloud account.
# Usage: ./open-soundcloud-profile.sh bos-423483424

set -euo pipefail

ACCOUNT="${1:-}"
case "$ACCOUNT" in
  bos-423483424|rivi-135338423|nn1v-680019554|gleb-oxaj|tt1-oki|sadliks-214997330) ;;
  *)
    echo "Usage: $0 {bos-423483424|rivi-135338423|nn1v-680019554|gleb-oxaj|tt1-oki|sadliks-214997330}"
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE_ROOT="$SCRIPT_DIR/soundcloud-profiles"
PROFILE_DIR="$PROFILE_ROOT/$ACCOUNT"
mkdir -p "$PROFILE_DIR"

echo "Opening separate Chrome profile for: $ACCOUNT"
echo "Sign in manually, check that the correct SoundCloud account is open, then close this Chrome window."
open -nb "com.google.Chrome" --args \
  --user-data-dir="$PROFILE_DIR" \
  --new-window \
  "https://soundcloud.com/you"
