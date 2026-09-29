import { HttpStatus, INestApplication } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  createInvalidBatchIdBody,
  inspectBatchRawUrl,
} from './batch-raw-url.gate.js';
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
        // Malformed percent-sequences in the :id segment never reach Nest
        // routing: find-my-way aborts the lookup first. Normalize the batch
        // routes to the same canonical invalid-id body as Express; every other
        // framework error keeps Fastify's default response verbatim.
        frameworkErrors: (
          error: FastifyError,
          frameworkRequest: FastifyRequest,
          reply: FastifyReply,
        ) => {
          if (
            error.code === 'FST_ERR_BAD_URL' &&
            inspectBatchRawUrl(
              frameworkRequest.url ?? frameworkRequest.raw?.url,
            ) === 'invalid-id-encoding'
          ) {
            reply.code(HttpStatus.BAD_REQUEST).send(createInvalidBatchIdBody());
            return;
          }
          const isAsyncConstraint = error.code === 'FST_ERR_ASYNC_CONSTRAINT';
          const status = isAsyncConstraint
            ? HttpStatus.INTERNAL_SERVER_ERROR
            : error.code === 'FST_ERR_MAX_PARAM_LENGTH'
              ? HttpStatus.URI_TOO_LONG
              : HttpStatus.BAD_REQUEST;
          reply.code(status).send({
            error: isAsyncConstraint ? 'Internal Server Error' : 'Bad Request',
            ...(error.code ? { code: error.code } : {}),
            message: error.message,
            statusCode: status,
          });
        },
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

  // Malformed percent-sequences in the :id segment fail inside Express'
  // path-matching decode before any Nest guard runs, producing Express' own
  // 'Failed to decode param' body instead of the canonical invalid-id one.
  // Registered before the Nest router, this middleware answers those batch
  // requests with the same body Fastify emits via frameworkErrors; every
  // other request passes through untouched and is still decoded exactly once.
  app
    .getHttpAdapter()
    .getInstance()
    .use((req: { url?: string }, res: any, next: () => void) => {
      if (inspectBatchRawUrl(req.url) === 'invalid-id-encoding') {
        res.status(HttpStatus.BAD_REQUEST).json(createInvalidBatchIdBody());
        return;
      }
      next();
    });

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
