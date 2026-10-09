import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TEXT_CODE_UNITS,
  MAX_TEXT_UTF8_BYTES,
  cleanText,
  measureText,
  normalizeNewlines,
  validateText,
} from '../public/js/core/text.mjs';

const DEFAULT_OPTIONS = Object.freeze({
  trimAscii: false,
  dropEmpty: false,
  deduplicate: false,
});

const zeroMetrics = { codePoints: 0, lines: 0, utf8Bytes: 0 };

function success(text, before, after) {
  return { ok: true, value: { text, before, after } };
}

function error(code) {
  return { ok: false, error: { code } };
}

const acceptanceCases = [
  {
    id: 'TX-01',
    text: '',
    options: DEFAULT_OPTIONS,
    expected: success('', zeroMetrics, zeroMetrics),
  },
  {
    id: 'TX-02',
    text: 'A\r\nB\rC',
    options: DEFAULT_OPTIONS,
    expected: success('A\nB\nC',
      { codePoints: 5, lines: 3, utf8Bytes: 5 },
      { codePoints: 5, lines: 3, utf8Bytes: 5 }),
  },
  {
    id: 'TX-03',
    text: '甲😀\n',
    options: DEFAULT_OPTIONS,
    expected: success('甲😀\n',
      { codePoints: 3, lines: 2, utf8Bytes: 8 },
      { codePoints: 3, lines: 2, utf8Bytes: 8 }),
  },
  {
    id: 'TX-04',
    text: 'e\u0301',
    options: DEFAULT_OPTIONS,
    expected: success('e\u0301',
      { codePoints: 2, lines: 1, utf8Bytes: 3 },
      { codePoints: 2, lines: 1, utf8Bytes: 3 }),
  },
  {
    id: 'TX-05',
    text: '  A\t\n\tB  ',
    options: { trimAscii: true, dropEmpty: false, deduplicate: false },
    expected: success('A\nB',
      { codePoints: 9, lines: 2, utf8Bytes: 9 },
      { codePoints: 3, lines: 2, utf8Bytes: 3 }),
  },
  {
    id: 'TX-06',
    text: '\u3000A\u3000',
    options: { trimAscii: true, dropEmpty: false, deduplicate: false },
    expected: success('\u3000A\u3000',
      { codePoints: 3, lines: 1, utf8Bytes: 7 },
      { codePoints: 3, lines: 1, utf8Bytes: 7 }),
  },
  {
    id: 'TX-07',
    text: 'A\n\n \nB\n',
    options: { trimAscii: false, dropEmpty: true, deduplicate: false },
    expected: success('A\n \nB',
      { codePoints: 7, lines: 5, utf8Bytes: 7 },
      { codePoints: 5, lines: 3, utf8Bytes: 5 }),
  },
  {
    id: 'TX-08',
    text: ' A \nA\n\nB\nB',
    options: { trimAscii: true, dropEmpty: true, deduplicate: true },
    expected: success('A\nB',
      { codePoints: 10, lines: 5, utf8Bytes: 10 },
      { codePoints: 3, lines: 2, utf8Bytes: 3 }),
  },
  {
    id: 'TX-09',
    text: 'A\na\nA\n',
    options: { trimAscii: false, dropEmpty: false, deduplicate: true },
    expected: success('A\na\n',
      { codePoints: 6, lines: 4, utf8Bytes: 6 },
      { codePoints: 4, lines: 3, utf8Bytes: 4 }),
  },
];

for (const acceptanceCase of acceptanceCases) {
  test(`${acceptanceCase.id}: fixed text-cleaning result and metrics`, () => {
    assert.deepEqual(
      cleanText(acceptanceCase.text, acceptanceCase.options),
      acceptanceCase.expected,
    );
  });
}

test('TX-10: accepts 200,000 UTF-16 code units and rejects 200,001 without truncation', () => {
  const atLimit = 'a'.repeat(200_000);
  const accepted = cleanText(atLimit, DEFAULT_OPTIONS);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.text.length, 200_000);
  assert.equal(accepted.value.text, atLimit);
  assert.deepEqual(accepted.value.before, {
    codePoints: 200_000,
    lines: 1,
    utf8Bytes: 200_000,
  });
  assert.deepEqual(accepted.value.after, accepted.value.before);

  const tooLong = 'a'.repeat(200_001);
  assert.deepEqual(cleanText(tooLong, DEFAULT_OPTIONS), error('INPUT_TOO_LARGE'));
  assert.deepEqual(validateText(tooLong), error('INPUT_TOO_LARGE'));
});

test('TX-11: accepts exactly 262,144 UTF-8 bytes and rejects one byte more', () => {
  const atLimit = '甲'.repeat(87_381) + 'a';
  assert.equal(atLimit.length, 87_382);
  assert.deepEqual(validateText(atLimit), { ok: true, value: { utf8Bytes: MAX_TEXT_UTF8_BYTES } });

  const accepted = cleanText(atLimit, DEFAULT_OPTIONS);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.text, atLimit);
  assert.deepEqual(accepted.value.before, {
    codePoints: 87_382,
    lines: 1,
    utf8Bytes: 262_144,
  });

  assert.deepEqual(validateText(`${atLimit}a`), error('INPUT_TOO_LARGE'));
  assert.deepEqual(cleanText(`${atLimit}a`, DEFAULT_OPTIONS), error('INPUT_TOO_LARGE'));
  assert.equal(MAX_TEXT_UTF8_BYTES, 262_144);
});

test('TX-12: rejects either unpaired surrogate without exposing or replacing the input', () => {
  for (const invalid of ['\uD800', '\uDC00']) {
    const result = cleanText(invalid, DEFAULT_OPTIONS);
    assert.deepEqual(result, error('INVALID_UNICODE'));
    assert.equal(JSON.stringify(result).includes(invalid), false);
  }
  assert.deepEqual(validateText('\uD83D\uDE00'), { ok: true, value: { utf8Bytes: 4 } });
});

test('TX-13: rejects an unknown option', () => {
  assert.deepEqual(cleanText('A', {
    trimAscii: false,
    dropEmpty: false,
    deduplicate: false,
    sort: true,
  }), error('INVALID_OPTIONS'));
});

test('validates the raw input length before newline normalization or surrogate scanning', () => {
  assert.equal(MAX_TEXT_CODE_UNITS, 200_000);
  assert.deepEqual(validateText('\r\n'.repeat(100_001)), error('INPUT_TOO_LARGE'));
  assert.deepEqual(validateText('\uD800'.repeat(MAX_TEXT_CODE_UNITS + 1)), error('INPUT_TOO_LARGE'));
  assert.equal(normalizeNewlines('\r\n\r'), '\n\n');
});

test('rejects non-string inputs without coercing them', () => {
  let coercions = 0;
  const input = {
    toString() {
      coercions += 1;
      return 'text';
    },
  };
  assert.deepEqual(validateText(input), error('INVALID_UNICODE'));
  assert.deepEqual(cleanText(input, DEFAULT_OPTIONS), error('INVALID_UNICODE'));
  assert.equal(coercions, 0);
});

test('options require exactly three own boolean data properties', () => {
  const missing = { trimAscii: false, dropEmpty: false };
  const inheritedRequired = Object.create(DEFAULT_OPTIONS);
  const nonBoolean = { trimAscii: 0, dropEmpty: false, deduplicate: false };
  const symbolExtra = { ...DEFAULT_OPTIONS };
  symbolExtra[Symbol('extra')] = false;
  const hiddenExtra = { ...DEFAULT_OPTIONS };
  Object.defineProperty(hiddenExtra, 'sort', { value: false, enumerable: false });
  const hiddenExpected = { dropEmpty: false, deduplicate: false };
  Object.defineProperty(hiddenExpected, 'trimAscii', { value: false, enumerable: false });

  for (const options of [undefined, null, [], missing, inheritedRequired, nonBoolean, symbolExtra, hiddenExtra]) {
    assert.deepEqual(cleanText('A', options), error('INVALID_OPTIONS'));
  }

  assert.deepEqual(cleanText('A', undefined), error('INVALID_OPTIONS'));
  assert.deepEqual(cleanText('A', 'options'), error('INVALID_OPTIONS'));

  assert.deepEqual(cleanText('A', hiddenExpected), success('A',
    { codePoints: 1, lines: 1, utf8Bytes: 1 },
    { codePoints: 1, lines: 1, utf8Bytes: 1 }));
  const nullPrototypeOptions = Object.assign(Object.create(null), DEFAULT_OPTIONS);
  assert.equal(cleanText('A', nullPrototypeOptions).ok, true);
  assert.equal(cleanText('A', Object.freeze({ ...DEFAULT_OPTIONS })).ok, true);
});

test('rejects accessor options without invoking getters or returning thrown details', () => {
  let reads = 0;
  const options = {
    get trimAscii() {
      reads += 1;
      throw new Error('private option detail');
    },
    dropEmpty: false,
    deduplicate: false,
  };
  const result = cleanText('A', options);
  assert.deepEqual(result, error('INVALID_OPTIONS'));
  assert.equal(reads, 0);
  assert.equal(JSON.stringify(result).includes('private option detail'), false);
});

test('returns fixed UNSUPPORTED when TextEncoder is unavailable after module import', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
  try {
    Object.defineProperty(globalThis, 'TextEncoder', { ...originalDescriptor, value: undefined });
    assert.deepEqual(validateText('A'), error('UNSUPPORTED'));
    assert.deepEqual(cleanText('A', DEFAULT_OPTIONS), error('UNSUPPORTED'));
  } finally {
    Object.defineProperty(globalThis, 'TextEncoder', originalDescriptor);
  }
});

test('empty results remain successful and exact deduplication preserves case and first order', () => {
  const empty = cleanText(' \n\t\n', {
    trimAscii: true,
    dropEmpty: true,
    deduplicate: false,
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.value.text, '');
  assert.deepEqual(empty.value.after, zeroMetrics);

  assert.deepEqual(cleanText('Apple\napple\nApple', {
    trimAscii: false,
    dropEmpty: false,
    deduplicate: true,
  }), success('Apple\napple',
    { codePoints: 17, lines: 3, utf8Bytes: 17 },
    { codePoints: 11, lines: 2, utf8Bytes: 11 }));
});

test('measureText counts Unicode code points and LF-separated lines', () => {
  assert.deepEqual(measureText('甲😀\n'), { codePoints: 3, lines: 2, utf8Bytes: 8 });
  assert.deepEqual(measureText(''), zeroMetrics);
  assert.deepEqual(measureText('A\n'), { codePoints: 2, lines: 2, utf8Bytes: 2 });
});
