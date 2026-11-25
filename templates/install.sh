#!/bin/sh
# Подключает ragana к агенту.
#
# Формат плагинов фрагментирован: Claude Code ждёт .claude-plugin/,
# Codex — секцию в config.toml, Cursor и VS Code — свои json. Но общий
# знаменатель у всех один: MCP-сервер поверх stdio. Этот скрипт
# подставляет реальные пути в нужный формат, потому что ручная правка
# конфигов с плейсхолдерами — частый источник ошибок.
#
#   sh install.sh claude | codex | cursor | vscode | print
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT="${1:-print}"
LAUNCH="$DIR/launcher.js"

[ -f "$LAUNCH" ] || { echo "нет launcher.js рядом со скриптом"; exit 1; }

case "$AGENT" in
  claude)
    command -v claude > /dev/null 2>&1 || {
      echo "claude не найден в PATH"; exit 1; }
    claude mcp add ragana -- node "$LAUNCH" --mcp
    echo "подключено к Claude Code"
    ;;

  codex)
    CFG="$HOME/.codex/config.toml"
    mkdir -p "$(dirname "$CFG")"
    # Повторный запуск не должен плодить дубли секции
    if grep -q 'mcp_servers.ragana' "$CFG" 2> /dev/null; then
      echo "ragana уже прописан в $CFG"
      exit 0
    fi
    {
      echo ''
      echo '[mcp_servers.ragana]'
      echo 'command = "node"'
      echo "args = [\"$LAUNCH\", \"--mcp\"]"
    } >> "$CFG"
    echo "добавлено в $CFG"
    ;;

  cursor)
    mkdir -p .cursor
    cat > .cursor/mcp.json <<JSON
{
  "mcpServers": {
    "ragana": {
      "command": "node",
      "args": ["$LAUNCH", "--mcp"]
    }
  }
}
JSON
    echo "создан .cursor/mcp.json"
    ;;

  vscode)
    mkdir -p .vscode
    cat > .vscode/mcp.json <<JSON
{
  "servers": {
    "ragana": {
      "type": "stdio",
      "command": "node",
      "args": ["$LAUNCH", "--mcp"]
    }
  }
}
JSON
    echo "создан .vscode/mcp.json"
    ;;

  print)
    echo "Команда для любого клиента MCP:"
    echo "  node $LAUNCH --mcp"
    echo
    echo "Готовые настройки:"
    echo "  sh install.sh claude   — Claude Code"
    echo "  sh install.sh codex    — Codex CLI"
    echo "  sh install.sh cursor   — Cursor (в текущем проекте)"
    echo "  sh install.sh vscode   — VS Code Copilot (в текущем проекте)"
    ;;

  *)
    echo "агенты: claude | codex | cursor | vscode | print"
    exit 2
    ;;
esac
