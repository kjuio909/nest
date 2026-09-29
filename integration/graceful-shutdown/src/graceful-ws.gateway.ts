import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Duplex } from 'stream';
import * as http from 'http';
import { WebSocket, type RawData, WebSocketServer } from 'ws';

/**
 * Mutable counters exposed through "GET /graceful-ws/stats" while the
 * application is serving traffic and through the exported snapshot after the
 * application has closed (the listening socket is gone by then, but the
 * figures must remain readable without counting as new business work).
 */
export const wsCounters = {
  /** WebSocket connections that completed the handshake and are still open. */
  activeConnections: 0,
  /** Echo messages whose "data" was actually sent back to the client. */
  completedMessages: 0,
  /** Graceful shutdown cleanup ("onModuleDestroy") executions. */
  cleanupCount: 0,
};

export function resetWsCounters() {
  wsCounters.activeConnections = 0;
  wsCounters.completedMessages = 0;
  wsCounters.cleanupCount = 0;
}

interface EchoMessage {
  type: 'echo';
  data: string;
  delay: number;
}

interface ErrorMessage {
  type: 'error';
}

type GracefulWsMessage = EchoMessage | ErrorMessage;

/**
 * Deterministic WebSocket lifecycle probe mounted at the fixed "/graceful-ws"
 * path of the underlying HTTP server.
 *
 * Text frames are JSON envelopes:
 * - { type: "echo", data: string, delay: number } waits "delay" ms and sends
 *   "data" back; the message counts as completed only when the reply is
 *   actually written, so a client aborting before the echo is sent does not
 *   move the counter;
 * - { type: "error" } closes that single connection with code 1011 and reason
 *   "gateway error"; other connections and the completed counter are untouched.
 *
 * The upgrade handling is "noServer": handshakes are accepted explicitly from
 * the raw HTTP server so the platform shutdown gate can reject new handshakes
 * before they ever reach this gateway, while handshakes accepted before the
 * shutdown started keep their established connections and in-flight work is
 * drained by "onModuleDestroy" before the HTTP server itself is closed.
 */
@Injectable()
export class GracefulWsGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GracefulWsGateway.name);
  private wss?: WebSocketServer;
  private httpServer?: http.Server;
  private readonly connections = new Set<WebSocket>();
  private readonly inFlight = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  get stats() {
    return { ...wsCounters };
  }

  onModuleInit() {
    // The probe rides on the Fastify HTTP server; other platforms keep their
    // ordinary (non-WebSocket) behavior.
    if (this.httpAdapterHost.httpAdapter?.getType() !== 'fastify') {
      return;
    }

    const httpServer =
      this.httpAdapterHost.httpAdapter.getHttpServer() as http.Server;
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', socket => this.handleConnection(socket));

    httpServer.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
  }
  async onModuleDestroy() {
    // Runs while connections that were accepted before the shutdown are
    // retained: let in-flight echoes/errors/aborts converge, then end every
    // remaining connection and only then perform the (single) cleanup.
    if (!this.wss) {
      // The probe is only mounted on the Fastify server; other platforms and
      // apps that never initialized it have no WebSocket state to clean up.
      return;
    }
    this.shuttingDown = true;

    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }

    if (this.wss) {
      await Promise.all(
        [...this.connections].map(socket => this.closeConnection(socket)),
      );
      await new Promise<void>(resolve => this.wss!.close(() => resolve()));
    }

    wsCounters.cleanupCount++;
  }

  private handleUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== '/graceful-ws') {
      // Unknown upgrade target: terminate just this handshake without
      // touching ordinary HTTP traffic or subsequent upgrade attempts.
      socket.destroy();
      return;
    }

    if (!this.wss) {
      socket.destroy();
      return;
    }

    try {
      this.wss.handleUpgrade(request, socket, head, websocket => {
        this.wss!.emit('connection', websocket, request);
      });
    } catch (err) {
      this.logger.error(err);
      socket.destroy();
    }
  }

  private handleConnection(socket: WebSocket) {
    wsCounters.activeConnections++;
    this.connections.add(socket);

    socket.on('message', data => {
      this.handleMessage(socket, data);
    });
    socket.on('close', () => {
      this.connections.delete(socket);
      wsCounters.activeConnections = this.connections.size;
    });
    socket.on('error', () => {
      // Error frames (e.g. an abrupt client reset) must not crash the process
      // or affect other connections; "close" follows and releases the socket.
    });
  }

  private handleMessage(socket: WebSocket, rawData: RawData) {
    // Messages observed only after the shutdown began are not new business:
    // the connection drains whatever was already in flight and then closes.
    if (this.shuttingDown) {
      return;
    }
    const payload = Array.isArray(rawData)
      ? Buffer.concat(rawData).toString()
      : rawData instanceof ArrayBuffer
        ? Buffer.from(rawData).toString()
        : rawData.toString();
    let message: GracefulWsMessage;
    try {
      message = JSON.parse(payload) as GracefulWsMessage;
    } catch {
      // Malformed envelopes are ignored and never counted.
      return;
    }

    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'error') {
      // Deterministic, observable error outcome for this connection only:
      // close frame 1011/"gateway error", no completion accounting. The
      // closing handshake is tracked as in-flight work so a shutdown starting
      // concurrently waits for it instead of overriding the error frame.
      if (socket.readyState === WebSocket.OPEN) {
        this.track(this.untilClosed(socket));
        socket.close(1011, 'gateway error');
      }
      return;
    }

    if (message.type !== 'echo') {
      return;
    }

    const work = this.scheduleEcho(
      socket,
      typeof message.data === 'string' ? message.data : String(message.data),
      Math.max(0, Number(message.delay) || 0),
    );
    this.track(work);
  }

  private track(work: Promise<void>) {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private untilClosed(socket: WebSocket): Promise<void> {
    return new Promise<void>(resolve => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.once('close', () => resolve());
    });
  }

  /**
   * Sends "payload" after "delayMs", resolving once the echo has been written,
   * the client aborted before it, or the connection ended for another reason.
   * The completed counter moves only for replies that were actually sent.
   */
  private scheduleEcho(
    socket: WebSocket,
    payload: string,
    delayMs: number,
  ): Promise<void> {
    return new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        socket.removeListener('close', onAbort);
        resolve();
      };
      const onAbort = () => {
        clearTimeout(timer);
        finish();
      };
      const timer = setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          // Client went away before the echo could be sent: not counted.
          finish();
          return;
        }
        socket.send(payload, err => {
          if (!err) {
            wsCounters.completedMessages++;
          }
          finish();
        });
      }, delayMs);
      socket.once('close', onAbort);
    });
  }

  private closeConnection(socket: WebSocket): Promise<void> {
    return new Promise<void>(resolve => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.once('close', () => resolve());
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      } else {
        socket.close(1001, 'shutting down');
      }
    });
  }
}
