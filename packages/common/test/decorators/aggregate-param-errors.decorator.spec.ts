import { AggregateParamErrors } from '../../decorators/http/aggregate-param-errors.decorator.js';
import { AGGREGATE_PARAM_ERRORS_METADATA } from '../../constants.js';

describe('@AggregateParamErrors', () => {
  class Test {
    @AggregateParamErrors()
    public static test() {}
  }

  it('should enhance method with the aggregate-param-errors metadata', () => {
    const metadata = Reflect.getMetadata(
      AGGREGATE_PARAM_ERRORS_METADATA,
      Test.test,
    );
    expect(metadata).toBe(true);
  });

  it('should not set metadata on methods without the decorator', () => {
    class Plain {
      public static test() {}
    }
    expect(
      Reflect.getMetadata(AGGREGATE_PARAM_ERRORS_METADATA, Plain.test),
    ).toBeUndefined();
  });
});
