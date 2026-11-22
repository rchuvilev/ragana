#!/bin/sh
# Сборка APK БЕЗ Gradle, прямо на телефоне.
#
# 🔴 КЛЮЧЕВОЙ ФАКТ: aapt2 и zipalign существуют ТОЛЬКО под x86-64.
# `file aapt2` -> ELF x86-64, хотя устройство aarch64. Google Maven НЕ
# публикует aapt2 под linux-aarch64 (проверено 8.2.0/8.1.0/7.4.2 -> 404).
# Поэтому они запускаются через qemu-x86_64 с минимальным glibc-корнем
# в /opt/x86root. Java-инструменты (d8, apksigner) кроссплатформенны.
#
# Цепочка: aapt2 compile -> aapt2 link -> javac -> d8 -> zip -> zipalign -> apksigner
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_SDK:-/opt/android-sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
X86ROOT="${X86ROOT:-/opt/x86root}"
OUT="$ROOT/build"
APK="$ROOT/ragana.apk"

QEMU="qemu-x86_64 -L $X86ROOT"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

[ -f "$PLATFORM" ] || { echo "нет android.jar: $PLATFORM"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/classes" "$OUT/apk/assets"

say "1/7 собираем ассеты"
# Веб-слой и ядро — внутрь APK, чтобы работало офлайн
cp "$ROOT/web/index.html" "$ROOT/web/style.css" "$ROOT/web/app.js" \
   "$ROOT/web/pdf-web.js" "$OUT/apk/assets/"
mkdir -p "$OUT/apk/assets/core"
cp "$ROOT"/core/*.mjs "$OUT/apk/assets/core/"
# app.js импортирует '../core/...', а в assets плоская раскладка —
# поправляем на './core/...'
sed -i "s#from '../core/#from './core/#g" "$OUT/apk/assets/app.js"
ASSET_COUNT=$(find "$OUT/apk/assets" -type f | wc -l)
echo "   файлов в assets: $ASSET_COUNT"

say "2/7 aapt2 compile (через qemu)"
$QEMU "$BT/aapt2" compile --dir "$OUT/res" -o "$OUT/res.zip" 2>/dev/null || true

say "3/7 aapt2 link"
$QEMU "$BT/aapt2" link \
  -I "$PLATFORM" \
  --manifest "$ROOT/android/AndroidManifest.xml" \
  --java "$OUT/gen" \
  -o "$OUT/base.apk" \
  --auto-add-overlay

say "4/7 javac"
mkdir -p "$OUT/gen"
find "$ROOT/android/java" -name '*.java' > "$OUT/sources.txt"
[ -d "$OUT/gen" ] && find "$OUT/gen" -name '*.java' >> "$OUT/sources.txt" 2>/dev/null || true
# 🔴 -bootclasspath НЕСОВМЕСТИМ с -target 11 в JDK 17:
#    "error: option --boot-class-path not allowed with target 11"
#    Правильно: --release 11 + -classpath android.jar
javac --release 11 -nowarn \
  -classpath "$PLATFORM" \
  -d "$OUT/classes" \
  @"$OUT/sources.txt"

# ⚠️ Ошибка javac раньше НЕ останавливала скрипт (пайп съедал код
# возврата), и сборка «успешно» доходила до apksigner с пустым dex.
CLASS_COUNT=$(find "$OUT/classes" -name '*.class' | wc -l)
[ "$CLASS_COUNT" -gt 0 ] || { echo "javac не создал ни одного .class"; exit 1; }
echo "   классов: $CLASS_COUNT"

say "5/7 d8"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BT/d8" --release --lib "$PLATFORM" --output "$OUT" @"$OUT/classes.txt"
[ -f "$OUT/classes.dex" ] || { echo "d8 не создал classes.dex"; exit 1; }

say "6/7 упаковка"
cd "$OUT"
cp base.apk unsigned.apk
mkdir -p stage && cp classes.dex stage/
(cd stage && zip -q "$OUT/unsigned.apk" classes.dex)
(cd apk && zip -qr "$OUT/unsigned.apk" assets)
$QEMU "$BT/zipalign" -p -f 4 unsigned.apk aligned.apk

say "7/7 подпись"
KS="$ROOT/android/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias ragana -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=ragana, OU=dev, O=hexstack, C=GE" 2>/dev/null
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$APK" aligned.apk

say "проверка"
"$BT/apksigner" verify --print-certs "$APK" | head -3
$QEMU "$BT/aapt2" dump badging "$APK" 2>/dev/null | head -3
ls -la "$APK"
echo
echo "готово: $APK"
