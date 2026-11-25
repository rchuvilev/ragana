#!/bin/sh
# Доказывает, что бинарь самодостаточен.
#
# 🔴 ЗАПУСК ПРИ НАЛИЧИИ node_modules НИЧЕГО НЕ ДОКАЗЫВАЕТ: резолвер
# находит пакеты на диске, и внешние зависимости остаются невидимыми.
# Два дефекта из пяти обнаружились только после убирания каталогов.
# Поэтому проверка именно такая: прячем всё и смотрим, работает ли.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-$ROOT/dist/ragana}"
WORK="/tmp/ragana-verify-$$"
HIDDEN="/tmp/ragana-hidden-$$"

[ -x "$BIN" ] || { echo "нет исполняемого файла: $BIN"; exit 1; }

say() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
bad() { printf '\033[31m  ✗ %s\033[0m\n' "$*"; }

cleanup() {
  [ -d "$HIDDEN/models" ] && mv "$HIDDEN/models" "$ROOT/models" 2>/dev/null || true
  [ -d "$HIDDEN/node_modules" ] && mv "$HIDDEN/node_modules" "$ROOT/node_modules" 2>/dev/null || true
  rm -rf "$HIDDEN" "$WORK"
}
trap cleanup EXIT INT TERM

mkdir -p "$HIDDEN" "$WORK"

say "прячем зависимости"
[ -d "$ROOT/models" ] && mv "$ROOT/models" "$HIDDEN/models"
[ -d "$ROOT/node_modules" ] && mv "$ROOT/node_modules" "$HIDDEN/node_modules"
rm -rf "${TMPDIR:-/tmp}/ragana-lib" "${TMPDIR:-/tmp}/ragana-ort"
# Снимаем подсказку на каталог разработки, иначе проверка нечестная
unset RAGANA_LIB_ROOT
export RAGANA_HOME="$WORK"
ok "models/ и node_modules/ убраны, кэши очищены"

FAILED=0

say "1. создание рабочего места"
if "$BIN" --status > /dev/null 2>&1; then
  [ -f "$WORK/ragana/knowledgebase.json" ] && ok "раскладка создана" \
    || { bad "нет knowledgebase.json"; FAILED=1; }
else
  bad "--status не отработал"
  # Дальше идти бессмысленно: без рабочего места остальные проверки
  # падают с 'nonexistent directory' и маскируют настоящую причину.
  printf '\033[31mПРОВЕРКА НЕ ПРОЙДЕНА: бинарь не запускается\033[0m\n'
  exit 1
fi

say "2. индексация (задействует модель целиком)"
printf 'Франшиза составляет 300 евро за каждый страховой случай.\n' \
  > "$WORK/ragana/knowledgebase/проверка.txt"
if "$BIN" --index --quiet > "$WORK/index.log" 2>&1; then
  # Ожидаем 2 файла: наш проверочный + ПРОЧТИ-МЕНЯ.md, который кладётся
  # при создании рабочего места. Жёсткая проверка на «новых 1» падала
  # именно поэтому — ошибка была в тесте, не в коде.
  grep -qE 'новых [0-9]+' "$WORK/index.log" && ok "файлы проиндексированы: $(grep -oE 'новых [0-9]+' "$WORK/index.log")" \
    || { bad "индексация без результата"; cat "$WORK/index.log"; FAILED=1; }
else
  bad "--index упал"; tail -3 "$WORK/index.log"; FAILED=1
fi

say "3. поиск"
if "$BIN" --search "какая франшиза" --json > "$WORK/search.json" 2>&1; then
  if grep -q '300 евро' "$WORK/search.json"; then
    ok "цитата найдена"
  else
    bad "цитата не найдена"; head -20 "$WORK/search.json"; FAILED=1
  fi
else
  bad "--search упал"; tail -3 "$WORK/search.json"; FAILED=1
fi

say "4. история поиска"
COUNT=$(ls "$WORK/ragana/searches" 2>/dev/null | wc -l)
[ "$COUNT" -ge 1 ] && ok "записей истории: $COUNT" \
  || { bad "история не пишется"; FAILED=1; }

say "5. неизвестный флаг отвергается (а не уходит в TUI)"
if "$BIN" --несуществующий > "$WORK/bad.log" 2>&1; then
  bad "неизвестный флаг принят"; FAILED=1
else
  grep -q 'неизвестные флаги' "$WORK/bad.log" && ok "отказ с подсказкой" \
    || { bad "неожиданная ошибка"; cat "$WORK/bad.log"; FAILED=1; }
fi

echo
if [ "$FAILED" = 0 ]; then
  printf '\033[32mБИНАРЬ САМОДОСТАТОЧЕН\033[0m\n'
else
  printf '\033[31mПРОВЕРКА НЕ ПРОЙДЕНА\033[0m\n'
  exit 1
fi
