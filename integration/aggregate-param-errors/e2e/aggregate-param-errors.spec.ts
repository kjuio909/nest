import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MyParamFilter } from '../src/aggregate-param-errors.controller.js';
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
    MyParamFilter.received = [];
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

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

  describe('when a @Headers() parameter is present', () => {
    it('runs the header pipe and hands all transformed values to the handler', () => {
      return request(server)
        .get('/p/headers/7?limit=10')
        .set('x-token', '5')
        .expect(200, '7,5,10');
    });

    it('responds with only the aggregated messages when the header is valid', () => {
      return request(server)
        .get('/p/headers/abc?limit=x')
        .set('x-token', '5')
        .expect(400)
        .expect({
          statusCode: 400,
          error: 'Bad Request',
          message: ['A', 'B'],
        });
    });

    it('aborts with only the header exception on a mixed failure', () => {
      return request(server)
        .get('/p/headers/abc?limit=x')
        .set('x-token', 'bad')
        .expect(400)
        .expect({
          statusCode: 400,
          error: 'Bad Request',
          message: 'H',
        });
    });
  });
});
