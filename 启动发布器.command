#!/bin/zsh
set -e
cd "${0:A:h}"
if curl -fsS http://127.0.0.1:17880/api/health >/dev/null 2>&1; then
  open http://127.0.0.1:17880/
  exit 0
fi
if [[ ! -d node_modules ]]; then
  npm install
fi
npm run web &
publisher_pid=$!
trap 'kill "$publisher_pid" 2>/dev/null || true' EXIT INT TERM
for attempt in {1..20}; do
  if curl -fsS http://127.0.0.1:17880/api/health >/dev/null 2>&1; then
    open http://127.0.0.1:17880/
    wait "$publisher_pid"
    exit $?
  fi
  sleep 0.25
done
echo "发布器未能启动，请保留本窗口并检查上方错误。"
wait "$publisher_pid"
