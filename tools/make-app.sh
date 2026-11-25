#!/bin/sh
# Собирает macOS-бандл .app вокруг исполняемого файла.
#
# У Mach-O НЕТ секции ресурсов, поэтому вшить иконку в сам бинарь нельзя
# ни на какой системе. Иконку несёт бандл: Finder показывает .app как
# одну программу, хотя внутри обычный исполняемый файл.
set -e

BIN="${1:?укажите путь к бинарю}"
APP="${2:?укажите путь к .app}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(grep -o '"version": *"[^"]*"' "$ROOT/package.json" | head -1 | cut -d'"' -f4)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/ragana"
chmod +x "$APP/Contents/MacOS/ragana"

if [ -f "$ROOT/assets/ragana.icns" ]; then
  cp "$ROOT/assets/ragana.icns" "$APP/Contents/Resources/ragana.icns"
else
  echo "предупреждение: нет assets/ragana.icns — иконки не будет"
fi

# CFBundleIconFile указывается БЕЗ расширения — с ним Finder иконку не
# подхватит. LSUIElement=false обязателен: это TUI, ему нужно окно
# терминала, иначе программа запустится невидимо и будет выглядеть как
# «ничего не произошло».
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>ragana</string>
  <key>CFBundleDisplayName</key>       <string>ragana</string>
  <key>CFBundleIdentifier</key>        <string>app.hexstack.ragana</string>
  <key>CFBundleVersion</key>           <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key>        <string>ragana</string>
  <key>CFBundleIconFile</key>          <string>ragana</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>LSMinimumSystemVersion</key>    <string>11.0</string>
  <key>LSUIElement</key>               <false/>
  <key>NSHighResolutionCapable</key>   <true/>
</dict>
</plist>
PLIST

echo "  $APP собран"
