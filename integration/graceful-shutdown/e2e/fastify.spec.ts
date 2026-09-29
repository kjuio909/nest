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
import { AppModule } from '../src/app.module.js';
import { appCounters, resetAppCounters } from '../src/app.controller.js';

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
      `http://localhost:${port}${path}`,
      {
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

  it('should enable the gate via the FastifyAdapter "return503OnClosing" option', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ return503OnClosing: true }),
      {
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    // Request A (slow) occupies the only socket
    const requestA = request(port, '/slow', agent);
    await new Promise(r => setTimeout(r, 100));

    const closePromise = app.close();
    await new Promise(r => setTimeout(r, 0));

    // Request B is queued on the same connection and arrives after the
    // shutdown state has been established
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

  it('should reject a request whose body completes after shutdown started, without side effects', async () => {
    resetAppCounters();

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ return503OnClosing: true }),
      {
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const socket = net.createConnection(port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise<void>(resolve => socket.once('connect', resolve));

    const body = JSON.stringify({ hello: 'world' });
    socket.write(
      `POST /echo HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`,
    );
    // Only the first chunk of the body goes out before the shutdown starts
    socket.write(body.slice(0, 5));
    await new Promise(r => setTimeout(r, 50));

    const closePromise = app.close();
    // Let the shutdown state establish
    await new Promise(r => setTimeout(r, 50));

    // The remaining bytes arrive after the shutdown has started
    socket.write(body.slice(5));

    // The server answers with the rejection and closes the connection
    const rawResponse = await new Promise<string>(resolve => {
      let data = '';
      socket.on('data', chunk => (data += chunk));
      socket.on('end', () => resolve(data));
    });
    expect(rawResponse).toContain(' 503 ');
    expect(rawResponse.toLowerCase()).toContain('connection: close');
    expect(rawResponse).toContain('Service Unavailable');

    // A follow-up request on the same connection cannot go through anymore:
    // the connection is closed, so it gets no response at all
    let extraData = '';
    socket.on('data', chunk => (extraData += chunk));
    socket.write('GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await new Promise(r => setTimeout(r, 150));
    expect(extraData).toBe('');

    await closePromise;

    // The late body bytes must not trigger any business side effect
    expect(appCounters.echoCount).toBe(0);
    expect(appCounters.handlerEntries).toBe(0);

    socket.destroy();
  }, 10000);

  it('should preserve status and body of an in-flight request that throws', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ return503OnClosing: true }),
      {
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
    expect(response.body).toContain('Internal server error');

    await closePromise;
  }, 10000);

  it('should wait for the in-flight request and run cleanup once across concurrent close() calls', async () => {
    resetAppCounters();

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ return503OnClosing: true }),
      {
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    let requestSettled = false;
    const requestPromise = request(port, '/slow?delay=400').then(response => {
      requestSettled = true;
      return response;
    });
    await new Promise(r => setTimeout(r, 100));

    // Two concurrent close() calls share the same shutdown cycle
    const closeStart = Date.now();
    await Promise.all([app.close(), app.close()]);
    const closeElapsed = Date.now() - closeStart;

    // Both calls resolved only after the in-flight request had finished
    // (the remaining ~300ms of work had to elapse first)
    expect(closeElapsed).toBeGreaterThanOrEqual(150);
    const response = await requestPromise;
    expect(requestSettled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');

    // Cleanup ran exactly once
    expect(appCounters.cleanupCount).toBe(1);
  }, 10000);

  it('should not re-listen or allow traffic after close() completed', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ return503OnClosing: true }),
      {
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

  it('should serve requests and echoes normally when the option is not enabled', async () => {
    resetAppCounters();

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        logger: false,
      },
    );
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const slow = await request(port, '/slow?delay=50');
    expect(slow.status).toBe(200);
    expect(slow.body).toBe('ok');

    const echoed = await new Promise<RawResponse>((resolve, reject) => {
      const body = JSON.stringify({ hello: 'world' });
      const req = http.request(
        `http://localhost:${port}/echo`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Connection: 'close',
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
    expect(echoed.status).toBe(201);
    expect(JSON.parse(echoed.body)).toEqual({ hello: 'world' });
    expect(appCounters.echoCount).toBe(1);
  }, 10000);

  describe('/graceful-probe', () => {
    const createApp = async (
      options: { viaAdapter?: boolean } = {},
    ): Promise<{ app: INestApplication; port: number }> => {
      app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        options.viaAdapter
          ? new FastifyAdapter({ return503OnClosing: true })
          : new FastifyAdapter(),
        {
          return503OnClosing: options.viaAdapter ? undefined : true,
          logger: false,
        },
      );
      await app.listen(0);
      return { app, port: app.getHttpServer().address().port };
    };

    it('slow mode succeeds after the delay and counts the handler entry', async () => {
      resetAppCounters();
      const { port } = await createApp();

      const started = Date.now();
      const response = await request(
        port,
        '/graceful-probe?mode=slow&delay=100',
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(80);
      expect(response.status).toBe(200);
      expect(response.body).toBe('ok');
      expect(appCounters.handlerEntries).toBe(1);
      expect(appCounters.echoCount).toBe(0);
    }, 10000);

    it('error mode preserves the original status and body after the delay', async () => {
      resetAppCounters();
      const { port } = await createApp();

      const response = await request(
        port,
        '/graceful-probe?mode=error&delay=50',
      );
      expect(response.status).toBe(500);
      expect(response.body).toContain('Internal server error');
      // The failed request still entered the handler once and is not rolled back
      expect(appCounters.handlerEntries).toBe(1);
    }, 10000);

    it('stats mode reports handler, body and cleanup counters without side effects', async () => {
      resetAppCounters();
      const { port } = await createApp();

      await request(port, '/graceful-probe?mode=slow&delay=10');
      const body = JSON.stringify({ hello: 'world' });
      const echoed = await post(port, '/graceful-probe?mode=echo', body);
      expect(echoed.status).toBe(201);
      expect(JSON.parse(echoed.body)).toEqual({ hello: 'world' });

      const stats = await request(port, '/graceful-probe?mode=stats');
      expect(stats.status).toBe(200);
      expect(JSON.parse(stats.body)).toEqual({
        handlerEntries: 2,
        echoCount: 1,
        cleanupCount: 0,
      });
    }, 10000);

    it('echo mode counts the full body only once and echoes its content', async () => {
      resetAppCounters();
      const { port } = await createApp();

      const echoed = await post(
        port,
        '/graceful-probe?mode=echo',
        JSON.stringify({ a: 1, b: [2, 3] }),
      );
      expect(echoed.status).toBe(201);
      expect(JSON.parse(echoed.body)).toEqual({ a: 1, b: [2, 3] });
      expect(appCounters.handlerEntries).toBe(1);
      expect(appCounters.echoCount).toBe(1);
    }, 10000);

    it('lets an in-flight slow probe finish when close() is called meanwhile', async () => {
      resetAppCounters();
      const { port } = await createApp();

      const requestPromise = request(
        port,
        '/graceful-probe?mode=slow&delay=300',
      );
      await new Promise(r => setTimeout(r, 100));

      const closePromise = app.close();
      const response = await requestPromise;
      expect(response.status).toBe(200);
      expect(response.body).toBe('ok');
      await closePromise;

      // The completed business work is not rolled back
      expect(appCounters.handlerEntries).toBe(1);
    }, 10000);

    it('exposes the final counters and cleanup-once after close completed', async () => {
      resetAppCounters();
      const { port } = await createApp();

      await request(port, '/graceful-probe?mode=slow&delay=10');
      await post(port, '/graceful-probe?mode=echo', JSON.stringify({ x: 1 }));

      await app.close();
      // Repeated (sequential) closes are no-ops: cleanup runs exactly once
      await app.close();

      expect(appCounters.handlerEntries).toBe(2);
      expect(appCounters.echoCount).toBe(1);
      expect(appCounters.cleanupCount).toBe(1);

      // The instance cannot receive requests anymore
      await expect(
        request(port, '/graceful-probe?mode=stats'),
      ).rejects.toThrow();
    }, 10000);

    it('rejects a partial-body probe after shutdown without polluting counters', async () => {
      resetAppCounters();
      const { port } = await createApp({ viaAdapter: true });

      const socket = net.createConnection(port, '127.0.0.1');
      socket.on('error', () => {});
      await new Promise<void>(resolve => socket.once('connect', resolve));

      const body = JSON.stringify({ hello: 'world' });
      socket.write(
        `POST /graceful-probe?mode=echo HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`,
      );
      socket.write(body.slice(0, 5));
      await new Promise(r => setTimeout(r, 50));

      const closePromise = app.close();
      await new Promise(r => setTimeout(r, 50));

      socket.write(body.slice(5));

      const rawResponse = await new Promise<string>(resolve => {
        let data = '';
        socket.on('data', chunk => (data += chunk));
        socket.on('end', () => resolve(data));
      });
      expect(rawResponse).toContain(' 503 ');
      expect(rawResponse.toLowerCase()).toContain('connection: close');
      expect(rawResponse).toContain('Service Unavailable');

      await closePromise;

      // Late body bytes never reached the business pipeline
      expect(appCounters.handlerEntries).toBe(0);
      expect(appCounters.echoCount).toBe(0);
      expect(appCounters.cleanupCount).toBe(1);

      socket.destroy();
    }, 10000);

    it('behaves identically when the gate is enabled via either option surface', async () => {
      resetAppCounters();
      const { port } = await createApp({ viaAdapter: true });

      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const requestA = request(
        port,
        '/graceful-probe?mode=slow&delay=300',
        agent,
      );
      await new Promise(r => setTimeout(r, 100));

      const closePromise = app.close();
      await new Promise(r => setTimeout(r, 0));

      const requestB = request(port, '/graceful-probe?mode=stats', agent);

      const responseA = await requestA;
      expect(responseA.status).toBe(200);
      expect(responseA.body).toBe('ok');

      const responseB = await requestB;
      expect(responseB.status).toBe(503);
      expect(responseB.body).toBe('Service Unavailable');
      expect(responseB.headers['connection']).toBe('close');

      await closePromise;
      agent.destroy();

      expect(appCounters.handlerEntries).toBe(1);
      expect(appCounters.cleanupCount).toBe(1);
    }, 10000);
  });
});
