// 业务时间统一取 now()（Date，UTC 语义由连接时区 '+00:00' 保证，§2.4 编码约定）
export const now = () => new Date();

// DTO 输出用 UTC ISO8601
export const toIso = (date) => (date instanceof Date ? date.toISOString() : date);

// 原生 SQL 写入用：'YYYY-MM-DD HH:mm:ss.mmm'（UTC，不经驱动时区转换）
export const toDbString = (date) => date.toISOString().replace('T', ' ').slice(0, 23);
