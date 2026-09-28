import { INestApplication } from '@nestjs/common';
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

const postEcho = (
  port: number,
  body: string,
  path = '/graceful-probe/echo',
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

const createApp = (
  gate: 'adapter' | 'application' | 'off' = 'application',
): Promise<NestFastifyApplication> => {
  const adapter =
    gate === 'adapter'
      ? new FastifyAdapter({ return503OnClosing: true })
      : new FastifyAdapter();
  return NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    return503OnClosing: gate === 'application',
    logger: false,
  });
};

describe('Graceful Shutdown probe (Fastify)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET slow mode delays then succeeds and records the handler entry', async () => {
    resetAppCounters();
    app = await createApp();
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const start = Date.now();
    const response = await request(port, '/graceful-probe/slow?delay=100');
    const elapsed = Date.now() - start;

    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(appCounters.handlerEntries).toBe(1);

    // The same mode is selectable through the "mode" query parameter
    const responseByQuery = await request(
      port,
      '/graceful-probe?mode=slow&delay=10',
    );
    expect(responseByQuery.status).toBe(200);
    expect(responseByQuery.body).toBe('ok');
    expect(appCounters.handlerEntries).toBe(2);
  }, 10000);

  it('GET error mode preserves the original status and body after a delay', async () => {
    resetAppCounters();
    app = await createApp();
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const start = Date.now();
    const response = await request(port, '/graceful-probe/error?delay=100');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(response.status).toBe(500);
    expect(response.body).toContain('Internal server error');

    // A failed request still counts as completed business work: its handler
    // entry must not be rolled back.
    expect(appCounters.handlerEntries).toBe(1);
  }, 10000);

  it('GET stats mode reports handler, full-body and cleanup counts without mutating them', async () => {
    resetAppCounters();
    app = await createApp();
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    await request(port, '/graceful-probe/slow?delay=10');
    await postEcho(port, JSON.stringify({ hello: 'world' }));

    const stats1 = await request(port, '/graceful-probe/stats');
    expect(stats1.status).toBe(200);
    expect(JSON.parse(stats1.body)).toEqual({
      handlerEntries: 2,
      echoCount: 1,
      cleanupCount: 0,
    });

    // Reading stats is not business work and moves no counters
    const stats2 = await request(port, '/graceful-probe?mode=stats');
    expect(JSON.parse(stats2.body)).toEqual({
      handlerEntries: 2,
      echoCount: 1,
      cleanupCount: 0,
    });
  }, 10000);

  it('POST echo mode counts only after the full body arrived and echoes it', async () => {
    resetAppCounters();
    app = await createApp();
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const body = JSON.stringify({ a: 1, b: [2, 3] });
    const echoed = await postEcho(port, body);
    expect(echoed.status).toBe(201);
    expect(JSON.parse(echoed.body)).toEqual({ a: 1, b: [2, 3] });
    expect(appCounters.handlerEntries).toBe(1);
    expect(appCounters.echoCount).toBe(1);

    const echoedByQuery = await postEcho(
      port,
      JSON.stringify({ c: true }),
      '/graceful-probe?mode=echo',
    );
    expect(echoedByQuery.status).toBe(201);
    expect(JSON.parse(echoedByQuery.body)).toEqual({ c: true });
    expect(appCounters.echoCount).toBe(2);
  }, 10000);

  it('completes an in-flight probe request that entered the handler before close()', async () => {
    resetAppCounters();
    app = await createApp();
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const inFlight = request(port, '/graceful-probe/slow?delay=300');
    await new Promise(r => setTimeout(r, 100));

    const closePromise = app.close();

    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');

    await closePromise;
    expect(appCounters.handlerEntries).toBe(1);
    expect(appCounters.cleanupCount).toBe(1);
  }, 10000);

  it('preserves status and body of an in-flight error request across close()', async () => {
    resetAppCounters();
    app = await createApp();
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const inFlight = request(port, '/graceful-probe/error?delay=200');
    await new Promise(r => setTimeout(r, 100));

    const closePromise = app.close();

    const response = await inFlight;
    expect(response.status).toBe(500);
    expect(response.body).toContain('Internal server error');

    await closePromise;
    expect(appCounters.handlerEntries).toBe(1);
    expect(appCounters.cleanupCount).toBe(1);
  }, 10000);

  it('rejects a request queued on a keep-alive connection after close() without touching business counters', async () => {
    resetAppCounters();
    app = await createApp();
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    const requestA = request(port, '/graceful-probe/slow?delay=300', agent);
    await new Promise(r => setTimeout(r, 100));

    const closePromise = app.close();
    await new Promise(r => setTimeout(r, 0));

    const requestB = request(port, '/graceful-probe/slow?delay=10', agent);

    const responseA = await requestA;
    expect(responseA.status).toBe(200);

    const responseB = await requestB;
    expect(responseB.status).toBe(503);
    expect(responseB.body).toBe('Service Unavailable');
    expect(responseB.headers['connection']).toBe('close');

    await closePromise;

    // Only request A ran business work; the rejection entered no pipeline stage
    expect(appCounters.handlerEntries).toBe(1);
    expect(appCounters.echoCount).toBe(0);
    expect(appCounters.cleanupCount).toBe(1);

    agent.destroy();
  }, 10000);

  it('rejects a partially-sent echo body completed after close() and keeps the data out of counters', async () => {
    resetAppCounters();
    app = await createApp('adapter');
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const socket = net.createConnection(port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise<void>(resolve => socket.once('connect', resolve));

    const body = JSON.stringify({ hello: 'world' });
    socket.write(
      `POST /graceful-probe/echo HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`,
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

    // A pipelined follow-up cannot go through: the connection is over
    let extraData = '';
    socket.on('data', chunk => (extraData += chunk));
    socket.write(
      'GET /graceful-probe/slow HTTP/1.1\r\nHost: localhost\r\n\r\n',
    );
    await new Promise(r => setTimeout(r, 150));
    expect(extraData).toBe('');

    await closePromise;

    expect(appCounters.handlerEntries).toBe(0);
    expect(appCounters.echoCount).toBe(0);
    expect(appCounters.cleanupCount).toBe(1);

    socket.destroy();
  }, 10000);

  it('runs cleanup exactly once for concurrent and sequential repeated close() calls', async () => {
    resetAppCounters();
    app = await createApp();
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const inFlight = request(port, '/graceful-probe/slow?delay=300');
    await new Promise(r => setTimeout(r, 100));

    await Promise.all([app.close(), app.close()]);
    await app.close();
    await app.close();

    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(appCounters.cleanupCount).toBe(1);
  }, 10000);

  it('exposes the final counts after close() completed and never reopens for traffic', async () => {
    resetAppCounters();
    app = await createApp();
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    await request(port, '/graceful-probe/slow?delay=10');
    await postEcho(port, JSON.stringify({ hello: 'world' }));
    await request(port, '/graceful-probe/error?delay=10').catch(() => {});

    await app.close();

    // The same counters the stats endpoint served are still readable in
    // process after shutdown, with cleanup recorded exactly once
    expect(appCounters).toEqual({
      handlerEntries: 3,
      echoCount: 1,
      cleanupCount: 1,
    });

    // The instance cannot accept traffic again
    await expect(request(port, '/graceful-probe/stats')).rejects.toThrow();
  }, 10000);

  it('behaves identically whether the gate is enabled via the adapter or via application options', async () => {
    for (const where of ['adapter', 'application'] as const) {
      resetAppCounters();
      const gatedApp = await createApp(where);
      await gatedApp.listen(0);
      const gatedPort = (
        gatedApp.getHttpServer().address() as {
          port: number;
        }
      ).port;

      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const requestA = request(
        gatedPort,
        '/graceful-probe/slow?delay=200',
        agent,
      );
      await new Promise(r => setTimeout(r, 100));

      const closePromise = gatedApp.close();
      await new Promise(r => setTimeout(r, 0));

      const requestB = request(gatedPort, '/graceful-probe/stats', agent);

      expect((await requestA).status).toBe(200);
      const responseB = await requestB;
      expect(responseB.status).toBe(503);
      expect(responseB.body).toBe('Service Unavailable');
      expect(responseB.headers['connection']).toBe('close');

      await closePromise;
      expect(appCounters.cleanupCount).toBe(1);
      agent.destroy();
      app = undefined as unknown as INestApplication;
    }
  }, 15000);

  it('keeps normal and keep-alive semantics when the protection is disabled', async () => {
    resetAppCounters();
    app = await createApp('off');
    await app.listen(0);
    const port = app.getHttpServer().address().port;

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    // Multiple requests reuse the same keep-alive connection successfully
    const first = await request(port, '/graceful-probe/slow?delay=10', agent);
    const second = await request(port, '/graceful-probe/stats', agent);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body)).toEqual({
      handlerEntries: 1,
      echoCount: 0,
      cleanupCount: 0,
    });

    const echoed = await postEcho(
      port,
      JSON.stringify({ hello: 'world' }),
      '/graceful-probe/echo',
      agent,
    );
    expect(echoed.status).toBe(201);
    expect(JSON.parse(echoed.body)).toEqual({ hello: 'world' });
    expect(appCounters.echoCount).toBe(1);

    // Ordinary error handling is untouched
    const failed = await request(port, '/graceful-probe/error?delay=10', agent);
    expect(failed.status).toBe(500);

    agent.destroy();
  }, 10000);
});
