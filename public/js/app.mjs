import { validateText, normalizeNewlines, measureText } from './core/text.mjs';
import { newSession, transition } from './core/session.mjs';
import { encodeOutput } from './core/export.mjs';
import { getMessages } from './i18n.mjs';

const CORE_ERRORS = new Set(['INPUT_TOO_LARGE', 'INVALID_UNICODE', 'INVALID_OPTIONS', 'UNSUPPORTED', 'WORKER_FAILED']);
const METRIC_KEYS = ['codePoints', 'lines', 'utf8Bytes'];
const zero = () => ({ codePoints: 0, lines: 0, utf8Bytes: 0 });

function exactFields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some(key => !names.includes(key))) return null;
    const fields = Object.create(null);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      fields[name] = descriptor.value;
    }
    return fields;
  } catch { return null; }
}

function matchesMetrics(actual, expected) {
  const fields = exactFields(actual, METRIC_KEYS);
  return fields && METRIC_KEYS.every(key => Number.isSafeInteger(fields[key]) && fields[key] >= 0 && fields[key] === expected[key]);
}

function inspectReply(data, jobId, expectedBefore) {
  const envelope = exactFields(data, ['type', 'jobId', 'result']);
  if (!envelope || envelope.type !== 'result' || envelope.jobId !== jobId) return null;
  const success = exactFields(envelope.result, ['ok', 'value']);
  if (success?.ok === true) {
    const value = exactFields(success.value, ['text', 'before', 'after']);
    if (!value || !validateText(value.text).ok || normalizeNewlines(value.text) !== value.text) return null;
    const after = measureText(value.text);
    if (!matchesMetrics(value.before, expectedBefore) || !matchesMetrics(value.after, after)) return null;
    return { ok: true, value: { text: value.text, before: expectedBefore, after } };
  }
  const failure = exactFields(envelope.result, ['ok', 'error']);
  const error = failure?.ok === false && exactFields(failure.error, ['code']);
  return error && CORE_ERRORS.has(error.code) ? { ok: false, error: { code: error.code } } : null;
}

// Explicit dependencies let a loopback-only test harness exercise late replies and timeouts.
export function mountWorkbench({
  doc = document,
  createWorker = () => new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' }),
  now = () => globalThis.performance.now(),
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  unschedule = handle => globalThis.clearTimeout(handle),
  writeClipboard = text => globalThis.navigator.clipboard.writeText(text),
  createObjectURL = blob => globalThis.URL.createObjectURL(blob),
  revokeObjectURL = url => globalThis.URL.revokeObjectURL(url),
  capabilities = {
    worker: typeof globalThis.Worker === 'function',
    encoder: typeof globalThis.TextEncoder === 'function',
    blob: typeof globalThis.Blob === 'function',
  },
} = {}) {
  const MESSAGES = getMessages(doc.documentElement.lang);
  const get = id => {
    const element = doc.getElementById(id);
    if (!element) throw new Error('Missing workbench element.');
    return element;
  };
  const source = get('source-text');
  const output = get('output-text');
  const options = [get('trim-ascii'), get('drop-empty'), get('deduplicate')];
  const processButton = get('process-button');
  const cancelButton = get('cancel-button');
  const clearButton = get('clear-button');
  const copyButton = get('copy-button');
  const downloadButton = get('download-button');
  const status = get('work-status');
  const sourceError = get('source-error');
  const availability = get('availability');
  const metrics = Object.fromEntries(['before', 'after'].map(prefix => [prefix, [get(`${prefix}-codepoints`), get(`${prefix}-lines`), get(`${prefix}-bytes`)]]));
  const supported = capabilities.worker && capabilities.encoder && capabilities.blob;
  let session = newSession();
  let worker = null;
  let watchdog = null;
  let before = zero();
  let after = zero();
  let outputText = '';
  let notice = supported ? 'idle' : 'UNSUPPORTED';
  let inputError = '';
  let downloadUrl = null;
  let downloadTimer = null;
  let copyTicket = 0;
  const subscriptions = [];

  function listen(target, type, listener) {
    target.addEventListener(type, listener);
    subscriptions.push(() => target.removeEventListener(type, listener));
  }
  function disposeJob() {
    if (watchdog !== null) { unschedule(watchdog); watchdog = null; }
    if (worker) {
      const oldWorker = worker;
      worker = null;
      oldWorker.onmessage = null;
      oldWorker.onerror = null;
      oldWorker.onmessageerror = null;
      try { oldWorker.terminate(); } catch { /* Work is already invalidated. */ }
    }
  }
  function disposeDownload() {
    if (downloadTimer !== null) { unschedule(downloadTimer); downloadTimer = null; }
    if (downloadUrl !== null) {
      const oldUrl = downloadUrl;
      downloadUrl = null;
      revokeObjectURL(oldUrl);
    }
  }
  function clearOutput() { copyTicket += 1; disposeDownload(); outputText = ''; after = zero(); }
  function hasResult() { return session.status === 'success' || session.status === 'empty'; }
  function refreshBefore() {
    const validation = validateText(source.value);
    inputError = validation.ok ? '' : validation.error.code;
    before = validation.ok ? measureText(normalizeNewlines(source.value)) : null;
  }
  function render() {
    const running = session.status === 'running';
    output.value = outputText;
    processButton.disabled = !supported || running;
    cancelButton.hidden = !running;
    cancelButton.disabled = !running;
    clearButton.disabled = false;
    copyButton.disabled = !hasResult();
    downloadButton.disabled = !hasResult() || outputText === '';
    source.setAttribute('aria-invalid', String(Boolean(inputError)));
    sourceError.hidden = !inputError;
    sourceError.textContent = inputError ? MESSAGES[inputError] : '';
    availability.hidden = Boolean(supported);
    if (!supported) availability.textContent = MESSAGES.UNSUPPORTED;
    const nextStatus = MESSAGES[notice] ?? MESSAGES.WORKER_FAILED;
    if (status.textContent !== nextStatus) status.textContent = nextStatus;
    for (const [prefix, value] of [['before', before], ['after', after]]) {
      metrics[prefix].forEach((element, index) => { element.textContent = value === null ? '—' : String(value[METRIC_KEYS[index]]); });
    }
    source.setAttribute('aria-busy', String(running));
  }
  function changed() {
    session = transition(session, { type: 'change' });
    disposeJob();
    clearOutput();
    refreshBefore();
    notice = supported ? 'dirty' : 'UNSUPPORTED';
    render();
  }
  function fail(jobId, code) {
    if (session.status !== 'running' || session.jobId !== jobId) return;
    session = transition(session, { type: 'fail', jobId, code });
    disposeJob();
    clearOutput();
    if (code === 'INPUT_TOO_LARGE' || code === 'INVALID_UNICODE') inputError = code;
    notice = code;
    render();
  }
  function start() {
    if (!supported || session.status === 'running') return;
    session = transition(session, { type: 'start' });
    if (session.status !== 'running') return;
    const jobId = session.jobId;
    clearOutput();
    refreshBefore();
    notice = 'running';
    render();
    if (inputError) { fail(jobId, inputError); return; }
    const expectedBefore = before;
    const request = {
      type: 'clean', jobId, text: source.value,
      options: { trimAscii: options[0].checked, dropEmpty: options[1].checked, deduplicate: options[2].checked },
    };
    try {
      const startedAt = now();
      if (!Number.isFinite(startedAt)) { fail(jobId, 'WORKER_FAILED'); return; }
      worker = createWorker();
      watchdog = schedule(() => fail(jobId, 'TIMEOUT'), 5000);
      worker.onmessage = event => {
        if (session.status !== 'running' || session.jobId !== jobId) return;
        let data;
        let incomingId;
        let elapsed;
        try {
          data = event.data;
          incomingId = data && Object.getOwnPropertyDescriptor(data, 'jobId')?.value;
          elapsed = now() - startedAt;
        } catch { fail(jobId, 'WORKER_FAILED'); return; }
        if (Number.isSafeInteger(incomingId) && incomingId > 0 && incomingId !== jobId) return;
        if (!Number.isFinite(elapsed) || elapsed < 0) { fail(jobId, 'WORKER_FAILED'); return; }
        if (elapsed >= 5000) { fail(jobId, 'TIMEOUT'); return; }
        let reply;
        try { reply = inspectReply(data, jobId, expectedBefore); } catch { reply = null; }
        if (!reply) { fail(jobId, 'WORKER_FAILED'); return; }
        if (!reply.ok) { fail(jobId, reply.error.code); return; }
        session = transition(session, { type: 'finish', jobId, outcome: reply.value.text === '' ? 'empty' : 'success' });
        disposeJob();
        outputText = reply.value.text;
        before = reply.value.before;
        after = reply.value.after;
        notice = session.status;
        render();
      };
      worker.onerror = event => { event.preventDefault?.(); fail(jobId, 'WORKER_FAILED'); };
      worker.onmessageerror = () => fail(jobId, 'WORKER_FAILED');
      worker.postMessage(request);
    } catch { fail(jobId, 'WORKER_FAILED'); }
  }
  function cancel() {
    if (session.status !== 'running') return;
    session = transition(session, { type: 'cancel' });
    disposeJob();
    clearOutput();
    notice = 'cancelled';
    render();
  }
  function clear(focus = true) {
    session = transition(session, { type: 'clear' });
    disposeJob();
    clearOutput();
    source.value = '';
    before = zero();
    inputError = '';
    for (const option of options) option.checked = false;
    notice = supported ? 'idle' : 'UNSUPPORTED';
    render();
    if (focus) source.focus();
  }
  async function copy() {
    if (!hasResult()) return;
    const jobId = session.jobId;
    const ticket = ++copyTicket;
    let message;
    try { await writeClipboard(outputText); message = 'copied'; }
    catch { message = 'CLIPBOARD_FAILED'; }
    if (hasResult() && session.jobId === jobId && ticket === copyTicket) {
      notice = message;
      render();
    }
  }
  function download() {
    if (!hasResult() || outputText === '') return;
    copyTicket += 1;
    disposeDownload();
    const encoded = encodeOutput(outputText);
    if (!encoded.ok) { notice = encoded.error.code; render(); return; }
    let anchor;
    try {
      downloadUrl = createObjectURL(new Blob([encoded.value], { type: 'text/plain;charset=utf-8' }));
      anchor = doc.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = 'cleaned-text.txt';
      anchor.hidden = true;
      doc.body.append(anchor);
      anchor.click();
      downloadTimer = schedule(disposeDownload, 1000);
      notice = 'downloaded';
    } catch { disposeDownload(); notice = 'DOWNLOAD_FAILED'; }
    finally { anchor?.remove(); }
    render();
  }
  listen(source, 'input', changed);
  for (const option of options) listen(option, 'change', changed);
  listen(processButton, 'click', start);
  listen(cancelButton, 'click', cancel);
  listen(clearButton, 'click', () => clear());
  listen(copyButton, 'click', copy);
  listen(downloadButton, 'click', download);
  listen(doc.defaultView, 'pagehide', () => clear(false));
  render();
  return { destroy() { clear(false); for (const unsubscribe of subscriptions) unsubscribe(); } };
}

if (typeof document !== 'undefined' && document.body?.dataset.workbench === 'true') {
  mountWorkbench();
}
