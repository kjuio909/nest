import { createAggregateParamErrorsApp } from '../src/create-aggregate-param-errors-app.js';
import { MyParamFilter } from '../src/aggregate-param-errors.controller.js';

describe('AggregateParamErrors (Fastify)', () => {
  let request: Awaited<
    ReturnType<typeof createAggregateParamErrorsApp>
  >['request'];
  let close: () => Promise<void>;

  beforeEach(async () => {
    const harness = await createAggregateParamErrorsApp('fastify');
    request = harness.request;
    close = harness.close;
    MyParamFilter.received = [];
  });

  afterEach(async () => {
    await close();
  });

  describe('when every parameter is valid', () => {
    it('runs the handler with the transformed parameters', async () => {
      const response = await request('GET', '/p/7?limit=10');
      expect(response.status).toBe(200);
      expect(response.text).toBe('7,10');
    });
  });

  describe('when a single @Param/@Query pipe fails', () => {
    it('responds with the aggregated 400 body (single-element message)', async () => {
      const response = await request('GET', '/p/7?limit=x');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['B'],
      });
    });
  });

  describe('when multiple @Param/@Query pipes fail', () => {
    it('skips the handler and responds with one 400 containing all messages in parameter order', async () => {
      const response = await request('GET', '/p/abc?limit=x');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A', 'B'],
      });
    });
  });

  describe('when a custom exception filter is applied', () => {
    it('the filter receives only the aggregated exception once and rewrites the response', async () => {
      const response = await request('GET', '/p/filtered/abc?limit=x');
      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        code: 'PARAMS_INVALID',
        count: 2,
      });
      expect(MyParamFilter.received).toHaveLength(1);
      expect(MyParamFilter.received[0]).toEqual({
        status: 400,
        message: ['A', 'B'],
      });
    });

    it('reports the count of a single error consistently', async () => {
      const response = await request('GET', '/p/filtered/7?limit=x');
      expect(response.status).toBe(422);
      expect(response.body).toEqual({ code: 'PARAMS_INVALID', count: 1 });
    });
  });

  describe('when the handler is not annotated with @AggregateParamErrors', () => {
    it('keeps the existing fail-fast path (string message, first failure)', async () => {
      const response = await request('GET', '/p/legacy/7?limit=x');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'B',
      });
    });
  });

  describe('when a @Param/@Query pipe throws a non-BadRequest exception', () => {
    it('propagates the original exception unchanged (existing path)', async () => {
      const response = await request('GET', '/p/other/missing?limit=x');
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'NOT-FOUND',
      });
    });
  });

  describe('when a @Headers() parameter is present', () => {
    it('runs the header pipe and hands all transformed values to the handler', async () => {
      const response = await request('GET', '/p/headers/7?limit=10', {
        headers: { 'x-token': '5' },
      });
      expect(response.status).toBe(200);
      expect(response.text).toBe('7,5,10');
    });

    it('responds with only the aggregated messages when the header is valid', async () => {
      const response = await request('GET', '/p/headers/abc?limit=x', {
        headers: { 'x-token': '5' },
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A', 'B'],
      });
    });

    it('aborts with only the header exception on a mixed failure', async () => {
      const response = await request('GET', '/p/headers/abc?limit=x', {
        headers: { 'x-token': 'bad' },
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'H',
      });
    });
  });

  describe('when an optional @Query() has a default value', () => {
    it('seeds the default and runs it through the same conversion chain', async () => {
      const response = await request('GET', '/p/defaults/7?currency=usd');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: 7,
        currency: 'USD',
        limit: 10,
      });
    });

    it('uses the explicit converted value when present', async () => {
      const response = await request(
        'GET',
        '/p/defaults/7?currency=usd&limit=3',
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ id: 7, currency: 'USD', limit: 3 });
    });

    it('does not fall back to the default when the explicit value is invalid', async () => {
      const response = await request(
        'GET',
        '/p/defaults/7?currency=usd&limit=x',
      );
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['LIMIT'],
      });
    });

    it('reports a missing required currency as a one-element aggregated error', async () => {
      const response = await request('GET', '/p/defaults/7');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['CURRENCY'],
      });
    });

    it('reports a blank required currency even when the optional limit defaults', async () => {
      const response = await request('GET', '/p/defaults/7?currency=');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['CURRENCY'],
      });
    });

    it('aggregates currency and limit failures in declaration order', async () => {
      const response = await request('GET', '/p/defaults/7?currency=&limit=x');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['CURRENCY', 'LIMIT'],
      });
    });

    it('aggregates param, currency and limit failures in declaration order', async () => {
      const response = await request(
        'GET',
        '/p/defaults/abc?currency=&limit=x',
      );
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A', 'CURRENCY', 'LIMIT'],
      });
    });
  });
});
