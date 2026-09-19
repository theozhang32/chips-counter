import { definePlayer } from './player.js';
import { defineRoom } from './room.js';
import { defineRoomPlayer } from './roomPlayer.js';
import { defineGame } from './game.js';
import { defineRound } from './round.js';
import { defineAction } from './action.js';
import { defineFeedEvent } from './feedEvent.js';

// 由组合根显式调用，模块自身无副作用（§2.4）
export function defineEntities(sequelize) {
  const Player = definePlayer(sequelize);
  const Room = defineRoom(sequelize);
  const RoomPlayer = defineRoomPlayer(sequelize);
  const Game = defineGame(sequelize);
  const Round = defineRound(sequelize);
  const Action = defineAction(sequelize);
  const FeedEvent = defineFeedEvent(sequelize);

  Player.hasMany(RoomPlayer, { foreignKey: 'player_id', as: 'room_players' });
  RoomPlayer.belongsTo(Player, { foreignKey: 'player_id', as: 'player' });

  Room.hasMany(RoomPlayer, { foreignKey: 'room_id', as: 'room_players' });
  RoomPlayer.belongsTo(Room, { foreignKey: 'room_id', as: 'room' });
  Room.belongsTo(Player, { foreignKey: 'host_player_id', as: 'host' });

  Room.hasMany(Game, { foreignKey: 'room_id', as: 'games' });
  Game.belongsTo(Room, { foreignKey: 'room_id', as: 'room' });

  Game.hasMany(Round, { foreignKey: 'game_id', as: 'rounds' });
  Round.belongsTo(Game, { foreignKey: 'game_id', as: 'game' });

  Round.hasMany(Action, { foreignKey: 'round_id', as: 'actions' });
  Action.belongsTo(Round, { foreignKey: 'round_id', as: 'round' });
  RoomPlayer.hasMany(Action, { foreignKey: 'room_player_id', as: 'actions' });
  Action.belongsTo(RoomPlayer, { foreignKey: 'room_player_id', as: 'member' });

  Room.hasMany(FeedEvent, { foreignKey: 'room_id', as: 'feed_events' });
  FeedEvent.belongsTo(Room, { foreignKey: 'room_id', as: 'room' });
  Player.hasMany(FeedEvent, { foreignKey: 'actor_player_id', as: 'feed_events' });
  FeedEvent.belongsTo(Player, { foreignKey: 'actor_player_id', as: 'actor' });

  return { Player, Room, RoomPlayer, Game, Round, Action, FeedEvent };
}
