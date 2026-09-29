import { createAggregateParamErrorsApp } from '../src/create-aggregate-param-errors-app.js';
import { registerEncodingSuite } from './encoding-suite.js';

registerEncodingSuite({
  platformName: 'Express',
  async createApp() {
    const harness = await createAggregateParamErrorsApp('express');
    return {
      request: harness.request,
      close: harness.close,
    };
  },
});
