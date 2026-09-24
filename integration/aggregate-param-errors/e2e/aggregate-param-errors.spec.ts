import { HttpStatus, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AggregateParamErrorsModule } from '../src/aggregate-param-errors.module.js';

describe('AggregateParamErrors (Express)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [AggregateParamErrorsModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('runs the handler with transformed arguments when every pipe passes', () => {
    return request(app.getHttpServer())
      .get('/p/7?limit=10')
      .expect(HttpStatus.OK)
      .expect('7,10');
  });

  it('returns the aggregated errors when multiple pipes fail', () => {
    return request(app.getHttpServer())
      .get('/p/abc?limit=x')
      .expect(HttpStatus.BAD_REQUEST)
      .expect({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A', 'B'],
      });
  });

  it('uses the same shape when a single pipe fails', () => {
    return request(app.getHttpServer())
      .get('/p/abc?limit=10')
      .expect(HttpStatus.BAD_REQUEST)
      .expect({
        statusCode: 400,
        error: 'Bad Request',
        message: ['A'],
      });
  });

  it('lets a method-scoped filter rewrite the aggregated error', async () => {
    const response = await request(app.getHttpServer())
      .get('/p/filtered/abc?limit=x')
      .expect(422);

    expect(response.body).toEqual({
      code: 'PARAMS_INVALID',
      count: 2,
    });
  });

  it('keeps the fail-fast behavior without the decorator (single error)', () => {
    return request(app.getHttpServer())
      .get('/p/legacy/abc?limit=10')
      .expect(HttpStatus.BAD_REQUEST)
      .expect({
        statusCode: 400,
        error: 'Bad Request',
        message: 'A',
      });
  });

  it('does not aggregate when multiple pipes fail without the decorator', async () => {
    const response = await request(app.getHttpServer())
      .get('/p/legacy/abc?limit=x')
      .expect(HttpStatus.BAD_REQUEST);

    // The existing path fails fast with one exception; the message is never
    // the aggregated array shape.
    expect(typeof response.body.message).toBe('string');
    expect(['A', 'B']).toContain(response.body.message);
  });
});
