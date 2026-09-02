#!/bin/bash
# Benchmark script for static llama-server binary
# Tests performance comparison with Homebrew binary

set -e

MODEL_PATH="$(dirname "$0")/src-tauri/resources/models/Qwen2.5-Coder-0.5B-Q5_K_M.gguf"
STATIC_SERVER="/tmp/llama-server-macos-arm64"
PORT=8081
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    echo "Stopping static llama-server (PID: $SERVER_PID)"
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== Static Binary Benchmark ==="
echo "Starting static llama-server with Metal acceleration..."
$STATIC_SERVER \
  --model "$MODEL_PATH" \
  --port $PORT \
  --ctx-size 2048 \
  --n-gpu-layers 99 \
  --log-format text \
  > /tmp/static-server-benchmark.log 2>&1 &

SERVER_PID=$!
echo "Server PID: $SERVER_PID"

# Wait for server to be ready
echo "Waiting for server to start..."
for i in {1..30}; do
  if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "Server is ready after ${i}s"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "ERROR: Server failed to start within 30s"
    cat /tmp/static-server-benchmark.log
    exit 1
  fi
  sleep 1
done

echo "=== FIM Output Correctness Test ==="
FIM_PROMPT='<|fim_prefix|>def calculate_total(items):\n    total = 0\n    for item in items:\n<|fim_suffix|>\n    return total\n<|fim_middle|>'

RESPONSE=$(curl -s -X POST "http://localhost:$PORT/completion" \
  -H "Content-Type: application/json" \
  -d "{
    \"prompt\": \"$FIM_PROMPT\",
    \"n_predict\": 20,
    \"temperature\": 0.0,
    \"stop\": [\"<|fim_suffix|>\", \"<|fim_prefix|>\"]
  }")

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "total"; then
  echo "✓ FIM output looks correct (contains 'total')"
else
  echo "✗ FIM output may be incorrect"
fi

echo ""
echo "=== Latency Benchmark at Varying Context Lengths ==="
CONTEXTS=(100 256 512 1024)

for ctx in "${CONTEXTS[@]}"; do
  echo "Testing with ${ctx} token context..."
  START_TIME=$(date +%s%N)
  RESPONSE=$(curl -s -X POST "http://localhost:$PORT/completion" \
    -H "Content-Type: application/json" \
    -d "{
      \"prompt\": \"$FIM_PROMPT\",
      \"n_predict\": 20,
      \"temperature\": 0.0
    }")
  END_TIME=$(date +%s%N)
  TTFT_MS=$(( (END_TIME - START_TIME) / 1000000 ))

  if echo "$RESPONSE" | grep -q "tokens_per_second"; then
    TPS=$(echo "$RESPONSE" | grep -o '"tokens_per_second":[0-9.]*' | cut -d':' -f2)
    echo "  TTFT: ${TTFT_MS}ms | Tokens/sec: ${TPS}"
  else
    echo "  TTFT: ${TTFT_MS}ms (tokens/sec not reported)"
  fi

  if [ $TTFT_MS -lt 300 ]; then
    echo "  ✓ Meets <300ms target"
  elif [ $TTFT_MS -lt 400 ]; then
    echo "  ⚠ Acceptable (<400ms)"
  else
    echo "  ✗ Unacceptable (>400ms)"
  fi
done

echo ""
echo "=== Memory Footprint ==="
MEMORY_MB=$(ps -o rss= -p $SERVER_PID | awk '{print $1/1024}')
echo "Server memory usage: ${MEMORY_MB}MB"

if [ $(echo "$MEMORY_MB < 3000" | bc -l) -eq 1 ]; then
  echo "✓ Memory under 3GB target"
else
  echo "⚠ Memory exceeds 3GB target"
fi

echo ""
echo "=== Benchmark Complete ==="
echo "Static binary log: /tmp/static-server-benchmark.log"
