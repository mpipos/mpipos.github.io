#!/bin/zsh
# Double-click to start the personal live mode. It asks for your Kite API key the first time and for each
# day's access token, then opens the site in your browser with live prices. Close this window to stop.
cd "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js isn't installed. Get it from https://nodejs.org, then double-click this file again."
  read -k 1 "?Press any key to close."
  exit 1
fi

# The pages and the day's official data come from the published site, so nothing needs building here.
# It stops by itself at 4 PM, after the market's close, unless started later than that.
npm run live -- --until 16:00
