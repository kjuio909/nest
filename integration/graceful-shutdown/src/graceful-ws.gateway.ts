import {
  Injectable,
  OnModuleDestroy,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyAdapter } from '@nestjs/platform-fastify';
import type * as http from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';

export const GRACEFUL_WS_PATH = '/graceful-ws';

/**
 * Observable state of the "/graceful-ws" probe. The counters live at module
 * scope so that they stay readable after the HTTP server itself has been
 * closed by "app.close()": the "GET /graceful-ws/stats" route serves them
 * while the app is running, and tests (or anything in the same process) can
 * read the very same object once shutdown completed, without that read
 * counting as a new business request.
 */
export const wsCounters = {
  /** WebSocket connections whose upgrade completed and are still open. */
  activeConnections: 0,
  /** Echo messages whose delayed reply was actually delivered. */
  completedMessages: 0,
  /** Number of gateway teardown runs; must stay at exactly one. */
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
 * Minimal raw-"ws" gateway bound to the underlying HTTP server at
 * "/graceful-ws". It deliberately does not go through the @nestjs/websockets
 * machinery: the probe exercises the platform-level upgrade lifecycle, so the
 * gateway talks to the same raw server the Fastify adapter gates.
 *
 * Protocol (text frames, JSON):
 * - {type:"echo", data:string, delay:number}: replies with "data" alone after
 *   "delay" ms and counts the message as completed; an abort before the reply
 *   cancels the work and does not count.
 * - {type:"error"}: closes this single connection with code 1011 and reason
 *   "gateway error"; other connections and the completed counter are untouched.
 *
 * Shutdown convergence ("onModuleDestroy"):
 * - the platform upgrade gate rejects every new handshake, so this only has to
 *   deal with connections that completed their handshake before shutdown;
 * - in-flight delayed echoes are awaited so their reply is delivered (unless
 *   the client aborted first, in which case the work is simply cancelled);
 * - every remaining connection is then closed gracefully, and the teardown
 *   only finishes once they have all ended.
 */
@Injectable()
export class GracefulWsGateway
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private wss?: WebSocketServer;
  private httpServer?: http.Server;
  private readonly clients = new Set<WebSocket>();
  /** In-flight echo work across every connection; awaited during shutdown. */
  private readonly pendingWork = new Set<Promise<void>>();
  private readonly upgradeListener = (
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => this.handleUpgrade(request, socket, head);

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost<FastifyAdapter>,
  ) {}

  public onApplicationBootstrap() {
    this.httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', ws => this.handleConnection(ws));
    this.httpServer.on('upgrade', this.upgradeListener);
  }

  public async onModuleDestroy(): Promise<void> {
    // Runs exactly once per shutdown cycle; repeated/concurrent app.close()
    // calls share the cycle and never enter this hook a second time.
    wsCounters.cleanupCount++;
    this.httpServer?.off('upgrade', this.upgradeListener);

    // Messages sent on an established connection immediately before the
    // shutdown started may still be in flight on the socket. Yield I/O turns
    // so those frames are received and parsed - an echo registers in-flight
    // work below, an "error" message closes its own connection - before the
    // gate decides what is still pending. Two turns cover a frame arriving
    // in the same poll cycle as well as one coalesced with the shutdown.
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    // Let delayed echoes accepted before shutdown finish their business work.
    // Aborted messages were already removed when their connection ended.
    await this.drainPendingWork();

    // All business work has converged; close the connections that are still
    // open so the underlying HTTP server's own close() can finish.
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'server shutting down');
      }
    }

    // "WebSocketServer.close()" with "noServer" waits until every client is
    // gone before emitting its 'close' event.
    await new Promise<void>(resolve => this.wss?.close(() => resolve()));
  }

  private async drainPendingWork() {
    // Re-check after each await: the flush above parses frames synchronously,
    // but a message whose reply lands while we wait must not be missed.
    while (this.pendingWork.size > 0) {
      await Promise.allSettled(this.pendingWork);
    }
  }

  private handleUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) {
    const pathname = new URL(
      request.url ?? '/',
      'http://localhost',
    ).pathname;
    if (pathname !== GRACEFUL_WS_PATH) {
      // Not ours. If no other upgrade listener exists on the server, destroy
      // the socket so an unhandled upgrade cannot linger on the connection.
      if ((this.httpServer?.listenerCount('upgrade') ?? 0) === 1) {
        socket.destroy();
      }
      return;
    }
    this.wss!.handleUpgrade(request, socket, head, ws => {
      this.wss!.emit('connection', ws, request);
    });
  }

  private handleConnection(ws: WebSocket) {
    this.clients.add(ws);
    wsCounters.activeConnections++;

    // Timers of delayed echoes that have not been answered yet. Closing the
    // connection clears them, which is what makes an abort before the reply
    // cancel the work instead of letting it run (and potentially be counted).
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    // Resolvers of the in-flight work promises; invoked when the connection
    // ends so an abort cannot leave "pendingWork" (and thus shutdown) waiting.
    const pendingResolvers = new Set<() => void>();
    let settled = false;

    ws.on('message', raw => {
      let message: GracefulWsMessage;
      try {
        message = JSON.parse(raw.toString()) as GracefulWsMessage;
      } catch {
        // Malformed input is ignored: it must not tear the connection down.
        return;
      }

      if (message?.type === 'echo') {
        this.scheduleEcho(
          ws,
          message,
          pendingTimers,
          pendingResolvers,
          () => settled,
        );
      } else if (message?.type === 'error') {
        // Observable, connection-local failure: 1011/"gateway error".
        ws.close(1011, 'gateway error');
      }
    });

    ws.on('close', () => {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      for (const resolve of pendingResolvers) {
        resolve();
      }
      pendingResolvers.clear();
      this.clients.delete(ws);
      wsCounters.activeConnections--;
    });
  }

  private scheduleEcho(
    ws: WebSocket,
    message: EchoMessage,
    pendingTimers: Set<ReturnType<typeof setTimeout>>,
    pendingResolvers: Set<() => void>,
    isSettled: () => boolean,
  ) {
    const data =
      typeof message.data === 'string'
        ? message.data
        : String(message.data ?? '');
    const delay = Math.max(0, Number(message.delay) || 0);

    let finishWork: () => void = () => {};
    const work = new Promise<void>(resolve => {
      finishWork = resolve;
    });
    this.pendingWork.add(work);

    const completeWork = () => {
      this.pendingWork.delete(work);
      pendingResolvers.delete(completeWork);
      finishWork();
    };
    pendingResolvers.add(completeWork);

    const timer = setTimeout(
      () => {
        pendingTimers.delete(timer);
        if (isSettled() || ws.readyState !== WebSocket.OPEN) {
          completeWork();
          return;
        }
        // Only the payload string goes back; count the message only once the
        // frame was actually delivered, so a client aborting around the
        // deadline cannot inflate the completed counter.
        ws.send(data, err => {
          if (!err && !isSettled()) {
            wsCounters.completedMessages++;
          }
          completeWork();
        });
      },
      delay,
    );
    pendingTimers.add(timer);
  }
}
