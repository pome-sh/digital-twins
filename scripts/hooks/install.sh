#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

chmod +x scripts/hooks/pre-commit
git config core.hooksPath scripts/hooks

echo "✅ git hooks installed (core.hooksPath = scripts/hooks)"
echo "   pre-commit will run the OSS boundary and no-eval gates."
