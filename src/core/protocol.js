import { normalizeSQL } from "../utils/normalize.js";
import { TOKEN_COLUMN } from "../constants.js";

export { TOKEN_COLUMN } from "../constants.js";

/**
 * 构建发送给 sqlite3 进程的完整载荷。
 * 在原始 SQL 末尾追加一条 sentinel 查询，用于标记该任务输出的结束。
 *
 * @param {string} sql - 要执行的 SQL 语句（已规范化时设 skipNormalize=true）
 * @param {string} token - 唯一 sentinel token
 * @param {{ skipNormalize?: boolean }} [options]
 * @returns {string} 追加了 sentinel 查询后的完整载荷
 */
export function buildPayload(sql, token, { skipNormalize = false } = {}) {
	const normalized = skipNormalize ? sql : normalizeSQL(sql);
	const suffix = normalized.endsWith(";") ? "" : ";";
	// 模板字面量在 V8 中会优化为 join，保持原状即可
	return `${normalized}${suffix}\nSELECT '${token}' AS ${TOKEN_COLUMN};\n`;
}

/**
 * 判断 SQL 是否为事务控制语句（BEGIN / COMMIT / ROLLBACK）。
 * WAL batch 不应包裹事务控制语句，否则会破坏事务嵌套层级。
 * @param {string} sql
 * @returns {boolean}
 */
function isTransactionControl(sql) {
	// sql 经过 normalizeSQL 后关键词大小写不变；首 charCodeAt 快速失败避免字符串分配。
	// 若首字母不是 B/C/R（事务关键字），直接返回 false。
	const f = sql.charCodeAt(0);
	if (f === 66 || f === 98) {
		return sql === "BEGIN" || sql === "BEGIN;" || sql.startsWith("BEGIN ") || sql.startsWith("BEGIN;");
	}
	if (f === 67 || f === 99) {
		return sql === "COMMIT" || sql === "COMMIT;" || sql.startsWith("COMMIT ") || sql.startsWith("COMMIT;");
	}
	if (f === 82 || f === 114) {
		return sql === "ROLLBACK" || sql === "ROLLBACK;" || sql.startsWith("ROLLBACK ") || sql.startsWith("ROLLBACK;");
	}
	return false;
}

/**
 * 将一批任务合并为单个发送给 sqlite3 进程的载荷字符串。
 * 由 PipelineEngine 和 TaskWorker 共享，避免 25 行重复 payload 构建逻辑。
 *
 * 如果全是 execute 类型且数量 > 1，自动使用 WAL 批量优化：
 * 将多条 INSERT/UPDATE 用 BEGIN/COMMIT 包裹，每条语句后紧跟其 sentinel token。
 *
 * ★ WAL batch sentinel 交错模式
 * 传统格式将所有 SQL 放在一起、所有 sentinel 放在末尾（`BEGIN; T1; T2; COMMIT; tok1; tok2`），
 * 这导致最后一条 SQL 的 sentinel 要等前面所有 SQL 执行完才到达，而全部任务的 startTime
 * 都在 pump 时统一设置，因此后面任务的 elapsed 会累积前面任务的执行时间，在大量 SQL
 * 场景下容易误触超时。
 *
 * 新格式将 sentinel 交错在每条 SQL 之后（`BEGIN; T1; tok1; T2; tok2; COMMIT`），
 * 使得每条 SQL 的 sentinel 紧随其自身执行完毕即到达。结合 handleParsedValue 中
 * 对 next inflight task 的 startTime 前移机制，确保每条任务的 timeout 倒计时
 * 只计算其自身的执行时间，而非 batch 中前面所有任务的累积时间。
 *
 * WAL batch 会自动跳过事务控制语句（BEGIN / COMMIT / ROLLBACK），
 * 避免 BEGIN/COMMIT 被 WAL batch 的 BEGIN/COMMIT 再次包裹导致事务嵌套异常。
 *
 * @param {Array<{ kind: string, sql: string, token: string }>} batch
 * @returns {string}
 */
export function buildBatchPayload(batch) {
	const useWalBatch = batch.length > 1 && batch.every((t) => t.kind === "execute" && !isTransactionControl(t.sql));
	if (useWalBatch) {
		const parts = ["BEGIN;\n"];
		for (const task of batch) {
			parts.push(task.sql, "\n");
			parts.push(`SELECT '${task.token}' AS ${TOKEN_COLUMN};\n`);
		}
		parts.push("COMMIT;\n");
		return parts.join("");
	}

	const parts = [];
	for (const task of batch) {
		parts.push(buildPayload(task.sql, task.token, { skipNormalize: true }));
	}
	return parts.join("");
}

const TC_FIRST_CHAR = TOKEN_COLUMN.charCodeAt(0);

/**
 * 构建 sentinel 字符串，供 isSentinelRaw 直接比较。
 * 每任务调用一次（而非每 JSON 值），消除模板字符串重复分配。
 * @param {string} token
 * @returns {string}
 */
function buildSentinelStr(token) {
	return `[{"${TOKEN_COLUMN}":"${token}"}]`;
}

/**
 * 通过原始字符串模式检测 sentinel 行，避免 JSON.parse。
 * sentinel 原始格式固定为 [{"__sqlite_executor_token__":"TOKEN"}]，
 * token 由 crypto.randomUUID() 生成（hex UUID，不含特殊 JSON 字符），
 * 因此精确字符串匹配即可安全判断。
 *
 * 哨兵字符串在 isSentinelRaw 内部按需构建；外部调用只需传入 token。
 * fast path 首先检查第 4 个字符是否匹配列名首字符，不匹配则快速返回 false。
 *
 * @param {string} raw - 流式解析器提取的原始 JSON 文本
 * @param {string} token - 当前任务的唯一 token
 * @returns {boolean}
 */
export function isSentinelRaw(raw, token) {
	return raw.charCodeAt(3) === TC_FIRST_CHAR && raw === buildSentinelStr(token);
}

/**
 * 检查解析出的 JSON 行是否为当前任务的 sentinel 结束标记行。
 *
 * @param {unknown} value - 已解析的 JSON 值
 * @param {string} token - 当前任务的唯一 token
 * @returns {boolean}
 */
export function isSentinelRow(value, token) {
	return Array.isArray(value) && value.length === 1 && value[0]?.[TOKEN_COLUMN] === token;
}
