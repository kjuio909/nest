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

    describe('optional @Query() default value', () => {
      it('seeds the per-request default and converts it through the same chain', async () => {
        const ok = await request('GET', '/p/defaults/7?currency=usd');
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ id: 7, currency: 'USD', limit: 10 });
        expect(isolationState.handlerCalls.defaults).toBe(1);
        // Even with a default, the limit conversion runs once per request.
        expect(isolationState.pipeCalls).toEqual(['A', 'CURRENCY', 'LIMIT']);
      });

      it('uses the explicit converted value instead of the default', async () => {
        const ok = await request('GET', '/p/defaults/7?currency=usd&limit=3');
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ id: 7, currency: 'USD', limit: 3 });
        expect(isolationState.handlerCalls.defaults).toBe(1);
      });

      it('keeps default-success, explicit-success, single-error, double-error and a final default-success isolated', async () => {
        const defaulted = await request('GET', '/p/defaults/7?currency=usd');
        expect(defaulted.status).toBe(200);
        expect(defaulted.body).toEqual({
          id: 7,
          currency: 'USD',
          limit: 10,
        });
        expect(isolationState.handlerCalls.defaults).toBe(1);

        const explicit = await request(
          'GET',
          '/p/defaults/8?currency=eur&limit=3',
        );
        expect(explicit.status).toBe(200);
        expect(explicit.body).toEqual({
          id: 8,
          currency: 'EUR',
          limit: 3,
        });
        expect(isolationState.handlerCalls.defaults).toBe(2);

        const singleError = await request(
          'GET',
          '/p/defaults/7?currency=usd&limit=x',
        );
        expect(singleError.status).toBe(400);
        expect(singleError.body.message).toEqual(['LIMIT']);
        expect(isolationState.handlerCalls.defaults).toBe(2);

        const doubleError = await request(
          'GET',
          '/p/defaults/abc?currency=&limit=x',
        );
        expect(doubleError.status).toBe(400);
        expect(doubleError.body.message).toEqual([
          'A',
          'CURRENCY',
          'LIMIT',
        ]);
        expect(isolationState.handlerCalls.defaults).toBe(2);

        const defaultedAgain = await request(
          'GET',
          '/p/defaults/9?currency=jpy',
        );
        expect(defaultedAgain.status).toBe(200);
        expect(defaultedAgain.body).toEqual({
          id: 9,
          currency: 'JPY',
          limit: 10,
        });
        expect(isolationState.handlerCalls.defaults).toBe(3);

        // Every request re-ran all three conversions; the default, converted
        // values and collected errors never crossed request boundaries.
        expect(isolationState.pipeCalls).toEqual([
          'A', 'CURRENCY', 'LIMIT',
          'A', 'CURRENCY', 'LIMIT',
          'A', 'CURRENCY', 'LIMIT',
          'A', 'CURRENCY', 'LIMIT',
          'A', 'CURRENCY', 'LIMIT',
        ]);
      });

      it('never masks a missing required currency with the optional limit default', async () => {
        const missingCurrency = await request('GET', '/p/defaults/7');
        expect(missingCurrency.status).toBe(400);
        expect(missingCurrency.body.message).toEqual(['CURRENCY']);
        expect(isolationState.handlerCalls.defaults ?? 0).toBe(0);

        const ok = await request('GET', '/p/defaults/7?currency=usd');
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ id: 7, currency: 'USD', limit: 10 });
        expect(isolationState.handlerCalls.defaults).toBe(1);
      });

      it('keeps a concurrent default-success and explicit-invalid request isolated', async () => {
        const [defaulted, invalid] = await Promise.all([
          request('GET', '/p/defaults-slow/7?currency=usd'),
          request('GET', '/p/defaults-slow/8?currency=eur&limit=x'),
        ]);

        expect(defaulted.status).toBe(200);
        expect(defaulted.body).toEqual({
          id: 7,
          currency: 'USD',
          limit: 10,
        });
        expect(invalid.status).toBe(400);
        expect(invalid.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ['LIMIT'],
        });

        // Each request converted every parameter exactly once; the default
        // value 10 only ever reached the successful handler.
        expect(isolationState.pipeCalls.filter(t => t === 'A')).toHaveLength(2);
        expect(
          isolationState.pipeCalls.filter(t => t === 'CURRENCY'),
        ).toHaveLength(2);
        expect(
          isolationState.pipeCalls.filter(t => t === 'LIMIT'),
        ).toHaveLength(2);
        expect(isolationState.handlerCalls.defaultsSlow).toBe(1);
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

    describe('batch route with a repeatable @Query() key', () => {
      it('keeps interleaved success, single-error, multi-error, missing and denied requests isolated', async () => {
        const ok = await request('GET', '/batch/7?item=2&item=4');
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ id: 7, items: [2, 4] });
        expect(isolationState.handlerCalls.batch).toBe(1);

        const singleError = await request('GET', '/batch/8?item=y');
        expect(singleError.status).toBe(400);
        expect(singleError.body.message).toEqual(['ITEM[0]']);

        const multiError = await request('GET', '/batch/9?item=x&item=3&item=y');
        expect(multiError.status).toBe(400);
        expect(multiError.body.message).toEqual(['ITEM[0]', 'ITEM[2]']);

        const missing = await request('GET', '/batch/10');
        expect(missing.status).toBe(400);
        expect(missing.body.message).toEqual(['ITEM']);

        const denied = await request('GET', '/batch/11?item=x&item=deny');
        expect(denied.status).toBe(409);
        expect(denied.body.message).toBe('DENIED');

        // Only the first request reached the handler; every request re-ran
        // both conversions and no staged message crossed a request boundary.
        expect(isolationState.handlerCalls.batch).toBe(1);
        expect(isolationState.pipeCalls).toEqual([
          'A', 'ITEM',
          'A', 'ITEM',
          'A', 'ITEM',
          'A', 'ITEM',
          'A', 'ITEM',
        ]);
      });

      it('converts each element of this request only, in appearance order', async () => {
        const failed = await request('GET', '/batch/7?item=x&item=3&item=y');
        expect(failed.body.message).toEqual(['ITEM[0]', 'ITEM[2]']);
        expect(isolationState.handlerCalls.batch ?? 0).toBe(0);

        const ok = await request('GET', '/batch/7?item=2&item=4');
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ id: 7, items: [2, 4] });
        expect(isolationState.handlerCalls.batch).toBe(1);
      });

      it('keeps a concurrent success and failure isolated', async () => {
        const [ok, failed] = await Promise.all([
          request('GET', '/batch/7?item=2&item=4'),
          request('GET', '/batch/8?item=x&item=y'),
        ]);

        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ id: 7, items: [2, 4] });
        expect(failed.status).toBe(400);
        expect(failed.body.message).toEqual(['ITEM[0]', 'ITEM[1]']);

        // Each request converted its own elements exactly once; the handler
        // ran only for the successful request.
        expect(isolationState.pipeCalls.filter(t => t === 'A')).toHaveLength(2);
        expect(
          isolationState.pipeCalls.filter(t => t === 'ITEM'),
        ).toHaveLength(2);
        expect(isolationState.handlerCalls.batch).toBe(1);
      });

      it('keeps the unmarked batch compatibility route fail-fast and independent', async () => {
        const legacyFailed = await request(
          'GET',
          '/batch/legacy/7?item=x&item=y',
        );
        expect(legacyFailed.status).toBe(400);
        expect(legacyFailed.body.message).toBe('ITEM[0]');
        expect(isolationState.handlerCalls.batchLegacy ?? 0).toBe(0);

        const ok = await request('GET', '/batch/7?item=2');
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ id: 7, items: [2] });
        expect(isolationState.handlerCalls.batch).toBe(1);
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

    describe('@Headers() independent input domain', () => {
      it('runs the header pipe and calls the handler once with all three transformed values', async () => {
        const ok = await request('GET', '/p/headers/7?limit=10', {
          headers: { 'x-token': '5' },
        });
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('7,5,10');
        expect(isolationState.pipeCalls).toEqual(['A', 'H', 'B']);
        expect(isolationState.handlerCalls.headers).toBe(1);
      });

      it('responds with only the aggregated param/query messages when the header is valid', async () => {
        const failed = await request('GET', '/p/headers/abc?limit=x', {
          headers: { 'x-token': '5' },
        });
        expect(failed.status).toBe(400);
        expect(failed.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ['A', 'B'],
        });
        expect(isolationState.handlerCalls.headers ?? 0).toBe(0);
        expect(isolationState.pipeCalls).toEqual(['A', 'H', 'B']);
      });

      it('aborts immediately on a header failure: staged param messages are discarded and later pipes never run', async () => {
        const failed = await request('GET', '/p/headers/abc?limit=x', {
          headers: { 'x-token': 'bad' },
        });
        expect(failed.status).toBe(400);
        expect(failed.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: 'H',
        });
        expect(isolationState.handlerCalls.headers ?? 0).toBe(0);
        // 'A' ran and was collected, the header aborted the resolution, so
        // the trailing @Query() pipe never ran.
        expect(isolationState.pipeCalls).toEqual(['A', 'H']);
      });

      it('a valid request after a mixed failure observes no leftover state', async () => {
        const mixed = await request('GET', '/p/headers/abc?limit=x', {
          headers: { 'x-token': 'bad' },
        });
        expect(mixed.body.message).toBe('H');

        const ok = await request('GET', '/p/headers/7?limit=10', {
          headers: { 'x-token': '5' },
        });
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('7,5,10');
        expect(isolationState.pipeCalls).toEqual(['A', 'H', 'A', 'H', 'B']);
        expect(isolationState.handlerCalls.headers).toBe(1);
      });

      it('the exception filter observes only the header exception on a mixed failure', async () => {
        const failed = await request('GET', '/p/headers-filtered/abc?limit=x', {
          headers: { 'x-token': 'bad' },
        });
        expect(failed.status).toBe(422);
        expect(failed.body).toEqual({ code: 'PARAMS_INVALID', count: 1 });
        expect(MyParamFilter.received).toHaveLength(1);
        expect(MyParamFilter.received[0]).toEqual({
          status: 400,
          message: 'H',
        });
        expect(isolationState.handlerCalls.headersFiltered ?? 0).toBe(0);
      });

      it('the filter still receives the single aggregated exception when only params fail', async () => {
        const failed = await request('GET', '/p/headers-filtered/abc?limit=x', {
          headers: { 'x-token': '5' },
        });
        expect(failed.status).toBe(422);
        expect(failed.body).toEqual({ code: 'PARAMS_INVALID', count: 2 });
        expect(MyParamFilter.received).toHaveLength(1);
        expect(MyParamFilter.received[0]).toEqual({
          status: 400,
          message: ['A', 'B'],
        });
      });

      it('propagates a non-BadRequest header exception unchanged and discards staged messages', async () => {
        const failed = await request('GET', '/p/headers-wide/abc?limit=x', {
          headers: { 'x-mode': 'abort' },
        });
        expect(failed.status).toBe(418);
        expect(failed.body).toEqual({ code: 'WIDE' });
        expect(MyWideFilter.last).toEqual({
          name: 'ForbiddenException',
          status: 403,
        });
        expect(isolationState.handlerCalls.headersWide ?? 0).toBe(0);
        expect(isolationState.pipeCalls).toEqual(['A', 'HF']);
      });

      it('runs header pipes on unannotated routes without changing the fail-fast path', async () => {
        const failed = await request('GET', '/p/headers-legacy/7?limit=10', {
          headers: { 'x-token': 'bad' },
        });
        expect(failed.status).toBe(400);
        expect(failed.body.message).toBe('H');
        expect(isolationState.handlerCalls.headersLegacy ?? 0).toBe(0);

        const ok = await request('GET', '/p/headers-legacy/7?limit=10', {
          headers: { 'x-token': '5' },
        });
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('7,5,10');
        expect(isolationState.handlerCalls.headersLegacy).toBe(1);
      });

      it('keeps consecutive success, double-error, header-failure and mixed-failure responses isolated', async () => {
        const ok = await request('GET', '/p/headers/7?limit=10', {
          headers: { 'x-token': '5' },
        });
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('7,5,10');

        const doubleError = await request('GET', '/p/headers/abc?limit=x', {
          headers: { 'x-token': '5' },
        });
        expect(doubleError.body.message).toEqual(['A', 'B']);

        const headerOnly = await request('GET', '/p/headers/7?limit=10', {
          headers: { 'x-token': 'bad' },
        });
        expect(headerOnly.body.message).toBe('H');

        const mixed = await request('GET', '/p/headers/abc?limit=x', {
          headers: { 'x-token': 'bad' },
        });
        expect(mixed.body.message).toBe('H');

        expect(isolationState.handlerCalls.headers).toBe(1);
        // The header failures stopped at 'H' (the trailing @Query() pipe never
        // ran); no response carried messages collected by another response.
        expect(isolationState.pipeCalls).toEqual([
          'A', 'H', 'B',
          'A', 'H', 'B',
          'A', 'H',
          'A', 'H',
        ]);
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

      it('keeps a concurrent valid and header-failure request isolated', async () => {
        const [valid, headerFailure] = await Promise.all([
          request('GET', '/p/headers-slow/7?limit=10', {
            headers: { 'x-token': '5' },
          }),
          request('GET', '/p/headers-slow/7?limit=10', {
            headers: { 'x-token': 'bad' },
          }),
        ]);

        expect(valid.status).toBe(200);
        expect(valid.text).toBe('7,5,10');
        expect(headerFailure.status).toBe(400);
        expect(headerFailure.body.message).toBe('H');

        expect(isolationState.handlerCalls.headersSlow).toBe(1);
        // The failing request aborted at 'H' and never ran its query pipe;
        // the transformed token only ever reached the successful handler.
        expect(isolationState.pipeCalls.filter(t => t === 'A')).toHaveLength(2);
        expect(isolationState.pipeCalls.filter(t => t === 'H')).toHaveLength(2);
        expect(isolationState.pipeCalls.filter(t => t === 'B')).toHaveLength(1);
      });

      it('keeps a concurrent double-error and header-failure (mixed) request isolated', async () => {
        const [doubleError, mixed] = await Promise.all([
          request('GET', '/p/headers-slow/abc?limit=x', {
            headers: { 'x-token': '5' },
          }),
          request('GET', '/p/headers-slow/abc?limit=x', {
            headers: { 'x-token': 'bad' },
          }),
        ]);

        expect(doubleError.status).toBe(400);
        expect(doubleError.body.message).toEqual(['A', 'B']);
        expect(mixed.status).toBe(400);
        expect(mixed.body.message).toBe('H');

        expect(isolationState.handlerCalls.headersSlow ?? 0).toBe(0);
        // Both requests collected an 'A'; only the double-error request
        // reached its @Query() pipe. The mixed request discarded its staged
        // 'A' instead of leaking it into the double-error response.
        expect(
          isolationState.pipeCalls.filter(tag => tag === 'A'),
        ).toHaveLength(2);
        expect(
          isolationState.pipeCalls.filter(tag => tag === 'H'),
        ).toHaveLength(2);
        expect(
          isolationState.pipeCalls.filter(tag => tag === 'B'),
        ).toHaveLength(1);
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
