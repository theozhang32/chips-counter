// §7.6：保留期清理（D8）——删除"已解散且超保留期"的房间及级联数据
export class RetentionService {
  constructor({ sequelize, config, roomRepository, roomQueues, wsGateway, logger }) {
    this.sequelize = sequelize;
    this.retentionDays = config.retentionDays;
    this.rooms = roomRepository;
    this.queues = roomQueues;
    this.gateway = wsGateway;
    this.logger = logger;
  }

  async runOnce() {
    const cutoff = new Date(Date.now() - this.retentionDays * 86400_000);
    const expired = await this.rooms.listDissolvedBefore(cutoff);
    let deleted = 0;
    const failed = [];
    for (const room of expired) {
      try {
        this.queues.destroy(room.id); // 确保队列不再接收命令
        await this.sequelize.transaction(async (t) => this.rooms.deleteById(room.id, t)); // 外键级联删除成员/游戏/轮次/动作/事件
        this.gateway.closeRoom(room.id);
        deleted += 1;
      } catch (err) {
        failed.push(room.room_no);
        this.logger.warn('retention delete failed', { roomNo: room.room_no, error: err });
      }
    }
    if (expired.length) {
      this.logger.info('retention run', { scanned: expired.length, deleted, failed: failed.length });
    }
    return { scanned: expired.length, deleted, failed };
  }
}
