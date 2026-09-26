import { INestApplication } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AggregateParamErrorsModule } from './aggregate-param-errors.module.js';

export type AggregateParamErrorsAdapter = 'express' | 'fastify';

export interface AggregateParamErrorsResponse {
  /** HTTP status code of this single request. */
  status: number;
  /**
   * Parsed JSON body. Falls back to the raw text when the response is not
   * JSON, and stays `undefined` for an empty body.
   */
  body: any;
}

export interface AggregateParamErrorsApp {
  /**
   * Sends one HTTP request to the running instance. Each call is independent:
   * the response only reflects its own input, including when requests are
   * interleaved or fired in parallel.
   */
  request(path: string): Promise<AggregateParamErrorsResponse>;
  /** Stops the underlying HTTP server and releases the ephemeral port. */
  close(): Promise<void>;
}

/**
 * The only public bootstrap entry point for the aggregated parameter-errors
 * fixture. It builds the same module for Express and Fastify, listens on an
 * ephemeral port and returns a thin request client plus a shutdown hook.
 */
export async function createAggregateParamErrorsApp(
  adapter: AggregateParamErrorsAdapter,
): Promise<AggregateParamErrorsApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AggregateParamErrorsModule],
  }).compile();

  const app: INestApplication =
    adapter === 'fastify'
      ? moduleRef.createNestApplication<NestFastifyApplication>(
          new FastifyAdapter(),
        )
      : moduleRef.createNestApplication();

  await app.init();
  await app.listen(0);
  const baseUrl = await app.getUrl();

  return {
    async request(path: string): Promise<AggregateParamErrorsResponse> {
      const response = await fetch(new URL(path, baseUrl));
      const text = await response.text();
      let body: unknown;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: response.status, body };
    },
    close: () => app.close(),
  };
}
