// Обёртка над core/lang.mjs.
//
// Сама логика живёт в ядре и работает в браузере без изменений: там нет
// ни одного платформенного вызова. Этот файл существует, чтобы
// TypeScript-код в src/ импортировал её привычным путём.
export {
  scriptProfile, isMostlyLatin, tesseractLangs, florenceDecision,
} from '../core/lang.mjs';
export type { ScriptProfile } from '../core/lang.mjs';
