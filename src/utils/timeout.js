/** 默认 SQL 超时时间（毫秒） */
export const DEFAULT_STATEMENT_TIMEOUT = 30_000;

/**
 * @typedef {Object} TimeoutDiagnostics
 * @property {number} [queueSize] - 队列中等待的任务数
 * @property {number} [inflightCount] - 正在执行中的任务数
 * @property {number} [pendingFinalizeCount] - 待最终结算的任务数
 * @property {number} [totalPending] - 所有待处理任务总数
 */

/**
 * 创建一个描述 SQL 超时的 Error 对象。
 * 消息包含人类可读的超时时长、开始时间、截止时间，
 * 以及可选的上下文诊断信息（如队列积压情况）。
 * @param {number} timeout - 超时毫秒数
 * @param {string} sql - 超时的 SQL 语句（已标准化）
 * @param {number} [startTime] - 任务开始时的 Unix 毫秒时间戳或 performance.now() 值
 * @param {TimeoutDiagnostics} [diagnostics] - 任务队列上下文诊断信息
 * @returns {Error}
 */
export function createTimeoutError(timeout, sql, startTime, diagnostics) {
	const startedAt = resolveStartTimestamp(startTime, timeout);
	const deadline = startedAt + timeout;
	const duration = formatDuration(timeout);
	const rawDuration = duration === `${timeout}ms` ? "" : ` (${timeout}ms)`;

	const parts = [
		`SQLite statement timed out after ${duration}${rawDuration}`,
		`started at ${formatTimestamp(startedAt)}`,
		`deadline at ${formatTimestamp(deadline)}`,
		`SQL: ${sql}`,
	];

	if (diagnostics) {
		parts.push(`diagnostics: queueSize=${diagnostics.queueSize ?? "?"}, inflightCount=${diagnostics.inflightCount ?? "?"}, pendingFinalizeCount=${diagnostics.pendingFinalizeCount ?? "?"}, totalPending=${diagnostics.totalPending ?? "?"}`);
	}

	return new Error(parts.join("; "));
}

function resolveStartTimestamp(startTime, timeout) {
	if (!Number.isFinite(startTime)) return Date.now() - timeout;
	if (startTime >= 1_000_000_000_000) return startTime;
	return Date.now() - Math.max(0, performance.now() - startTime);
}

function formatDuration(milliseconds) {
	let remaining = milliseconds;
	const parts = [];
	const units = [
		[86_400_000, "d"],
		[3_600_000, "h"],
		[60_000, "m"],
		[1000, "s"],
	];

	for (const [unitMilliseconds, suffix] of units) {
		const value = Math.floor(remaining / unitMilliseconds);
		if (value > 0) {
			parts.push(`${value}${suffix}`);
			remaining -= value * unitMilliseconds;
		}
	}
	if (remaining > 0 || parts.length === 0) {
		parts.push(`${remaining}ms`);
	}
	return parts.join(" ");
}

function formatTimestamp(timestamp) {
	return new Date(timestamp).toISOString().replace("T", " ").replace("Z", " UTC");
}
