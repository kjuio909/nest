import { INestApplication } from '@nestjs/common';
import {
  isolationState,
  MyParamFilter,
  MyWideFilter,
  resetIsolationState,
} from '../src/aggregate-param-errors.controller.js';

export interface IsolationResponse {
  status: number;
  body: any;
  text: string;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

export interface IsolationSuiteDeps {
  readonly platformName: string;
  createApp(): Promise<{
    app: INestApplication;
    request: (
      method: 'GET' | 'POST',
      path: string,
      options?: RequestOptions,
    ) => Promise<IsolationResponse>;
    close: () => Promise<void>;
  }>;
}

/**
 * Sequences, failure boundaries and parallel-execution assertions shared
 * verbatim by the Express and Fastify adapters: both platforms must expose
 * exactly the same per-request isolation behaviour.
 */
export function registerIsolationSuite(deps: IsolationSuiteDeps): void {
  type SendRequest = (
    method: 'GET' | 'POST',
    path: string,
    options?: RequestOptions,
  ) => Promise<IsolationResponse>;
  let request: SendRequest;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const harness = await deps.createApp();
    request = harness.request;
    close = harness.close;
    resetIsolationState();
  });

  afterEach(async () => {
    await close();
  });

  describe(`[${deps.platformName}] per-request isolation`, () => {
    describe('sequential requests on an annotated route', () => {
      it('re-runs every pipe on a valid request after a double-error and calls the handler once with transformed values', async () => {
        const failed = await request('GET', '/p/abc?limit=x');
        expect(failed.status).toBe(400);
        expect(failed.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ['A', 'B'],
        });
        expect(isolationState.handlerCalls.aggregated ?? 0).toBe(0);
        expect(isolationState.pipeCalls).toEqual(['A', 'B']);

        const ok = await request('GET', '/p/7?limit=10');
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('7,10');
        // Both pipes of the second request ran again, in declaration order.
        expect(isolationState.pipeCalls).toEqual(['A', 'B', 'A', 'B']);
        expect(isolationState.handlerCalls.aggregated).toBe(1);
      });

      it("reports only this request's messages on a double-error after a valid request (reverse order)", async () => {
        const ok = await request('GET', '/p/7?limit=10');
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('7,10');
        expect(isolationState.handlerCalls.aggregated).toBe(1);

        const failed = await request('GET', '/p/abc?limit=x');
        expect(failed.status).toBe(400);
        expect(failed.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ['A', 'B'],
        });
        // The handler ran only for the valid request; the message array was
        // not carried over from (or duplicated by) the first request.
        expect(isolationState.handlerCalls.aggregated).toBe(1);
      });

      it('keeps every failing response independent across consecutive failures (no accumulation, no misplacement)', async () => {
        const both = await request('GET', '/p/abc?limit=x');
        expect(both.body.message).toEqual(['A', 'B']);

        const queryOnly = await request('GET', '/p/7?limit=x');
        expect(queryOnly.body.message).toEqual(['B']);

        const paramOnly = await request('GET', '/p/abc?limit=10');
        expect(paramOnly.body.message).toEqual(['A']);

        const bothAgain = await request('GET', '/p/abc?limit=x');
        expect(bothAgain.body.message).toEqual(['A', 'B']);

        expect(isolationState.handlerCalls.aggregated ?? 0).toBe(0);
        // Every request executed both pipes; nothing was cached or skipped.
        expect(isolationState.pipeCalls).toEqual([
          'A',
          'B',
          'A',
          'B',
          'A',
          'B',
          'A',
          'B',
        ]);
      });
    });

    describe('non-BadRequest failure boundary', () => {
      it('aborts immediately with the original error and a following valid request stays clean', async () => {
        const aborted = await request('GET', '/p/partial/abc/abort?limit=x');
        expect(aborted.status).toBe(403);
        expect(aborted.body).toEqual({
          statusCode: 403,
          error: 'Forbidden',
          message: 'ABORTED',
        });
        expect(isolationState.handlerCalls.partial ?? 0).toBe(0);
        // Processing stopped at the aborting parameter: the trailing @Query()
        // pipe never ran.
        expect(isolationState.pipeCalls).toEqual(['A', 'M']);

        const ok = await request('GET', '/p/partial/7/ok?limit=10');
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('7,ok,10');
        // The 'A' collected by the aborted request did not leak into this one.
        expect(isolationState.pipeCalls).toEqual(['A', 'M', 'A', 'M', 'B']);
        expect(isolationState.handlerCalls.partial).toBe(1);
      });
    });

    describe('interaction with an unannotated route', () => {
      it('does not let a fail-fast failure change the annotated route behaviour', async () => {
        const legacyFailed = await request('GET', '/p/legacy/7?limit=x');
        expect(legacyFailed.status).toBe(400);
        expect(legacyFailed.body.message).toBe('B');

        const ok = await request('GET', '/p/7?limit=10');
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('7,10');
        expect(isolationState.handlerCalls.aggregated).toBe(1);
      });

      it('keeps the unannotated route fail-fast after the annotated route failed', async () => {
        const aggregatedFailed = await request('GET', '/p/abc?limit=x');
        expect(aggregatedFailed.body.message).toEqual(['A', 'B']);

        const legacyFailed = await request('GET', '/p/legacy/7?limit=x');
        expect(legacyFailed.status).toBe(400);
        expect(legacyFailed.body.message).toBe('B');
        expect(isolationState.handlerCalls.legacy ?? 0).toBe(0);
      });
    });

    describe('@Headers() input domain', () => {
      it('hands the transformed header value to the handler together with the param/query values', async () => {
        const ok = await request('GET', '/p/headers/7?limit=10', {
          headers: { 'x-token': 'valid' },
        });
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('7,10,token:valid');
        // All three pipes ran once, in parameter-index order.
        expect(isolationState.pipeCalls).toEqual(['A', 'B', 'H']);
        expect(isolationState.handlerCalls.headers).toBe(1);
      });

      it('responds with only the aggregated param/query messages when the header is valid', async () => {
        const failed = await request('GET', '/p/headers/abc?limit=x', {
          headers: { 'x-token': 'valid' },
        });
        expect(failed.status).toBe(400);
        expect(failed.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ['A', 'B'],
        });
        expect(isolationState.handlerCalls.headers ?? 0).toBe(0);
      });

      it('aborts with only the header exception on a mixed failure, discarding the collected param/query errors', async () => {
        const failed = await request('GET', '/p/headers/abc?limit=x', {
          headers: { 'x-token': 'wrong' },
        });
        expect(failed.status).toBe(400);
        expect(failed.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: 'H',
        });
        expect(isolationState.handlerCalls.headers ?? 0).toBe(0);
        // The header parameter sits last by index: every pipe ran, but the
        // collected 'A'/'B' messages died with the header failure.
        expect(isolationState.pipeCalls).toEqual(['A', 'B', 'H']);
      });

      it('keeps a header failure isolated from the following valid request', async () => {
        const failed = await request('GET', '/p/headers/abc?limit=x', {
          headers: { 'x-token': 'wrong' },
        });
        expect(failed.body.message).toBe('H');

        const ok = await request('GET', '/p/headers/7?limit=10', {
          headers: { 'x-token': 'valid' },
        });
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('7,10,token:valid');
        expect(isolationState.pipeCalls).toEqual([
          'A',
          'B',
          'H',
          'A',
          'B',
          'H',
        ]);
        expect(isolationState.handlerCalls.headers).toBe(1);
      });

      it('lets the method filter observe only the header exception on a mixed failure', async () => {
        const failed = await request('GET', '/p/headers-filtered/abc?limit=x', {
          headers: { 'x-token': 'wrong' },
        });
        expect(failed.status).toBe(422);
        expect(failed.body).toEqual({ code: 'PARAMS_INVALID', count: 1 });
        expect(MyParamFilter.received).toHaveLength(1);
        expect(MyParamFilter.received[0]).toEqual({
          status: 400,
          message: 'H',
        });
      });

      it('lets the method filter observe the aggregated exception when only param/query fail', async () => {
        const failed = await request('GET', '/p/headers-filtered/abc?limit=x', {
          headers: { 'x-token': 'valid' },
        });
        expect(failed.status).toBe(422);
        expect(failed.body).toEqual({ code: 'PARAMS_INVALID', count: 2 });
        expect(MyParamFilter.received).toHaveLength(1);
        expect(MyParamFilter.received[0]).toEqual({
          status: 400,
          message: ['A', 'B'],
        });
      });

      it('does not execute header pipes on unannotated routes (legacy path unchanged)', async () => {
        const ok = await request('GET', '/p/headers-legacy/7', {
          headers: { 'x-token': 'wrong' },
        });
        // The header pipe never ran: the raw header value reaches the handler.
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('7,wrong');
        expect(isolationState.pipeCalls).toEqual(['A']);
        expect(isolationState.handlerCalls.headersLegacy).toBe(1);
      });
    });

    describe('@Body() and custom extractor scope', () => {
      it('does not aggregate a @Body() pipe error even when a @Param() failed first', async () => {
        const bodyFailure = await request('POST', '/p/body/abc?limit=x', {
          body: {},
        });
        expect(bodyFailure.status).toBe(400);
        expect(bodyFailure.body.message).toBe('BODY');
        expect(isolationState.handlerCalls.body ?? 0).toBe(0);
      });

      it('still aggregates the surrounding @Param()/@Query() errors when @Body() succeeds', async () => {
        const paramFailures = await request('POST', '/p/body/abc?limit=x', {
          body: { valid: true },
        });
        expect(paramFailures.status).toBe(400);
        expect(paramFailures.body.message).toEqual(['A', 'B']);
        expect(isolationState.handlerCalls.body ?? 0).toBe(0);
      });

      it('runs the handler with the transformed body when everything is valid', async () => {
        const ok = await request('POST', '/p/body/7?limit=10', {
          body: { valid: true },
        });
        // POST keeps the default 201 status; aggregation changes nothing here.
        expect(ok.status).toBe(201);
        expect(ok.text).toBe('7,10,transformed');
        expect(isolationState.handlerCalls.body).toBe(1);
      });

      it('keeps custom parameter extractors on the fail-fast path', async () => {
        const customFailure = await request('GET', '/p/custom/abc?limit=x');
        expect(customFailure.status).toBe(400);
        expect(customFailure.body.message).toBe('CUSTOM');

        const headerOk = await request('GET', '/p/custom/abc?limit=x', {
          headers: { 'x-user': 'alice' },
        });
        // Custom extractor succeeds, so only the param/query errors aggregate.
        expect(headerOk.status).toBe(400);
        expect(headerOk.body.message).toEqual(['A', 'B']);
        expect(isolationState.handlerCalls.custom ?? 0).toBe(0);
      });
    });

    describe('parallel requests', () => {
      it('keeps a concurrent valid and double-error request isolated regardless of completion order', async () => {
        const [valid, invalid] = await Promise.all([
          request('GET', '/p/slow/7?limit=10'),
          request('GET', '/p/slow/abc?limit=x'),
        ]);

        expect(valid.status).toBe(200);
        expect(valid.text).toBe('7,10');
        expect(invalid.status).toBe(400);
        expect(invalid.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ['A', 'B'],
        });

        // Each request executed its own two pipes exactly once.
        expect(
          isolationState.pipeCalls.filter(tag => tag === 'A'),
        ).toHaveLength(2);
        expect(
          isolationState.pipeCalls.filter(tag => tag === 'B'),
        ).toHaveLength(2);
        expect(isolationState.handlerCalls.slow).toBe(1);
      });

      it('keeps a concurrent header failure and a valid request isolated regardless of completion order', async () => {
        const [headerFailure, valid] = await Promise.all([
          request('GET', '/p/headers-slow/abc?limit=x', {
            headers: { 'x-token': 'wrong' },
          }),
          request('GET', '/p/headers-slow/7?limit=10', {
            headers: { 'x-token': 'valid' },
          }),
        ]);

        // The failing request surfaces only its own header exception; the
        // 'A'/'B' messages it collected were discarded, not shared.
        expect(headerFailure.status).toBe(400);
        expect(headerFailure.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: 'H',
        });
        expect(valid.status).toBe(200);
        expect(valid.text).toBe('7,10,token:valid');

        // Each request executed its own three pipes exactly once.
        for (const tag of ['A', 'B', 'H']) {
          expect(
            isolationState.pipeCalls.filter(call => call === tag),
          ).toHaveLength(2);
        }
        expect(isolationState.handlerCalls.headersSlow).toBe(1);
      });
    });

    describe('method-level exception filters', () => {
      it('sees the single aggregated exception once per request and rewrites the response', async () => {
        const both = await request('GET', '/p/filtered/abc?limit=x');
        expect(both.status).toBe(422);
        expect(both.body).toEqual({ code: 'PARAMS_INVALID', count: 2 });
        expect(MyParamFilter.received).toHaveLength(1);
        expect(MyParamFilter.received[0]).toEqual({
          status: 400,
          message: ['A', 'B'],
        });

        const queryOnly = await request('GET', '/p/filtered/7?limit=x');
        expect(queryOnly.status).toBe(422);
        expect(queryOnly.body).toEqual({ code: 'PARAMS_INVALID', count: 1 });
        expect(MyParamFilter.received).toHaveLength(2);
        expect(MyParamFilter.received[1]).toEqual({
          status: 400,
          message: ['B'],
        });
      });

      it('receives the original non-request exception unchanged', async () => {
        const response = await request('GET', '/p/wide/missing?limit=x');
        expect(response.status).toBe(418);
        expect(response.body).toEqual({ code: 'WIDE' });
        expect(MyWideFilter.last).toEqual({
          name: 'NotFoundException',
          status: 404,
        });
        expect(isolationState.handlerCalls.wide ?? 0).toBe(0);
      });

      it('receives the aggregated BadRequest (not per-parameter exceptions) when params fail', async () => {
        const response = await request('GET', '/p/wide/x?limit=y');
        expect(response.status).toBe(418);
        expect(MyWideFilter.last).toEqual({
          name: 'BadRequestException',
          status: 400,
        });
      });
    });
  });
}
