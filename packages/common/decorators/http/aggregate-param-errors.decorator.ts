import { AGGREGATE_PARAM_ERRORS_METADATA } from '../../constants.js';

/**
 * Request method Decorator. Aggregates errors thrown by `@Param()` and
 * `@Query()` parameter pipes into a single {@link BadRequestException}.
 *
 * By default, parameter pipes run concurrently and the first thrown error is
 * propagated immediately. When `@AggregateParamErrors()` is present, the
 * `@Param()` and `@Query()` pipes of the handler run serially in parameter
 * position order. Every thrown {@link BadRequestException} is collected and
 * the handler is skipped if at least one pipe failed; instead a single
 * `BadRequestException` is thrown whose response `message` is an array of the
 * collected messages (single-error responses use the same shape):
 *
 * ```ts
 * @Get(':id')
 * @AggregateParamErrors()
 * findOne(
 *   @Param('id', ParseIntPipe) id: number,
 *   @Query('limit', ParseIntPipe) limit: number,
 * ) {
 *   return [id, limit];
 * }
 * ```
 *
 * A request of `GET /p/abc?limit=x` then produces:
 *
 * ```json
 * { "statusCode": 400, "error": "Bad Request", "message": ["A", "B"] }
 * ```
 *
 * The aggregated exception is the only exception that reaches the exception
 * filter chain, so method-scoped filters registered with `@UseFilters()` can
 * rewrite the status code or response body as usual. Methods without the
 * decorator keep the existing fail-fast behavior, and errors other than
 * `BadRequestException` propagate unchanged.
 *
 * @see [Pipes](https://docs.nestjs.com/pipes)
 *
 * @publicApi
 */
export function AggregateParamErrors(): MethodDecorator {
  return (
    target: object,
    key: string | symbol,
    descriptor: TypedPropertyDescriptor<any>,
  ) => {
    Reflect.defineMetadata(
      AGGREGATE_PARAM_ERRORS_METADATA,
      true,
      descriptor.value,
    );
    return descriptor;
  };
}
