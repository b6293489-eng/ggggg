#!/usr/bin/env bash
# Double-click this file in Finder to run ACE-Step locally on macOS.

set -euo pipefail

ACESTEP_DIR="/Users/hlibokhai/Documents/Codex/ACE-Step-1.5"
cd "$ACESTEP_DIR"

mkdir -p .runtime-cache/huggingface .runtime-cache/modelscope .runtime-cache/matplotlib
export HF_HOME="$ACESTEP_DIR/.runtime-cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$HF_HOME/hub"
export MODELSCOPE_CACHE="$ACESTEP_DIR/.runtime-cache/modelscope"
export MPLCONFIGDIR="$ACESTEP_DIR/.runtime-cache/matplotlib"

echo "Starting ACE-Step on http://127.0.0.1:7860"
echo "Keep this Terminal window open while generating music."
echo

./.venv/bin/acestep \
  --port 7860 \
  --server-name 127.0.0.1 \
  --language en \
  --config_path acestep-v15-turbo \
  --lm_model_path acestep-5Hz-lm-1.7B \
  --init_llm false \
  --backend mlx \
  --init_service true \
  --batch_size 1

echo
echo "ACE-Step stopped. Press Enter to close this window."
read -r
