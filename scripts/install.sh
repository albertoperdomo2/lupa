#!/usr/bin/env bash
set -euo pipefail

LUPA_HOME="${LUPA_HOME:-$HOME/.lupa}"
LUPA_BIN_DIR="${LUPA_BIN_DIR:-$HOME/.local/bin}"
LUPA_INSTALL_PATH="${LUPA_INSTALL_PATH:-$LUPA_BIN_DIR/lupa}"
LUPA_INSTALL_BASE_URL="${LUPA_INSTALL_BASE_URL:-https://raw.githubusercontent.com/albertoperdomo2/lupa/main}"

mkdir -p "$LUPA_HOME" "$LUPA_BIN_DIR"

if [[ -f "${BASH_SOURCE[0]%/*}/lupa" ]]; then
  cp "${BASH_SOURCE[0]%/*}/lupa" "$LUPA_INSTALL_PATH"
else
  curl -fsSL "$LUPA_INSTALL_BASE_URL/scripts/lupa" -o "$LUPA_INSTALL_PATH"
fi

chmod +x "$LUPA_INSTALL_PATH"

if [[ ! -f "$LUPA_HOME/.env" ]]; then
  cat >"$LUPA_HOME/.env" <<'EOF'
# LLM provider: "gemini" or "openai" (auto-detected from API key if omitted)
# LLM_PROVIDER=gemini

# Google Gemini (recommended — generous free tier)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash

# OpenAI (alternative)
# OPENAI_API_KEY=
# OPENAI_MODEL=gpt-5.4
EOF
  chmod 600 "$LUPA_HOME/.env"
fi

"$LUPA_INSTALL_PATH" run "$@"

case ":$PATH:" in
  *":$LUPA_BIN_DIR:"*) ;;
  *)
    printf '\nAdd %s to your PATH to use `lupa` directly.\n' "$LUPA_BIN_DIR"
    ;;
esac
