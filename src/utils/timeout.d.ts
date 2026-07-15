/** 默认语句超时时间 30 秒 */
export const DEFAULT_STATEMENT_TIMEOUT: 30000;

/**
 * 创建包含 SQL 上下文的超时错误。
 * 注意：sql 应已由调用方完成规范化，本函数不再内部调用 normalizeSQL。
 *
 * @param timeout - 超时时间（毫秒）
 * @param sql     - 超时发生时正在执行的 SQL 语句（已规范化）
 * @param startedAt - 任务开始时的 Unix 毫秒时间戳
 * @returns 包含超时时间和 SQL 信息的 Error 实例
 */
export function createTimeoutError(timeout: number, sql: string, startedAt?: number): Error;
