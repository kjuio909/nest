import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AggregateParamErrorsModule } from '../src/aggregate-param-errors.module.js';
import {
  IsolationResponse,
  registerIsolationSuite,
  RequestOptions,
} from './isolation-suite.js';

registerIsolationSuite({
  platformName: 'Fastify',
  async createApp() {
    const moduleRef = await Test.createTestingModule({
      imports: [AggregateParamErrorsModule],
    }).compile();

    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const send = async (
      method: 'GET' | 'POST',
      path: string,
      options?: RequestOptions,
    ): Promise<IsolationResponse> => {
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

    return { app, request: send, close: () => app.close() };
  },
});
