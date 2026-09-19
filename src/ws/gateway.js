import { WebSocketServer } from 'ws';

const OPEN = 1; // ws.readyState: OPEN

// §6.3：WS 网关——hello/welcome、频道、心跳、publish
export class WsGateway {
  #wss = null;
  #channels = new Map(); // roomId -> Set<ws>
  #heartbeatTimer = null;

  constructor({
    tokenService,
    roomRepository,
    queryService,
    feedService,
    logger,
    helloTimeoutMs = 10_000,
    heartbeatIntervalMs = 30_000,
  }) {
    this.tokenService = tokenService;
    this.roomRepository = roomRepository;
    this.queryService = queryService;
    this.feedService = feedService;
    this.logger = logger;
    this.helloTimeoutMs = helloTimeoutMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
  }

  // 挂载 Koa HTTP server 的 upgrade 事件（仅接受 /ws）
  attach(server) {
    this.#wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      let pathname;
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        pathname = null;
      }
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws));
    });
    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), this.heartbeatIntervalMs);
  }

  #onConnection(ws) {
    ws.isAlive = true;
    ws.authenticated = false;
    ws.roomId = null;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data) => {
      this.#onMessage(ws, data).catch((err) => this.logger.warn('ws message handling failed', { error: err }));
    });
    ws.on('close', () => this.#removeFromChannels(ws));
    ws.on('error', () => {});
    ws.helloTimer = setTimeout(() => {
      if (!ws.authenticated) this.#close(ws, 4002, 'hello timeout');
    }, this.helloTimeoutMs);
  }

  async #onMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return this.#close(ws, 4002, 'invalid json frame');
    }
    if (!ws.authenticated) {
      if (msg?.type !== 'hello') return this.#close(ws, 4002, 'first frame must be hello');
      return this.#handleHello(ws, msg);
    }
    if (msg?.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
      return;
    }
    return this.#close(ws, 4002, 'unexpected frame');
  }

  async #handleHello(ws, msg) {
    try {
      this.tokenService.verify(msg?.token);
    } catch {
      this.#sendError(ws, 'AUTH_INVALID', '令牌无效或已过期');
      return this.#close(ws, 4001, 'auth invalid');
    }
    if (!Number.isInteger(msg?.roomNo)) {
      this.#sendError(ws, 'INVALID_PARAMS', 'roomNo 非法');
      return this.#close(ws, 4002, 'invalid roomNo');
    }
    const room = await this.roomRepository.findByRoomNo(msg.roomNo);
    if (!room) {
      this.#sendError(ws, 'ROOM_NOT_FOUND', '房间不存在');
      return this.#close(ws, 4003, 'room not found');
    }

    clearTimeout(ws.helloTimer);
    ws.authenticated = true;
    ws.roomId = room.id;
    // 先入频道再取快照：窗口期事件会同时出现在快照与 events 帧，客户端按 id 去重（§7.5）
    this.#addToChannel(room.id, ws);
    const [snapshot, latestEventId] = await Promise.all([
      this.queryService.snapshot(room.id),
      this.feedService.latestIdByRoom(room.id),
    ]);
    this.#send(ws, { type: 'welcome', snapshot, latestEventId, serverTime: new Date().toISOString() });
  }

  // D21：仅 RoomQueues 提交事务后调用；广播失败只 warn
  publish(roomId, { events, snapshot }) {
    const channel = this.#channels.get(roomId);
    if (!channel?.size) return;
    const frame = JSON.stringify({ type: 'events', events, snapshot });
    for (const ws of channel) {
      if (ws.readyState === OPEN) {
        try {
          ws.send(frame);
        } catch (err) {
          this.logger.warn('ws send failed', { roomId, error: err });
        }
      }
    }
  }

  // 保留期清理删除房间后关闭全部连接（1000）；解散房间保留频道只读（§6.3）
  closeRoom(roomId) {
    const channel = this.#channels.get(roomId);
    if (!channel) return;
    for (const ws of channel) this.#close(ws, 1000, 'room closed');
    this.#channels.delete(roomId);
  }

  // 优雅停机：1001 服务端重启（客户端走重连流程）
  close() {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    for (const channel of this.#channels.values()) {
      for (const ws of channel) this.#close(ws, 1001, 'server shutdown');
    }
    this.#channels.clear();
    if (this.#wss) this.#wss.close();
  }

  channelSize(roomId) {
    return this.#channels.get(roomId)?.size ?? 0;
  }

  #heartbeat() {
    if (!this.#wss) return;
    for (const ws of this.#wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* 连接异常由 close 事件收尾 */
      }
    }
  }

  #addToChannel(roomId, ws) {
    let channel = this.#channels.get(roomId);
    if (!channel) {
      channel = new Set();
      this.#channels.set(roomId, channel);
    }
    channel.add(ws);
  }

  #removeFromChannels(ws) {
    if (!ws.roomId) return;
    const channel = this.#channels.get(ws.roomId);
    if (!channel) return;
    channel.delete(ws);
    if (!channel.size) this.#channels.delete(ws.roomId);
  }

  #send(ws, obj) {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(obj));
  }

  #sendError(ws, code, message) {
    this.#send(ws, { type: 'error', code, message });
  }

  #close(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* 已关闭 */
    }
  }
}
