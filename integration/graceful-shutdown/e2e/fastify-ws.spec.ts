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
import {
  GRACEFUL_WS_PATH,
  resetWsCounters,
  wsCounters,
} from '../src/graceful-ws.gateway.js';

interface UpgradeRejection {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const createAppUnmanaged = async (
  options: { gateEnabled?: boolean } = {},
): Promise<{ app: INestApplication; port: number }> => {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(
      options.gateEnabled === false ? {} : { return503OnClosing: true },
    ),
    { logger: false },
  );
  await app.listen(0);
  const port = (app.getHttpServer().address() as { port: number }).port;
  return { app, port };
};

/**
 * Attempts a WebSocket upgrade that the server is expected to reject at the
 * HTTP layer, resolving with the raw response instead of opening a socket.
 */
const expectRejectedUpgrade = (
  url: string,
  extra: WebSocket.ClientOptions = {},
): Promise<UpgradeRejection> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, extra);
    ws.on('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', chunk => (body += chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body,
        }),
      );
    });
    ws.on('open', () => reject(new Error('Upgrade unexpectedly succeeded')));
    ws.on('error', () => {
      /* the rejected upgrade also surfaces as an error; ignored here */
    });
  });

const httpGet = (port: number, path: string): Promise<{ status: number }> =>
  new Promise((resolve, reject) => {
    http
      .get(
        `http://localhost:${port}${path}`,
        { headers: { Connection: 'close' } },
        res => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode || 0 }));
        },
      )
      .on('error', reject);
  });

const openWs = (url: string) => {
  const ws = new WebSocket(url);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
};

/**
 * Waits until the server-side counters match the predicate. A client observes
 * its own close before the server processes the closing frame, so asserting
 * counters straight after a client-side event races the server; polling the
 * in-process counters observes the actual server state.
 */
const waitForCounters = (
  predicate: (counters: typeof wsCounters) => boolean,
  timeoutMs = 3000,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (predicate(wsCounters)) {
      resolve();
      return;
    }
    const interval = setInterval(() => {
      if (predicate(wsCounters)) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve();
      }
    }, 10);
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Counters never matched: ${JSON.stringify(wsCounters)}`));
    }, timeoutMs);
  });

describe('Graceful Shutdown (Fastify) - WebSocket lifecycle', () => {
  let app: INestApplication;

  /**
   * Creates the app and registers it with the outer "app" so afterEach always
   * tears down the instance that belongs to the running test, even when a test
   * only destructures the port.
   */
  const createApp = async (
    options: { gateEnabled?: boolean } = {},
  ): Promise<{ app: INestApplication; port: number }> => {
    const created = await createAppUnmanaged(options);
    app = created.app;
    return created;
  };

  beforeEach(() => resetWsCounters());

  afterEach(async () => {
    if (app) {
      await app.close();
      // Wait for every server-side close event to land before the next test
      // resets the counters, so an established connection torn down here does
      // not decrement the next test's counter below zero.
      await waitForCounters(() => wsCounters.activeConnections === 0).catch(
        () => {},
      );
      app = undefined as unknown as INestApplication;
    }
  });

  describe('business protocol while serving', () => {
    it('echoes only the data after the delay and counts the message', async () => {
      const { port } = await createApp();

      const ws = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      const started = Date.now();
      ws.send(JSON.stringify({ type: 'echo', data: 'hello-1', delay: 120 }));

      const raw = await new Promise<WebSocket.Data>(resolve =>
        ws.once('message', resolve),
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      expect(raw.toString()).toBe('hello-1');

      ws.send(JSON.stringify({ type: 'echo', data: 'hello-2', delay: 10 }));
      const raw2 = await new Promise<WebSocket.Data>(resolve =>
        ws.once('message', resolve),
      );
      expect(raw2.toString()).toBe('hello-2');

      const stats = await httpGet(port, '/graceful-ws/stats');
      expect(stats.status).toBe(200);
      expect(wsCounters.activeConnections).toBe(1);
      expect(wsCounters.completedMessages).toBe(2);
      expect(wsCounters.cleanupCount).toBe(0);

      ws.close();
      await new Promise(resolve => ws.once('close', resolve));
      await waitForCounters(c => c.activeConnections === 0);
    });

    it('does not count an echo when the client aborts before the reply', async () => {
      const { port } = await createApp();

      const ws = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      ws.send(JSON.stringify({ type: 'echo', data: 'late', delay: 300 }));

      await new Promise(resolve => setTimeout(resolve, 80));
      ws.terminate();
      await waitForCounters(c => c.activeConnections === 0);

      expect(wsCounters.completedMessages).toBe(0);
    });

    it('closes only the failing connection with 1011/"gateway error"', async () => {
      const { port } = await createApp();

      const failing = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      const healthy = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      expect(wsCounters.activeConnections).toBe(2);

      failing.send(JSON.stringify({ type: 'error' }));
      const [code, reason] = await new Promise<[number, Buffer]>(resolve =>
        failing.once('close', (c, r) => resolve([c, r])),
      );
      expect(code).toBe(1011);
      expect(reason.toString()).toBe('gateway error');

      // Wait for the server to register the failed connection's close before
      // expecting only the healthy one to remain.
      await waitForCounters(c => c.activeConnections === 1);

      // The healthy connection keeps working and its echo still counts.
      healthy.send(JSON.stringify({ type: 'echo', data: 'still-here', delay: 5 }));
      const raw = await new Promise<WebSocket.Data>(resolve =>
        healthy.once('message', resolve),
      );
      expect(raw.toString()).toBe('still-here');

      // Errors and aborts never increase the completed-message counter.
      expect(wsCounters.completedMessages).toBe(1);
      expect(wsCounters.cleanupCount).toBe(0);

      healthy.close();
      await new Promise(resolve => healthy.once('close', resolve));
    });

    it('serves stats repeatedly without the read affecting any counter', async () => {
      const { port } = await createApp();

      const ws = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      ws.send(JSON.stringify({ type: 'echo', data: 'x', delay: 5 }));
      await new Promise(resolve => ws.once('message', resolve));

      const first = await httpGet(port, '/graceful-ws/stats');
      const second = await httpGet(port, '/graceful-ws/stats');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(wsCounters).toEqual({
        activeConnections: 1,
        completedMessages: 1,
        cleanupCount: 0,
      });

      ws.close();
      await new Promise(resolve => ws.once('close', resolve));
    });

    it('does not let a failed handshake poison later HTTP requests or upgrades', async () => {
      const { port } = await createApp();

      // A malformed handshake (invalid key) on its own connection is rejected
      // and the socket is closed...
      const malformed = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(port, '127.0.0.1');
        socket.on('error', reject);
        socket.once('connect', () => {
          socket.write(
            `GET ${GRACEFUL_WS_PATH} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          );
        });
        let data = '';
        socket.on('data', chunk => (data += chunk));
        socket.on('end', () => resolve(data));
      });
      expect(malformed).toMatch(/ 400 /);

      // ...a follow-up plain HTTP request on a new connection still works...
      const stats = await httpGet(port, '/graceful-ws/stats');
      expect(stats.status).toBe(200);

      // ...and the next, well-formed upgrade succeeds.
      const ws = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await new Promise(resolve => ws.once('close', resolve));
    });
  });

  describe('drain during close()', () => {
    it('keeps pre-close connections alive and waits for delayed echoes', async () => {
      const { app: closedApp, port } = await createApp();
      app = closedApp;

      const ws = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      const sentAt = Date.now();
      ws.send(JSON.stringify({ type: 'echo', data: 'draining', delay: 300 }));

      // Make sure the message is in flight (timer armed) before shutting down,
      // without assuming how long that wait takes under load.
      await new Promise(resolve => setTimeout(resolve, 80));
      const closePromise = app.close();

      const raw = await new Promise<WebSocket.Data>(resolve =>
        ws.once('message', resolve),
      );
      expect(raw.toString()).toBe('draining');
      await new Promise(resolve => ws.once('close', resolve));

      await closePromise;
      // close() returned only after the 300ms in-flight echo (and its
      // connection) had finished, not when the shutdown started.
      expect(Date.now() - sentAt).toBeGreaterThanOrEqual(280);
      expect(wsCounters.activeConnections).toBe(0);
      expect(wsCounters.completedMessages).toBe(1);
    }, 10000);

    it('waits while connections converge through errors and client aborts', async () => {
      const { app: closedApp, port } = await createApp();
      app = closedApp;

      const erroring = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      const aborting = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      const delayed = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      expect(wsCounters.activeConnections).toBe(3);

      delayed.send(JSON.stringify({ type: 'echo', data: 'last', delay: 300 }));
      erroring.send(JSON.stringify({ type: 'error' }));

      // Register all observers before the shutdown: the 1011 failure and the
      // reply arrive on their own schedules during the drain.
      const errorCode = new Promise<[number, Buffer]>(resolve =>
        erroring.once('close', (c, r) => resolve([c, r])),
      );
      const delayedReply = new Promise<WebSocket.Data>(resolve =>
        delayed.once('message', resolve),
      );
      const delayedClosed = new Promise<void>(resolve =>
        delayed.once('close', () => resolve()),
      );

      const closePromise = app.close();
      // Give the shutdown state a moment to establish before the abort.
      await new Promise(resolve => setTimeout(resolve, 30));
      aborting.terminate();

      const [code] = await errorCode;
      expect(code).toBe(1011);

      const reply = await delayedReply;
      expect(reply.toString()).toBe('last');
      await delayedClosed;

      await closePromise;
      await waitForCounters(
        c => c.activeConnections === 0 && c.completedMessages === 1,
      );
      expect(wsCounters.cleanupCount).toBe(1);
    }, 10000);

    it('runs cleanup exactly once across concurrent and repeated close() calls', async () => {
      const { app: closedApp, port } = await createApp();
      app = closedApp;

      const ws = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      ws.send(JSON.stringify({ type: 'echo', data: 'once', delay: 250 }));
      await new Promise(resolve => setTimeout(resolve, 50));

      await Promise.all([app.close(), app.close()]);
      await app.close();

      expect(wsCounters.cleanupCount).toBe(1);
      expect(wsCounters.activeConnections).toBe(0);
      expect(wsCounters.completedMessages).toBe(1);
    }, 10000);
  });

  describe('upgrade rejection once closing', () => {
    it('rejects an upgrade on a brand new connection with 503 plain text', async () => {
      const { app: closedApp, port } = await createApp();
      app = closedApp;

      const ws = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      ws.send(JSON.stringify({ type: 'echo', data: 'keep-busy', delay: 400 }));
      await new Promise(resolve => setTimeout(resolve, 50));

      const closePromise = app.close();
      // Wait for the one legitimate teardown run to register, then snapshot:
      // the contract under test is that the *rejection* moves none of the
      // three counters.
      await waitForCounters(c => c.cleanupCount === 1);
      const countersBefore = { ...wsCounters };

      const rejection = await expectRejectedUpgrade(
        `ws://localhost:${port}${GRACEFUL_WS_PATH}`,
      );
      expect(rejection.status).toBe(503);
      expect(rejection.body).toBe('Service Unavailable');
      expect(rejection.headers['content-type']).toContain('text/plain');
      expect(rejection.headers['connection']).toBe('close');

      // The rejection must not enter the gateway or touch any counter.
      expect(wsCounters).toEqual(countersBefore);

      ws.terminate();
      await closePromise;
    }, 10000);

    it('rejects an upgrade attempted on a reused keep-alive connection', async () => {
      const { app: closedApp, port } = await createApp();
      app = closedApp;

      // Keep the shutdown window open with one established connection.
      const busy = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      busy.send(JSON.stringify({ type: 'echo', data: 'busy', delay: 400 }));

      // Plain HTTP traffic on a raw keep-alive connection, before shutdown.
      const socket = net.createConnection(port, '127.0.0.1');
      socket.on('error', () => {});
      await new Promise<void>(resolve => socket.once('connect', resolve));
      socket.write(
        `GET /graceful-ws/stats HTTP/1.1\r\nHost: localhost\r\n\r\n`,
      );
      await new Promise<void>(resolve => {
        socket.once('data', () => resolve());
      });

      const closePromise = app.close();
      // Wait for the one legitimate teardown run to register, then snapshot:
      // the contract under test is that the *rejection* moves none of the
      // three counters.
      await waitForCounters(c => c.cleanupCount === 1);
      const countersBefore = { ...wsCounters };
      await new Promise(resolve => setTimeout(resolve, 30));

      // Upgrade request pipelined on the already-established connection.
      let data = '';
      const ended = new Promise<void>(resolve => socket.once('end', resolve));
      socket.on('data', chunk => (data += chunk));
      socket.write(
        `GET ${GRACEFUL_WS_PATH} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      await ended;

      expect(data).toContain(' 503 ');
      expect(data.toLowerCase()).toContain('connection: close');
      expect(data).toContain('Service Unavailable');
      expect(wsCounters).toEqual(countersBefore);

      busy.terminate();
      await closePromise;
      socket.destroy();
    }, 10000);

    it('classifies a handshake split across the close boundary by what the server observes', async () => {
      const { app: closedApp, port } = await createApp();
      app = closedApp;

      // Hold the shutdown open so the server is definitely around when the
      // rest of the handshake arrives.
      const busy = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      busy.send(JSON.stringify({ type: 'echo', data: 'busy', delay: 400 }));

      const socket = net.createConnection(port, '127.0.0.1');
      socket.on('error', () => {});
      await new Promise<void>(resolve => socket.once('connect', resolve));

      // First part of the handshake goes out before the shutdown starts.
      socket.write(
        `GET ${GRACEFUL_WS_PATH} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`,
      );

      const closePromise = app.close();
      await new Promise(resolve => setTimeout(resolve, 50));

      // The handshake only becomes observable (complete headers) afterwards.
      let data = '';
      const ended = new Promise<void>(resolve => socket.once('end', resolve));
      socket.on('data', chunk => (data += chunk));
      socket.write(
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
      await ended;

      expect(data).toContain(' 503 ');
      expect(data.toLowerCase()).toContain('connection: close');
      expect(data).toContain('Service Unavailable');
      expect(wsCounters.activeConnections).toBe(1);

      busy.terminate();
      await closePromise;
      socket.destroy();
    }, 10000);
  });

  describe('after close() completed', () => {
    it('reports zero active connections and keeps stats readable in-process', async () => {
      const { app: closedApp, port } = await createApp();
      app = closedApp;

      const ws = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      ws.send(JSON.stringify({ type: 'echo', data: 'done', delay: 10 }));
      await new Promise(resolve => ws.once('message', resolve));
      ws.close();
      await new Promise(resolve => ws.once('close', resolve));

      await app.close();

      expect(wsCounters).toEqual({
        activeConnections: 0,
        completedMessages: 1,
        cleanupCount: 1,
      });

      // Neither plain HTTP nor a new upgrade can enter the business anymore.
      await expect(httpGet(port, '/graceful-ws/stats')).rejects.toThrow();
      await expect(
        openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`),
      ).rejects.toThrow();
    }, 10000);
  });

  describe('without the shutdown gate enabled', () => {
    it('keeps normal HTTP, keep-alive and WebSocket behavior compatible', async () => {
      const { app: runningApp, port } = await createApp({ gateEnabled: false });
      app = runningApp;

      // Two sequential requests share the keep-alive connection.
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const responses = await Promise.all([
        new Promise<number>((resolve, reject) => {
          http
            .get(`http://localhost:${port}/slow?delay=5`, { agent }, res => {
              res.resume();
              res.on('end', () => resolve(res.statusCode || 0));
            })
            .on('error', reject);
        }),
        new Promise<number>((resolve, reject) => {
          http
            .get(`http://localhost:${port}/graceful-ws/stats`, { agent }, res => {
              res.resume();
              res.on('end', () => resolve(res.statusCode || 0));
            })
            .on('error', reject);
        }),
      ]);
      expect(responses).toEqual([200, 200]);
      agent.destroy();

      // WebSockets and their error semantics work exactly as usual.
      const ws = await openWs(`ws://localhost:${port}${GRACEFUL_WS_PATH}`);
      ws.send(JSON.stringify({ type: 'echo', data: 'plain', delay: 5 }));
      const raw = await new Promise<WebSocket.Data>(resolve =>
        ws.once('message', resolve),
      );
      expect(raw.toString()).toBe('plain');

      ws.send(JSON.stringify({ type: 'error' }));
      const [code, reason] = await new Promise<[number, Buffer]>(resolve =>
        ws.once('close', (c, r) => resolve([c, r])),
      );
      expect(code).toBe(1011);
      expect(reason.toString()).toBe('gateway error');
    }, 10000);
  });
});
