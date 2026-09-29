import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Canonical body for an invalid batch id. It mirrors
 * {@link InvalidBatchIdException}'s plain single-message 400 exactly (same
 * key order), so both adapters - and both batch routes - serialise an
 * undecodable id segment identically.
 */
export const INVALID_BATCH_ID_BODY = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'ID',
} as const;

// The two batch routes are '/batch/:id' and '/batch-plain/:id', each with a
// single (raw, still percent-encoded) path segment. Capturing that segment
// lets us apply the same single percent-decoding step the HTTP layer would.
// The pattern is anchored to the full pathname (no trailing segments), so a
// malformed percent sequence on a URL that cannot match either route is
// left to the framework's regular not-found/bad-URL handling.
const BATCH_ID_SEGMENT_REGEXP = /^\/batch(?:-plain)?\/([^/?#]+)$/;

/**
 * Returns the raw (percent-encoded) id segment of a batch route URL, or
 * `undefined` when the request does not target one of the batch routes.
 */
export function rawBatchIdSegment(
  rawUrl: string | undefined,
): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  const questionIndex = rawUrl.indexOf('?');
  const pathname =
    questionIndex === -1 ? rawUrl : rawUrl.slice(0, questionIndex);
  return BATCH_ID_SEGMENT_REGEXP.exec(pathname)?.[1];
}

/**
 * Applies the one percent-decoding step the HTTP layer would apply to a
 * path segment, returning the decoded value or `null` when the segment is
 * not a valid percent-encoding (malformed sequence, dangling '%', or bytes
 * that are not legal UTF-8). `decodeURIComponent` throws `URIError` for all
 * of those cases, which is the exact boundary Express's router uses.
 */
function decodePathSegmentOnce(rawSegment: string): string | null {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
}

/**
 * Express middleware mounted ahead of the routes. Express decodes path
 * params lazily while matching a route: a malformed percent sequence (e.g.
 * '/batch/%zz') makes the router's `decodeParam` throw a URIError (its own
 * 400 "Failed to decode param ..." body) before any guard or pipe can run.
 * Detect that situation from the raw URL and answer with the same plain
 * 'ID' 400 a decodable-but-non-numeric id produces, so the two adapters
 * cannot be told apart. Every other request proceeds untouched.
 */
export function batchIdDecodingGuard(
  req: { url?: string },
  res: {
    status(code: number): { json(body: unknown): void };
  },
  next: (err?: unknown) => void,
): void {
  const rawSegment = rawBatchIdSegment(req.url);
  if (rawSegment !== undefined && decodePathSegmentOnce(rawSegment) === null) {
    res.status(400).json(INVALID_BATCH_ID_BODY);
    return;
  }
  next();
}

/**
 * Fastify (via find-my-way) rejects a request whose *path* contains a
 * malformed percent sequence before routing even starts, answering with a
 * framework-level `FST_ERR_BAD_URL` that never reaches Nest. Translate that
 * framework error for the batch routes into the same plain 'ID' 400 Express
 * yields; every other bad URL keeps Fastify's default rendering.
 */
export function batchIdFrameworkErrors(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | void {
  if (
    error.code === 'FST_ERR_BAD_URL' &&
    rawBatchIdSegment(request.raw.url) !== undefined
  ) {
    return reply.code(400).send(INVALID_BATCH_ID_BODY);
  }
  return reply.send(error);
}
