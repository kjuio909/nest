import {
  isolationState,
  resetIsolationState,
} from '../src/aggregate-param-errors.controller.js';

export interface EncodingResponse {
  status: number;
  body: any;
  text: string;
}

export interface EncodingSuiteDeps {
  readonly platformName: string;
  createApp(): Promise<{
    request: (
      method: 'GET' | 'POST',
      path: string,
    ) => Promise<EncodingResponse>;
    close: () => Promise<void>;
  }>;
}

const badRequest = (message: unknown) => ({
  statusCode: 400,
  error: 'Bad Request',
  message,
});

const denied = () => ({
  statusCode: 409,
  error: 'Conflict',
  message: 'DENIED',
});

/**
 * Fixed inputs with their canonical responses. Every entry is sent verbatim
 * to both adapters, so the table pins the raw query sequence and the
 * percent-decoding boundary independently of the framework parser.
 */
interface EncodingCase {
  readonly label: string;
  readonly path: string;
  readonly expected: { status: number; body: unknown };
}

const aggregatedCases: EncodingCase[] = [
  {
    label: 'plain digits',
    path: '/batch/7?item=1',
    expected: { status: 200, body: { id: 7, items: [1] } },
  },
  {
    label: 'encoded digits are equivalent to plaintext',
    path: '/batch/7?item=%32&item=004',
    expected: { status: 200, body: { id: 7, items: [2, 4] } },
  },
  {
    label: 'appearance order stays stable across an unrelated key',
    path: '/batch/7?item=2&tag=x&item=004',
    expected: { status: 200, body: { id: 7, items: [2, 4] } },
  },
  {
    label: 'appearance order stays stable with several interleaved keys',
    path: '/batch/7?item=1&tag=a&item=2&tag=b&item=3',
    expected: { status: 200, body: { id: 7, items: [1, 2, 3] } },
  },
  {
    label: 'encoded id and encoded single item keep the array shape',
    path: '/batch/%37?item=%32',
    expected: { status: 200, body: { id: 7, items: [2] } },
  },
  {
    label: 'inclusive range boundaries',
    path: '/batch/0?item=0&item=2147483647',
    expected: { status: 200, body: { id: 0, items: [0, 2147483647] } },
  },
  {
    label: 'percent escape in the middle of digits',
    path: '/batch/7?item=2%34',
    expected: { status: 200, body: { id: 7, items: [24] } },
  },
  {
    label: 'explicit empty value is element 0',
    path: '/batch/7?item=',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'missing item key is a single unindexed element',
    path: '/batch/7',
    expected: { status: 400, body: badRequest(['ITEM']) },
  },
  {
    label: 'a lone plus is not a decoded digit',
    path: '/batch/7?item=+',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'a raw plus between digits is invalid at its position',
    path: '/batch/7?item=2+4',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'an encoded plus never becomes a space or a digit',
    path: '/batch/7?item=2%2B4',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'an encoded leading space is invalid at its position',
    path: '/batch/7?item=%207',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'a value only valid after decoding twice stays invalid',
    path: '/batch/7?item=%2532',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'a lone percent is an element error, not a parser failure',
    path: '/batch/7?item=%',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'a non-hex percent sequence is an element error',
    path: '/batch/7?item=%ZZ',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'a truncated percent sequence is an element error',
    path: '/batch/7?item=%3',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'an invalid UTF-8 percent sequence is an element error',
    path: '/batch/7?item=%FF',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'an overlong UTF-8 sequence is an element error',
    path: '/batch/7?item=%C0%80',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'an encoded null byte is an element error',
    path: '/batch/7?item=%00',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'a null byte between digits is an element error',
    path: '/batch/7?item=1%002',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'an encoded tab before a digit is an element error',
    path: '/batch/7?item=%091',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'an encoded ampersand stays inside the element',
    path: '/batch/7?item=2%26item%3D3',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'an encoded hash is an element error',
    path: '/batch/7?item=%23',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'an encoded semicolon is an element error',
    path: '/batch/7?item=2%3B4',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'a raw semicolon is an element error on both parsers',
    path: '/batch/7?item=2;4',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'a comma is not an array separator',
    path: '/batch/7?item=1,2',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'encoded brackets are element data, not array notation',
    path: '/batch/7?item=%5B%5D',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'multiple invalid elements keep their original indexes',
    path: '/batch/7?item=x&item=3&item=y',
    expected: {
      status: 400,
      body: badRequest(['ITEM[0]', 'ITEM[2]']),
    },
  },
  {
    label: 'the full sequence is checked and messages stay in element order',
    path: '/batch/7?item=2147483648&item=1e3&item=0x10&item=%207&item=2.5',
    expected: {
      status: 400,
      body: badRequest(['ITEM[0]', 'ITEM[1]', 'ITEM[2]', 'ITEM[3]', 'ITEM[4]']),
    },
  },
  {
    label: 'a bad percent keeps its index between valid elements',
    path: '/batch/7?item=1&item=%&item=2',
    expected: { status: 400, body: badRequest(['ITEM[1]']) },
  },
  {
    label: 'plain deny aborts with 409',
    path: '/batch/7?item=deny',
    expected: { status: 409, body: denied() },
  },
  {
    label: 'fully encoded deny is equivalent to plaintext deny',
    path: '/batch/7?item=%64%65%6e%79',
    expected: { status: 409, body: denied() },
  },
  {
    label: 'partially encoded deny is equivalent to plaintext deny',
    path: '/batch/7?item=de%6ey',
    expected: { status: 409, body: denied() },
  },
  {
    label: 'uppercase DENY is an element error, not a conflict',
    path: '/batch/7?item=%44%45%4e%59',
    expected: { status: 400, body: badRequest(['ITEM[0]']) },
  },
  {
    label: 'deny discards staged errors and skips later elements',
    path: '/batch/7?item=x&item=deny&item=y',
    expected: { status: 409, body: denied() },
  },
  {
    label: 'deny wins over invalid values after it',
    path: '/batch/7?item=deny&item=x',
    expected: { status: 409, body: denied() },
  },
];

// Ids that decode successfully but fail the ASCII-digit rule reach the guard.
const guardRejectedIdCases: EncodingCase[] = [
  {
    label: 'encoded letters',
    path: '/batch/%61%62%63?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
  {
    label: 'double-encoded digit',
    path: '/batch/%2537?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
  {
    label: 'null byte',
    path: '/batch/%00?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
  {
    label: 'encoded plus suffix',
    path: '/batch/7%2B?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
  {
    label: 'encoded space suffix',
    path: '/batch/7%20?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
  {
    label: 'raw plus',
    path: '/batch/7+8?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
  {
    label: 'decoded multibyte letter',
    path: '/batch/%C3%A9?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
];

// Ids whose percent sequence the framework itself cannot decode never enter
// Nest routing: the raw-URL gate answers them before any guard runs.
const gateRejectedIdCases: EncodingCase[] = [
  {
    label: 'lone percent',
    path: '/batch/%?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
  {
    label: 'non-hex sequence',
    path: '/batch/%ZZ?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
  {
    label: 'truncated sequence',
    path: '/batch/%3?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
  {
    label: 'invalid UTF-8 sequence',
    path: '/batch/%FF?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
  {
    label: 'invalid UTF-8 sequence before a deny item',
    path: '/batch/%FF?item=deny',
    expected: { status: 400, body: badRequest('ID') },
  },
];

const plainCases: EncodingCase[] = [
  {
    label: 'plain route converts repeated encoded items',
    path: '/batch-plain/7?item=2&item=4',
    expected: { status: 200, body: { id: 7, items: [2, 4] } },
  },
  {
    label: 'plain route fails fast at the first invalid element',
    path: '/batch-plain/7?item=x&item=3&item=y',
    expected: { status: 400, body: badRequest('ITEM[0]') },
  },
  {
    label: 'plain route reports a missing key as a plain single error',
    path: '/batch-plain/7',
    expected: { status: 400, body: badRequest('ITEM') },
  },
  {
    label: 'plain route treats an encoded deny as deny',
    path: '/batch-plain/7?item=%64%65%6e%79',
    expected: { status: 409, body: denied() },
  },
  {
    label: 'plain route rejects a truncated percent element',
    path: '/batch-plain/7?item=%3',
    expected: { status: 400, body: badRequest('ITEM[0]') },
  },
  {
    label: 'plain route answers a malformed id like the aggregated route',
    path: '/batch-plain/%ZZ?item=1',
    expected: { status: 400, body: badRequest('ID') },
  },
];

/**
 * Percent-decoding boundary and repeatable-query-sequence assertions shared
 * verbatim by the Express and Fastify adapters.
 */
export function registerEncodingSuite(deps: EncodingSuiteDeps): void {
  let request: (
    method: 'GET' | 'POST',
    path: string,
  ) => Promise<EncodingResponse>;
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

  describe(`[${deps.platformName}] query/path decoding boundary`, () => {
    it.each(aggregatedCases)('$label', async ({ path, expected }) => {
      const response = await request('GET', path);
      expect(response.status).toBe(expected.status);
      expect(response.body).toEqual(expected.body);
    });

    it.each(guardRejectedIdCases)(
      'id: $label fails via the id guard without inspecting items',
      async ({ path, expected }) => {
        const response = await request('GET', path);
        expect(response.status).toBe(expected.status);
        expect(response.body).toEqual(expected.body);
        expect(isolationState.pipeCalls).toEqual(['ID']);
        expect(isolationState.handlerCalls.batch ?? 0).toBe(0);
      },
    );

    it.each(gateRejectedIdCases)(
      'id: $label is rejected before routing without a 500',
      async ({ path, expected }) => {
        const response = await request('GET', path);
        expect(response.status).toBe(expected.status);
        expect(response.body).toEqual(expected.body);
        expect(isolationState.pipeCalls).toEqual([]);
        expect(isolationState.handlerCalls.batch ?? 0).toBe(0);
      },
    );

    it.each(plainCases)('compat: $label', async ({ path, expected }) => {
      const response = await request('GET', path);
      expect(response.status).toBe(expected.status);
      expect(response.body).toEqual(expected.body);
    });

    it('keeps encoded parameters on non-batch routes working', async () => {
      const response = await request('GET', '/p/%37?limit=%31%30');
      expect(response.status).toBe(200);
      expect(response.text).toBe('7,10');
    });

    it('still answers a malformed percent on a non-batch route with a 400 (not a 500)', async () => {
      const response = await request('GET', '/p/%FF?limit=10');
      expect(response.status).toBe(400);
      expect(isolationState.handlerCalls.aggregated ?? 0).toBe(0);
    });

    it('decides every response from its own request in an encoded sequence', async () => {
      const success = await request('GET', '/batch/%37?item=%32&item=004');
      expect(success.status).toBe(200);
      expect(success.body).toEqual({ id: 7, items: [2, 4] });

      const elementError = await request('GET', '/batch/7?item=%');
      expect(elementError.body).toEqual(badRequest(['ITEM[0]']));

      const conflict = await request(
        'GET',
        '/batch/7?item=x&item=%64%65%6e%79&item=y',
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual(denied());

      const successAgain = await request(
        'GET',
        '/batch/7?item=2&tag=x&item=004',
      );
      expect(successAgain.body).toEqual({ id: 7, items: [2, 4] });

      expect(isolationState.handlerCalls.batch).toBe(2);
      expect(isolationState.pipeCalls).toEqual([
        'ID',
        'ITEM',
        'ITEM',
        'ID',
        'ITEM',
        'ID',
        'ITEM',
        'ITEM',
        'ID',
        'ITEM',
        'ITEM',
      ]);

      // Nothing leaked into a subsequent request.
      const clean = await request('GET', '/batch/8?item=5');
      expect(clean.body).toEqual({ id: 8, items: [5] });
      expect(isolationState.handlerCalls.batch).toBe(3);
    });

    it('keeps parallel encoded success, element-error and deny requests isolated', async () => {
      const [first, second, elementError, conflict] = await Promise.all([
        request('GET', '/batch/7?item=%32&item=004'),
        request('GET', '/batch/7?item=%32&item=004'),
        request('GET', '/batch/7?item=1&item=%&item=2'),
        request('GET', '/batch/7?item=%64%65%6e%79'),
      ]);

      for (const response of [first, second]) {
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ id: 7, items: [2, 4] });
      }
      expect(elementError.status).toBe(400);
      expect(elementError.body).toEqual(badRequest(['ITEM[1]']));
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual(denied());

      // Exactly the two successful requests reached the handler.
      expect(isolationState.handlerCalls.batch).toBe(2);
      expect(isolationState.pipeCalls.filter(tag => tag === 'ID')).toHaveLength(
        4,
      );
      expect(
        isolationState.pipeCalls.filter(tag => tag === 'ITEM'),
      ).toHaveLength(8);

      const clean = await request('GET', '/batch/8?item=5');
      expect(clean.body).toEqual({ id: 8, items: [5] });
      expect(isolationState.handlerCalls.batch).toBe(3);
    });
  });
}
