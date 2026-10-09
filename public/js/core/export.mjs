import { MAX_TEXT_UTF8_BYTES, normalizeNewlines, validateText } from './text.mjs';

function failure(code) {
  return { ok: false, error: { code } };
}

export function encodeOutput(text) {
  const validation = validateText(text);
  if (!validation.ok) return validation;

  const Encoder = globalThis.TextEncoder;
  if (typeof Encoder !== 'function') return failure('UNSUPPORTED');

  try {
    const bytes = new Encoder().encode(normalizeNewlines(text));
    if (bytes.byteLength > MAX_TEXT_UTF8_BYTES) return failure('INPUT_TOO_LARGE');
    return { ok: true, value: bytes };
  } catch {
    return failure('UNSUPPORTED');
  }
}
