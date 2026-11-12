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

# The page is built from the market data on this computer. The first time, that data is collected, which takes a while.
if [ ! -f dist/index.html ]; then
  if [ -f .cache/site/meta.json ]; then npm run assemble; else npm run build; fi || { read -k 1 "?Building the site failed. Press any key to close."; exit 1; }
fi

npm run live
