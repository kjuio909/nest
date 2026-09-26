import { createAggregateParamErrorsApp } from '../src/create-aggregate-param-errors-app.js';
import { registerIsolationSuite } from './isolation-suite.js';

registerIsolationSuite({
  platformName: 'Express',
  async createApp() {
    const harness = await createAggregateParamErrorsApp('express');
    return {
      app: harness.app,
      request: harness.request,
      close: harness.close,
    };
  },
});
