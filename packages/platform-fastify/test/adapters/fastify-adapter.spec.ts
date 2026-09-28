import { FastifyAdapter } from '../../adapters/fastify-adapter';
import { createError } from '@fastify/error';
import {
  HttpException,
  VERSION_NEUTRAL,
  VersioningOptions,
  VersioningType,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

describe('FastifyAdapter', () => {
  let fastifyAdapter: FastifyAdapter;

  beforeEach(() => {
    fastifyAdapter = new FastifyAdapter();
  });

  afterEach(() => vi.restoreAllMocks());

  describe('reply', () => {
    const createReply = () => ({
      status: vi.fn(),
      send: vi.fn(),
      getHeader: vi.fn(),
      header: vi.fn(),
    });

    it('should apply the given status code', () => {
      const reply = createReply();

      fastifyAdapter.reply(reply as any, { message: 'Oops' }, 404);

      expect(reply.status).toHaveBeenCalledWith(404);
    });

    it('should not apply any status code when it is omitted', () => {
      const reply = createReply();

      fastifyAdapter.reply(reply as any, { message: 'Hello' });

      expect(reply.status).not.toHaveBeenCalled();
    });

    it('should apply falsy status codes instead of dropping them', () => {
      // "0" and "NaN" are falsy, but they were still passed in. Forwarding them
      // lets fastify reject the value, whereas skipping the call leaves the
      // status that was set before the handler ran (200/201), so an error would
      // be sent with a successful status code.
      for (const statusCode of [0, NaN]) {
        const reply = createReply();

        fastifyAdapter.reply(reply as any, { message: 'Oops' }, statusCode);

        expect(reply.status).toHaveBeenCalledWith(statusCode);
      }
    });
  });

  describe('mapException', () => {
    it('should map FastifyError with status code to HttpException', () => {
      const FastifyErrorCls = createError(
        'FST_ERR_CTP_INVALID_MEDIA_TYPE',
        'Unsupported Media Type: %s',
        415,
      );
      const error = new FastifyErrorCls();

      const result = fastifyAdapter.mapException(error) as HttpException;

      expect(result).toBeInstanceOf(HttpException);
      expect(result.message).toBe(error.message);
      expect(result.getStatus()).toBe(415);
    });

    it('should return FastifyError without user status code to Internal Server Error HttpException', () => {
      const FastifyErrorCls = createError(
        'FST_WITHOUT_STATUS_CODE',
        'Error without status code',
      );
      const error = new FastifyErrorCls();

      const result = fastifyAdapter.mapException(error) as HttpException;
      expect(result).toBeInstanceOf(HttpException);
      expect(result.message).toBe(error.message);
      expect(result.getStatus()).toBe(500);
    });

    it('should return error if it is not FastifyError', () => {
      const error = new Error('Test error');
      const result = fastifyAdapter.mapException(error);
      expect(result).toBe(error);
    });
  });

  describe('appendHeader', () => {
    it('should append to an existing header instead of overwriting it', async () => {
      fastifyAdapter.initHttpServer();
      fastifyAdapter.get('/p', (_req, reply) => {
        fastifyAdapter.appendHeader(reply, 'x-a', '1');
        fastifyAdapter.appendHeader(reply, 'x-a', '2');
        fastifyAdapter.reply(reply, {
          got: fastifyAdapter.getHeader(reply, 'x-a'),
        });
      });

      await fastifyAdapter.getInstance().ready();
      const res = await fastifyAdapter.inject({ method: 'GET', url: '/p' });

      expect(JSON.parse(res.body).got).toEqual(['1', '2']);
      await fastifyAdapter.close();
    });

    it('should append after setHeader', async () => {
      fastifyAdapter.initHttpServer();
      fastifyAdapter.get('/p', (_req, reply) => {
        fastifyAdapter.setHeader(reply, 'x-a', '1');
        fastifyAdapter.appendHeader(reply, 'x-a', '2');
        fastifyAdapter.reply(reply, {
          got: fastifyAdapter.getHeader(reply, 'x-a'),
        });
      });

      await fastifyAdapter.getInstance().ready();
      const res = await fastifyAdapter.inject({ method: 'GET', url: '/p' });

      expect(JSON.parse(res.body).got).toEqual(['1', '2']);
      await fastifyAdapter.close();
    });

    it('should append when header names differ only by case', async () => {
      fastifyAdapter.initHttpServer();
      fastifyAdapter.get('/p', (_req, reply) => {
        fastifyAdapter.appendHeader(reply, 'X-A', '1');
        fastifyAdapter.appendHeader(reply, 'x-a', '2');
        fastifyAdapter.reply(reply, {
          got: fastifyAdapter.getHeader(reply, 'X-A'),
        });
      });

      await fastifyAdapter.getInstance().ready();
      const res = await fastifyAdapter.inject({ method: 'GET', url: '/p' });

      expect(JSON.parse(res.body).got).toEqual(['1', '2']);
      await fastifyAdapter.close();
    });

    it('should append more than two values', async () => {
      fastifyAdapter.initHttpServer();
      fastifyAdapter.get('/p', (_req, reply) => {
        fastifyAdapter.appendHeader(reply, 'x-a', '1');
        fastifyAdapter.appendHeader(reply, 'x-a', '2');
        fastifyAdapter.appendHeader(reply, 'x-a', '3');
        fastifyAdapter.reply(reply, {
          got: fastifyAdapter.getHeader(reply, 'x-a'),
        });
      });

      await fastifyAdapter.getInstance().ready();
      const res = await fastifyAdapter.inject({ method: 'GET', url: '/p' });

      expect(JSON.parse(res.body).got).toEqual(['1', '2', '3']);
      await fastifyAdapter.close();
    });

    it('should still append set-cookie values', async () => {
      fastifyAdapter.initHttpServer();
      fastifyAdapter.get('/p', (_req, reply) => {
        fastifyAdapter.appendHeader(reply, 'set-cookie', 'a=1');
        fastifyAdapter.appendHeader(reply, 'set-cookie', 'b=2');
        fastifyAdapter.reply(reply, {
          got: fastifyAdapter.getHeader(reply, 'set-cookie'),
        });
      });

      await fastifyAdapter.getInstance().ready();
      const res = await fastifyAdapter.inject({ method: 'GET', url: '/p' });

      expect(JSON.parse(res.body).got).toEqual(['a=1', 'b=2']);
      await fastifyAdapter.close();
    });

    it('should not duplicate set-cookie when appending a third value', async () => {
      fastifyAdapter.initHttpServer();
      fastifyAdapter.get('/p', (_req, reply) => {
        fastifyAdapter.appendHeader(reply, 'set-cookie', 'a=1');
        fastifyAdapter.appendHeader(reply, 'set-cookie', 'b=2');
        fastifyAdapter.appendHeader(reply, 'set-cookie', 'c=3');
        fastifyAdapter.reply(reply, {
          got: fastifyAdapter.getHeader(reply, 'set-cookie'),
        });
      });

      await fastifyAdapter.getInstance().ready();
      const res = await fastifyAdapter.inject({ method: 'GET', url: '/p' });

      expect(JSON.parse(res.body).got).toEqual(['a=1', 'b=2', 'c=3']);
      await fastifyAdapter.close();
    });
  });

  describe('applyVersionFilter', () => {
    const registerVersionNeutralRoute = (
      type: VersioningType.MEDIA_TYPE | VersioningType.HEADER,
    ) => {
      fastifyAdapter.initHttpServer();
      const handler = (_req: FastifyRequest, reply: FastifyReply) =>
        fastifyAdapter.reply(reply, { ok: true }, 200);
      const versioningOptions: VersioningOptions =
        type === VersioningType.MEDIA_TYPE
          ? { type, key: 'v=' }
          : { type, header: 'X-API-Version' };
      const versionedHandler = fastifyAdapter.applyVersionFilter(
        handler,
        [VERSION_NEUTRAL, '2'],
        versioningOptions,
      );
      fastifyAdapter.get('/neutral', versionedHandler);
    };

    afterEach(async () => {
      await fastifyAdapter.close();
    });

    it('should serve a version-neutral route when the accept header carries no version (media type versioning)', async () => {
      registerVersionNeutralRoute(VersioningType.MEDIA_TYPE);
      await fastifyAdapter.getInstance().ready();

      const res = await fastifyAdapter.inject({
        method: 'GET',
        url: '/neutral',
        headers: { accept: 'application/json' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('should serve a version-neutral route when the accept header is absent (media type versioning)', async () => {
      registerVersionNeutralRoute(VersioningType.MEDIA_TYPE);
      await fastifyAdapter.getInstance().ready();

      const res = await fastifyAdapter.inject({
        method: 'GET',
        url: '/neutral',
      });
      expect(res.statusCode).toBe(200);
    });

    it('should serve a version-neutral route when the version header is absent (header versioning)', async () => {
      registerVersionNeutralRoute(VersioningType.HEADER);
      await fastifyAdapter.getInstance().ready();

      const res = await fastifyAdapter.inject({
        method: 'GET',
        url: '/neutral',
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('close', () => {
    it('should be idempotent across repeated close() calls', async () => {
      fastifyAdapter.initHttpServer({ return503OnClosing: true });
      await fastifyAdapter.getInstance().ready();

      await fastifyAdapter.close();
      await expect(fastifyAdapter.close()).resolves.toBeUndefined();
    });

    it('should not throw when the server was never started', async () => {
      fastifyAdapter.initHttpServer({ return503OnClosing: true });

      await expect(fastifyAdapter.close()).resolves.toBeUndefined();
    });
  });

  describe('closing request gate', () => {
    const getRequestListeners = (adapter: FastifyAdapter) =>
      (adapter.getHttpServer() as import('http').Server).listeners('request');

    it('should not be installed by default', () => {
      fastifyAdapter.initHttpServer({});

      const listeners = getRequestListeners(fastifyAdapter);
      expect(listeners).toHaveLength(1);
      expect(listeners[0]).toBe(fastifyAdapter.getInstance().routing);
    });

    it('should be installed via the application option', () => {
      fastifyAdapter.initHttpServer({ return503OnClosing: true });

      const listeners = getRequestListeners(fastifyAdapter);
      expect(listeners).toHaveLength(1);
      expect(listeners[0]).not.toBe(fastifyAdapter.getInstance().routing);
    });

    it('should be installed via the adapter constructor option', () => {
      const adapter = new FastifyAdapter({ return503OnClosing: true });
      adapter.initHttpServer();

      const listeners = getRequestListeners(adapter);
      expect(listeners).toHaveLength(1);
      expect(listeners[0]).not.toBe(adapter.getInstance().routing);
    });

    it('should reject requests with 503 once the shutdown started', async () => {
      const adapter = new FastifyAdapter({ return503OnClosing: true });
      adapter.initHttpServer();
      adapter.beforeClose();

      const server = adapter.getHttpServer() as import('http').Server;
      const [listener] = getRequestListeners(adapter);

      const end = vi.fn();
      const res = {
        setHeader: vi.fn(),
        writeHead: vi.fn(),
        end,
      };
      listener({ httpVersionMajor: 1 } as any, res as any);

      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close');
      expect(res.writeHead).toHaveBeenCalledWith(503, {
        'Content-Type': 'text/plain',
      });
      expect(end).toHaveBeenCalledWith('Service Unavailable');

      await adapter.close();
      expect(server.listening).toBe(false);
    });

    it('should leave the upgrade event untouched when the gate is off', () => {
      fastifyAdapter.initHttpServer({});
      const server = fastifyAdapter.getHttpServer() as import('http').Server;
      const emit = server.emit;
      const listener = vi.fn();
      server.on('upgrade', listener);

      server.emit('upgrade', { httpVersion: '1.1' }, { destroyed: false }, Buffer.alloc(0));

      expect(listener).toHaveBeenCalledTimes(1);
      server.emit = emit;
    });

    it('should forward upgrades to listeners before the shutdown started', () => {
      const adapter = new FastifyAdapter({ return503OnClosing: true });
      adapter.initHttpServer();

      const server = adapter.getHttpServer() as import('http').Server;
      const listener = vi.fn();
      server.on('upgrade', listener);

      server.emit(
        'upgrade',
        { httpVersion: '1.1' },
        {
          destroyed: false,
          writableEnded: false,
          on() {},
        },
        Buffer.alloc(0),
      );

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should reject upgrades with 503 once the shutdown started, without invoking listeners', async () => {
      const adapter = new FastifyAdapter({ return503OnClosing: true });
      adapter.initHttpServer();

      const server = adapter.getHttpServer() as import('http').Server;
      const listener = vi.fn();
      server.on('upgrade', listener);

      adapter.beforeClose();

      const write = vi.fn();
      const end = vi.fn();
      const socket = {
        destroyed: false,
        writableEnded: false,
        on: vi.fn(),
        write,
        end,
        destroySoon: vi.fn(),
      };
      const result = server.emit(
        'upgrade',
        { httpVersion: '1.1' },
        socket as any,
        Buffer.alloc(0),
      );

      expect(listener).not.toHaveBeenCalled();
      // Node treats a truthy emit result as "a listener handled the event".
      expect(result).toBe(true);
      const rawResponse = write.mock.calls[0][0] as string;
      expect(rawResponse).toContain('HTTP/1.1 503 Service Unavailable');
      expect(rawResponse.toLowerCase()).toContain('connection: close');
      expect(rawResponse).toContain('Service Unavailable');
      expect(end).toHaveBeenCalled();

      await adapter.close();
    });
  });
});
