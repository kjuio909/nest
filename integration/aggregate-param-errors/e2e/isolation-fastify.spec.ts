import { createAggregateParamErrorsApp } from '../src/create-aggregate-param-errors-app.js';
import { registerIsolationSuite } from './isolation-suite.js';

registerIsolationSuite({
  platformName: 'Fastify',
  async createApp() {
    const harness = await createAggregateParamErrorsApp('fastify');
    return {
      app: harness.app,
      request: harness.request,
      close: harness.close,
    };
  },
});
