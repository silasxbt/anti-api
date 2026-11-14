#!/usr/bin/env bash
# Launcher Linux/macOS per esportare credenziali Antigravity
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$DIR/scripts/export-credentials.py" "$@"
