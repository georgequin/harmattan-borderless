import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { createHash } from 'node:crypto';
import { Errors } from './errors';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';
const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;

/** Extracts and validates the Idempotency-Key header; it is mandatory on money-moving routes. */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const key = request.header(IDEMPOTENCY_HEADER);
  if (!key || !KEY_PATTERN.test(key)) {
    throw Errors.idempotencyKeyMissing();
  }
  return key;
});

/**
 * Fingerprint of what a request asks for. A key replayed with a different
 * fingerprint is a client bug and is rejected instead of silently replayed.
 */
export function requestFingerprint(operation: string, payload: Record<string, string>): string {
  const canonical = JSON.stringify(
    [operation, ...Object.keys(payload).sort()].map((k, i) => (i === 0 ? k : [k, payload[k]])),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
