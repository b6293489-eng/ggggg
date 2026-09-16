#!/usr/bin/env bash
# Opens the three existing Chrome profiles in the required SoundCloud order.
# It only opens browser windows. Login credentials and publication stay manual.

set -euo pipefail

CHROME_APP="/Applications/Google Chrome.app"
SOUNDCLOUD_URL="https://soundcloud.com/you"

open_profile() {
  local chrome_profile="$1"
  local label="$2"
  echo
  echo "Opening ${label} (${chrome_profile})..."
  open -na "$CHROME_APP" --args \
    --profile-directory="$chrome_profile" \
    --new-window \
    "$SOUNDCLOUD_URL"
  echo "Log into the correct SoundCloud account and verify its profile URL."
  read -r -p "Press Enter here when ${label} is ready to continue: "
}

open_profile "Profile 7" "Бос / bos-423483424"
open_profile "Default" "Gleb Ohai / gleb-oxaj"
open_profile "Profile 4" "Boner Kurva / rivi-135338423"

echo
echo "All three SoundCloud profile windows have been opened."
echo "You may keep them open for review; close them before browser automation runs."
read -r -p "Press Enter to close this launcher: "
