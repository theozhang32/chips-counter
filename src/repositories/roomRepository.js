import { randomInt } from 'node:crypto';
import { Op } from 'sequelize';
import { isUniqueViolation, duplicateIndex } from './translateError.js';

const ROOM_NO_MAX_ATTEMPTS = 5;

export class RoomRepository {
  constructor(sequelize, { Room }) {
    this.sequelize = sequelize;
    this.Room = Room;
  }

  async findByRoomNo(roomNo) {
    return this.Room.findOne({ where: { room_no: roomNo } });
  }

  async findById(id, t) {
    return this.Room.findByPk(id, { transaction: t });
  }

  // D1：6 位随机数字房间号；仅建房路径使用，唯一冲突由 insert 的内部重试兜底（§3.5）
  async generateRoomNo(t) {
    for (let i = 0; i < ROOM_NO_MAX_ATTEMPTS; i++) {
      const candidate = randomInt(100000, 1000000);
      const exists = await this.Room.findOne({
        where: { room_no: candidate },
        transaction: t,
      });
      if (!exists) return candidate;
    }
    throw new Error('generateRoomNo: exhausted attempts');
  }

  // 注：uniq_room_no 冲突不在此翻译——建房调用方需要捕获它做内部重试（§3.5）
  async insert(room, t) {
    return this.Room.create(room, { transaction: t });
  }

  // insert + 房间号唯一冲突内部重试（≤ 5 次，不外抛）；其余错误透传
  async insertWithRoomNoRetry(buildRoom, t) {
    let lastError;
    for (let i = 0; i < ROOM_NO_MAX_ATTEMPTS; i++) {
      const roomNo = await this.generateRoomNo(t);
      try {
        return await this.insert(buildRoom(roomNo), t);
      } catch (err) {
        if (isUniqueViolation(err) && duplicateIndex(err) === 'uniq_room_no') {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new Error('insertWithRoomNoRetry: exhausted attempts');
  }

  async updateHost(id, playerId, t) {
    await this.Room.update({ host_player_id: playerId }, { where: { id }, transaction: t });
  }

  async updateBaseChips(id, baseChips, t) {
    await this.Room.update({ base_chips: baseChips }, { where: { id }, transaction: t });
  }

  async markDissolved(id, at, t) {
    await this.Room.update({ status: 'dissolved', dissolved_at: at }, { where: { id }, transaction: t });
  }

  async listDissolvedBefore(cutoff, t) {
    return this.Room.findAll({
      where: { status: 'dissolved', dissolved_at: { [Op.lt]: cutoff } },
      transaction: t,
    });
  }

  async listAll() {
    return this.Room.findAll();
  }

  async deleteById(id, t) {
    await this.Room.destroy({ where: { id }, transaction: t });
  }
}
