#!/usr/bin/env bash
# Full HAPI stack smoke for DSH subagent support: local hub + `hapi runner
# start-sync` + a real DSH session driven by a real model. Verifies the metadata
# catalog, the hub transcript/prompt/interrupt routes, and the CLI session RPCs.
#
# Requires: bun, jq, curl, an installed `dsh` with usable model credentials, and
# a writable DSH_HOME. Creates one real root session plus its teammate in the
# DSH store and deletes both again on exit.
#
#   DSH_HOME=/path/to/dsh/home scripts/testing/dsh-subagent-stack-smoke.sh
set -uo pipefail
WS=$(cd "$(dirname "$0")/../.." && pwd)
TMP=${HAPI_SMOKE_TMP:-/tmp/hapi-dsh-stack-smoke}
TOKEN=smoke-token
PORT=${HAPI_SMOKE_PORT:-3999}
rm -rf "$TMP"; mkdir -p "$TMP/hub-home" "$TMP/runner-home"
if curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "[stack] port $PORT is already serving a hub; refusing to reuse it"
    exit 1
fi
HUB_PID=""; RUNNER_PID=""; ROOT_DSH=""; CHILD_DSH=""; SESSION=""
cleanup() {
    [ -n "$RUNNER_PID" ] && kill "$RUNNER_PID" 2>/dev/null
    [ -n "$HUB_PID" ] && kill "$HUB_PID" 2>/dev/null
    sleep 1
    [ -n "$RUNNER_PID" ] && kill -9 "$RUNNER_PID" 2>/dev/null
    [ -n "$HUB_PID" ] && kill -9 "$HUB_PID" 2>/dev/null
    # Never leave smoke sessions in the operator's DSH store.
    if [ -n "${DSH_HOME:-}" ] && [ -n "${ROOT_DSH:-}${CHILD_DSH:-}" ]; then
        for id in $ROOT_DSH $CHILD_DSH; do
            rm -rf -- "$DSH_HOME"/sessions/*/"$id" 2>/dev/null
        done
    fi
    if [ -n "${SESSION:-}" ]; then
        pkill -f -- "--hapi-session-id $SESSION" 2>/dev/null
    fi
}
trap cleanup EXIT

echo "[stack] starting hub"
(cd "$WS/hub" && exec env HAPI_HOME="$TMP/hub-home" CLI_API_TOKEN="$TOKEN" HAPI_LISTEN_PORT="$PORT" DB_PATH="$TMP/hub.db" \
    bun run src/index.ts > "$TMP/hub.log" 2>&1) &
HUB_PID=$!
for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "[stack] hub did not start"; tail -20 "$TMP/hub.log"; exit 1; }

JWT=$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth" -H 'content-type: application/json' \
    -d "{\"accessToken\":\"$TOKEN\"}" | jq -r '.token // empty')
[ -n "$JWT" ] || { echo "[stack] auth failed"; exit 1; }
AUTH="Authorization: Bearer $JWT"
echo "[stack] hub up, jwt acquired"

echo "[stack] starting runner"
(cd "$WS/cli" && exec env HAPI_HOME="$TMP/runner-home" HAPI_API_URL="http://127.0.0.1:$PORT" CLI_API_TOKEN="$TOKEN" HAPI_CLI_API_TOKEN="$TOKEN" \
    bun src/index.ts runner start-sync --workspace-root "$WS" > "$TMP/runner.log" 2>&1) &
RUNNER_PID=$!
MACHINE=""
for _ in $(seq 1 120); do
    MACHINE=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/api/machines" | jq -r '.machines[0].id // empty')
    [ -n "$MACHINE" ] && break
    sleep 0.5
done
[ -n "$MACHINE" ] || { echo "[stack] machine did not register"; tail -30 "$TMP/runner.log"; exit 1; }
echo "[stack] machine $MACHINE"

echo "[stack] spawning dsh session"
SPAWN=$(curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
    -d "{\"agent\":\"dsh\",\"directory\":\"$WS\",\"startingMode\":\"remote\"}" \
    "http://127.0.0.1:$PORT/api/machines/$MACHINE/spawn")
SESSION=$(echo "$SPAWN" | jq -r '.sessionId // empty')
[ -n "$SESSION" ] || { echo "[stack] spawn failed: $SPAWN"; exit 1; }
echo "[stack] session $SESSION"

for _ in $(seq 1 120); do
    ACTIVE=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/api/sessions" | jq -r --arg id "$SESSION" '.sessions[] | select(.id==$id) | .active')
    [ "$ACTIVE" = "true" ] && break
    sleep 0.5
done
[ "$ACTIVE" = "true" ] || { echo "[stack] session never became active"; tail -40 "$TMP/runner.log"; exit 1; }
echo "[stack] session active"

if [ "${SMOKE_PHASE:-team}" = "external" ]; then
    EXTERNAL_TASK='Use the subagent_codex tool exactly once with description "Stack external probe" and prompt "Reply with the single word PONG and nothing else. Do not use any tools." Then reply with one short sentence reporting its answer.'
    curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d "$(jq -nc --arg t "$EXTERNAL_TASK" '{text:$t}')" \
        "http://127.0.0.1:$PORT/api/sessions/$SESSION/messages" > /dev/null
    echo "[stack] external task delivered; waiting for the external catalog row"
    EXTERNAL=""
    for _ in $(seq 1 600); do
        SUMMARY=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/api/sessions" | jq -c --arg id "$SESSION" '.sessions[] | select(.id==$id)')
        EXTERNAL=$(echo "$SUMMARY" | jq -r '[.metadata.dshSubagents[]? | select(.mode=="external")][0].sessionId // empty')
        [ -n "$EXTERNAL" ] && break
        sleep 0.5
    done
    [ -n "$EXTERNAL" ] || { echo "[stack] no external DSH child appeared"; echo "$SUMMARY" | jq '.metadata.dshSubagents'; tail -40 "$TMP/runner.log"; exit 1; }
    echo "[stack] external child $EXTERNAL"
    RECORD=""
    for _ in $(seq 1 240); do
        RECORD=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/api/sessions/$SESSION/dsh-subagents/$EXTERNAL/messages?limit=20")
        COUNT=$(echo "$RECORD" | jq -r '.messages | length // 0')
        [ "$COUNT" -ge 2 ] && break
        sleep 0.5
    done
    COUNT=$(echo "$RECORD" | jq -r '.messages | length // 0')
    [ "$COUNT" -ge 2 ] || { echo "[stack] external record incomplete: $RECORD"; exit 1; }
    echo "[stack] external record: $(echo "$RECORD" | jq -c '[.messages[] | {role, kind, head: (.text[0:120])}]')"
    echo "$RECORD" | jq -e '[.messages[] | select(.role=="user")] | length > 0' >/dev/null || { echo "[stack] external record has no task"; exit 1; }
    echo "$RECORD" | jq -e '[.messages[] | select(.role=="assistant")] | length > 0' >/dev/null || { echo "[stack] external record has no result"; exit 1; }
    echo "[stack] external phase ok child=$EXTERNAL"
    STACK_SMOKE_OK=external
    trap - EXIT
    cleanup
    echo "STACK_SMOKE_OK external child=$EXTERNAL"
    exit 0
fi
TASK='Use the spawn_teammate tool exactly once with name "stack-ajax" and task "Use the bash tool to run `sleep 3`, then reply with the single word PONG and nothing else. Do not use any other tools." Then call wait_agent once with a 60 second timeout and reply with one short sentence.'
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d "$(jq -nc --arg t "$TASK" '{text:$t}')" \
    "http://127.0.0.1:$PORT/api/sessions/$SESSION/messages" > /dev/null
echo "[stack] task delivered; waiting for teammate catalog"

CHILD=""
for _ in $(seq 1 480); do
    SUMMARY=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/api/sessions" | jq -c --arg id "$SESSION" '.sessions[] | select(.id==$id)')
    CHILD=$(echo "$SUMMARY" | jq -r '.metadata.dshSubagents[0].sessionId // empty')
    [ -n "$CHILD" ] && break
    sleep 0.5
done
[ -n "$CHILD" ] || { echo "[stack] no dshSubagents appeared"; echo "$SUMMARY" | jq '.metadata.dshSubagents'; tail -40 "$TMP/runner.log"; exit 1; }
echo "[stack] catalog: $(echo "$SUMMARY" | jq -c '.metadata.dshSubagents')"

EXPECTED_CHILD=$(echo "$SUMMARY" | jq -r --arg id "$CHILD" '.metadata.dshSubagents[] | select(.sessionId==$id) | .name // .label // empty')
echo "[stack] child $CHILD name=$EXPECTED_CHILD"

echo "[stack] reading child transcript through the hub route"
PAGE=""
for _ in $(seq 1 120); do
    PAGE=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/api/sessions/$SESSION/dsh-subagents/$CHILD/messages?limit=50")
    COUNT=$(echo "$PAGE" | jq -r '.messages | length // 0')
    [ "$COUNT" -gt 0 ] && break
    sleep 0.5
done
COUNT=$(echo "$PAGE" | jq -r '.messages | length // 0')
[ "$COUNT" -gt 0 ] || { echo "[stack] transcript empty: $PAGE"; exit 1; }
echo "[stack] transcript $COUNT messages, kinds: $(echo "$PAGE" | jq -c '[.messages[].kind // .messages[].role] | group_by(.) | map({(.[0]): length}) | add')"

echo "[stack] prompting the child through the hub route"
REQ="stack-$(date +%s)-abcd1234"
PROMPT=$(curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
    -d "$(jq -nc --arg t 'Reply with the single word PONG2 and nothing else.' --arg r "$REQ" '{text:$t,delivery:"queue",requestId:$r}')" \
    "http://127.0.0.1:$PORT/api/sessions/$SESSION/dsh-subagents/$CHILD/prompt")
echo "[stack] prompt response: $PROMPT"

SEEN=""
for _ in $(seq 1 480); do
    PAGE=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/api/sessions/$SESSION/dsh-subagents/$CHILD/messages?limit=100")
    SEEN=$(echo "$PAGE" | jq -r '[.messages[] | select(.role=="assistant") | .text] | join(" ") | test("PONG2")')
    [ "$SEEN" = "true" ] && break
    sleep 0.5
done
[ "$SEEN" = "true" ] || { echo "[stack] follow-up answer missing"; echo "$PAGE" | jq -c '[.messages[].text]'; exit 1; }
echo "[stack] follow-up answered"

STOP=$(curl -s -X POST -H "$AUTH" "http://127.0.0.1:$PORT/api/sessions/$SESSION/dsh-subagents/$CHILD/interrupt")
echo "[stack] interrupt response: $STOP"
[ "$(echo "$STOP" | jq -r '.accepted // false')" = "true" ] || { echo "[stack] interrupt failed"; exit 1; }

FULL=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/api/sessions/$SESSION")
ROOT_DSH=$(echo "$FULL" | jq -r '.session.metadata.dshSessionId // empty')
CHILD_DSH=$CHILD
echo "[stack] ok root=$ROOT_DSH child=$CHILD"
echo "STACK_SMOKE_OK"
