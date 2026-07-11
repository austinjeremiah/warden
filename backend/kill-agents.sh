#!/usr/bin/env bash
# Force-stop any lingering Warden agent processes (use only if Ctrl+C didn't work).
# NOTE: this is a hard kill, so CROO needs ~60-90s afterwards to release the
# WebSocket sessions before `npm run agents` will connect cleanly again.
pids=$(ps -Ao pid,command | grep -E "src/(warden|demo-providers|demo-buyer|scripts/agents)" | grep -v grep | awk '{print $1}')
if [ -z "$pids" ]; then
  echo "No agent processes running."
  exit 0
fi
for pid in $pids; do
  kill -9 "$pid" 2>/dev/null && echo "killed $pid"
done
echo "Done. Wait ~80s before 'npm run agents' so CROO releases the WS sessions."
