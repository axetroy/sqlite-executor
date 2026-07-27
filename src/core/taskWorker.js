import { ProcessManager } from "./process.js";
import { Queue } from "./queue.js";
import { InflightTracker } from "./inflightTracker.js";
import { createJsonValueParser, toError } from "./parser.js";
import { settleTask } from "./settleUtils.js";
import { handleParsedValue, createSweeper, createFinalizeScheduler, createPumpQueue, rejectAllTasks, prepareTaskTimeout, handleSentinelTask, handleStderrChunk } from "./pipelineUtils.js";
import { DEFAULT_BATCH_SIZE, DEFAULT_MAX_INFLIGHT } from "../constants.js";

/**
 * 单个 sqlite3 进程的任务执行器。
 * 内部维护 pending 和 inflight 两个队列，支持管线化（pipelining）：
 * 多个任务的 SQL payload 合并为一次 stdin.write() 发送，由 sqlite3 顺序执行后，
 * 在 stdout 解析时按 FIFO 顺序匹配 sentinel token 并逐一完成 Promise。
 *
 * TaskWorker 不关心任务是读还是写——它只负责发送 SQL、解析输出、完成 Promise。
 * 由上层（SQLiteExecutor / ReaderPool）决定如何分发任务。
 */
export class TaskWorker {
	#processManager;
	#pendingQueue = new Queue();
	#inflight = new InflightTracker();
	#pendingFinalizeTasks = new Set();
	#valueParser;
	#statementTimeout;
	#logger;
	#name;
	#batchSize;
	#maxInflight;
	#metrics;
	#onHardTaskTimeout;
	#sweeper;
	/** 由 createFinalizeScheduler 创建的闭包，替代 #scheduleFinalizeCheck 方法 */
	#scheduleFinalizeCheck;
	/** 由 createPumpQueue 创建的泵送函数 */
	#pump;

	/** 多任务非 WAL batch 中无法立即归因的 stderr 缓冲 */
	#pendingStderr = [];

	/** 是否已启动子进程（延迟启动标记） */
	#processStarted = false;

	/**
	 * @param {{
	 *   binary: string
	 *   database: string
	 *   statementTimeout: number
	 *   logger?: import("../index.js").Logger
	 *   name?: string
	 *   initMode?: "wal" | "none"
	 *   readonly?: boolean
	 *   batchSize?: number
	 *   metrics?: import("./metrics.js").Metrics
	 *   sweepInterval?: number
	 *   onHardTaskTimeout?: (task: object) => void,
	 * }} options
	 */
	constructor({ binary, database, statementTimeout, logger, name, initMode, readonly, batchSize = DEFAULT_BATCH_SIZE, maxInflight = DEFAULT_MAX_INFLIGHT, metrics, sweepInterval = 100, onHardTaskTimeout }) {
		this.#name = name ?? "worker";
		this.#statementTimeout = statementTimeout;
		this.#logger = logger;
		this.#batchSize = batchSize;
		this.#maxInflight = maxInflight;
		this.#metrics = metrics;
		this.#onHardTaskTimeout = onHardTaskTimeout ?? (() => {});

		// 创建共享管道组件
		// ProcessManager 需在其他管道组件之前创建，因为 createPumpQueue 依赖它
		this.#processManager = new ProcessManager({ binary, database, initMode, readonly });
		this.#processManager.setOnDrainCallback(() => this.#pumpQueue());

		this.#sweeper = createSweeper({
			inflight: this.#inflight,
			sweepIntervalMs: sweepInterval,
			handleTaskTimeout: (task) => {
				const error = prepareTaskTimeout(task, this.#metrics, {
					queueSize: this.#pendingQueue.size,
					inflightCount: this.#inflight.count,
					pendingFinalizeCount: this.#pendingFinalizeTasks.size,
					totalPending: this.pendingStatements,
				});
				if (error) this.#settleTask(task, error, undefined);
			},
			handleHardTaskTimeout: (task) => {
				this.#onHardTaskTimeout?.(task);
			},
		});
		this.#pump = createPumpQueue({
			queue: this.#pendingQueue,
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
		this.#valueParser = createJsonValueParser((raw) => {
			handleParsedValue(raw, this.#inflight, {
				afterSentinel: (task) => this.#afterSentinel(task),
				rejectAll: (error) => this.#rejectAll(error),
			});
		});

		// 延迟启动进程：不在构造函数中启动，而是在第一次 enqueue 时再启动。
		// 原因：当 ReaderPool 的多个 TaskWorker 与 SQLiteExecutor 的 writer
		// 几乎同时启动时，所有进程都会通过 -cmd 执行 PRAGMA journal_mode=WAL;
		// 该 PRAGMA 需要 EXCLUSIVE 锁，而每个进程在打开数据库时已持有 SHARED 锁，
		// 导致双方均无法获取 EXCLUSIVE 锁，出现 "database is locked" 竞争条件。
		// 延迟启动后，reader 进程启动时 writer 已完成 WAL 模式初始化，此时即使
		// reader 的 -cmd 再次执行 PRAGMA journal_mode=WAL; 也是无害的 no-op。
		// this.#startProcess() — 移到 enqueue 中调用
	}

	get name() {
		return this.#name;
	}

	get idle() {
		return this.#inflight.count === 0 && this.#pendingQueue.isEmpty() && this.#pendingFinalizeTasks.size === 0;
	}

	get pendingStatements() {
		return this.#pendingQueue.size + this.#inflight.count + this.#pendingFinalizeTasks.size;
	}

	/**
	 * 接收一个任务配置并加入队列。
	 * 任务配置应包含：kind, sql, timeout, token, resolve, reject, onRow
	 * @param {object} config
	 */
	enqueue(config) {
		// 延迟启动：首次入队时才启动子进程。
		// 避免与同一数据库上的其他 sqlite3 进程（如 SQLiteExecutor 的 writer）
		// 同时启动时两者均通过 -cmd 执行 PRAGMA journal_mode=WAL;
		// 导致 EXCLUSIVE 锁竞争而出现 "database is locked" 错误。
		if (!this.#processStarted) {
			this.#startProcess();
		}
		const task = {
			kind: config.kind,
			sql: config.sql,
			timeout: config.timeout,
			token: config.token,
			resolve: config.resolve,
			reject: config.reject,
			rows: config.kind === "query" ? [] : undefined,
			onRow: config.onRow ?? null,
			consumerError: null,
			stderrText: "",
			settled: false,
			startTime: 0,
			startedAt: 0,
		};
		this.#metrics?.incrementTasksTotal(config.kind);
		this.#pendingQueue.enqueue(task);
		this.#pumpQueue();
	}

	/** 测试用：获取扫制定时器引用。 */
	get _sweepTimer() {
		return this.#sweeper?.getSweepTimer() ?? null;
	}

	/** 测试用：获取底层子进程引用。若进程尚未启动，则触发延迟启动。 */
	get _process() {
		if (!this.#processManager.process && !this.#processStarted) {
			this.#startProcess();
		}
		return this.#processManager.process;
	}

	/** 终止进程并清理。 */
	kill() {
		this.#sweeper.clear();
		this.#scheduleFinalizeCheck.cancel?.();
		this.#rejectAll(new Error(`${this.#name} is killed`));
		this.#processManager.kill();
	}

	// ---- 内部 ----

	#startProcess() {
		if (this.#processStarted) return;
		this.#processStarted = true;

		const proc = this.#processManager.start();

		proc.stdout.on("data", (chunk) => {
			this.#valueParser.feed(chunk);
		});

		proc.stderr.on("data", (chunk) => {
			this.#handleStderrChunk(chunk);
		});

		proc.on("error", (error) => {
			if (this.#processManager.process !== proc) return;
			this.#logger?.error?.(`${this.#name} process error`, error);
			this.#rejectAll(toError(error));
		});

		proc.on("close", (code, signal) => {
			if (this.#processManager.process !== proc) return;
			const err = new Error(`${this.#name} exited unexpectedly (code=${code}, signal=${signal ?? "none"})`);
			this.#rejectAll(err);
		});
	}

	/**
	 * 从 pendingQueue 中取出最多 batchSize 个任务，合并 payload 后一次性写入 stdin。
	 * 实际逻辑委托给 this.#pump（由 createPumpQueue 创建）。
	 */
	#pumpQueue() {
		this.#pump();
	}

	/** sentinel token 命中后的统一处理逻辑（委托给共享函数）。 */
	#afterSentinel(task) {
		handleSentinelTask(task, {
			settleTask: (t, e, v) => this.#settleTask(t, e, v),
			pendingFinalizeTasks: this.#pendingFinalizeTasks,
			scheduleFinalizeCheck: () => this.#scheduleFinalizeCheck(),
			pumpQueue: () => this.#pumpQueue(),
		});
	}

	#handleStderrChunk(chunk) {
		handleStderrChunk(chunk, {
			inflight: this.#inflight,
			pendingFinalizeTasks: this.#pendingFinalizeTasks,
			logger: this.#logger,
			pendingStderr: this.#pendingStderr,
		});
	}

	#settleTask(task, error, value) {
		settleTask(task, error, value, this.#metrics);
	}

	#rejectAll(error) {
		this.#sweeper.clear();
		rejectAllTasks({
			inflight: this.#inflight,
			queue: this.#pendingQueue,
			pendingFinalizeTasks: this.#pendingFinalizeTasks,
			settleTask: (t, e, v) => this.#settleTask(t, e, v),
			error,
		});
	}
}
