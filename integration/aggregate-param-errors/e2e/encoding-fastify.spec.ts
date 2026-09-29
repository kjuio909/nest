import { createAggregateParamErrorsApp } from '../src/create-aggregate-param-errors-app.js';
import { registerEncodingSuite } from './encoding-suite.js';

registerEncodingSuite({
  platformName: 'Fastify',
  async createApp() {
    const harness = await createAggregateParamErrorsApp('fastify');
    return {
      request: harness.request,
      close: harness.close,
    };
  },
});
