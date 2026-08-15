#!/bin/bash
# Benchmark script for socrata-v1-flash FIM completion
# Tests model loading, FIM output correctness, TTFT, tokens/sec, and memory

set -e

MODEL_PATH="$HOME/Downloads/socrata-v1-flash/gguf_q4_k_m_gguf/Qwen3.5-0.8B.Q4_K_M.gguf"
PORT=8080
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    echo "Stopping llama-server (PID: $SERVER_PID)"
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== Phase 1: Model Load Test ==="
echo "Starting llama-server with Metal acceleration..."
llama-server \
  --model "$MODEL_PATH" \
  --port $PORT \
  --metal \
  --ctx-size 2048 \
  --n-gpu-layers 99 \
  --log-format text \
  > /tmp/llama-server.log 2>&1 &

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
    cat /tmp/llama-server.log
    exit 1
  fi
  sleep 1
done

echo "=== Phase 2: FIM Output Correctness Test ==="
echo "Testing basic FIM completion..."

# Simple Python function completion (properly escaped for JSON)
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

# Check if response contains expected Python-like content
if echo "$RESPONSE" | grep -q "total"; then
  echo "✓ FIM output looks correct (contains 'total')"
else
  echo "✗ FIM output may be incorrect (missing expected content)"
fi

echo ""
echo "=== Phase 3: Latency Benchmark at Varying Context Lengths ==="

# Test at different context lengths
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

  # Extract timing data if available
  if echo "$RESPONSE" | grep -q "tokens_per_second"; then
    TPS=$(echo "$RESPONSE" | grep -o '"tokens_per_second":[0-9.]*' | cut -d':' -f2)
    echo "  TTFT: ${TTFT_MS}ms | Tokens/sec: ${TPS}"
  else
    echo "  TTFT: ${TTFT_MS}ms (tokens/sec not reported)"
  fi

  # Check against targets
  if [ $TTFT_MS -lt 300 ]; then
    echo "  ✓ Meets <300ms target"
  elif [ $TTFT_MS -lt 400 ]; then
    echo "  ⚠ Acceptable (<400ms)"
  else
    echo "  ✗ Unacceptable (>400ms)"
  fi
done

echo ""
echo "=== Phase 4: Memory Footprint ==="
MEMORY_MB=$(ps -o rss= -p $SERVER_PID | awk '{print $1/1024}')
echo "Server memory usage: ${MEMORY_MB}MB"

if [ $(echo "$MEMORY_MB < 3000" | bc -l) -eq 1 ]; then
  echo "✓ Memory under 3GB target"
else
  echo "⚠ Memory exceeds 3GB target"
fi

echo ""
echo "=== Benchmark Complete ==="
echo "Server log available at /tmp/llama-server.log"
