import {
  CallHandler,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Injectable,
  Module,
  NestInterceptor,
  Observable,
  PipeTransform,
  Query,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as http from 'http';
import * as net from 'net';
import { appCounters, resetAppCounters } from '../src/app.controller.js';
import {
  AppModule,
  cleanupCounters,
  resetCleanupCounters,
} from '../src/app.module.js';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const request = (
  port: number,
  path: string,
  agent?: http.Agent,
): Promise<RawResponse> =>
  new Promise<RawResponse>((resolve, reject) => {
    http
      .get(
        `http://localhost:${port}${path}`,
        agent
          ? { agent }
          : {
              // Explicitly close connection after response to speed up server shutdown
              headers: { Connection: 'close' },
            },
        res => {
          let body = '';
          res.on('data', chunk => (body += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode || 0,
              headers: res.headers,
              body,
            }),
          );
        },
      )
      .on('error', reject);
  });

const post = (
  port: number,
  path: string,
  body: string,
  agent?: http.Agent,
): Promise<RawResponse> =>
  new Promise<RawResponse>((resolve, reject) => {
    const req = http.request(
      {
        port,
        path,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(agent ? {} : { Connection: 'close' }),
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: data,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });

const counters = {
  guard: 0,
  pipe: 0,
  interceptor: 0,
  handler: 0,
};

@Injectable()
class CountingGuard implements CanActivate {
  canActivate() {
    counters.guard++;
    return true;
  }
}

@Injectable()
class CountingPipe implements PipeTransform {
  transform(value: unknown) {
    counters.pipe++;
    return value;
  }
}

@Injectable()
class CountingInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<any> {
    counters.interceptor++;
    return next.handle();
  }
}

@Controller()
class SideEffectController {
  @Get('slow')
  async slow(@Query('q', CountingPipe) _q?: string) {
    counters.handler++;
    // Simulate work
    await new Promise(resolve => setTimeout(resolve, 500));
    return 'ok';
  }

  @Get('boom')
  async boom() {
    await new Promise(resolve => setTimeout(resolve, 100));
    throw new Error('boom');
  }
}

@Module({
  controllers: [SideEffectController],
})
class SideEffectModule {}

describe('Graceful Shutdown (Fastify)', () => {
  let app: INestApplication;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should allow in-flight requests to complete when return503OnClosing is enabled', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const requestPromise = request(port, '/slow');

    // Wait to ensure request is processing
    await new Promise(r => setTimeout(r, 100));

    const closePromise = app.close();

    // The in-flight request should finish successfully
    const response = await requestPromise;
    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');

    await closePromise;
  }, 10000);

  it('should return 503 for NEW queued requests on existing connections during shutdown', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    // Force 1 socket to ensure queuing/reuse
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    // 1. Send Request A (slow) - occupies the socket
    const requestA = request(port, '/slow', agent);

    // 2. Wait so Request A is definitely "in flight"
    await new Promise(r => setTimeout(r, 100));

    // 3. Trigger Shutdown (don't await yet)
    const closePromise = app.close();

    // Allow the microtask for prepareClose() to flush (sets isShuttingDown)
    await new Promise(r => setTimeout(r, 0));

    // 4. Send Request B immediately using the same agent.
    const requestB = request(port, '/slow', agent);

    const responseA = await requestA;
    expect(responseA.status).toBe(200);
    expect(responseA.body).toBe('ok');

    const responseB = await requestB;
    expect(responseB.status).toBe(503);
    expect(responseB.body).toBe('Service Unavailable');
    expect(responseB.headers['connection']).toBe('close');

    await closePromise;
    agent.destroy();
  }, 10000);

  it('should reject post-shutdown requests before guards, pipes, interceptors and handlers run', async () => {
    counters.guard = 0;
    counters.pipe = 0;
    counters.interceptor = 0;
    counters.handler = 0;

    app = await NestFactory.create<NestFastifyApplication>(
      SideEffectModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    app.useGlobalGuards(new CountingGuard());
    app.useGlobalInterceptors(new CountingInterceptor());
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    // Request A (slow) occupies the only socket
    const requestA = request(port, '/slow?q=1', agent);
    await new Promise(r => setTimeout(r, 100));

    const closePromise = app.close();
    await new Promise(r => setTimeout(r, 0));

    // Request B is queued on the same connection and arrives after the
    // shutdown state has been established
    const requestB = request(port, '/slow?q=2', agent);

    const responseA = await requestA;
    expect(responseA.status).toBe(200);

    const responseB = await requestB;
    expect(responseB.status).toBe(503);
    expect(responseB.body).toBe('Service Unavailable');
    expect(responseB.headers['connection']).toBe('close');

    await closePromise;

    // Only request A was allowed into the Nest pipeline
    expect(counters.guard).toBe(1);
    expect(counters.pipe).toBe(1);
    expect(counters.interceptor).toBe(1);
    expect(counters.handler).toBe(1);

    agent.destroy();
  }, 10000);

  it('should finish closing when an in-flight request throws', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      SideEffectModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const requestPromise = request(port, '/boom');
    await new Promise(r => setTimeout(r, 20));

    const closePromise = app.close();

    const response = await requestPromise;
    expect(response.status).toBe(500);

    await closePromise;
  }, 10000);

  it('should finish closing when the client aborts an in-flight request', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const req = http.get(`http://localhost:${port}/slow`);
    req.on('error', () => {});
    await new Promise(r => setTimeout(r, 100));

    // Abort the in-flight request, then shut down
    req.destroy();

    await app.close();
  }, 10000);

  it('should be idempotent across repeated close() calls', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);

    await app.close();
    await expect(app.close()).resolves.toBeUndefined();
  }, 10000);

  it('should preserve status and body of an in-flight request that throws', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const requestPromise = request(port, '/error');
    await new Promise(r => setTimeout(r, 20));

    const closePromise = app.close();

    const response = await requestPromise;
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      statusCode: 500,
      message: 'Internal server error',
    });

    await closePromise;
  }, 10000);

  it('should complete an in-flight echo request and echo the body back', async () => {
    resetAppCounters();
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const requestPromise = post(port, '/echo', '{"hello":"world"}');
    await new Promise(r => setTimeout(r, 50));

    const closePromise = app.close();

    const response = await requestPromise;
    expect(response.status).toBe(201);
    expect(response.body).toBe('{"hello":"world"}');
    expect(appCounters.echo).toBe(1);

    await closePromise;
  }, 10000);

  it('should reject a request whose body completes after the shutdown began, without side effects', async () => {
    resetAppCounters();
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise(resolve => socket.on('connect', resolve));

    const body = '{"hello":"world"}';
    const firstChunk = body.slice(0, 5);
    const rest = body.slice(5);

    let rawResponse = '';
    socket.on('data', chunk => (rawResponse += chunk.toString()));

    // Send the headers and only the first chunk of the body
    socket.write(
      `POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${firstChunk}`,
    );
    await new Promise(r => setTimeout(r, 100));

    // Begin the shutdown while the body is still incomplete
    const closePromise = app.close();
    await new Promise(r => setTimeout(r, 50));

    // Send the remaining bytes, then try to pipeline a next request
    socket.write(rest);
    socket.write(
      `POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );

    await new Promise(r => setTimeout(r, 300));

    // The request is rejected with the 503 contract (or the connection is
    // closed); the late bytes must not pollute the pipelined request and
    // neither request may reach the handler
    expect(rawResponse).toMatch(/^HTTP\/1\.1 503 Service Unavailable/);
    expect(rawResponse).toContain('connection: close');
    expect(rawResponse).toContain('Service Unavailable');
    expect(appCounters.echo).toBe(0);

    socket.destroy();
    await closePromise;
  }, 10000);

  it('should wait for the in-flight request on concurrent close() calls and run cleanup once', async () => {
    resetCleanupCounters();
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const requestPromise = request(port, '/slow?delay=400');
    await new Promise(r => setTimeout(r, 100));

    const close1 = app.close();
    const close2 = app.close();

    let close1Settled = false;
    let close2Settled = false;
    close1.then(() => (close1Settled = true));
    close2.then(() => (close2Settled = true));

    // While the delayed request is still in flight, neither close() may settle
    await new Promise(r => setTimeout(r, 100));
    expect(close1Settled).toBe(false);
    expect(close2Settled).toBe(false);

    const response = await requestPromise;
    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');

    await Promise.all([close1, close2]);

    expect(cleanupCounters.onModuleDestroy).toBe(1);
    expect(cleanupCounters.beforeApplicationShutdown).toBe(1);
    expect(cleanupCounters.onApplicationShutdown).toBe(1);
  }, 10000);

  it('should not re-listen or allow traffic after close has completed', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        return503OnClosing: true,
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    await app.close();
    await expect(app.close()).resolves.toBeUndefined();

    // The server is not listening anymore and no traffic is allowed through
    await expect(request(port, '/slow')).rejects.toThrow();
  }, 10000);

  it('should not install the gate when return503OnClosing is not enabled', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const response = await request(port, '/slow?delay=10');
    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');
  }, 10000);
});
