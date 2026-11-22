# Chrome-расширение

```sh
sh tools/build-extension.sh
```
→ `extension/dist/` (14.9 МБ) → `chrome://extensions` → Режим разработчика
→ Загрузить распакованное.

## Что отличается от веба и APK

Только `manifest.json` и `sw.js`. Ядро `core/*.mjs`, веб-слой и PDF-парсер
**копируются теми же файлами**, а не дублируются.

## 🔴 MV3 запрещает внешние скрипты

`import('https://cdn.jsdelivr.net/...')` будет заблокирован CSP, поэтому
Transformers.js и WASM вкладываются локально. Сборка проверяет, что в
`app.js` не осталось ни одного внешнего URL.

CSP требует `'wasm-unsafe-eval'` — без него onnxruntime не запустится.

## Почему вкладка, а не popup

Popup закрывается при потере фокуса, а индексация идёт минутами. Service
worker в MV3 тоже выгружается через ~30 с простоя, поэтому вся работа —
на странице `app.html`. IndexedDB общая, состояние не теряется.

## Размер

Из `onnxruntime-web` берётся только `ort-wasm-simd-threaded.wasm`
(13.6 МБ). Варианты jsep/jspi/asyncify (+69 МБ) на телефоне не нужны.
