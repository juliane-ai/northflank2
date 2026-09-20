import { createPostgresPool } from '../postgres.js';
export { transaction } from '../postgres.js';

export function createPool(raw) {
  if (!raw) throw new Error('请配置 STOCK_DATABASE_URL 或 EXTERNAL_JDBC_POSTGRES_URI_ADMIN');
  return createPostgresPool(raw, 'stock-watch');
}
