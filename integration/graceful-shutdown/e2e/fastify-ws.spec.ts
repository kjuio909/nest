import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as http from 'http';
import * as net from 'net';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module.js';
import { resetWsCounters, wsCounters } from '../src/graceful-ws.gateway.js';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const getJson = (port: number, path: string): Promise<RawResponse> =>
  new Promise<RawResponse>((resolve, reject) => {
    http
      .get(
        `http://localhost:${port}${path}`,
        { headers: { Connection: 'close' } },
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

const openWs = (port: number) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/graceful-ws`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

const nextMessage = (ws: WebSocket) =>
  new Promise<string>((resolve, reject) => {
    ws.once('message', data => resolve(data.toString()));
    ws.once('error', reject);
  });

const nextClose = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>(resolve => {
    ws.once('close', (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });

const echo = (ws: WebSocket, data: string, delay: number) =>
  ws.send(JSON.stringify({ type: 'echo', data, delay }));

const flush = (ms = 20) => new Promise<void>(r => setTimeout(r, ms));

/** Raw HTTP/1.1 client socket with buffered response collection. */
const rawSocket = async (port: number) => {
  const socket = net.createConnection(port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise<void>(resolve => socket.once('connect', resolve));
  return socket;
};

const readUntilEnd = (socket: net.Socket) =>
  new Promise<string>(resolve => {
    let data = '';
    socket.on('data', chunk => (data += chunk.toString()));
    socket.on('end', () => resolve(data));
    socket.on('close', () => resolve(data));
  });

const UPGRADE_HEADERS = (port: number) =>
  [
    `GET /graceful-ws HTTP/1.1`,
    `Host: localhost:${port}`,
    `Upgrade: websocket`,
    `Connection: Upgrade`,
    `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`,
    `Sec-WebSocket-Version: 13`,
    '',
    '',
  ].join('\r\n');

describe('Graceful Shutdown (Fastify WebSocket)', () => {
  let app: INestApplication;
  const clients: Array<WebSocket | net.Socket> = [];

  const createApp = async (options: { gate?: boolean } = {}) => {
    const { gate = true } = options;
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      {
        return503OnClosing: gate,
        logger: false,
      },
    );
    await app.listen(0);
    return app.getHttpServer().address().port as number;
  };

  const trackWs = async (port: number) => {
    const ws = await openWs(port);
    clients.push(ws);
    return ws;
  };

  const trackSocket = async (port: number) => {
    const socket = await rawSocket(port);
    clients.push(socket);
    return socket;
  };

  beforeEach(() => {
    resetWsCounters();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      if (client instanceof WebSocket) {
        client.terminate();
      } else {
        client.destroy();
      }
    }
    if (app) {
      await app.close().catch(() => {});
    }
  });

  describe('message lifecycle', () => {
    it('echoes data after the delay and counts completed messages', async () => {
      const port = await createApp();
      const ws = await trackWs(port);

      const stats0 = await getJson(port, '/graceful-ws/stats');
      expect(JSON.parse(stats0.body)).toEqual({
        activeConnections: 1,
        completedMessages: 0,
        cleanupCount: 0,
      });

      const started = Date.now();
      echo(ws, 'hello', 150);
      expect(await nextMessage(ws)).toBe('hello');
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);

      const stats1 = await getJson(port, '/graceful-ws/stats');
      expect(JSON.parse(stats1.body)).toEqual({
        activeConnections: 1,
        completedMessages: 1,
        cleanupCount: 0,
      });
    });

    it('does not count an echo when the client aborts before it is sent', async () => {
      const port = await createApp();
      const ws = await trackWs(port);

      echo(ws, 'late', 400);
      await flush(30);
      ws.terminate();
      await flush(500);

      const stats = await getJson(port, '/graceful-ws/stats');
      expect(JSON.parse(stats.body)).toEqual({
        activeConnections: 0,
        completedMessages: 0,
        cleanupCount: 0,
      });
    });

    it('closes only the faulting connection with 1011 "gateway error"', async () => {
      const port = await createApp();
      const faulting = await trackWs(port);
      const healthy = await trackWs(port);

      faulting.send(JSON.stringify({ type: 'error' }));
      const closed = await nextClose(faulting);
      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe('gateway error');

      // The other connection keeps serving, and errors never count.
      echo(healthy, 'still here', 10);
      expect(await nextMessage(healthy)).toBe('still here');

      const stats = await getJson(port, '/graceful-ws/stats');
      expect(JSON.parse(stats.body)).toEqual({
        activeConnections: 1,
        completedMessages: 1,
        cleanupCount: 0,
      });
    });

    it('reports stats reads without mutating any counter', async () => {
      const port = await createApp();
      const ws = await trackWs(port);
      echo(ws, 'one', 5);
      expect(await nextMessage(ws)).toBe('one');

      const first = JSON.parse(
        (await getJson(port, '/graceful-ws/stats')).body,
      );
      const second = JSON.parse(
        (await getJson(port, '/graceful-ws/stats')).body,
      );
      expect(second).toEqual(first);
      expect(second.completedMessages).toBe(1);
    });
  });

  describe('drain on shutdown', () => {
    it('waits for a delayed echo on an established connection', async () => {
      const port = await createApp();
      const ws = await trackWs(port);
      echo(ws, 'drain me', 300);
      const reply = nextMessage(ws);

      await flush(50);
      const closePromise = app.close();
      await flush(50);

      // The connection is retained while its in-flight work converges.
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(await reply).toBe('drain me');

      await closePromise;
      expect(wsCounters).toEqual({
        activeConnections: 0,
        completedMessages: 1,
        cleanupCount: 1,
      });
    });

    it('lets an in-flight error frame converge with code 1011', async () => {
      const port = await createApp();
      const ws = await trackWs(port);

      ws.send(JSON.stringify({ type: 'error' }));
      const closedPromise = nextClose(ws);

      // Let the error message enter in-flight processing before the shutdown
      // boundary is established.
      await flush(20);
      const closePromise = app.close();
      const closed = await closedPromise;
      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe('gateway error');

      await closePromise;
      expect(wsCounters).toEqual({
        activeConnections: 0,
        completedMessages: 0,
        cleanupCount: 1,
      });
    });

    it('converges when a client aborts during shutdown', async () => {
      const port = await createApp();
      const ws = await trackWs(port);
      echo(ws, 'never sent', 500);
      await flush(30);

      const closePromise = app.close();
      ws.terminate();

      await closePromise;
      expect(wsCounters).toEqual({
        activeConnections: 0,
        completedMessages: 0,
        cleanupCount: 1,
      });
    });

    it('runs cleanup exactly once across concurrent close() calls', async () => {
      const port = await createApp();
      const ws = await trackWs(port);
      echo(ws, 'once', 250);
      const reply = nextMessage(ws);

      await flush(30);
      const start = Date.now();
      const closePromise = Promise.all([app.close(), app.close(), app.close()]);
      expect(Date.now() - start).toBeLessThan(200);

      expect(await reply).toBe('once');
      await closePromise;

      expect(wsCounters).toEqual({
        activeConnections: 0,
        completedMessages: 1,
        cleanupCount: 1,
      });
    });
  });

  describe('upgrade gate after shutdown started', () => {
    it('rejects a new upgrade with HTTP 503, plain text and Connection: close', async () => {
      const port = await createApp();
      // An established connection keeps the server alive while closing.
      const established = await trackWs(port);
      echo(established, 'slow', 400);
      const reply = nextMessage(established);
      await flush(20);

      const closePromise = app.close();
      await flush(30);

      const socket = await trackSocket(port);
      socket.write(UPGRADE_HEADERS(port));
      const response = await readUntilEnd(socket);

      expect(response).toContain('503 Service Unavailable');
      expect(response.toLowerCase()).toContain('content-type: text/plain');
      expect(response.toLowerCase()).toContain('connection: close');
      expect(response).toContain('Service Unavailable');
      expect(response.toLowerCase()).not.toContain('101 switching protocols');

      // Rejection must not affect the connection accepted before shutdown.
      expect(await reply).toBe('slow');
      await closePromise;

      expect(wsCounters).toEqual({
        activeConnections: 0,
        completedMessages: 1,
        cleanupCount: 1,
      });
    });

    it('rejects an upgrade pipelined on a reused keep-alive connection', async () => {
      const port = await createApp();
      const established = await trackWs(port);
      echo(established, 'slow', 400);

      const socket = await trackSocket(port);
      // Reuse this very socket: a normal keep-alive HTTP request first.
      socket.write(
        `GET /graceful-ws/stats HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`,
      );
      const ok = await new Promise<string>(resolve => {
        let data = '';
        const onData = (chunk: Buffer) => {
          data += chunk.toString();
          if (data.includes(' 200 ')) {
            socket.removeListener('data', onData);
            resolve(data);
          }
        };
        socket.on('data', onData);
      });
      expect(ok).toContain(' 200 ');

      const closePromise = app.close();
      await flush(30);

      socket.write(UPGRADE_HEADERS(port));
      const response = await readUntilEnd(socket);
      expect(response).toContain('503 Service Unavailable');
      expect(response.toLowerCase()).toContain('connection: close');

      await closePromise;
    });

    it('classifies split handshake headers by what the server observed first', async () => {
      const port = await createApp();
      const established = await trackWs(port);
      echo(established, 'slow', 500);

      // Headers completed before the shutdown boundary: accepted.
      const acceptedSocket = await trackSocket(port);
      acceptedSocket.write(UPGRADE_HEADERS(port));
      const accepted = await new Promise<string>(resolve => {
        let data = '';
        const onData = (chunk: Buffer) => {
          data += chunk.toString();
          if (data.includes('101')) {
            acceptedSocket.removeListener('data', onData);
            resolve(data);
          }
        };
        acceptedSocket.on('data', onData);
      });
      expect(accepted).toContain('101 Switching Protocols');
      // This raw socket cannot answer the server's WebSocket closing
      // handshake; release it now (its mere acceptance is what the test
      // asserts) so the shutdown drain cannot wait on it.
      acceptedSocket.destroy();

      // Headers straddle the boundary: only a prefix is observed beforehand,
      // the terminating blank line arrives after shutdown: rejected.
      const partialSocket = await trackSocket(port);
      partialSocket.write(
        `GET /graceful-ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\n`,
      );
      await flush(30);

      const closePromise = app.close();
      await flush(30);

      partialSocket.write(
        `Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      const rejected = await readUntilEnd(partialSocket);
      expect(rejected).toContain('503 Service Unavailable');
      expect(rejected.toLowerCase()).toContain('connection: close');

      await closePromise;
    });

    it('does not let failed handshakes pollute later traffic', async () => {
      const port = await createApp();

      // An upgrade to an unknown path fails while the app is healthy...
      const stray = await trackSocket(port);
      stray.write(UPGRADE_HEADERS(port).replace('/graceful-ws', '/nope'));
      await flush(50);

      // ...yet ordinary HTTP and the next valid upgrade still work.
      const stats = await getJson(port, '/graceful-ws/stats');
      expect(stats.status).toBe(200);
      const ws = await trackWs(port);
      echo(ws, 'clean', 5);
      expect(await nextMessage(ws)).toBe('clean');
      expect(
        JSON.parse((await getJson(port, '/graceful-ws/stats')).body),
      ).toEqual({
        activeConnections: 1,
        completedMessages: 1,
        cleanupCount: 0,
      });
    });

    it('does not move the counters when rejecting an upgrade', async () => {
      const port = await createApp();
      const established = await trackWs(port);
      echo(established, 'slow', 400);
      const reply = nextMessage(established);
      await flush(20);

      const closePromise = app.close();
      await flush(30);

      const socket = await trackSocket(port);
      socket.write(UPGRADE_HEADERS(port));
      await readUntilEnd(socket);

      await reply;
      await closePromise;

      // Only the established echo completed; the rejected upgrade created no
      // connection, no message and no extra cleanup.
      expect(wsCounters).toEqual({
        activeConnections: 0,
        completedMessages: 1,
        cleanupCount: 1,
      });
    });
  });

  describe('after close completed', () => {
    it('admits no new HTTP or WebSocket traffic but keeps stats readable', async () => {
      const port = await createApp();
      const ws = await trackWs(port);
      echo(ws, 'done', 5);
      expect(await nextMessage(ws)).toBe('done');

      await app.close();
      await app.close();

      await expect(openWs(port)).rejects.toThrow();
      await expect(getJson(port, '/graceful-ws/stats')).rejects.toThrow();

      // The final figures remain readable in-process, and the closed
      // instance performs no business work or cleanup on repeated closes.
      expect(wsCounters).toEqual({
        activeConnections: 0,
        completedMessages: 1,
        cleanupCount: 1,
      });
    });
  });

  describe('without the shutdown gate', () => {
    it('keeps serving the WebSocket probe and ordinary routes normally', async () => {
      const port = await createApp({ gate: false });

      const ws = await trackWs(port);
      echo(ws, 'plain', 10);
      expect(await nextMessage(ws)).toBe('plain');

      const stats = await getJson(port, '/graceful-ws/stats');
      expect(stats.status).toBe(200);
      expect(JSON.parse(stats.body).completedMessages).toBe(1);

      // Close still converges and cleanup runs exactly once.
      await app.close();
      await app.close();
      expect(wsCounters.cleanupCount).toBe(1);
    });
  });
});
