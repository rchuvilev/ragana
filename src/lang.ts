// Определение языка текста по алфавиту.
//
// ЗАЧЕМ: Florence-2 обучен на английских корпусах и на кириллице даёт
// нечитаемый результат. ЗАМЕРЕНО на одной и той же картинке:
//   tesseract  «Франшиза составляет 300 евро»        0.6 с
//   Florence-2 «ОРОчНИЯЯ СОспостивел ЗО ЕРо»        91.7 с
// И даже на английском он ошибается: «Deductible is 300 euro per claim»
// превратилось в «Deutscible is 30 euro per chaim» за 86 с, тогда как
// tesseract отработал точно.
//
// Вывод: Florence-2 НЕ годится как OCR ни для какого языка. Его
// единственная настоящая ниша — ОПИСАНИЕ изображений без текста, где
// tesseract возвращает пустоту (проверено: картинка с фигурами -> «синий
// круг слева, красный прямоугольник справа»).
//
// Определение языка нужно не для выбора OCR, а для выбора ЯЗЫКОВ
// tesseract: передавать ему все 66 сразу нельзя — это замедляет
// распознавание в разы и роняет точность.

/** Доли символов по письменностям. */
export interface ScriptProfile {
  cyrillic: number;
  latin: number;
  cjk: number;
  arabic: number;
  other: number;
  /** Сколько букв всего посчитано. */
  letters: number;
}

/**
 * Считает доли письменностей. Небуквенные символы (цифры, пунктуация,
 * пробелы) игнорируются: в таблице цифр больше, чем букв, и они
 * исказили бы картину.
 */
export function scriptProfile(text: string): ScriptProfile {
  let cyr = 0, lat = 0, cjk = 0, ara = 0, oth = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    // Пропускаем всё, что не буква
    if (!/\p{L}/u.test(ch)) continue;
    if ((c >= 0x0400 && c <= 0x04ff) || (c >= 0x0500 && c <= 0x052f)) cyr++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
             || (c >= 0xc0 && c <= 0x24f)) lat++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)
             || (c >= 0xac00 && c <= 0xd7af)) cjk++;
    else if (c >= 0x0600 && c <= 0x06ff) ara++;
    else oth++;
  }
  const letters = cyr + lat + cjk + ara + oth;
  if (letters === 0) {
    return { cyrillic: 0, latin: 0, cjk: 0, arabic: 0, other: 0, letters: 0 };
  }
  return {
    cyrillic: cyr / letters,
    latin: lat / letters,
    cjk: cjk / letters,
    arabic: ara / letters,
    other: oth / letters,
    letters,
  };
}

/**
 * Преимущественно латиница?
 *
 * Порог 0.85, а не 1.0: в английском тексте встречаются единичные
 * кириллические символы (имена, цитаты), и жёсткое равенство
 * отбраковывало бы нормальные документы.
 *
 * При менее чем 20 буквах ответ отрицательный: на обрывке в пару слов
 * определять язык бессмысленно, а ошибка здесь дороже отказа.
 */
export function isMostlyLatin(text: string): boolean {
  const p = scriptProfile(text);
  if (p.letters < 20) return false;
  return p.latin >= 0.85;
}

/**
 * Языки tesseract по профилю письменностей.
 *
 * Передавать tesseract все 66 языков нельзя: каждый добавленный язык
 * замедляет распознавание и увеличивает шанс неверной подстановки
 * похожих букв. Поэтому выбираем по алфавиту — это дёшево и надёжнее,
 * чем угадывать конкретный язык.
 *
 * @param hint текст-подсказка (имя файла, соседние документы) или ''
 * @param fallback что использовать, когда подсказки нет
 */
export function tesseractLangs(hint: string, fallback = 'rus+eng'): string {
  const p = scriptProfile(hint);
  if (p.letters < 10) return fallback;

  // 🔴 ДОМИНИРУЮЩАЯ письменность забирает набор себе.
  //
  // Порог 0.15 на каждый алфавит не работает: tesseract с набором
  // rus+eng подменяет латиницу похожей кириллицей, и его же вывод
  // выглядит «двуязычным». Замер: «Deductible is 300 euro per claim»
  // распозналось как «Deductible 15 300 еиго рег claim» — 32% кириллицы
  // при том, что на картинке её НЕТ ВООБЩЕ. Сужение по такому профилю
  // оставляло бы rus+eng и закрепляло ошибку.
  //
  // Поэтому: если один алфавит занимает 60% и больше — выбираем только
  // его. Смешанные наборы остаются для действительно двуязычных текстов.
  const scripts: Array<[number, string]> = [
    [p.cyrillic, 'rus'],
    [p.latin, 'eng'],
    [p.cjk, 'chi_sim'],
    [p.arabic, 'ara'],
  ];
  scripts.sort((a, b) => b[0] - a[0]);
  const top = scripts[0]!;
  if (top[0] >= 0.6) return top[1];

  const langs = scripts.filter(([share]) => share > 0.15).map(([, l]) => l);
  return langs.length > 0 ? langs.join('+') : fallback;
}

/**
 * Стоит ли звать Florence-2 для этого изображения.
 *
 * Решение принимается ПО РЕЗУЛЬТАТУ tesseract, а не по языку исходника:
 * язык картинки заранее неизвестен, а вот пустой результат распознавания
 * — точный признак того, что текста на ней нет.
 *
 * @param ocrText что вернул tesseract
 * @returns 'skip' | 'caption' — описание, OCR через Florence-2 не нужен
 */
export function florenceDecision(ocrText: string): 'skip' | 'caption' {
  // Если tesseract что-то нашёл — Florence-2 не улучшит, а испортит:
  // замерено, что он ошибается даже на чистом английском.
  return ocrText.trim().length >= 10 ? 'skip' : 'caption';
}
