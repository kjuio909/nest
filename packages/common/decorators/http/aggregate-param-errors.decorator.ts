import { AGGREGATE_PARAM_ERRORS_METADATA } from '../../constants.js';

/**
 * Request method Decorator. Aggregates validation errors thrown by the pipes
 * bound to `@Param()` and `@Query()` parameters.
 *
 * When a handler is annotated with `@AggregateParamErrors()`, the `@Param()`
 * and `@Query()` parameter pipes are executed serially in parameter-index
 * order instead of concurrently. If one or more of those pipes reject, the
 * handler is skipped and a single {@link BadRequestException} is thrown whose
 * `message` is the array of the collected error messages (ordered by parameter
 * position). With a single error the response has the same shape as the
 * default validation error (`message` is a one-element array).
 *
 * Pipes bound to `@Headers()` parameters always run (their transformed
 * values are passed to the handler alongside the `@Param()`/`@Query()`
 * values), but they form an independent input domain: a header pipe failure
 * aborts the parameter resolution immediately, any `@Param()`/`@Query()`
 * messages collected so far are discarded, and exception filters only
 * observe the header exception.
 *
 * Pipes bound to other parameter decorators (`@Body()`, custom decorators,
 * ...) and handlers without this decorator keep following the existing
 * execution path.
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
