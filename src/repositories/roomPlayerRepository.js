import { translateDuplicate } from './translateError.js';
import { AppError, E } from '../common/errors.js';

export class RoomPlayerRepository {
  constructor(sequelize, { RoomPlayer }) {
    this.sequelize = sequelize;
    this.RoomPlayer = RoomPlayer;
  }

  async findById(id, t) {
    return this.RoomPlayer.findByPk(id, { transaction: t });
  }

  async findActiveByPlayer(playerId, t) {
    return this.RoomPlayer.findOne({
      where: { player_id: playerId, status: 'active' },
      include: [{ association: 'room' }],
      transaction: t,
    });
  }

  async findByRoomAndPlayer(roomId, playerId, t) {
    return this.RoomPlayer.findOne({ where: { room_id: roomId, player_id: playerId }, transaction: t });
  }

  async insert(member, t) {
    try {
      return await this.RoomPlayer.create(member, { transaction: t });
    } catch (err) {
      translateDuplicate(
        err,
        {
          uniq_room_player_active: () => new AppError(E.ALREADY_IN_ROOM, '已在某个房间中（一人一房间）'),
          'fields:active_player_key': () => new AppError(E.ALREADY_IN_ROOM, '已在某个房间中（一人一房间）'),
          uniq_room_member: () => new AppError(E.ALREADY_IN_ROOM, '已在本房间中'),
          'fields:room_id,player_id': () => new AppError(E.ALREADY_IN_ROOM, '已在本房间中'),
          uniq_room_nickname: () => new AppError(E.NICKNAME_TAKEN, '房间内昵称已被占用'),
          'fields:nickname': () => new AppError(E.NICKNAME_TAKEN, '房间内昵称已被占用'),
        },
        'room_player.insert'
      );
      throw err;
    }
  }

  async markLeft(id, at, t) {
    await this.RoomPlayer.update({ status: 'left', left_at: at }, { where: { id }, transaction: t });
  }

  async markAllLeft(roomId, at, t) {
    await this.RoomPlayer.update(
      { status: 'left', left_at: at },
      { where: { room_id: roomId, status: 'active' }, transaction: t }
    );
  }

  async markActive(id, t) {
    await this.RoomPlayer.update({ status: 'active' }, { where: { id }, transaction: t });
  }

  async setChips(id, chips, t) {
    await this.RoomPlayer.update({ chips }, { where: { id }, transaction: t });
  }

  async updateNickname(id, nickname, t) {
    try {
      await this.RoomPlayer.update({ nickname }, { where: { id }, transaction: t });
    } catch (err) {
      translateDuplicate(
        err,
        {
          uniq_room_nickname: () => new AppError(E.NICKNAME_TAKEN, '房间内昵称已被占用'),
          'fields:nickname': () => new AppError(E.NICKNAME_TAKEN, '房间内昵称已被占用'),
        },
        'room_player.updateNickname'
      );
      throw err;
    }
  }

  async listByRoom(roomId, t) {
    return this.RoomPlayer.findAll({ where: { room_id: roomId }, order: [['joined_at', 'ASC']], transaction: t });
  }

  async activeCount(roomId, t) {
    return this.RoomPlayer.count({ where: { room_id: roomId, status: 'active' }, transaction: t });
  }
}
