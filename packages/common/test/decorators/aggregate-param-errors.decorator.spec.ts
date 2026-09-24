import { AGGREGATE_PARAM_ERRORS_METADATA } from '../../constants.js';
import { AggregateParamErrors } from '../../decorators/http/aggregate-param-errors.decorator.js';

describe('@AggregateParamErrors', () => {
  class Test {
    @AggregateParamErrors()
    public static test() {}

    public static withoutDecorator() {}
  }

  it('should mark the method with the aggregate-param-errors metadata', () => {
    const metadata = Reflect.getMetadata(
      AGGREGATE_PARAM_ERRORS_METADATA,
      Test.test,
    );
    expect(metadata).toBe(true);
  });

  it('should not set metadata on methods without the decorator', () => {
    const metadata = Reflect.getMetadata(
      AGGREGATE_PARAM_ERRORS_METADATA,
      Test.withoutDecorator,
    );
    expect(metadata).toBeUndefined();
  });
});
