#!/bin/sh
# Сквозная проверка: все команды на настоящих файлах.
#
# Юнит-тесты проверяют модули по отдельности; этот скрипт проверяет, что
# они работают ВМЕСТЕ — от создания рабочего места до поиска с цитатами.
# Запускается на исходниках (bun run) либо на собранном бинаре:
#
#   sh test/e2e.sh                 исходники
#   sh test/e2e.sh dist/ragana     бинарь
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-}"
WORK="/tmp/ragana-e2e-$$"

# Запуск: либо бинарь, либо исходники
if [ -n "$BIN" ]; then
  RUN="$BIN"
else
  RUN="bun run $ROOT/src/main.ts"
  export RAGANA_LIB_ROOT="$ROOT"
fi
export RAGANA_HOME="$WORK"

ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
bad()  { printf '\033[31m  ✗ %s\033[0m\n' "$*"; FAILED=$((FAILED + 1)); }
step() { printf '\033[1m%s\033[0m\n' "$*"; }

FAILED=0
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

mkdir -p "$WORK"

# ---------- 1. первый запуск ----------
step "1. создание рабочего места"
$RUN --status > "$WORK/status.txt" 2>&1 || true
for f in ragana/knowledgebase.json ragana/knowledgebase ragana/searches; do
  [ -e "$WORK/$f" ] && ok "создано: $f" || bad "нет: $f"
done
# Без рабочего места остальные проверки падают с 'nonexistent directory'
# и маскируют настоящую причину — выходим сразу.
if [ "$FAILED" != 0 ]; then
  printf '\033[31mE2E ПРЕРВАН: рабочее место не создано\033[0m\n'
  exit 1
fi

# ---------- 2. подготовка документов ----------
step "2. документы"
DOCS="$WORK/ragana/knowledgebase"
cat > "$DOCS/договор.txt" <<'TXT'
ДОГОВОР СТРАХОВАНИЯ № 77-АБ-2026

Франшиза по каждому страховому случаю составляет 300 евро. Если размер
ущерба меньше суммы франшизы, выплата не производится.

Выплата возмещения производится в течение десяти рабочих дней.

Покрытие не распространяется на управление в состоянии опьянения.
TXT
mkdir -p "$DOCS/кадры"
cat > "$DOCS/кадры/отпуск.md" <<'MD'
# Регламент отпусков

Ежегодный отпуск предоставляется по согласованию с руководителем.
Заявление подаётся не позднее чем за четырнадцать календарных дней.
MD
# PDF берём настоящий, если он есть: синтетический не проверяет парсер
[ -f /var/minis/shared/Flights_AGP-RIX_25-26_Oct_2026.pdf ] \
  && cp /var/minis/shared/Flights_AGP-RIX_25-26_Oct_2026.pdf "$DOCS/рейсы.pdf"
ok "подготовлено файлов: $(find "$DOCS" -type f | wc -l)"

# ---------- 3. индексация ----------
step "3. индексация"
if $RUN --index --quiet > "$WORK/index.log" 2>&1; then
  grep -q 'новых' "$WORK/index.log" && ok "проиндексировано" \
    || { bad "нет отчёта об индексации"; cat "$WORK/index.log"; }
else
  bad "--index упал"; tail -5 "$WORK/index.log"
fi

CHUNKS=$($RUN --status --json 2>/dev/null | grep -o '"chunks": *[0-9]*' | grep -o '[0-9]*')
[ "${CHUNKS:-0}" -gt 5 ] && ok "фрагментов: $CHUNKS" || bad "мало фрагментов: ${CHUNKS:-0}"

# ---------- 4. поиск ----------
step "4. поиск с цитатами"
$RUN --search "какая франшиза" --json > "$WORK/s1.json" 2>&1 || true
grep -q '300 евро' "$WORK/s1.json" && ok "цитата найдена дословно" \
  || { bad "цитата не найдена"; head -20 "$WORK/s1.json"; }

$RUN --search "когда дадут отпуск" --json > "$WORK/s2.json" 2>&1 || true
grep -q 'отпуск' "$WORK/s2.json" && ok "второй документ найден" \
  || bad "второй документ не найден"

# ---------- 5. координаты ----------
step "5. координаты в цитатах"
if [ -f "$DOCS/рейсы.pdf" ]; then
  $RUN --search "Riga Ryanair" --json > "$WORK/s3.json" 2>&1 || true
  grep -q '"page": *[0-9]' "$WORK/s3.json" && ok "номер страницы в цитате" \
    || bad "координата страницы отсутствует"
  [ -f "$DOCS/рейсы.pdf.md" ] && ok "расшифровка PDF создана" \
    || bad "нет расшифровки PDF"
  grep -q '## \[с\. ' "$DOCS/рейсы.pdf.md" 2>/dev/null && ok "якоря страниц в расшифровке" \
    || bad "нет якорей в расшифровке"
else
  printf '\033[2m  (PDF недоступен — проверка координат пропущена)\033[0m\n'
fi

# ---------- 6. составной запрос ----------
step "6. разбиение составного вопроса"
$RUN --search "какая франшиза и когда платить" --json > "$WORK/s4.json" 2>&1 || true
QN=$(grep -c '"' "$WORK/s4.json" 2>/dev/null || echo 0)
grep -q '"queries"' "$WORK/s4.json" && ok "подзапросы в ответе" \
  || bad "нет поля queries"

# ---------- 7. частичная переиндексация ----------
step "7. частичная переиндексация"
$RUN --index --quiet > "$WORK/i2.log" 2>&1 || true
grep -q 'актуально' "$WORK/i2.log" && ok "без изменений — работы нет" \
  || { bad "повторная индексация переиндексировала всё"; cat "$WORK/i2.log"; }

echo "Дополнение: эвакуация оплачивается отдельно." >> "$DOCS/договор.txt"
$RUN --index --quiet > "$WORK/i3.log" 2>&1 || true
grep -q 'изменённых 1' "$WORK/i3.log" && ok "изменение замечено" \
  || { bad "изменение не замечено"; cat "$WORK/i3.log"; }

rm "$DOCS/кадры/отпуск.md"
$RUN --index --quiet > "$WORK/i4.log" 2>&1 || true
grep -q 'удалённых 1' "$WORK/i4.log" && ok "удаление замечено" \
  || { bad "удаление не замечено"; cat "$WORK/i4.log"; }

# Позитивный контроль: удалённый документ больше НЕ находится
$RUN --search "согласованию с руководителем" --json > "$WORK/s5.json" 2>&1 || true
grep -q 'отпуск.md' "$WORK/s5.json" && bad "удалённый файл всё ещё в выдаче" \
  || ok "удалённый файл исчез из выдачи"

# ---------- 8. история поисков ----------
step "8. история поисков"
LOGS=$(ls "$WORK/ragana/searches" 2>/dev/null | wc -l)
[ "$LOGS" -ge 4 ] && ok "файлов истории: $LOGS" || bad "история не пишется: $LOGS"
LAST=$(ls "$WORK/ragana/searches" | tail -1)
grep -q '"' "$WORK/ragana/searches/$LAST" && ok "история — корректный JSON" \
  || bad "история повреждена"

# ---------- 9. коды возврата ----------
step "9. коды возврата (контракт для пайплайна)"
# 🔴 set -e обрывает скрипт на ЛЮБОМ ненулевом коде, а здесь ненулевой
# код — это ожидаемый результат. Проверка через функцию с явным
# подавлением: иначе тест молча заканчивался на первой же команде,
# и разделы 9-11 просто не выполнялись (видно по обрыву вывода).
check_code() {
  expected="$1"; shift
  actual=0
  "$@" > /dev/null 2>&1 || actual=$?
  if [ "$actual" = "$expected" ]; then
    ok "$* -> $expected"
  else
    bad "$*: ожидался $expected, получен $actual"
  fi
}

check_code 2 $RUN --search ""
check_code 2 $RUN --несуществующий
check_code 4 $RUN --search "квазимодокракозябра"
check_code 0 $RUN --help

# ---------- 10. MCP ----------
step "10. сервер MCP"
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | $RUN --mcp > "$WORK/mcp.txt" 2>&1 || true
grep -q '"protocolVersion"' "$WORK/mcp.txt" && ok "initialize отвечает" \
  || bad "MCP не инициализируется"
grep -q 'search_documents' "$WORK/mcp.txt" && ok "инструменты объявлены" \
  || bad "инструменты не объявлены"

printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_documents","arguments":{"query":"франшиза","limit":2}}}' \
  | $RUN --mcp > "$WORK/mcp2.txt" 2>&1 || true
grep -q '300 евро' "$WORK/mcp2.txt" && ok "поиск через MCP работает" \
  || { bad "MCP-поиск не вернул цитату"; tail -2 "$WORK/mcp2.txt"; }

# ---------- 11. сброс ----------
step "11. сброс индекса"
$RUN --reset > /dev/null 2>&1 || true
AFTER=$($RUN --status --json 2>/dev/null | grep -o '"chunks": *[0-9]*' | grep -o '[0-9]*')
[ "${AFTER:-1}" = "0" ] && ok "индекс очищен" || bad "индекс не очистился: ${AFTER}"
# Главное: документы пользователя НЕ ТРОНУТЫ
[ -f "$DOCS/договор.txt" ] && ok "документы на месте" || bad "СБРОС УДАЛИЛ ДОКУМЕНТЫ"

echo
if [ "$FAILED" = 0 ]; then
  printf '\033[32mE2E ПРОЙДЕН\033[0m\n'
else
  printf '\033[31mE2E: провалено проверок: %s\033[0m\n' "$FAILED"
  exit 1
fi
