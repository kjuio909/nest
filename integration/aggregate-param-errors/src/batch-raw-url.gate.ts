import { HttpStatus } from '@nestjs/common';

// Matches the single-segment :id slot of the two batch routes. The raw,
// still-encoded pathname is matched on purpose: the segment is inspected
// before the HTTP adapter performs its own percent-decoding.
const BATCH_ID_PATH_PATTERN = /^\/batch(?:-plain)?\/([^/]+)\/?$/;

export type BatchRawPathInspection =
  'unrelated' | 'valid-encoding' | 'invalid-id-encoding';

/**
 * Inspects the raw request URL (pathname + query, as received over the wire)
 * and reports whether the `:id` segment of a batch route carries a percent
 * sequence that the HTTP adapter would reject *before* Nest routing runs.
 *
 * Express answers such a segment with its own `Failed to decode param` 400 and
 * Fastify with `FST_ERR_BAD_URL`, so the BatchIdGuard would never run and the
 * two adapters would answer the same request with different bodies. Decoding
 * the segment exactly once here lets both adapters funnel the request into
 * the regular invalid-id response. The URL itself is never rewritten, so a
 * request that passes this inspection is still decoded exactly once by the
 * framework afterwards (no double decoding).
 */
export function inspectBatchRawUrl(
  rawUrl: string | undefined,
): BatchRawPathInspection {
  if (typeof rawUrl !== 'string') {
    return 'unrelated';
  }
  const queryIndex = rawUrl.indexOf('?');
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const match = BATCH_ID_PATH_PATTERN.exec(pathname);
  if (!match) {
    return 'unrelated';
  }
  try {
    decodeURIComponent(match[1]);
  } catch {
    return 'invalid-id-encoding';
  }
  return 'valid-encoding';
}

/**
 * The canonical invalid-batch-id body, shared by the guard and the raw-URL
 * gates so an undecodable segment answers identically on both adapters.
 */
export function createInvalidBatchIdBody() {
  return {
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    message: 'ID',
  };
}
