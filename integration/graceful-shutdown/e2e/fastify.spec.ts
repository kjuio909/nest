import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import * as http from 'http';
import { AppModule } from '../src/app.module.js';
import {
  FastifyShutdownModule,
  shutdownSideEffects,
} from '../src/fastify-shutdown.module.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const get = (
  port: number,
  path: string,
  options: http.RequestOptions = {},
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> =>
  new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${port}${path}`, options, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode!, body, headers: res.headers }),
        );
      })
      .on('error', reject);
  });

describe('Graceful Shutdown (Fastify)', () => {
  let app: INestApplication;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should allow in-flight requests to complete when return503OnClosing is enabled', async () => {
    app = await NestFactory.create(AppModule, new FastifyAdapter(), {
      return503OnClosing: true,
      logger: false,
    });
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const requestPromise = new Promise<string>((resolve, reject) => {
      http
        .get(
          `http://localhost:${port}/slow`,
          {
            // Explicitly close connection after response to speed up server shutdown
            headers: { Connection: 'close' },
          },
          res => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => resolve(data));
          },
        )
        .on('error', reject);
    });

    // Wait to ensure request is processing
    await sleep(100);

    const closePromise = app.close();

    // The in-flight request should finish successfully
    const response = await requestPromise;
    expect(response).toBe('ok');

    await closePromise;
  }, 10000);

  it('should return 503 for NEW queued requests on existing connections during shutdown', async () => {
    app = await NestFactory.create(AppModule, new FastifyAdapter(), {
      return503OnClosing: true,
      logger: false,
    });
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    // Force 1 socket to ensure queuing/reuse
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    // 1. Send Request A (slow) - occupies the socket
    const inFlightPromise = new Promise<string>((resolve, reject) => {
      http
        .get(`http://localhost:${port}/slow`, { agent }, res => {
          let data = '';
          res.on('data', c => (data += c));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });

    // 2. Wait so Request A is definitely "in flight"
    await sleep(100);

    // 3. Trigger Shutdown (don't await yet)
    const closePromise = app.close();

    // Allow the microtask for prepareClose() to flush (sets isShuttingDown)
    await sleep(0);

    // 4. Send Request B immediately using the same agent.
    const queuedPromise = get(port, '/slow', { agent });

    const queued = await queuedPromise;
    expect(queued.status).toBe(503);
    expect(queued.body).toBe('Service Unavailable');
    expect(queued.headers.connection).toBe('close');

    // 5. The in-flight request still completes with its original result
    expect(await inFlightPromise).toBe('ok');

    await closePromise;
    agent.destroy();
  }, 10000);

  it('should reject requests during shutdown before guards, pipes, interceptors and controllers run', async () => {
    app = await NestFactory.create(
      FastifyShutdownModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    // Sanity check: the full request chain runs before shutdown
    shutdownSideEffects.reset();
    const ok = await get(port, '/work?value=1', {
      headers: { Connection: 'close' },
    });
    expect(ok.status).toBe(200);
    expect(shutdownSideEffects.guard).toBe(1);
    expect(shutdownSideEffects.pipe).toBe(1);
    expect(shutdownSideEffects.interceptor).toBe(1);
    expect(shutdownSideEffects.controller).toBe(1);

    // A single kept-alive socket lets us pipeline a "new" request behind an
    // in-flight one after closing begins (server.close() refuses new TCP
    // connections, but existing ones keep being served)
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const inFlightPromise = new Promise<string>((resolve, reject) => {
      http
        .get(`http://localhost:${port}/slow`, { agent }, res => {
          let data = '';
          res.on('data', c => (data += c));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
    await sleep(100);

    // Trigger shutdown; prepareClose() flips the closing state before the
    // shutdown hooks and server close run
    const closePromise = app.close();
    await sleep(0);

    // Pipelined behind the in-flight request on the same socket
    shutdownSideEffects.reset();
    const rejected = await get(port, '/work?value=1', { agent });
    expect(rejected.status).toBe(503);
    expect(rejected.body).toBe('Service Unavailable');
    expect(rejected.headers.connection).toBe('close');

    // No layer of the business chain may have run for the rejected request
    expect(shutdownSideEffects.guard).toBe(0);
    expect(shutdownSideEffects.pipe).toBe(0);
    expect(shutdownSideEffects.interceptor).toBe(0);
    expect(shutdownSideEffects.controller).toBe(0);

    // The in-flight request still completed with its original result
    expect(await inFlightPromise).toBe('ok');

    await closePromise;
    agent.destroy();
  }, 10000);

  it('should complete closing when an in-flight request throws', async () => {
    app = await NestFactory.create(
      FastifyShutdownModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    // "Connection: close" so the socket is released right after the error
    // response instead of waiting out the keep-alive timeout
    const responsePromise = get(port, '/throw', {
      headers: { Connection: 'close' },
    });
    await sleep(10);

    // The in-flight request fails while the application is closing;
    // closing must still complete
    await app.close();

    const response = await responsePromise;
    expect(response.status).toBe(500);
  }, 10000);

  it('should complete closing when the client aborts an in-flight request', async () => {
    app = await NestFactory.create(
      FastifyShutdownModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const req = http.get(`http://localhost:${port}/hang`);
    req.on('error', () => {});
    await sleep(100);

    // Abort the in-flight request, then close; closing must still complete
    req.destroy();
    await app.close();
  }, 10000);

  it('should be idempotent across repeated close() calls', async () => {
    app = await NestFactory.create(AppModule, new FastifyAdapter(), {
      return503OnClosing: true,
      logger: false,
    });
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    await app.close();
    await app.close();
    await app.close();

    // The server is fully closed; new connections are refused
    await expect(get(port, '/slow')).rejects.toThrow();
  }, 10000);

  it('should leave Fastify native closing behavior untouched when the option is disabled', async () => {
    app = await NestFactory.create(
      FastifyShutdownModule,
      new FastifyAdapter(),
      {
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    // Before shutdown, requests are processed normally by the full chain
    shutdownSideEffects.reset();
    const ok = await get(port, '/work?value=1', {
      headers: { Connection: 'close' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('ok');
    expect(shutdownSideEffects.controller).toBe(1);

    // After closing begins, Fastify's own built-in behavior applies:
    // a pipelined request is rejected with its native JSON 503 response
    // (not the adapter's plain-text one), proving the adapter did not
    // install its gate.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const inFlightPromise = new Promise<string>((resolve, reject) => {
      http
        .get(`http://localhost:${port}/slow`, { agent }, res => {
          let data = '';
          res.on('data', c => (data += c));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
    await sleep(100);

    const closePromise = app.close();
    await sleep(0);

    const rejected = await get(port, '/work?value=1', { agent });
    expect(rejected.status).toBe(503);
    expect(JSON.parse(rejected.body)).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Service Unavailable',
    });
    expect(rejected.headers.connection).toBe('close');

    expect(await inFlightPromise).toBe('ok');
    await closePromise;
    agent.destroy();
  }, 10000);
});
