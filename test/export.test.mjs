import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeOutput } from '../public/js/core/export.mjs';

function error(code) {
  return { ok: false, error: { code } };
}

test('TX-15: encodes UTF-8 without a BOM or an added trailing newline', () => {
  const result = encodeOutput('甲\nA');
  assert.equal(result.ok, true);
  assert.ok(result.value instanceof Uint8Array);
  assert.deepEqual([...result.value], [231, 148, 178, 10, 65]);
});

test('accepts empty text and preserves only the newlines already present', () => {
  const empty = encodeOutput('');
  assert.equal(empty.ok, true);
  assert.deepEqual([...empty.value], []);

  assert.deepEqual([...encodeOutput('A').value], [65]);
  assert.deepEqual([...encodeOutput('A\n').value], [65, 10]);
  assert.deepEqual([...encodeOutput('\r\n').value], [10]);
});

test('normalizes CRLF and CR to LF before UTF-8 encoding', () => {
  assert.deepEqual([...encodeOutput('A\r\nB\rC').value], [65, 10, 66, 10, 67]);
});

test('rejects non-string and invalid Unicode input without coercion or echo', () => {
  let coercions = 0;
  const input = {
    toString() {
      coercions += 1;
      return 'private source';
    },
  };

  assert.deepEqual(encodeOutput(input), error('INVALID_UNICODE'));
  assert.deepEqual(encodeOutput(null), error('INVALID_UNICODE'));
  for (const invalid of ['\uD800', '\uDC00']) {
    const result = encodeOutput(invalid);
    assert.deepEqual(result, error('INVALID_UNICODE'));
    assert.equal(JSON.stringify(result).includes(invalid), false);
  }
  assert.equal(coercions, 0);
});

test('enforces the raw UTF-16 limit before normalizing line endings', () => {
  const exactLimit = 'a'.repeat(200_000);
  const accepted = encodeOutput(exactLimit);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.byteLength, 200_000);

  assert.deepEqual(encodeOutput('a'.repeat(200_001)), error('INPUT_TOO_LARGE'));
  assert.deepEqual(encodeOutput('\r\n'.repeat(100_001)), error('INPUT_TOO_LARGE'));
});

test('enforces the exact UTF-8 byte limit', () => {
  const exactLimit = '甲'.repeat(87_381) + 'a';
  const accepted = encodeOutput(exactLimit);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.byteLength, 262_144);

  assert.deepEqual(encodeOutput(`${exactLimit}a`), error('INPUT_TOO_LARGE'));
});

test('returns fixed UNSUPPORTED if TextEncoder is unavailable or fails', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
  assert.ok(originalDescriptor);
  try {
    Object.defineProperty(globalThis, 'TextEncoder', { ...originalDescriptor, value: undefined });
    assert.deepEqual(encodeOutput('A'), error('UNSUPPORTED'));

    Object.defineProperty(globalThis, 'TextEncoder', {
      ...originalDescriptor,
      value: class BrokenTextEncoder {
        constructor() {
          throw new Error('private encoder detail');
        }
      },
    });
    const result = encodeOutput('A');
    assert.deepEqual(result, error('UNSUPPORTED'));
    assert.equal(JSON.stringify(result).includes('private encoder detail'), false);
  } finally {
    Object.defineProperty(globalThis, 'TextEncoder', originalDescriptor);
  }
});
