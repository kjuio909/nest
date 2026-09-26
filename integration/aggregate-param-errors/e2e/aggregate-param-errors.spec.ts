import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  AggregateParamErrorsController,
  AllExceptionsFilter,
  MyParamFilter,
  NotFoundPipe,
  NumberPipe,
} from '../src/aggregate-param-errors.controller.js';
import { AggregateParamErrorsModule } from '../src/aggregate-param-errors.module.js';

describe('AggregateParamErrors (Express)', () => {
  let server: any;
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AggregateParamErrorsModule],
    }).compile();

    app = moduleRef.createNestApplication();
    server = app.getHttpServer();
    AggregateParamErrorsController.reset();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const handlerCalls = (name: string) =>
    AggregateParamErrorsController.handlerCalls[name] ?? 0;

  describe('when every parameter is valid', () => {
    it('runs the handler with the transformed parameters', () => {
      return request(server).get('/p/7?limit=10').expect(200, '7,10');
    });
  });

  describe('when a single @Param/@Query pipe fails', () => {
    it('responds with the aggregated 400 body (single-element message)', () => {
      return request(server)
        .get('/p/7?limit=x')
        .expect(400)
        .expect({
          statusCode: 400,
          error: 'Bad Request',
          message: ['B'],
        });
    });
  });

  describe('when multiple @Param/@Query pipes fail', () => {
    it('skips the handler and responds with one 400 containing all messages in parameter order', () => {
      return request(server)
        .get('/p/abc?limit=x')
        .expect(400)
        .expect({
          statusCode: 400,
          error: 'Bad Request',
          message: ['A', 'B'],
        });
    });
  });

  describe('when a custom exception filter is applied', () => {
    it('the filter receives only the aggregated exception once and rewrites the response', async () => {
      const response = await request(server)
        .get('/p/filtered/abc?limit=x')
        .expect(422);

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

    it('reports the count of a single error consistently', () => {
      return request(server)
        .get('/p/filtered/7?limit=x')
        .expect(422)
        .expect({ code: 'PARAMS_INVALID', count: 1 });
    });

    it('hands non-request errors to the filter as the original exception', async () => {
      await request(server).get('/p/any/missing?limit=x').expect(404).expect({
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
    it('keeps the existing fail-fast path (string message, first failure)', () => {
      return request(server).get('/p/legacy/7?limit=x').expect(400).expect({
        statusCode: 400,
        error: 'Bad Request',
        message: 'B',
      });
    });
  });

  describe('when a @Param/@Query pipe throws a non-BadRequest exception', () => {
    it('propagates the original exception unchanged (existing path)', () => {
      return request(server)
        .get('/p/other/missing?limit=x')
        .expect(404)
        .expect({
          statusCode: 404,
          error: 'Not Found',
          message: 'NOT-FOUND',
        });
    });
  });

  describe('request isolation', () => {
    it('a failed request does not affect a subsequent valid request on the same route', async () => {
      await request(server)
        .get('/p/abc?limit=x')
        .expect(400)
        .expect({
          statusCode: 400,
          error: 'Bad Request',
          message: ['A', 'B'],
        });
      expect(handlerCalls('aggregated')).toBe(0);

      NumberPipe.calls = [];
      await request(server).get('/p/7?limit=10').expect(200, '7,10');

      // Every relevant pipe re-ran once, in declaration order, and the
      // handler ran exactly once with this request's transformed values.
      expect(NumberPipe.calls).toEqual(['A', 'B']);
      expect(handlerCalls('aggregated')).toBe(1);
    });

    it('a valid request does not affect a subsequent double-invalid request', async () => {
      await request(server).get('/p/7?limit=10').expect(200, '7,10');
      expect(handlerCalls('aggregated')).toBe(1);

      await request(server)
        .get('/p/abc?limit=x')
        .expect(400)
        .expect({
          statusCode: 400,
          error: 'Bad Request',
          message: ['A', 'B'],
        });
      expect(handlerCalls('aggregated')).toBe(1);
    });

    it('does not accumulate, duplicate or misplace messages across consecutive failures', async () => {
      for (let i = 0; i < 3; i++) {
        await request(server)
          .get('/p/abc?limit=x')
          .expect(400)
          .expect({
            statusCode: 400,
            error: 'Bad Request',
            message: ['A', 'B'],
          });
      }
      expect(handlerCalls('aggregated')).toBe(0);

      await request(server).get('/p/7?limit=x').expect(400).expect({
        statusCode: 400,
        error: 'Bad Request',
        message: ['B'],
      });
    });

    it('collected errors are not leaked into later requests after a non-BadRequest exception', async () => {
      await request(server)
        .get('/p/other/missing?limit=x')
        .expect(404)
        .expect({
          statusCode: 404,
          error: 'Not Found',
          message: 'NOT-FOUND',
        });
      expect(handlerCalls('other')).toBe(0);

      // The next request on the same route must only report its own errors.
      await request(server).get('/p/other/ok?limit=x').expect(400).expect({
        statusCode: 400,
        error: 'Bad Request',
        message: ['B'],
      });

      // And a valid request still reaches the handler exactly once.
      await request(server).get('/p/other/ok?limit=3').expect(200, 'ok,3');
      expect(handlerCalls('other')).toBe(1);
    });

    it('a failure on the unmarked route does not change the marked route behavior', async () => {
      await request(server).get('/p/legacy/abc?limit=x').expect(400);
      expect(handlerCalls('legacy')).toBe(0);

      await request(server).get('/p/7?limit=10').expect(200, '7,10');
      expect(handlerCalls('aggregated')).toBe(1);

      await request(server)
        .get('/p/abc?limit=x')
        .expect(400)
        .expect({
          statusCode: 400,
          error: 'Bad Request',
          message: ['A', 'B'],
        });
    });

    it('a failure on the marked route does not change the unmarked route behavior', async () => {
      await request(server).get('/p/abc?limit=x').expect(400);

      await request(server).get('/p/legacy/7?limit=x').expect(400).expect({
        statusCode: 400,
        error: 'Bad Request',
        message: 'B',
      });
      await request(server).get('/p/legacy/5?limit=6').expect(200, '5,6');
      expect(handlerCalls('legacy')).toBe(1);
    });

    it('keeps parallel valid and invalid requests fully independent', async () => {
      NumberPipe.calls = [];
      const [valid, invalid] = await Promise.all([
        request(server).get('/p/7?limit=10'),
        request(server).get('/p/abc?limit=x'),
      ]);

      expect(valid.status).toBe(200);
      expect(valid.text).toBe('7,10');
      expect(invalid.status).toBe(400);
      expect(invalid.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A', 'B'],
      });
      expect(handlerCalls('aggregated')).toBe(1);
      // Each request ran both pipes exactly once.
      expect(NumberPipe.calls.filter(c => c === 'A')).toHaveLength(2);
      expect(NumberPipe.calls.filter(c => c === 'B')).toHaveLength(2);
    });

    it('matches serial behavior when the same requests are sent sequentially', async () => {
      const valid = await request(server).get('/p/7?limit=10');
      const invalid = await request(server).get('/p/abc?limit=x');

      expect(valid.status).toBe(200);
      expect(valid.text).toBe('7,10');
      expect(invalid.status).toBe(400);
      expect(invalid.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A', 'B'],
      });
      expect(handlerCalls('aggregated')).toBe(1);
    });

    it('the filter only ever sees the final aggregated exception of its own request', async () => {
      await Promise.all([
        request(server).get('/p/filtered/abc?limit=x').expect(422),
        request(server).get('/p/filtered/7?limit=x').expect(422),
        request(server).get('/p/filtered/7?limit=10').expect(200, '7,10'),
      ]);

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

      await request(server).get('/p/other/missing?limit=x').expect(404);

      expect(NotFoundPipe.calls).toBe(1);
      // The query pipe never ran for the short-circuited request.
      expect(NumberPipe.calls).toEqual([]);
    });
  });
});
