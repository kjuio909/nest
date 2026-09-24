import { HttpStatus } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AggregateParamErrorsModule } from '../src/aggregate-param-errors.module.js';

describe('AggregateParamErrors (Fastify)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [AggregateParamErrorsModule],
    }).compile();

    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('runs the handler with transformed arguments when every pipe passes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/p/7?limit=10',
    });

    expect(response.statusCode).toBe(HttpStatus.OK);
    expect(response.payload).toBe('7,10');
  });

  it('returns the aggregated errors when multiple pipes fail', async () => {
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

  it('uses the same shape when a single pipe fails', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/p/abc?limit=10',
    });

    expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(response.json()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: ['A'],
    });
  });

  it('lets a method-scoped filter rewrite the aggregated error', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/p/filtered/abc?limit=x',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      code: 'PARAMS_INVALID',
      count: 2,
    });
  });

  it('keeps the fail-fast behavior without the decorator (single error)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/p/legacy/abc?limit=10',
    });

    expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(response.json()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'A',
    });
  });

  it('does not aggregate when multiple pipes fail without the decorator', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/p/legacy/abc?limit=x',
    });

    // The existing path fails fast with one exception; the message is never
    // the aggregated array shape.
    const body = response.json();
    expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(typeof body.message).toBe('string');
    expect(['A', 'B']).toContain(body.message);
  });
});
