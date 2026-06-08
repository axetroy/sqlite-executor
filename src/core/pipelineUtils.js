import { settleTask, collectQueryRows, processStreamRows } from "./settleUtils.js";
import { isSentinelRaw, isSentinelRow, buildBatchPayload } from "./protocol.js";
import { toError } from "./parser.js";
import { createTimeoutError } from "../utils/timeout.js";

/**
 * 批量结算 pendingFinalize 集合中的所有任务。
 * 由 scheduleFinalizeCheck 的 setImmediate 回调调用。
 *
 * 在结算前排空 pendingStderr 缓冲，将之前无法归因的 stderr
 * 通过零行归因机制正确分配到失败的任务上。
 *
 * @param {Set<object>} tasks - pendingFinalizeTasks 集合
 * @param {(task: object, error: Error | null, value: any) => void} settle
 * @param {() => void} pumpQueue
 * @param {string[]} [pendingStderr] - 待处理的 stderr 缓冲
 */
export function finalizePendingTasks(tasks, settle, pumpQueue, pendingStderr, inflight) {
	const hasStderrBuffer = pendingStderr && pendingStderr.length > 0;
	// 排空 pendingStderr 缓冲，尝试零行归因
	if (hasStderrBuffer) {
		for (const chunk of pendingStderr) {
			for (const t of tasks) {
				// 归因给所有零行 query 任务（可能有多个失败 SQL 在同一 batch）
				if (t.kind === "query" && t.rows.length === 0) {
					t.stderrText += chunk;
				}
			}
		}
		// 仅当无更多 inflight 任务时才清除缓冲（否则保留以供后续零行任务使用）
		if (!inflight || inflight.count === 0) {
			pendingStderr.length = 0;
		}
	}

	for (const task of tasks) {
		if (task.stderrText) {
			settle(task, new Error(task.stderrText.trim()), undefined);
			continue;
		}

		if (task.consumerError) {
			settle(task, task.consumerError, undefined);
			continue;
		}

		if (task.kind === "query") {
			settle(task, null, task.rows);
			continue;
		}

		settle(task, null, undefined);
	}

	tasks.clear();
	pumpQueue();
}

/**
 * 处理单任务超时：防重复结算、清除定时器、更新指标、创建超时错误。
 *
 * @param {object} task
 * @param {import("./metrics.js").Metrics | null | undefined} metrics
 * @returns {Error | null} 已创建的 TimeoutError，若任务已结算则返回 null
 */
export function prepareTaskTimeout(task, metrics) {
	if (task.settled) return null;
	task.timedout = true;
	metrics?.incrementTasksTimeout();
	return createTimeoutError(task.timeout, task.sql);
}

/**
 * 创建 sweep 定时器管理器。
 * schedule() 启动定期扫描，检查 inflight 任务是否超时；
 * clear() 停止定时器。
 *
 * @param {{
 *   inflight: import("./inflightTracker.js").InflightTracker,
 *   sweepIntervalMs: number,
 *   handleTaskTimeout: (task: object) => void,
 * }} params
 * @returns {{ schedule: () => void, clear: () => void, getSweepTimer: () => (number | null) }}
 */
export function createSweeper({ inflight, sweepIntervalMs, handleTaskTimeout }) {
	let sweepTimer = null;
	const schedule = () => {
		if (sweepTimer) return;
		sweepTimer = setTimeout(() => {
			sweepTimer = null;
			const now = performance.now();
			inflight.forEach((task) => {
				if (now - task.startTime > task.timeout) {
					handleTaskTimeout(task);
				}
			});
			if (inflight.count > 0) {
				schedule();
			}
		}, sweepIntervalMs).unref();
	};
	const clear = () => {
		clearTimeout(sweepTimer);
		sweepTimer = null;
	};
	return { schedule, clear, getSweepTimer: () => sweepTimer };
}

/**
 * 创建 pendingFinalize 结算调度器。
 * 通过 setImmediate 延迟一帧执行 finalizePendingTasks，给 stderr chunk 到达的时间窗口。
 * 若 finalizePendingTasks 中有零行 query 等待 stderr，自动重新调度下一轮 finalize。
 *
 * @param {{
 *   pendingFinalizeTasks: Set<object>,
 *   settleTask: (task: object, error: Error | null, value: any) => void,
 *   pumpQueue: () => void,
 *   pendingStderr?: string[],
 *   inflight?: import("./inflightTracker.js").InflightTracker,
 * }} params
 * @returns {() => void}
 */
export function createFinalizeScheduler({ pendingFinalizeTasks, settleTask: settle, pumpQueue, pendingStderr, inflight }) {
	let scheduled = false;
	let immediate = null;
	let cancelled = false;
	const cancel = () => {
		cancelled = true;
		if (immediate) {
			clearImmediate(immediate);
			immediate = null;
		}
	};
	const check = () => {
		if (cancelled) return;
		if (scheduled) return;
		if (pendingFinalizeTasks.size === 0) return;
		scheduled = true;
		immediate = setImmediate(() => {
			immediate = null;
			if (cancelled) return;
			finalizePendingTasks(pendingFinalizeTasks, settle, pumpQueue, pendingStderr, inflight);
			scheduled = false;
		});
	};
	check.cancel = cancel;
	return check;
}

/**
 * 处理一个完整的 JSON 值（来自 sharedValueParser）。
 * 匹配 sentinel token、收集 query 行数据、触发 stream 回调。
 * PipelineEngine 和 TaskWorker 共享此逻辑。
 *
 * @param {string} raw - 原始 JSON 文本
 * @param {import("./inflightTracker.js").InflightTracker} inflight
 * @param {{
 *   afterSentinel: (task: object) => void,
 *   rejectAll: (error: Error) => void,
 * }} callbacks
 */
export function handleParsedValue(raw, inflight, { afterSentinel, rejectAll }) {
	const task = inflight.first;
	if (!task) return;

	// Fast path: 原始字符串精确匹配 sentinel，跳过 JSON.parse
	if (isSentinelRaw(raw, task.token)) {
		inflight.shift();
		afterSentinel(task);
		return;
	}

	// Fast path: 空数组 []，execute 的零行结果，跳过 JSON.parse
	if (raw === "[]") return;

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		rejectAll(new Error(`Invalid JSON from sqlite3: ${toError(error).message}`));
		return;
	}

	if (isSentinelRow(parsed, task.token)) {
		inflight.shift();
		afterSentinel(task);
		return;
	}

	if (task.timedout) return;

	if (task.kind === "query") {
		collectQueryRows(task, parsed);
		return;
	}

	if (task.kind === "stream") {
		processStreamRows(task, parsed);
	}
}

/**
 * 创建一个泵送（pump）函数，将队列中的任务批量发送给 sqlite3 进程。
 *
 * PipelineEngine 和 TaskWorker 共享此工厂，消除 #pumpQueue 方法的重复。
 * 调用方可通过 active 守卫（可选）控制是否允许泵送。
 *
 * @param {{
 *   queue: import("./queue.js").Queue,
 *   inflight: import("./inflightTracker.js").InflightTracker,
 *   processManager: { draining: boolean, write: (data: string) => void, onDrained: (cb: () => void) => void },
 *   sweeper: { schedule: () => void },
 *   batchSize: number,
 *   maxInflight: number,
 * }} params
 * @returns {() => void} 泵送函数，调用后尝试从队列取出 batch 发送
 */
export function createPumpQueue({ queue, inflight, processManager, sweeper, batchSize, maxInflight }) {
	let nextBatchId = 1;
	return function pump() {
		if (processManager.draining) {
			processManager.onDrained(() => pump());
			return;
		}
		if (inflight.count >= maxInflight) return;

		const batch = [];
		while (batch.length < batchSize && !queue.isEmpty() && inflight.count + batch.length < maxInflight) {
			const task = queue.peek();
			if (task.kind === "stream" && (batch.length > 0 || inflight.count > 0)) break;
			queue.dequeue();
			batch.push(task);
		}
		if (batch.length === 0) return;

		const now = performance.now();
		const payload = buildBatchPayload(batch);
		const batchId = nextBatchId++;
		const useWalBatch = payload.startsWith("BEGIN;");

		for (const task of batch) {
			task.startTime = now;
			task.batchId = batchId;
			task.walBatch = useWalBatch;
		}
		inflight.push(...batch);
		sweeper.schedule();
		processManager.write(payload);
	};
}

/**
 * 处理 sentinel token 命中后的任务结算。
 *
 * 此函数提取自 PipelineEngine.#afterSentinel 和 TaskWorker.#afterSentinel，
 * 消除二者间的逻辑重复。统一使用延迟结算策略：
 * - timedout 任务直接跳过（不结算，数据已丢弃）
 * - consumerError 任务立即 reject（用户主动错误无需等待）
 * - 其他任务进入 pendingFinalize 延迟一帧，给 stderr chunk 留到达时间
 *
 * @param {object} task - 已从 inflight shift 的任务
 * @param {{
 *   settleTask: (task: object, error: Error | null, value: any) => void,
 *   pendingFinalizeTasks: Set<object>,
 *   scheduleFinalizeCheck: () => void,
 *   pumpQueue: () => void,
 * }} params
 */
export function handleSentinelTask(task, { settleTask, pendingFinalizeTasks, scheduleFinalizeCheck, pumpQueue }) {
	if (task.timedout) {
		pumpQueue();
		return;
	}

	if (task.consumerError) {
		settleTask(task, task.consumerError, undefined);
		pumpQueue();
		return;
	}

	// 无论 stderrText 是否为空，都走 pendingFinalize 延迟结算。
	// 原因：Windows 上 sqlite3 的 stderr 输出可能被 OS pipe 拆分为多个 chunk，
	// 若在此处立即 reject，后续到达的 stderr chunk 会丢失或被错误地配给下一个 inflight 任务。
	pendingFinalizeTasks.add(task);
	scheduleFinalizeCheck();
	pumpQueue();
}

/**
 * 处理 sqlite3 的 stderr 输出，将其归因到合适的任务。
 *
 * 提取自 PipelineEngine.handleStderrChunk 和 TaskWorker.#handleStderrChunk，
 * 统一采用 PipelineEngine 的精细归因策略：
 *   1. 零行归因 — pendingFinalize 中 rows.length === 0 的 query 极可能是失败源
 *   2. WAL batch — 整个事务回滚，传播到 batch 内所有任务
 *   3. 非 WAL batch（多任务） — 无法确定来源时缓冲到 pendingStderr，由后续
 *      finalizePendingTasks 中的零行归因机制正确归因，避免 stderr 错误地
 *      归因给第一个 inflight 任务（#1957 随机测试报错修复）
 *   4. 非 WAL batch（单任务或 primary 为 pendingFinalize）— 归因给该任务
 *
 * @param {string} chunk - stderr 文本块
 * @param {{
 *   inflight: import("./inflightTracker.js").InflightTracker,
 *   pendingFinalizeTasks: Set<object>,
 *   logger?: { error?: (msg: string) => void },
 *   pendingStderr?: string[],
 * }} params
 */
export function handleStderrChunk(chunk, { inflight, pendingFinalizeTasks, logger, pendingStderr }) {
	const inflightFirst = inflight.first;
	const firstPending = pendingFinalizeTasks.values().next().value;

	// ── 零行归因（优先）──
	// sqlite3 对失败 SQL 只输出 stderr 不输出数据行。
	// pendingFinalize 中 rows.length === 0 的 query 全部可能是失败源。
	// 此 stderr chunk 归因给所有零行任务（而非仅第一个匹配），
	// 确保 batch 中所有失败任务都收到错误消息。
	let zeroRowMatch = false;
	for (const t of pendingFinalizeTasks) {
		if (t.kind === "query" && t.rows.length === 0) {
			t.stderrText += chunk;
			zeroRowMatch = true;
		}
	}
	if (zeroRowMatch) return;

	// ── 选择 primary 任务 ──
	const task = inflightFirst ?? firstPending;

	if (!task) {
		logger?.error?.(chunk.trim());
		return;
	}

	// ── 非 batch 任务（standalone）：直接归因 ──
	if (task.batchId == null) {
		task.stderrText += chunk;
		return;
	}

	// ── WAL batch：整个事务回滚，所有任务受影响 ──
	if (task.walBatch) {
		task.stderrText += chunk;
		for (const t of pendingFinalizeTasks) {
			if (t !== task) t.stderrText += chunk;
		}
		inflight.forEach((t) => {
			if (t !== task) t.stderrText += chunk;
		});
		return;
	}

	// ── 非 WAL batch ──
	if (task === inflightFirst) {
		if (inflight.count > 1) {
			// 多个活跃 inflight 任务：无法确定 stderr 来源。
			// 缓冲，由 finalizePendingTasks 中的零行归因正确匹配。
			pendingStderr?.push(chunk);
		} else if (pendingFinalizeTasks.size > 0) {
			// 唯一 inflight 任务 + 存在 pending 任务。
			// 检查 pending 中是否有零行 query（可能来自已完成任务的 stderr）。
			let hasZeroRowQuery = false;
			for (const t of pendingFinalizeTasks) {
				if (t.kind === "query" && t.rows.length === 0) {
					hasZeroRowQuery = true;
					break;
				}
			}
			if (hasZeroRowQuery) {
				// 有零行 query：缓冲，由 finalizePendingTasks 正确归因
				pendingStderr?.push(chunk);
			} else if (task.kind === "query" && task.rows.length > 0) {
				// inflight 任务已有数据行：它是合法查询，stderr 不来自它。
				logger?.error?.(chunk.trim());
			} else {
				// 唯一 inflight 任务，pending 中无零行 query：
				// stderr 只能来自该 inflight 任务。
				task.stderrText += chunk;
			}
		} else if (task.kind === "query" && task.rows.length > 0) {
			// 唯一的 inflight 任务已有数据行：它是合法查询，stderr 不来自它。
			logger?.error?.(chunk.trim());
		} else if (task.kind === "query") {
			// query 任务：缓冲而非直接归因。
			// 在 macOS 等平台上，上一批次失败任务的 stderr 可能延迟到达，此时的
			// 唯一 inflight query 不一定就是失败源。将其缓冲到 pendingStderr，
			// 由 finalizePendingTasks 的零行归因机制按行数决定是否实际归因：
			//   - sentinel 到达后 rows.length === 0 → 确为失败查询，正确归因
			//   - sentinel 到达后 rows.length > 0  → 合法查询，清除 pendingStderr 不归因
			pendingStderr?.push(chunk);
		} else {
			// execute 任务：无 rows 字段，零行机制无法处理，直接归因。
			task.stderrText += chunk;
		}
		return;
	}

	// ── Primary 是 pendingFinalize 任务（无 inflight）──
	// 没有零行 query 来匹配 stderr。此时 stderr 可能来自某个 execute 任务。
	// 保守地归因给所有 pendingFinalize 任务（恢复旧行为兜底）。
	for (const t of pendingFinalizeTasks) {
		t.stderrText += chunk;
	}
}

/**
 * 拒绝所有待处理任务（inflight、队列、pendingFinalize）。
 *
 * 提取自 PipelineEngine.rejectAll 和 TaskWorker.#rejectAll，
 * 消除二者间的逻辑重复。调用方负责清理各自特有的资源
 * （如 sharedValueParser.reset() 或 sweeper.clear()）。
 *
 * @param {{
 *   inflight: import("./inflightTracker.js").InflightTracker,
 *   queue: import("./queue.js").Queue,
 *   pendingFinalizeTasks: Set<object>,
 *   settleTask: (task: object, error: Error | null, value: any) => void,
 *   error: Error,
 * }} params
 */
export function rejectAllTasks({ inflight, queue, pendingFinalizeTasks, settleTask, error }) {
	// 1. 取走并清空 inflight
	const all = inflight.toArray();
	inflight.clear();

	// 2. 结算队列中的任务（尚未发送）
	let queued = queue.dequeue();
	while (queued) {
		settleTask(queued, error, undefined);
		queued = queue.dequeue();
	}

	// 3. 结算 inflight 任务（正在执行）
	for (const task of all) {
		settleTask(task, error, undefined);
	}

	// 4. 结算 pendingFinalize 任务（等待延迟结算）
	for (const task of pendingFinalizeTasks) {
		settleTask(task, error, undefined);
	}
	pendingFinalizeTasks.clear();
}
