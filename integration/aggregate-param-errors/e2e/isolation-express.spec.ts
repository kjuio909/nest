import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AggregateParamErrorsModule } from '../src/aggregate-param-errors.module.js';
import {
  IsolationResponse,
  registerIsolationSuite,
  RequestOptions,
} from './isolation-suite.js';

registerIsolationSuite({
  platformName: 'Express',
  async createApp() {
    const moduleRef = await Test.createTestingModule({
      imports: [AggregateParamErrorsModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    const server = app.getHttpServer();

    const send = async (
      method: 'GET' | 'POST',
      path: string,
      options?: RequestOptions,
    ): Promise<IsolationResponse> => {
      let req = request(server)[method.toLowerCase() as 'get' | 'post'](path);
      req.set(options?.headers ?? {});
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

    return { app, request: send, close: () => app.close() };
  },
});
