#!/bin/bash
cd "$(dirname "$0")"
nohup node server/index.js > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
echo "Server started, PID: $(cat /tmp/server.pid)"