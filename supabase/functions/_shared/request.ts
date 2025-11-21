import { errorResponse } from './auth.ts';

export class RequestValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'RequestValidationError';
    this.status = status;
  }
}

export type JsonRecord = Record<string, unknown>;

export async function parseJsonRequest(req: Request): Promise<JsonRecord> {
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object') {
      throw new RequestValidationError('invalid JSON payload', 400);
    }
    return body as JsonRecord;
  } catch (err) {
    if (err instanceof RequestValidationError) {
      throw err;
    }
    throw new RequestValidationError('invalid JSON payload', 400);
  }
}

export function requireString(
  payload: JsonRecord,
  key: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw new RequestValidationError(`${key} is required and must be a string`, 400);
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    throw new RequestValidationError(`${key} cannot be empty`, 400);
  }
  return allowEmpty ? value : trimmed;
}

export function optionalString(payload: JsonRecord, key: string): string | null {
  const value = payload[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

export function optionalNumber(payload: JsonRecord, key: string): number | null {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (value === null || value === undefined) {
    return null;
  }
  throw new RequestValidationError(`${key} must be a number`, 400);
}

export function optionalBoolean(payload: JsonRecord, key: string): boolean | null {
  const value = payload[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') {
      return true;
    }
    if (value.toLowerCase() === 'false') {
      return false;
    }
  }
  throw new RequestValidationError(`${key} must be a boolean`, 400);
}

export function resolveRequestId(payload: JsonRecord): string {
  const raw = payload['request_id'];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function respondWithError(err: unknown): Response | null {
  if (err instanceof RequestValidationError) {
    return errorResponse(err.message, err.status);
  }
  return null;
}
