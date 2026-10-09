import { cleanText } from './core/text.mjs';

const REQUEST_FIELDS = ['type', 'jobId', 'text', 'options'];

function readExactOwnDataFields(value, fieldNames) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== fieldNames.length ||
        ownKeys.some((key) => typeof key !== 'string' || !fieldNames.includes(key))) {
      return null;
    }

    const fields = Object.create(null);
    for (const fieldName of fieldNames) {
      const descriptor = Object.getOwnPropertyDescriptor(value, fieldName);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      fields[fieldName] = descriptor.value;
    }
    return fields;
  } catch {
    return null;
  }
}

function readSafeJobId(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(message, 'jobId');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') ||
        !Number.isSafeInteger(descriptor.value) || descriptor.value <= 0) {
      return null;
    }
    return descriptor.value;
  } catch {
    return null;
  }
}

function resultMessage(jobId, result) {
  return { type: 'result', jobId, result };
}

function workerFailure(jobId) {
  return resultMessage(jobId, { ok: false, error: { code: 'WORKER_FAILED' } });
}

export function handleWorkerMessage(message) {
  const jobId = readSafeJobId(message);
  if (jobId === null) return undefined;

  const request = readExactOwnDataFields(message, REQUEST_FIELDS);
  if (!request || request.jobId !== jobId || request.type !== 'clean') {
    return workerFailure(jobId);
  }

  try {
    return resultMessage(jobId, cleanText(request.text, request.options));
  } catch {
    return workerFailure(jobId);
  }
}

function currentWorkerScope() {
  const scope = globalThis;
  const WorkerScope = scope.WorkerGlobalScope;
  if (typeof WorkerScope !== 'function' || !(scope instanceof WorkerScope) ||
      typeof scope.addEventListener !== 'function' || typeof scope.postMessage !== 'function') {
    return null;
  }
  return scope;
}

const workerScope = currentWorkerScope();
if (workerScope) {
  workerScope.addEventListener('message', (event) => {
    const response = handleWorkerMessage(event.data);
    if (response !== undefined) workerScope.postMessage(response);
  });
}
