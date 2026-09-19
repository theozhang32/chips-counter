import { AppError, E } from './errors.js';

const invalidParams = (details) => new AppError(E.INVALID_PARAMS, '请求参数校验失败', details);

const detail = (field, reason) => ({ field, reason });

// 读取字符串字段；语义校验（长度等）抛 errCode（如 NICKNAME_INVALID），结构问题抛 INVALID_PARAMS
export function readString(obj, key, { optional = false, min = 1, max = Infinity, code = E.INVALID_PARAMS } = {}) {
  const value = obj?.[key];
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw invalidParams([detail(key, 'required')]);
  }
  if (typeof value !== 'string') throw invalidParams([detail(key, 'must be a string')]);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new AppError(code, `${key} 长度需在 ${min}~${max} 之间`, [detail(key, `length must be ${min}..${max}`)]);
  }
  return trimmed;
}

// code 提供时，类型/范围错误统一抛该业务码（如 AMOUNT_INVALID/Base Chips_INVALID）；
// 未提供时抛 INVALID_PARAMS
export function readInt(obj, key, { optional = false, min, max, code } = {}) {
  const fail = (reason, message) => {
    if (code) throw new AppError(code, message, [detail(key, reason)]);
    throw invalidParams([detail(key, reason)]);
  };
  const value = obj?.[key];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw invalidParams([detail(key, 'required')]);
  }
  let parsed = value;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) fail('must be an integer', `${key} 必须是整数`);
    parsed = Number(value);
  }
  if (min !== undefined && parsed < min) fail(`must be >= ${min}`, `${key} 不能小于 ${min}`);
  if (max !== undefined && parsed > max) fail(`must be <= ${max}`, `${key} 不能大于 ${max}`);
  return parsed;
}

export function readBoolean(obj, key, { optional = false } = {}) {
  const value = obj?.[key];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw invalidParams([detail(key, 'required')]);
  }
  if (typeof value !== 'boolean') throw invalidParams([detail(key, 'must be a boolean')]);
  return value;
}

// 路径房间标识：6 位数字
export function parseRoomNo(raw) {
  if (!/^\d{6}$/.test(String(raw ?? ''))) {
    throw invalidParams([detail('roomNo', 'must be a 6-digit number')]);
  }
  return Number(raw);
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
