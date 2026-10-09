import assert from 'node:assert/strict';
import test from 'node:test';
import { handleWorkerMessage } from '../public/js/worker.mjs';
import { newSession, transition } from '../public/js/core/session.mjs';

const event = (type) => ({ type });

function runningJobTwo() {
  const dirty = transition(newSession(), event('change'));
  return transition(dirty, event('start'));
}

function cleanRequest(overrides = {}) {
  return {
    type: 'clean',
    jobId: 1,
    text: 'A\r\nB',
    options: { trimAscii: false, dropEmpty: false, deduplicate: false },
    ...overrides,
  };
}

function failedReply(jobId, code = 'WORKER_FAILED') {
  return { type: 'result', jobId, result: { ok: false, error: { code } } };
}

test('newSession and start keep only metadata and assign a fresh job id', () => {
  const idle = newSession();
  assert.deepEqual(idle, { jobId: 0, status: 'idle' });
  assert.deepEqual(Object.keys(idle).sort(), ['jobId', 'status']);

  const firstRun = transition(idle, event('start'));
  assert.deepEqual(firstRun, { jobId: 1, status: 'running' });
  assert.notStrictEqual(firstRun, idle);
  assert.strictEqual(transition(firstRun, event('start')), firstRun);
});

test('TX-14: job 2 ignores a late result from job 1 without changing the session', () => {
  const running = runningJobTwo();
  assert.deepEqual(running, { jobId: 2, status: 'running' });

  assert.strictEqual(transition(running, {
    type: 'finish', jobId: 1, outcome: 'success',
  }), running);
  assert.strictEqual(transition(running, { type: 'fail', jobId: 1, code: 'WORKER_FAILED' }), running);
  assert.deepEqual(running, { jobId: 2, status: 'running' });
});

test('change invalidates the running job before its caller disposes the worker', () => {
  const running = runningJobTwo();
  const changed = transition(running, event('change'));
  assert.deepEqual(changed, { jobId: 3, status: 'dirty' });
  assert.notStrictEqual(changed, running);

  assert.strictEqual(transition(changed, {
    type: 'finish', jobId: 2, outcome: 'success',
  }), changed);
  assert.strictEqual(transition(changed, { type: 'fail', jobId: 2, code: 'TIMEOUT' }), changed);
});

test('cancel moves running to dirty with a new generation and rejects late completion', () => {
  const running = runningJobTwo();
  const cancelled = transition(running, event('cancel'));
  assert.deepEqual(cancelled, { jobId: 3, status: 'dirty' });
  assert.strictEqual(transition(cancelled, {
    type: 'finish', jobId: 2, outcome: 'empty',
  }), cancelled);
  assert.strictEqual(transition(cancelled, { type: 'fail', jobId: 2, code: 'WORKER_FAILED' }), cancelled);
  assert.strictEqual(transition(cancelled, event('cancel')), cancelled);
});

test('clear always returns idle with a new generation and invalidates an active job', () => {
  const running = runningJobTwo();
  const cleared = transition(running, event('clear'));
  assert.deepEqual(cleared, { jobId: 3, status: 'idle' });
  assert.strictEqual(transition(cleared, {
    type: 'finish', jobId: 2, outcome: 'success',
  }), cleared);

  const clearedIdle = transition(newSession(), event('clear'));
  assert.deepEqual(clearedIdle, { jobId: 1, status: 'idle' });
});

test('a restarted session gets a new job id and stale results cannot replace it', () => {
  const running = runningJobTwo();
  const cancelled = transition(running, event('cancel'));
  const restarted = transition(cancelled, event('start'));
  assert.deepEqual(restarted, { jobId: 4, status: 'running' });

  for (const outcome of ['success', 'empty']) {
    assert.strictEqual(transition(restarted, { type: 'finish', jobId: 2, outcome }), restarted);
  }
  assert.strictEqual(transition(restarted, { type: 'fail', jobId: 3, code: 'TIMEOUT' }), restarted);

  assert.deepEqual(transition(restarted, {
    type: 'finish', jobId: 4, outcome: 'success',
  }), { jobId: 4, status: 'success' });
});

test('current empty completion and fixed worker failures become metadata-only terminal states', () => {
  const running = transition(newSession(), event('start'));
  assert.deepEqual(transition(running, { type: 'finish', jobId: 1, outcome: 'empty' }), {
    jobId: 1, status: 'empty',
  });
  assert.deepEqual(transition(running, { type: 'fail', jobId: 1, code: 'INPUT_TOO_LARGE' }), {
    jobId: 1, status: 'error', errorCode: 'INPUT_TOO_LARGE',
  });
  assert.strictEqual(transition(running, { type: 'fail', jobId: 1, code: 'CLIPBOARD_FAILED' }), running);
  assert.strictEqual(transition(running, { type: 'fail', jobId: 1, code: 'raw exception' }), running);
  assert.strictEqual(transition(running, { type: 'finish', jobId: 1, outcome: 'failed' }), running);
});

test('malformed session/event metadata is ignored without invoking accessors', () => {
  const running = transition(newSession(), event('start'));
  let reads = 0;
  const getterEvent = { type: 'finish', jobId: 1, outcome: 'success' };
  Object.defineProperty(getterEvent, 'outcome', {
    get() {
      reads += 1;
      throw new Error('private event detail');
    },
  });
  const extraField = { type: 'cancel', extra: true };
  const symbolField = { type: 'clear', [Symbol('extra')]: true };

  assert.strictEqual(transition(running, getterEvent), running);
  assert.strictEqual(transition(running, extraField), running);
  assert.strictEqual(transition(running, symbolField), running);
  assert.strictEqual(transition({ jobId: 1, status: 'running', text: 'not metadata' }, event('clear'))
    .jobId, 1);
  assert.equal(reads, 0);
});

test('worker replies use the exact envelope and the bounded text core result', () => {
  const reply = handleWorkerMessage(cleanRequest({
    jobId: 42,
    text: 'A\r\nB',
    options: { trimAscii: true, dropEmpty: false, deduplicate: false },
  }));

  assert.deepEqual(reply, {
    type: 'result',
    jobId: 42,
    result: {
      ok: true,
      value: {
        text: 'A\nB',
        before: { codePoints: 3, lines: 2, utf8Bytes: 3 },
        after: { codePoints: 3, lines: 2, utf8Bytes: 3 },
      },
    },
  });
  assert.deepEqual(Object.keys(reply).sort(), ['jobId', 'result', 'type']);
});

test('worker returns fixed core validation errors without echoing oversized text', () => {
  const oversized = 'x'.repeat(200_001);
  const reply = handleWorkerMessage(cleanRequest({ text: oversized }));
  assert.deepEqual(reply, failedReply(1, 'INPUT_TOO_LARGE'));
  assert.equal(JSON.stringify(reply).includes(oversized), false);

  assert.deepEqual(handleWorkerMessage(cleanRequest({ text: 42 })), failedReply(1, 'INVALID_UNICODE'));
  assert.deepEqual(handleWorkerMessage(cleanRequest({ options: null })), failedReply(1, 'INVALID_OPTIONS'));
});

test('worker rejects malformed current requests with a fixed failure and ignores unsafe ids', () => {
  assert.deepEqual(handleWorkerMessage(cleanRequest({ unexpected: true })), failedReply(1));
  assert.deepEqual(handleWorkerMessage(cleanRequest({ type: 'run' })), failedReply(1));
  assert.equal(handleWorkerMessage({ type: 'clean', text: 'A', options: {} }), undefined);

  for (const jobId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', NaN]) {
    assert.equal(handleWorkerMessage(cleanRequest({ jobId })), undefined);
  }
});

test('worker schema inspection does not invoke request or option getters', () => {
  let reads = 0;
  const request = cleanRequest();
  Object.defineProperty(request, 'text', {
    get() {
      reads += 1;
      throw new Error('private text detail');
    },
  });
  assert.deepEqual(handleWorkerMessage(request), failedReply(1));

  const options = {
    get trimAscii() {
      reads += 1;
      throw new Error('private option detail');
    },
    dropEmpty: false,
    deduplicate: false,
  };
  assert.deepEqual(handleWorkerMessage(cleanRequest({ options })), failedReply(1, 'INVALID_OPTIONS'));
  assert.equal(reads, 0);
});
