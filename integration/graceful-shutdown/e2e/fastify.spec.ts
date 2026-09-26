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
import { AppModule } from '../src/app.module.js';

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
});
