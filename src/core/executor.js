import { DEFAULT_STATEMENT_TIMEOUT } from "../utils/timeout.js";
import { VALID_TRANSACTION_MODES, createTransactionHandle } from "../transaction/transaction.js";
import { ProcessManager } from "./process.js";
import { toError } from "./parser.js";
import { generateToken } from "../utils/token.js";

import { setupStreamParser, AsyncRowBuffer } from "../stream/stream.js";
import { interpolateFromTemplate } from "../utils/interpolate.js";
import { normalizeSQLTemplate } from "../utils/normalize.js";
import { classifySQL } from "./classifier.js";
import { ReaderPool } from "./readerPool.js";
import { Metrics } from "./metrics.js";
import { TransactionScope } from "./transactionScope.js";
import { PipelineEngine } from "./pipelineEngine.js";

/**
 * SQLite 执行器。
 *
 * 通过 stdin/stdout 与 sqlite3 CLI 进程通信，提供 execute/query/stream/transaction API。
 * 内部使用管线化队列批量发送任务，基于 Sentinel token 协议检测单个 SQL 任务的输出边界。
 */
export class SQLiteExecutor {
	#closed = false;
	#proc = null;
	#logger;
	#statementTimeout;
	#autoRestart;
	#fatalError = null;
	#processManager;
	#readerPool = null;
	#poolSize;
	#binary;
	#database;
	#metrics;
	#pipeline;
	#txScope = new TransactionScope();

	/**
	 * @param {{
	 *   binary?: string,
	 *   database?: string,
	 *   logger?: import("../index.js").Logger,
	 *   statementTimeout?: number,
	 *   autoRestart?: boolean,
	 *   poolSize?: number,
	 *   metrics?: import("./metrics.js").Metrics,
	 * }} options
	 */
	constructor({
		binary = "sqlite3",
		database = ":memory:",
		logger,
		statementTimeout = DEFAULT_STATEMENT_TIMEOUT,
		autoRestart = true,
		poolSize = 0,
		metrics,
	} = {}) {
		this.#logger = logger;
		this.#statementTimeout = this.#normalizeTimeout(statementTimeout);
		this.#autoRestart = autoRestart !== false;
		this.#binary = binary;
		this.#database = database;
		this.#poolSize = poolSize;
		this.#metrics = metrics ?? new Metrics();

		this.#processManager = new ProcessManager({ binary, database });
		this.#pipeline = new PipelineEngine(this.#processManager, {
			metrics: this.#metrics,
			statementTimeout: this.#statementTimeout,
			logger: this.#logger,
			onTaskTimeout: () => {},
			onHardTaskTimeout: (task) => {
				this.#logger?.warn?.(
					`SQLite process stuck: task timed out but sentinel never arrived (${task.sql}). Restarting...`,
				);
				this.#handleProcessFailure(
					new Error(
						`SQLite hard timeout: task exceeded ${task.timeout}ms (2× timeout) without sentinel arrival; `
						+ `SQL: ${task.sql}`,
					),
				);
			},
		});
		this.#startProcess();

		if (poolSize > 0 && database !== ":memory:") {
			this.#readerPool = new ReaderPool({
				binary,
				database,
				poolSize,
				statementTimeout,
				logger,
				metrics: this.#metrics,
			});
		}
	}

	/** 当前待处理的任务总数（队列中 + 执行中 + reader 队列中） */
	get pendingStatements() {
		return this.#txScope.pendingStatements + this.#pipeline.pendingStatements + (this.#readerPool?.pendingStatements ?? 0);
	}

	/** 读取器连接池（null 表示未启用读写分离）。 */
	get readerPool() {
		return this.#readerPool;
	}

	/** 测试用：获取底层子进程引用。 */
	get _process() {
		return this.#proc;
	}

	/** 运行时指标收集器。 */
	get metrics() {
		return this.#metrics;
	}

	/**
	 * 执行 SQL 语句（不返回行数据）。
	 * 适用于 INSERT / UPDATE / CREATE 等非查询操作。
	 * @param {string} sql
	 * @param {any[]} [params]
	 * @param {{ timeout?: number }} [options]
	 * @returns {Promise<void>}
	 */
	async execute(sql, params = [], options = {}) {
		await this.#enqueue("execute", sql, params, options, null);
	}

	/**
	 * 执行查询并返回所有结果行。
	 * @template T
	 * @param {string} sql
	 * @param {any[]} [params]
	 * @param {{ timeout?: number }} [options]
	 * @returns {Promise<T[]>}
	 */
	query(sql, params = [], options = {}) {
		return this.#enqueue("query", sql, params, options, null);
	}

	/**
	 * 流式执行查询，返回 AsyncIterable，可配合 `for await` 逐行消费。
	 *
	 * @template T
	 * @param {string} sql
	 * @param {any[]} [params]
	 * @param {{ timeout?: number }} [options]
	 * @returns {AsyncIterable<T>}
	 */
	stream(sql, params = [], options = {}) {
		if (!Array.isArray(params)) throw new TypeError("params must be an array");

		const buffer = new AsyncRowBuffer();

		this.#enqueue(
			"stream",
			sql,
			params,
			{
				...options,
				onRow: (row) => buffer.push(row),
			},
			null,
		).then(
			() => buffer.end(),
			(err) => buffer.error(err),
		);

		return buffer;
	}

	/**
	 * 在一个数据库事务中执行用户函数。
	 * 事务内所有操作共享一个域，不会被外部任务交错。
	 * 函数成功时自动 COMMIT，抛出异常时自动 ROLLBACK。
	 * @template T
	 * @param {(tx: import("../index.js").TransactionHandle) => Promise<T>} fn
	 * @param {{ mode?: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE" }} [options]
	 * @returns {Promise<T>}
	 */
	async transaction(fn, options = {}) {
		const mode = options?.mode ?? "DEFERRED";
		if (!VALID_TRANSACTION_MODES.includes(mode)) {
			throw new TypeError(`transaction mode must be one of: ${VALID_TRANSACTION_MODES.join(", ")}`);
		}

		const { scopeId, release } = await this.#txScope.enter();

		const tx = createTransactionHandle(scopeId, {
			enqueue: (kind, sql, params, options, sid) => this.#enqueue(kind, sql, params, options, sid),
		});

		try {
			await tx.execute(`BEGIN ${mode}`);
			try {
				const result = await fn(tx);
				await tx.execute("COMMIT");
				return result;
			} catch (error) {
				await tx.execute("ROLLBACK").catch(() => {});
				throw error;
			}
		} finally {
			this.#txScope.exit();
			this.#txScope.restoreDeferred(this.#pipeline.mainQueue);
			this.#pipeline.pump();
			release();
		}
	}

	/**
	 * 关闭执行器，拒绝所有待处理任务，终止 sqlite3 进程。
	 * @returns {Promise<void>}
	 */
	async close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#pipeline.kill();
		this.#txScope.rejectAll(new Error("SQLiteExecutor is closed"));

		this.#readerPool?.kill();

		// gracefulShutdown 已等 close 事件，进程一定已退出
		await this.#processManager.gracefulShutdown();
		this.#processManager.kill();
	}

	/**
	 * 显式资源管理（Stage 3 TC39）：await using。
	 * 委托给 close()，使得执行器可通过 `await using db = new SQLiteExecutor()` 使用。
	 * @returns {Promise<void>}
	 */
	[Symbol.asyncDispose]() {
		return this.close();
	}

	/**
	 * 显式资源管理（Stage 3 TC39）：using。
	 * 同步销毁场景下的 fire-and-forget 关闭。
	 */
	[Symbol.dispose]() {
		void this.close();
	}

	#normalizeTimeout(value) {
		if (!Number.isInteger(value) || value < 0) {
			throw new TypeError("statementTimeout must be a non-negative integer");
		}
		return value;
	}

	#startProcess() {
		let proc;
		try {
			proc = this.#processManager.start();
		} catch (error) {
			this.#fatalError = toError(error);
			this.#logger?.error?.("failed to start sqlite3 process", this.#fatalError);
			return;
		}

		if (!proc.stdout) {
			this.#fatalError = new Error(`Failed to spawn sqlite3 process: stdio unavailable (binary=${this.#binary})`);
			this.#processManager.kill();
			return;
		}

		proc.stdout.on("data", (chunk) => {
			this.#pipeline.handleStdoutChunk(chunk);
		});

		proc.stderr?.on("data", (chunk) => {
			this.#pipeline.handleStderrChunk(chunk);
		});

		proc.on("error", (error) => {
			/* c8 ignore next */ // 死亡分支：listener 在 #handleProcessFailure 中被 removeAllListeners 清除
			if (this.#proc !== proc) return;
			this.#logger?.error?.("sqlite3 process error", error);
			this.#handleProcessFailure(error);
		});

		proc.on("close", (code, signal) => {
			/* c8 ignore next */ // 死亡分支：listener 在 #handleProcessFailure 中被 removeAllListeners 清除
			if (this.#proc !== proc) return;
			if (this.#closed) return;
			/* c8 ignore next */ // Windows: kill→signal=null, ?? 永远取 "none"
			this.#handleProcessFailure(new Error(`sqlite3 process exited unexpectedly (code=${code}, signal=${signal ?? "none"})`));
		});

		this.#proc = proc;
		this.#pipeline.activate();
	}

	#enqueue(kind, sql, params, options, scopeId) {
		if (this.#closed) return Promise.reject(new Error("SQLiteExecutor is closed"));
		if (this.#fatalError) return Promise.reject(this.#fatalError);
		if (!Array.isArray(params)) return Promise.reject(new TypeError("params must be an array"));

		const timeout = options?.timeout ?? this.#statementTimeout;
		const token = generateToken();
		const onRow = options?.onRow ?? null;

		const template = normalizeSQLTemplate(sql);

		let formatted;
		if (params.length === 0 && template.paramCount === 0) {
			formatted = template.normalized;
		} else {
			formatted = interpolateFromTemplate(template, params);
		}

		if (scopeId) {
			return this.#enqueueWriter(kind, formatted, timeout, token, onRow, scopeId);
		}

		if (this.#readerPool) {
			if (kind === "stream" || kind === "query") {
				return this.#enqueueReader(kind, formatted, timeout, token, onRow);
			}
			if (kind === "execute" && classifySQL(template.normalized) === "read") {
				return this.#enqueueReader(kind, formatted, timeout, token, onRow);
			}
		}

		return this.#enqueueWriter(kind, formatted, timeout, token, onRow, null);
	}

	#enqueueWriter(kind, sql, timeout, token, onRow, scopeId) {
		this.#metrics.incrementTasksTotal(kind);
		return new Promise((resolve, reject) => {
			const task = {
				kind,
				sql,
				timeout,
				token,
				onRow,
				scopeId,
				resolve,
				reject,
				consumerError: null,
				stderrText: "",
				settled: false,
				startTime: 0,
				startedAt: 0,
				rowParser: null,
				rows: kind === "query" ? [] : null,
			};

			if (kind === "stream") {
				task.rowParser = setupStreamParser(task, this.#pipeline);
			}

			if (this.#txScope.isDeferred(scopeId)) {
				this.#txScope.defer(task);
			} else {
				this.#pipeline.enqueue(task);
			}
		});
	}

	#enqueueReader(kind, sql, timeout, token, onRow) {
		return new Promise((resolve, reject) => {
			this.#readerPool.enqueue({
				kind,
				sql,
				timeout,
				token,
				onRow,
				resolve,
				reject,
			});
		});
	}

	#handleProcessFailure(error) {
		const failure = toError(error);
		this.#processManager.kill();
		this.#proc = null;

		this.#pipeline.deactivate();
		this.#pipeline.rejectAll(failure);
		this.#txScope.rejectAll(failure);

		if (!this.#closed && this.#autoRestart) {
			this.#metrics.incrementProcessRestarts();
			this.#startProcess();
			return;
		}

		this.#fatalError = failure;
		this.#closed = true;
	}
}
