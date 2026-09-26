import { HttpStatus } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  AggregateParamErrorsController,
  AllExceptionsFilter,
  MyParamFilter,
  NotFoundPipe,
  NumberPipe,
} from '../src/aggregate-param-errors.controller.js';
import { AggregateParamErrorsModule } from '../src/aggregate-param-errors.module.js';

describe('AggregateParamErrors (Fastify)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AggregateParamErrorsModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    AggregateParamErrorsController.reset();
  });

  afterEach(async () => {
    await app.close();
  });

  const handlerCalls = (name: string) =>
    AggregateParamErrorsController.handlerCalls[name] ?? 0;

  describe('when every parameter is valid', () => {
    it('runs the handler with the transformed parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/p/7?limit=10',
      });
      expect(response.statusCode).toBe(HttpStatus.OK);
      expect(response.payload).toBe('7,10');
    });
  });

  describe('when a single @Param/@Query pipe fails', () => {
    it('responds with the aggregated 400 body (single-element message)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/p/7?limit=x',
      });
      expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(response.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['B'],
      });
    });
  });

  describe('when multiple @Param/@Query pipes fail', () => {
    it('skips the handler and responds with one 400 containing all messages in parameter order', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/p/abc?limit=x',
      });
      expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(response.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A', 'B'],
      });
    });
  });

  describe('when a custom exception filter is applied', () => {
    it('the filter receives only the aggregated exception once and rewrites the response', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/p/filtered/abc?limit=x',
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
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
      const response = await app.inject({
        method: 'GET',
        url: '/p/filtered/7?limit=x',
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        code: 'PARAMS_INVALID',
        count: 1,
      });
    });

    it('hands non-request errors to the filter as the original exception', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/p/any/missing?limit=x',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'NOT-FOUND',
      });
      expect(AllExceptionsFilter.received).toEqual([
        { status: 404, message: 'NOT-FOUND' },
      ]);
    });
  });

  describe('when the handler is not annotated with @AggregateParamErrors', () => {
    it('keeps the existing fail-fast path (string message, first failure)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/p/legacy/7?limit=x',
      });
      expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(response.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'B',
      });
    });
  });

  describe('when a @Param/@Query pipe throws a non-BadRequest exception', () => {
    it('propagates the original exception unchanged (existing path)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/p/other/missing?limit=x',
      });
      expect(response.statusCode).toBe(HttpStatus.NOT_FOUND);
      expect(response.json()).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'NOT-FOUND',
      });
    });
  });

  describe('request isolation', () => {
    it('a failed request does not affect a subsequent valid request on the same route', async () => {
      const failed = await app.inject({ method: 'GET', url: '/p/abc?limit=x' });
      expect(failed.statusCode).toBe(400);
      expect(failed.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A', 'B'],
      });
      expect(handlerCalls('aggregated')).toBe(0);

      NumberPipe.calls = [];
      const valid = await app.inject({ method: 'GET', url: '/p/7?limit=10' });
      expect(valid.statusCode).toBe(200);
      expect(valid.payload).toBe('7,10');
      expect(NumberPipe.calls).toEqual(['A', 'B']);
      expect(handlerCalls('aggregated')).toBe(1);
    });

    it('a valid request does not affect a subsequent double-invalid request', async () => {
      const valid = await app.inject({ method: 'GET', url: '/p/7?limit=10' });
      expect(valid.statusCode).toBe(200);
      expect(handlerCalls('aggregated')).toBe(1);

      const failed = await app.inject({ method: 'GET', url: '/p/abc?limit=x' });
      expect(failed.statusCode).toBe(400);
      expect(failed.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A', 'B'],
      });
      expect(handlerCalls('aggregated')).toBe(1);
    });

    it('does not accumulate, duplicate or misplace messages across consecutive failures', async () => {
      for (let i = 0; i < 3; i++) {
        const response = await app.inject({
          method: 'GET',
          url: '/p/abc?limit=x',
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ['A', 'B'],
        });
      }
      expect(handlerCalls('aggregated')).toBe(0);

      const single = await app.inject({ method: 'GET', url: '/p/7?limit=x' });
      expect(single.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['B'],
      });
    });

    it('collected errors are not leaked into later requests after a non-BadRequest exception', async () => {
      const notFound = await app.inject({
        method: 'GET',
        url: '/p/other/missing?limit=x',
      });
      expect(notFound.statusCode).toBe(404);
      expect(handlerCalls('other')).toBe(0);

      const failed = await app.inject({
        method: 'GET',
        url: '/p/other/ok?limit=x',
      });
      expect(failed.statusCode).toBe(400);
      expect(failed.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['B'],
      });

      const valid = await app.inject({
        method: 'GET',
        url: '/p/other/ok?limit=3',
      });
      expect(valid.statusCode).toBe(200);
      expect(valid.payload).toBe('ok,3');
      expect(handlerCalls('other')).toBe(1);
    });

    it('a failure on the unmarked route does not change the marked route behavior', async () => {
      const legacyFailed = await app.inject({
        method: 'GET',
        url: '/p/legacy/abc?limit=x',
      });
      expect(legacyFailed.statusCode).toBe(400);
      expect(handlerCalls('legacy')).toBe(0);

      const valid = await app.inject({ method: 'GET', url: '/p/7?limit=10' });
      expect(valid.statusCode).toBe(200);
      expect(valid.payload).toBe('7,10');
      expect(handlerCalls('aggregated')).toBe(1);
    });

    it('a failure on the marked route does not change the unmarked route behavior', async () => {
      await app.inject({ method: 'GET', url: '/p/abc?limit=x' });

      const legacyFailed = await app.inject({
        method: 'GET',
        url: '/p/legacy/7?limit=x',
      });
      expect(legacyFailed.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'B',
      });
      const legacyValid = await app.inject({
        method: 'GET',
        url: '/p/legacy/5?limit=6',
      });
      expect(legacyValid.payload).toBe('5,6');
      expect(handlerCalls('legacy')).toBe(1);
    });

    it('keeps parallel valid and invalid requests fully independent', async () => {
      NumberPipe.calls = [];
      const [valid, invalid] = await Promise.all([
        app.inject({ method: 'GET', url: '/p/7?limit=10' }),
        app.inject({ method: 'GET', url: '/p/abc?limit=x' }),
      ]);

      expect(valid.statusCode).toBe(200);
      expect(valid.payload).toBe('7,10');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A', 'B'],
      });
      expect(handlerCalls('aggregated')).toBe(1);
      expect(NumberPipe.calls.filter(c => c === 'A')).toHaveLength(2);
      expect(NumberPipe.calls.filter(c => c === 'B')).toHaveLength(2);
    });

    it('the filter only ever sees the final aggregated exception of its own request', async () => {
      const [double, single, valid] = await Promise.all([
        app.inject({ method: 'GET', url: '/p/filtered/abc?limit=x' }),
        app.inject({ method: 'GET', url: '/p/filtered/7?limit=x' }),
        app.inject({ method: 'GET', url: '/p/filtered/7?limit=10' }),
      ]);

      expect(double.statusCode).toBe(422);
      expect(double.json()).toEqual({ code: 'PARAMS_INVALID', count: 2 });
      expect(single.statusCode).toBe(422);
      expect(single.json()).toEqual({ code: 'PARAMS_INVALID', count: 1 });
      expect(valid.statusCode).toBe(200);

      expect(MyParamFilter.received).toHaveLength(2);
      expect(MyParamFilter.received).toContainEqual({
        status: 400,
        message: ['A', 'B'],
      });
      expect(MyParamFilter.received).toContainEqual({
        status: 400,
        message: ['B'],
      });
      expect(handlerCalls('filtered')).toBe(1);
    });

    it('does not invoke the @Query pipe of a request when a non-BadRequest exception short-circuits it', async () => {
      NumberPipe.calls = [];
      NotFoundPipe.calls = 0;

      await app.inject({ method: 'GET', url: '/p/other/missing?limit=x' });

      expect(NotFoundPipe.calls).toBe(1);
      expect(NumberPipe.calls).toEqual([]);
    });
  });
});
