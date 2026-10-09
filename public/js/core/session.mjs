const SESSION_STATUSES = new Set(['idle', 'dirty', 'running', 'success', 'empty', 'error']);
const WORKER_ERROR_CODES = new Set([
  'INPUT_TOO_LARGE',
  'INVALID_UNICODE',
  'INVALID_OPTIONS',
  'UNSUPPORTED',
  'TIMEOUT',
  'WORKER_FAILED',
]);

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

function readSession(session) {
  if (session === null || typeof session !== 'object' || Array.isArray(session)) return null;

  let status;
  try {
    const statusDescriptor = Object.getOwnPropertyDescriptor(session, 'status');
    if (!statusDescriptor || !Object.hasOwn(statusDescriptor, 'value')) return null;
    status = statusDescriptor.value;
  } catch {
    return null;
  }

  if (!SESSION_STATUSES.has(status)) return null;
  const fieldNames = status === 'error'
    ? ['jobId', 'status', 'errorCode']
    : ['jobId', 'status'];
  const fields = readExactOwnDataFields(session, fieldNames);
  if (!fields || fields.status !== status ||
      !Number.isSafeInteger(fields.jobId) || fields.jobId < 0) {
    return null;
  }
  if (status === 'error' && !WORKER_ERROR_CODES.has(fields.errorCode)) return null;
  return fields;
}

function readEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;

  let type;
  try {
    const typeDescriptor = Object.getOwnPropertyDescriptor(event, 'type');
    if (!typeDescriptor || !Object.hasOwn(typeDescriptor, 'value')) return null;
    type = typeDescriptor.value;
  } catch {
    return null;
  }

  let fieldNames;
  switch (type) {
    case 'change':
    case 'start':
    case 'cancel':
    case 'clear':
      fieldNames = ['type'];
      break;
    case 'finish':
      fieldNames = ['type', 'jobId', 'outcome'];
      break;
    case 'fail':
      fieldNames = ['type', 'jobId', 'code'];
      break;
    default:
      return null;
  }

  const fields = readExactOwnDataFields(event, fieldNames);
  return fields?.type === type ? fields : null;
}

function makeSession(jobId, status, errorCode = undefined) {
  if (status === 'error') return { jobId, status, errorCode };
  return { jobId, status };
}

function nextJobId(jobId) {
  return jobId < Number.MAX_SAFE_INTEGER ? jobId + 1 : null;
}

export function newSession() {
  return { jobId: 0, status: 'idle' };
}

export function transition(session, event) {
  const current = readSession(session);
  if (!current) return session;

  const action = readEvent(event);
  if (!action) return session;

  switch (action.type) {
    case 'change': {
      const jobId = nextJobId(current.jobId) ?? current.jobId;
      return makeSession(jobId, 'dirty');
    }
    case 'start': {
      if (current.status === 'running') return session;
      const jobId = nextJobId(current.jobId);
      return jobId === null ? session : makeSession(jobId, 'running');
    }
    case 'cancel': {
      if (current.status !== 'running') return session;
      const jobId = nextJobId(current.jobId) ?? current.jobId;
      return makeSession(jobId, 'dirty');
    }
    case 'clear': {
      const jobId = nextJobId(current.jobId) ?? current.jobId;
      return makeSession(jobId, 'idle');
    }
    case 'finish': {
      if (current.status !== 'running' || action.jobId !== current.jobId ||
          !Number.isSafeInteger(action.jobId) || action.jobId <= 0 ||
          (action.outcome !== 'success' && action.outcome !== 'empty')) {
        return session;
      }
      return makeSession(current.jobId, action.outcome);
    }
    case 'fail': {
      if (current.status !== 'running' || action.jobId !== current.jobId ||
          !Number.isSafeInteger(action.jobId) || action.jobId <= 0 ||
          !WORKER_ERROR_CODES.has(action.code)) {
        return session;
      }
      return makeSession(current.jobId, 'error', action.code);
    }
    default:
      return session;
  }
}
