/** 默认 SQL 超时时间（毫秒） */
export const DEFAULT_STATEMENT_TIMEOUT = 30_000;

/**
 * 将 Date 格式化为 `YYYY-MM-DD HH:mm:ss.SSS` 格式。
 * @param {Date} date
 * @returns {string}
 */
function formatDateTime(date) {
	const y = date.getFullYear();
	const M = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	const h = String(date.getHours()).padStart(2, "0");
	const m = String(date.getMinutes()).padStart(2, "0");
	const s = String(date.getSeconds()).padStart(2, "0");
	const ms = String(date.getMilliseconds()).padStart(3, "0");
	return `${y}-${M}-${d} ${h}:${m}:${s}.${ms}`;
}

/**
 * 格式化毫秒数为人类可读的持续时间字符串。
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60_000);
	const secs = ((ms % 60_000) / 1000).toFixed(1);
	return `${mins}m ${secs}s`;
}

/**
 * 创建一个描述 SQL 超时的 Error 对象。
 *
 * 当提供了 startTime 时，错误信息会包含可读的开始时间、截至时间和超时时间；
 * 否则保持向后兼容的简洁格式。
 *
 * @param {number} timeout - 超时毫秒数
 * @param {string} sql - 超时的 SQL 语句（已标准化）
 * @param {number} [startTime] - 任务开始时的 performance.now() 值；若提供则计算人类可读时间
 * @returns {Error}
 */
export function createTimeoutError(timeout, sql, startTime) {
	if (startTime !== undefined) {
		const elapsed = Math.max(0, performance.now() - startTime);
		const startDate = new Date(Date.now() - elapsed);
		const deadlineDate = new Date(startDate.getTime() + timeout);
		return new Error(
			`SQLite statement timed out after ${formatDuration(timeout)} ` +
			`(start: ${formatDateTime(startDate)}, ` +
			`deadline: ${formatDateTime(deadlineDate)}): ${sql}`,
		);
	}
	return new Error(`SQLite statement timed out after ${timeout}ms: ${sql}`);
}
