// D3/D21：房间级串行队列 + 事务 + 提交后广播
// CommandResult = { reply, broadcast: { events, snapshot } | null }
export class RoomQueues {
  #queues = new Map(); // roomId -> 尾链 Promise（已吞错，仅用于排队等待）

  constructor(sequelize, wsGateway, logger) {
    this.sequelize = sequelize;
    this.wsGateway = wsGateway;
    this.logger = logger;
  }

  /**
   * 将闭包排入 roomId 的 FIFO；闭包在 sequelize 托管事务中执行；
   * 成功提交后若闭包返回 broadcast 则 publish；返回闭包的 reply。
   * 闭包抛错 → 事务回滚 → 错误向调用方透传，队列继续消费后续命令。
   * ER_LOCK_DEADLOCK（跨房间命令在唯一索引上的缺口锁死锁）自动重试 ≤ 2 次：
   * 房间队列内命令严格串行，重放闭包无重复副作用（事务已整体回滚）。
   */
  async run(roomId, fn) {
    const prev = this.#queues.get(roomId) ?? Promise.resolve();
    const exec = (async () => {
      await prev.catch(() => {});
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.sequelize.transaction(async (t) => fn(t));
          if (result?.broadcast) this.publish(roomId, result.broadcast);
          return result?.reply;
        } catch (err) {
          if (err?.original?.code === 'ER_LOCK_DEADLOCK' && attempt < 2) {
            this.logger.warn('deadlock retry', { roomId, attempt: attempt + 1 });
            continue;
          }
          throw err;
        }
      }
    })();
    const tail = exec.catch(() => {});
    this.#queues.set(roomId, tail);
    // 空转自清理：链尾无后续命令时移除键，防止长期运行的 Map 泄漏（D10 懒创建的另一半）
    void tail.finally(() => {
      if (this.#queues.get(roomId) === tail) this.#queues.delete(roomId);
    });
    return exec;
  }

  // 建房等不经队列的路径提交后复用同一广播出口（§4.3）；广播失败只 warn（§6.3）
  publish(roomId, broadcast) {
    try {
      this.wsGateway.publish(roomId, broadcast);
    } catch (err) {
      this.logger.warn('broadcast failed', { roomId, error: err });
    }
  }

  // 房间解散/清理后销毁队列（防止泄漏）
  destroy(roomId) {
    this.#queues.delete(roomId);
  }

  // 观测：活跃队列数
  size() {
    return this.#queues.size;
  }
}
