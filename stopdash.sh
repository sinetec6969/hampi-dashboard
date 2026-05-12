#!/bin/bash
kill $(pgrep -f "uvicorn|rtl_tcp|dsd-fme") 2>/dev/null
sleep 1
ps aux | grep -E "(uvicorn|rtl_tcp|dsd)" | grep -v grep && echo "still running" || echo "all stopped"
