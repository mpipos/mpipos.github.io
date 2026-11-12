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
# It runs until 9:30 PM, when the evening's official update has arrived, so after the market closes you still
# see today's closing prices. Then the site shows the official ones, as it does whenever the live mode is off.
npm run live -- --until 21:30
