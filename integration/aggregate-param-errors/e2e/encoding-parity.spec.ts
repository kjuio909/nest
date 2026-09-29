import { createAggregateParamErrorsApp } from '../src/create-aggregate-param-errors-app.js';

// Fixed inputs sent verbatim to both adapters: status, JSON structure and
// message order must match exactly. The canonical responses themselves are
// pinned in the per-adapter encoding suite; here only cross-adapter parity
// is asserted.
const parityInputs: string[] = [
  '/batch/7?item=1',
  '/batch/7?item=2&item=4',
  '/batch/7?item=%32&item=004',
  '/batch/7?item=2&tag=x&item=004',
  '/batch/7?item=1&tag=a&item=2&tag=b&item=3',
  '/batch/%37?item=%32',
  '/batch/0?item=0&item=2147483647',
  '/batch/7?item=2%34',
  '/batch/7?item=',
  '/batch/7',
  '/batch/7?item=+',
  '/batch/7?item=2+4',
  '/batch/7?item=2%2B4',
  '/batch/7?item=%207',
  '/batch/7?item=%2532',
  '/batch/7?item=%',
  '/batch/7?item=%ZZ',
  '/batch/7?item=%3',
  '/batch/7?item=%FF',
  '/batch/7?item=%C0%80',
  '/batch/7?item=%00',
  '/batch/7?item=1%002',
  '/batch/7?item=%091',
  '/batch/7?item=2%26item%3D3',
  '/batch/7?item=%23',
  '/batch/7?item=2%3B4',
  '/batch/7?item=2;4',
  '/batch/7?item=1,2',
  '/batch/7?item=%5B%5D',
  '/batch/7?item[]=1&item[]=2',
  '/batch/7?item[0]=1&item[1]=2',
  '/batch/7?item=1;item=2',
  '/batch/7?item=1&&item=2',
  '/batch/7?item=x&item=3&item=y',
  '/batch/7?item=2147483648&item=1e3&item=0x10&item=%207&item=2.5',
  '/batch/7?item=1&item=%&item=2',
  '/batch/7?item=deny',
  '/batch/7?item=%64%65%6e%79',
  '/batch/7?item=de%6ey',
  '/batch/7?item=%44%45%4e%59',
  '/batch/7?item=x&item=deny&item=y',
  '/batch/7?item=deny&item=x',
  '/batch/%61%62%63?item=1',
  '/batch/%?item=1',
  '/batch/%ZZ?item=1',
  '/batch/%3?item=1',
  '/batch/%FF?item=1',
  '/batch/%2537?item=1',
  '/batch/%00?item=1',
  '/batch/7%2B?item=1',
  '/batch/7%20?item=1',
  '/batch/7+8?item=1',
  '/batch/%C3%A9?item=1',
  '/batch/%FF?item=deny',
  '/batch-plain/7?item=2&item=4',
  '/batch-plain/7?item=x&item=3&item=y',
  '/batch-plain/7',
  '/batch-plain/7?item=%64%65%6e%79',
  '/batch-plain/7?item=%3',
  '/batch-plain/%ZZ?item=1',
];

describe('AggregateParamErrors adapter parity', () => {
  it.each(parityInputs)(
    'GET %s answers identically on Express and Fastify',
    async path => {
      const [expressApp, fastifyApp] = await Promise.all([
        createAggregateParamErrorsApp('express'),
        createAggregateParamErrorsApp('fastify'),
      ]);
      try {
        const [expressResponse, fastifyResponse] = await Promise.all([
          expressApp.get(path),
          fastifyApp.get(path),
        ]);
        expect(fastifyResponse.status).toBe(expressResponse.status);
        expect(fastifyResponse.body).toEqual(expressResponse.body);
      } finally {
        await Promise.all([expressApp.close(), fastifyApp.close()]);
      }
    },
  );

  it('answers repeated sequential requests identically on both adapters', async () => {
    const [expressApp, fastifyApp] = await Promise.all([
      createAggregateParamErrorsApp('express'),
      createAggregateParamErrorsApp('fastify'),
    ]);
    try {
      const sequence = [
        '/batch/7?item=2&tag=x&item=004',
        '/batch/7?item=%',
        '/batch/7?item=x&item=%64%65%6e%79&item=y',
        '/batch/7?item=1&item=%&item=2',
        '/batch/%FF?item=deny',
        '/batch/8?item=5',
      ];
      for (const path of sequence) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const [expressResponse, fastifyResponse] = await Promise.all([
            expressApp.get(path),
            fastifyApp.get(path),
          ]);
          expect(fastifyResponse.status).toBe(expressResponse.status);
          expect(fastifyResponse.body).toEqual(expressResponse.body);
        }
      }
    } finally {
      await Promise.all([expressApp.close(), fastifyApp.close()]);
    }
  });

  it('answers parallel identical requests identically on both adapters', async () => {
    const [expressApp, fastifyApp] = await Promise.all([
      createAggregateParamErrorsApp('express'),
      createAggregateParamErrorsApp('fastify'),
    ]);
    try {
      const path = '/batch/7?item=x&item=3&item=%';
      const [expressResponses, fastifyResponses] = await Promise.all([
        Promise.all(Array.from({ length: 8 }, () => expressApp.get(path))),
        Promise.all(Array.from({ length: 8 }, () => fastifyApp.get(path))),
      ]);
      for (let i = 0; i < 8; i++) {
        expect(fastifyResponses[i].status).toBe(expressResponses[i].status);
        expect(fastifyResponses[i].body).toEqual(expressResponses[i].body);
      }
      // All eight attempts failed in exactly the same way; no request state
      // crossed over between parallel calls.
      for (const response of [...expressResponses, ...fastifyResponses]) {
        expect(response.status).toBe(400);
        expect(response.body.message).toEqual(['ITEM[0]', 'ITEM[2]']);
      }
    } finally {
      await Promise.all([expressApp.close(), fastifyApp.close()]);
    }
  });
});
