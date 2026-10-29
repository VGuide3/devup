#!/usr/bin/env bash
# Install devup/validate shell commands. Run once: ./install.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

command -v node >/dev/null || { echo "node.js required — https://nodejs.org"; exit 1; }

BLOCK="
# ── devup/validate (universal build validator) ──
validate()     { node \"$DIR/validate.js\" \"\$@\"; }
validate-all() { VALIDATE_TESTS=1 VALIDATE_LINT=1 VALIDATE_DEAD=1 node \"$DIR/validate.js\" \"\$@\"; }
devup()        { node \"$DIR/validate.js\" --fix --launch \"\$@\"; }
"

INSTALLED=0
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [ -f "$rc" ] || continue
  grep -q "devup()" "$rc" 2>/dev/null || { echo "$BLOCK" >> "$rc"; INSTALLED=1; }
done

if [ "$INSTALLED" = "1" ]; then
  echo "installed. restart your shell or run:  source ~/.zshrc"
else
  echo "already installed (or no .zshrc/.bashrc found)"
fi
echo "try it:  validate .   or   devup"
