import { UniqueConstraintError } from 'sequelize';
import { AppError, E } from '../common/errors.js';

// §3.5：MySQL 唯一冲突（ER_DUP_ENTRY）按冲突索引名分类翻译为业务错误码
export const isUniqueViolation = (err) =>
  err instanceof UniqueConstraintError && err?.original?.code === 'ER_DUP_ENTRY';

export const duplicateIndex = (err) => {
  const message = err?.original?.message ?? '';
  const match = message.match(/for key '([^']+)'/);
  if (match) return match[1];
  const fields = Object.keys(err?.fields ?? {});
  return fields.length ? `fields:${fields.join(',')}` : null;
};

// mapping: { [索引名或 fields:xxx]: () => AppError }；未匹配的冲突抛 INTERNAL_ERROR（理论不可达路径）
export function translateDuplicate(err, mapping, context = '') {
  if (!isUniqueViolation(err)) return false;
  const key = duplicateIndex(err);
  const factory = mapping[key];
  if (factory) throw factory();
  throw new AppError(E.INTERNAL_ERROR, `未预期的唯一约束冲突 ${context}（${key ?? 'unknown index'}）`);
}

// 幂等键并发双击：后到者命中 uniq_action_idempotency，回查后由 service 复用首次结果（§7.4.4）
export class IdempotencyDuplicateSignal extends Error {
  constructor(key) {
    super(`idempotency key duplicate: ${key}`);
    this.name = 'IdempotencyDuplicateSignal';
    this.key = key;
  }
}
