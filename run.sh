#!/bin/bash
set -eu

cd "$(dirname "$0")"

PID_FILE="/tmp/server.pid"
LOG_FILE="/tmp/server.log"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed or not in PATH" >&2
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  existing_pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${existing_pid:-}" ] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "Error: Server appears to already be running (PID: $existing_pid)" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

nohup node server/index.js > "$LOG_FILE" 2>&1 &
server_pid=$!
echo "$server_pid" > "$PID_FILE"

sleep 1
if ! kill -0 "$server_pid" 2>/dev/null; then
  echo "Error: Server failed to start. Check log: $LOG_FILE" >&2
  rm -f "$PID_FILE"
  exit 1
fi

echo "Server started, PID: $server_pid"
