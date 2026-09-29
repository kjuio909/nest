import { INestApplication } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  batchIdDecodingGuard,
  batchIdFrameworkErrors,
} from './batch-id-decoding.js';
import { AggregateParamErrorsModule } from './aggregate-param-errors.module.js';

export type AggregateParamErrorsAdapter = 'express' | 'fastify';

export interface AggregateParamErrorsRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

export interface AggregateParamErrorsResponse {
  status: number;
  body: any;
  text: string;
}

export interface AggregateParamErrorsApp {
  readonly app: INestApplication;
  request(
    method: 'GET' | 'POST',
    path: string,
    options?: AggregateParamErrorsRequestOptions,
  ): Promise<AggregateParamErrorsResponse>;
  get(
    path: string,
    options?: AggregateParamErrorsRequestOptions,
  ): Promise<AggregateParamErrorsResponse>;
  post(
    path: string,
    options?: AggregateParamErrorsRequestOptions,
  ): Promise<AggregateParamErrorsResponse>;
  close(): Promise<void>;
}

/**
 * The single public startup entry of the aggregate-param-errors integration
 * app. Boots the same module on top of either HTTP adapter and returns a
 * handle that can send HTTP requests (each response exposes its status and
 * JSON body) and shut the instance down again.
 */
export async function createAggregateParamErrorsApp(
  adapter: AggregateParamErrorsAdapter,
): Promise<AggregateParamErrorsApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AggregateParamErrorsModule],
  }).compile();

  if (adapter === 'fastify') {
    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        // Normalise a framework-level bad-URL rejection (malformed percent
        // sequence in the batch id segment) to the same plain 'ID' 400 the
        // Express adapter yields. Without this hook Fastify answers before
        // the request ever reaches Nest.
        frameworkErrors: batchIdFrameworkErrors,
      }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const send = async (
      method: 'GET' | 'POST',
      path: string,
      options?: AggregateParamErrorsRequestOptions,
    ): Promise<AggregateParamErrorsResponse> => {
      const response = await app.inject({
        method,
        url: path,
        headers: options?.headers,
        payload: options?.body as any,
      });
      let body: any;
      try {
        body = response.json();
      } catch {
        body = undefined;
      }
      return { status: response.statusCode, body, text: response.payload };
    };

    return {
      app,
      request: send,
      get: (path, options) => send('GET', path, options),
      post: (path, options) => send('POST', path, options),
      close: () => app.close(),
    };
  }

  const app = moduleRef.createNestApplication();
  // Mounted ahead of the routes (and Nest's exception layer): Express lazily
  // decodes path params while matching, so an undecodable batch id segment
  // would otherwise produce Express's own "Failed to decode param" 400 that
  // does not exist on Fastify. Answer with the canonical plain 'ID' 400.
  app.use(batchIdDecodingGuard);
  // Listen on an ephemeral port up front: supertest reuses an already
  // listening server instead of racing listen()/close() per request, which
  // keeps genuinely parallel requests on the same instance reliable.
  const server = await app.listen(0);

  const send = async (
    method: 'GET' | 'POST',
    path: string,
    options?: AggregateParamErrorsRequestOptions,
  ): Promise<AggregateParamErrorsResponse> => {
    let req = request(server)
      [method.toLowerCase() as 'get' | 'post'](path)
      .set(options?.headers ?? {});
    if (options?.body !== undefined) {
      req = req.send(options.body);
    }
    const response = await req;
    return {
      status: response.status,
      body: response.body,
      text: response.text,
    };
  };

  return {
    app,
    request: send,
    get: (path, options) => send('GET', path, options),
    post: (path, options) => send('POST', path, options),
    close: () => app.close(),
  };
}
