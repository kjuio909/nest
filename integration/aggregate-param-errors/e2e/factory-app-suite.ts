import {
  type AggregateParamErrorsAdapter,
  createAggregateParamErrorsApp,
  type AggregateParamErrorsApp,
} from '../src/create-aggregate-param-errors-app.js';

/**
 * Black-box contract driven exclusively through the public factory:
 * every assertion observes only the HTTP status and JSON body, and the same
 * matrix runs verbatim on Express and Fastify.
 */
export function registerFactoryAppSuite(
  adapter: AggregateParamErrorsAdapter,
): void {
  describe(`createAggregateParamErrorsApp("${adapter}")`, () => {
    let app: AggregateParamErrorsApp;

    beforeEach(async () => {
      app = await createAggregateParamErrorsApp(adapter);
    });

    afterEach(async () => {
      await app.close();
    });

    describe('GET /batch/:id (aggregated)', () => {
      it('converts the repeated items in appearance order and always returns an array', async () => {
        const multi = await app.request('/batch/7?item=2&item=004');
        expect(multi.status).toBe(200);
        expect(multi.body).toEqual({ id: 7, items: [2, 4] });

        const single = await app.request('/batch/8?item=9');
        expect(single.status).toBe(200);
        expect(single.body).toEqual({ id: 8, items: [9] });
      });

      it('accepts the 0/2147483647 boundaries, leading zeros and id 0', async () => {
        const edges = await app.request(
          '/batch/2147483647?item=0&item=00&item=0004&item=2147483647',
        );
        expect(edges.status).toBe(200);
        expect(edges.body).toEqual({
          id: 2147483647,
          items: [0, 0, 4, 2147483647],
        });

        const zeroId = await app.request('/batch/0?item=000');
        expect(zeroId.status).toBe(200);
        expect(zeroId.body).toEqual({ id: 0, items: [0] });
      });

      it.each([
        '-1',
        '1.5',
        '1e3',
        '0x1',
        '%207',
        '7%20',
        '%2B7',
        '2147483648',
        '99999999999999999999',
      ])('rejects the invalid item value %s as ITEM[0]', async raw => {
        const failed = await app.request(`/batch/7?item=${raw}`);
        expect(failed.status).toBe(400);
        expect(failed.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ['ITEM[0]'],
        });
      });

      it('keeps inspecting the remaining items and returns all indexed messages in ascending order', async () => {
        const failed = await app.request(
          '/batch/7?item=x&item=3&item=2147483648&item=-1',
        );
        expect(failed.status).toBe(400);
        expect(failed.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ['ITEM[0]', 'ITEM[2]', 'ITEM[3]'],
        });
      });

      it('reports only the bad index while still converting later valid items', async () => {
        const failed = await app.request('/batch/7?item=&item=004');
        expect(failed.status).toBe(400);
        expect(failed.body.message).toEqual(['ITEM[0]']);
      });

      it('distinguishes a missing item key from an explicit empty value', async () => {
        const missing = await app.request('/batch/7');
        expect(missing.status).toBe(400);
        expect(missing.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ['ITEM'],
        });

        const empty = await app.request('/batch/7?item=');
        expect(empty.status).toBe(400);
        expect(empty.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: ['ITEM[0]'],
        });
      });

      it('returns 409 DENIED on deny and ignores every later value, including invalid ones', async () => {
        const denied = await app.request('/batch/7?item=x&item=deny&item=y');
        expect(denied.status).toBe(409);
        expect(denied.body).toEqual({
          statusCode: 409,
          error: 'Conflict',
          message: 'DENIED',
        });

        const invalidAfterDeny = await app.request(
          '/batch/7?item=deny&item=2147483648&item=',
        );
        expect(invalidAfterDeny.status).toBe(409);
        expect(invalidAfterDeny.body.message).toBe('DENIED');
      });
    });

    describe('GET /batch-plain/:id (fail-fast comparison route)', () => {
      it('serves a valid batch with the same success shape', async () => {
        const ok = await app.request('/batch-plain/7?item=2&item=004');
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ id: 7, items: [2, 4] });
      });

      it('ends at the first invalid item and returns one single string message', async () => {
        const failed = await app.request('/batch-plain/7?item=x&item=3&item=y');
        expect(failed.status).toBe(400);
        expect(failed.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: 'ITEM[0]',
        });
      });

      it('reports a missing key and an explicit empty value as single strings', async () => {
        const missing = await app.request('/batch-plain/7');
        expect(missing.status).toBe(400);
        expect(missing.body.message).toBe('ITEM');

        const empty = await app.request('/batch-plain/7?item=');
        expect(empty.status).toBe(400);
        expect(empty.body.message).toBe('ITEM[0]');
      });

      it('keeps the deny short-circuit and ignores later invalid values', async () => {
        const denied = await app.request('/batch-plain/7?item=deny&item=x');
        expect(denied.status).toBe(409);
        expect(denied.body.message).toBe('DENIED');
      });

      it('shares the integer boundary rules', async () => {
        const ok = await app.request('/batch-plain/0?item=00&item=2147483647');
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ id: 0, items: [0, 2147483647] });

        const overflow = await app.request('/batch-plain/7?item=2147483648');
        expect(overflow.status).toBe(400);
        expect(overflow.body.message).toBe('ITEM[0]');
      });
    });

    describe('invalid id on either route', () => {
      it.each([
        ['abc', 'non-numeric'],
        ['-1', 'signed'],
        ['1.5', 'decimal point'],
        ['1e3', 'exponent'],
        ['0x1', 'hex'],
        ['%207', 'leading whitespace'],
        ['7%20', 'trailing whitespace'],
        ['%2B7', 'plus sign'],
        ['2147483648', 'above the max'],
      ])(
        'returns 400 with the bare "ID" string for %s (%s), before items run',
        async raw => {
          for (const prefix of ['batch', 'batch-plain']) {
            const withItems = await app.request(
              `/${prefix}/${raw}?item=x&item=deny`,
            );
            expect(withItems.status).toBe(400);
            expect(withItems.body).toEqual({ statusCode: 400, message: 'ID' });

            const withoutItems = await app.request(`/${prefix}/${raw}`);
            expect(withoutItems.status).toBe(400);
            expect(withoutItems.body).toEqual({
              statusCode: 400,
              message: 'ID',
            });
          }
        },
      );
    });

    describe('per-request isolation over real HTTP', () => {
      it('an interleaved success/error/deny sequence never borrows another response state', async () => {
        const success = await app.request('/batch/1?item=10&item=004');
        expect(success.body).toEqual({ id: 1, items: [10, 4] });

        const missing = await app.request('/batch/2');
        expect(missing.status).toBe(400);
        expect(missing.body.message).toEqual(['ITEM']);

        const denied = await app.request('/batch/3?item=deny&item=x');
        expect(denied.status).toBe(409);
        expect(denied.body.message).toBe('DENIED');

        const multiError = await app.request(
          '/batch/4?item=x&item=5&item=2147483648',
        );
        expect(multiError.status).toBe(400);
        expect(multiError.body.message).toEqual(['ITEM[0]', 'ITEM[2]']);

        const plainError = await app.request(
          '/batch-plain/6?item=x&item=7&item=y',
        );
        expect(plainError.status).toBe(400);
        expect(plainError.body.message).toBe('ITEM[0]');

        const invalidId = await app.request('/batch/abc?item=deny');
        expect(invalidId.status).toBe(400);
        expect(invalidId.body.message).toBe('ID');

        const successAgain = await app.request('/batch/9?item=11');
        expect(successAgain.status).toBe(200);
        expect(successAgain.body).toEqual({ id: 9, items: [11] });
      });

      it('parallel requests of every kind each reflect only their own input', async () => {
        const [
          success,
          single,
          missing,
          multiError,
          denied,
          invalidId,
          plainSuccess,
          plainFailFast,
        ] = await Promise.all([
          app.request('/batch/1?item=10&item=004'),
          app.request('/batch/2?item=x'),
          app.request('/batch/3'),
          app.request('/batch/4?item=x&item=5&item=2147483648'),
          app.request('/batch/5?item=x&item=deny&item=y'),
          app.request('/batch/abc?item=x&item=deny'),
          app.request('/batch-plain/8?item=2&item=4'),
          app.request('/batch-plain/9?item=x&item=deny'),
        ]);

        expect(success.status).toBe(200);
        expect(success.body).toEqual({ id: 1, items: [10, 4] });
        expect(single.status).toBe(400);
        expect(single.body.message).toEqual(['ITEM[0]']);
        expect(missing.status).toBe(400);
        expect(missing.body.message).toEqual(['ITEM']);
        expect(multiError.status).toBe(400);
        expect(multiError.body.message).toEqual(['ITEM[0]', 'ITEM[2]']);
        expect(denied.status).toBe(409);
        expect(denied.body.message).toBe('DENIED');
        expect(invalidId.status).toBe(400);
        expect(invalidId.body).toEqual({ statusCode: 400, message: 'ID' });
        expect(plainSuccess.status).toBe(200);
        expect(plainSuccess.body).toEqual({ id: 8, items: [2, 4] });
        expect(plainFailFast.status).toBe(400);
        expect(plainFailFast.body.message).toBe('ITEM[0]');
      });
    });
  });
}
