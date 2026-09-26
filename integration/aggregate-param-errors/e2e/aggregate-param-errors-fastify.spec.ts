import { HttpStatus } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MyParamFilter } from '../src/aggregate-param-errors.controller.js';
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
    MyParamFilter.received = [];
  });

  afterEach(async () => {
    await app.close();
  });

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

  describe('when a @Headers() parameter is present', () => {
    it('runs the header pipe and hands all transformed values to the handler', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/p/headers/7?limit=10',
        headers: { 'x-token': '5' },
      });
      expect(response.statusCode).toBe(HttpStatus.OK);
      expect(response.payload).toBe('7,5,10');
    });

    it('responds with only the aggregated messages when the header is valid', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/p/headers/abc?limit=x',
        headers: { 'x-token': '5' },
      });
      expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(response.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A', 'B'],
      });
    });

    it('aborts with only the header exception on a mixed failure', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/p/headers/abc?limit=x',
        headers: { 'x-token': 'bad' },
      });
      expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(response.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'H',
      });
    });
  });
});
