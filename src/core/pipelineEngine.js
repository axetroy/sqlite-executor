import { Queue } from "./queue.js";
import { InflightTracker } from "./inflightTracker.js";
import { createJsonValueParser } from "./parser.js";
import { settleTask } from "./settleUtils.js";
import { handleParsedValue, createSweeper, createFinalizeScheduler, createPumpQueue, rejectAllTasks, prepareTaskTimeout, handleSentinelTask, handleStderrChunk } from "./pipelineUtils.js";
import { DEFAULT_BATCH_SIZE, DEFAULT_MAX_INFLIGHT } from "../constants.js";

/**
 * 管线化执行引擎。
 *
 * 维护任务队列、管理 inflight 任务、处理 stdout/stderr 解析、
 * 实现 sentinel token 协议和 stderr 竞态处理。
 *
 * PipelineEngine 不关心事务作用域、读写分离或进程恢复 ——
 * 这些由上层（SQLiteExecutor）负责。
 */
export class PipelineEngine {
	#queue = new Queue();
	#inflight = new InflightTracker();
	#pendingFinalizeTasks = new Set();
	#sharedValueParser;
	#processManager;
	#metrics;
	#statementTimeout;
	#logger;
	#batchSize;
	#maxInflight;
	#onTaskTimeout;
	#active = false;
	#sweeper;
	/** 由 createFinalizeScheduler 创建的闭包，替代 #scheduleFinalizeCheck 方法 */
	#scheduleFinalizeCheck;
	/** 由 createPumpQueue 创建的泵送函数（不含 active 守卫） */
	#pump;

	/** 多任务非 WAL batch 中无法立即归因的 stderr 缓冲 */
	#pendingStderr = [];

	/**
	 * 标记此前是否已结算过零行 query 任务（无论成功或失败）。
	 * 若为 true，则 handleStderrChunk 中零行 inflight query 的 stderr
	 * 可能是来自已结算任务的延迟/残余 stderr，应缓冲到 #pendingStderr 而非直接归因。
	 */
	#hasFinalizedZeroRowQuery = false;

	/**
	 * @param {import("./process.js").ProcessManager} processManager
	 * @param {{
	 *   metrics: import("./metrics.js").Metrics,
	 *   statementTimeout: number,
	 *   logger?: import("../index.js").Logger,
	 *   batchSize?: number,
	 *   onTaskTimeout?: (task: object) => void,
	 * }} options
	 */
	constructor(
		processManager,
		{
			metrics,
			statementTimeout,
			logger,
			batchSize = DEFAULT_BATCH_SIZE,
			maxInflight = DEFAULT_MAX_INFLIGHT,
			onTaskTimeout,
			sweepInterval = 100,
		},
	) {
		this.#processManager = processManager;
		this.#metrics = metrics;
		this.#statementTimeout = statementTimeout;
		this.#logger = logger;
		this.#batchSize = batchSize;
		this.#maxInflight = maxInflight;
		this.#onTaskTimeout = onTaskTimeout ?? (() => {});

		// 创建共享管道组件
		this.#sweeper = createSweeper({
			inflight: this.#inflight,
			sweepIntervalMs: sweepInterval,
			handleTaskTimeout: (task) => {
				const error = prepareTaskTimeout(task, this.#metrics);
				if (error) {
					this.#settleTask(task, error, undefined);
					this.#onTaskTimeout?.(task);
				}
			},
		});
		this.#pump = createPumpQueue({
			queue: this.#queue,
			inflight: this.#inflight,
			processManager: this.#processManager,
			sweeper: this.#sweeper,
			batchSize: this.#batchSize,
			maxInflight: this.#maxInflight,
		});
		this.#scheduleFinalizeCheck = createFinalizeScheduler({
			pendingFinalizeTasks: this.#pendingFinalizeTasks,
			settleTask: (t, e, v) => this.#settleTask(t, e, v),
			pumpQueue: () => this.#pumpQueue(),
			pendingStderr: this.#pendingStderr,
			inflight: this.#inflight,
		});
		this.#sharedValueParser = createJsonValueParser((raw) => {
			handleParsedValue(raw, this.#inflight, {
				afterSentinel: (task) => this.#afterSentinel(task),
				rejectAll: (error) => this.rejectAll(error),
			});
		});
		this.#processManager.setOnDrainCallback(() => this.#pumpQueue());
	}

	/** 测试用：获取扫制定时器引用。 */
	get _sweepTimer() {
		return this.#sweeper?.getSweepTimer() ?? null;
	}

	/** 主任务队列（供事务延迟任务恢复使用）。 */
	get mainQueue() {
		return this.#queue;
	}

	/** 主动触发一次队列发送。 */
	pump() {
		this.#pumpQueue();
	}

	/** 当前待处理的任务总数（队列中 + 执行中 + pendingFinalize）。 */
	get pendingStatements() {
		return this.#queue.size + this.#inflight.count + this.#pendingFinalizeTasks.size;
	}

	/**
	 * 将数据送入 sharedValueParser 解析（供 stream 的 rowParser 回喂数据使用）。
	 * @param {string} raw
	 */
	feed(raw) {
		this.#sharedValueParser.feed(raw);
	}

	/** 标记引擎可用，允许发送任务。 */
	activate() {
		this.#sharedValueParser?.reset();
		this.#active = true;
	}

	/** 标记引擎不可用，阻止发送新任务。 */
	deactivate() {
		this.#active = false;
	}

	/**
	 * 入队一个任务。
	 * 任务对象应包含：kind, sql, timeout, token, onRow, rows, resolve, reject,
	 * consumerError, stderrText, timer, startTime, startedAt, rowParser。
	 * @param {object} task
	 */
	enqueue(task) {
		this.#queue.enqueue(task);
		this.#pumpQueue();
	}

	/**
	 * 从队列批量取出任务发送给 sqlite3 进程（active 守卫包装）。
	 * 实际逻辑委托给 this.#pump（由 createPumpQueue 创建）。
	 */
	#pumpQueue() {
		if (!this.#active) return;
		this.#pump();
	}

	/**
	 * 处理 sqlite3 的 stdout 输出。
	 * 对于 stream 类型任务，先通过行流解析器逐行处理，剩余数据转给 JSON 值解析器。
	 * @param {string} chunk
	 */
	handleStdoutChunk(chunk) {
		const task = this.#inflight.first;
		if (!task) return;

		// 已超时的 stream 任务：禁止继续喂给 rowParser（rowParser.reset 后 finished=false，
		// 否则会触发 spurious onRow 回调）。数据直接走 sharedValueParser 由
		// handleParsedValue 中的 task.timedout 短路丢弃。
		if (task.kind === "stream" && task.rowParser && !task.rowParser.finished && !task.timedout) {
			const leftover = task.rowParser.feed(chunk);
			if (leftover) this.#sharedValueParser.feed(leftover);
			return;
		}

		this.#sharedValueParser.feed(chunk);
	}

	/**
	 * sentinel token 命中后的统一处理逻辑（委托句共享函数）。
	 */
	#afterSentinel(task) {
		handleSentinelTask(task, {
			settleTask: (t, e, v) => this.#settleTask(t, e, v),
			pendingFinalizeTasks: this.#pendingFinalizeTasks,
			scheduleFinalizeCheck: () => this.#scheduleFinalizeCheck(),
			pumpQueue: () => this.#pumpQueue(),
		});
	}

	/**
	 * 处理 sqlite3 的 stderr 输出（委托给共享函数）。
	 * @param {string} chunk
	 */
	handleStderrChunk(chunk) {
		handleStderrChunk(chunk, {
			inflight: this.#inflight,
			pendingFinalizeTasks: this.#pendingFinalizeTasks,
			logger: this.#logger,
			pendingStderr: this.#pendingStderr,
			hasFinalizedZeroRowQuery: this.#hasFinalizedZeroRowQuery,
		});
	}

	#settleTask(task, error, value) {
		// 零行 query 任务结算后，其对应的 stderr 可能仍有残余分片在途：
		//   - 成功结算（无错误）：stderr 尚未到达
		//   - 失败结算（有错误）：部分 stderr 已到达并归因，但同一条错误消息
		//     可能被 OS 管道拆分，剩余分片仍会在稍后到达（Windows/macOS 常见）
		// 两种情况下，后续到达的延迟 stderr 都不应归因给新的 inflight query，
		// 故标记 #hasFinalizedZeroRowQuery 提醒 handleStderrChunk 将其缓冲到
		// pendingStderr，交由零行归因机制兜底。
		if (task.kind === "query" && task.rows?.length === 0) {
			this.#hasFinalizedZeroRowQuery = true;
		}
		settleTask(task, error, value, this.#metrics, { resetRowParser: true });
	}

	/**
	 * 拒绝 inflight 任务以及队列中的所有待处理任务。
	 * 不清除 deferred 队列（由上层负责）。
	 * @param {Error} error
	 */
	rejectAll(error) {
		this.#sharedValueParser.reset();
		rejectAllTasks({
			inflight: this.#inflight,
			queue: this.#queue,
			pendingFinalizeTasks: this.#pendingFinalizeTasks,
			settleTask: (t, e, v) => this.#settleTask(t, e, v),
			error,
		});
	}

	/**
	 * 终止引擎：拒绝所有任务，清空状态。
	 */
	kill() {
		this.#active = false;
		this.#sweeper.clear();
		this.#scheduleFinalizeCheck.cancel?.();
		this.rejectAll(new Error("PipelineEngine is killed"));
	}
}
