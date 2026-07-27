import { TaskWorker } from "./taskWorker.js";

/**
 * 读取器连接池。
 * 维护多个 TaskWorker 实例，每个连接一个独立的 sqlite3 进程。
 * 通过 round-robin 分发只读任务，实现并发读取。
 */
export class ReaderPool {
	#workers = [];
	#rrIndex = 0;

	/**
	 * @param {{
	 *   binary: string
	 *   database: string
	 *   poolSize: number
	 *   statementTimeout: number
	 *   logger?: import("../index.js").Logger
	 *   metrics?: import("./metrics.js").Metrics
	 * }} options
	 */
	constructor({ binary, database, poolSize, statementTimeout, logger, metrics }) {
		if (poolSize < 1) throw new RangeError("poolSize must be >= 1");
		for (let i = 0; i < poolSize; i++) {
			const worker = new TaskWorker({
				binary,
				database,
				statementTimeout,
				logger,
				metrics,
				name: `reader-${i}`,
				// 使用 initMode="none"：reader 进程由 TaskWorker 延迟启动
				// （首次 enqueue 时），此时 SQLiteExecutor 的 writer 已完成 WAL 模式初始化。
				// reader 的 sqlite3 进程会自动从数据库文件头检测到 WAL 模式并沿用。
				// 使用 "none" 可以避免：
				//   1. 与 writer 同时启动时 -cmd PRAGMA journal_mode=WAL; 的 EXCLUSIVE 锁竞争
				//      （"database is locked" 错误）
				//   2. -cmd PRAGMAs 的 stdout 输出（如 [{"journal_mode":"wal"}]）泄漏到首个
				//      查询任务的 rows 中（延迟启动导致 PRAGMA 输出在首任务入队后才到达）
				initMode: "none",
			});
			this.#workers.push(worker);
		}
	}

	get size() {
		return this.#workers.length;
	}

	get pendingStatements() {
		return this.#workers.reduce((sum, w) => sum + w.pendingStatements, 0);
	}

	/**
	 * Least Busy 选择一个 reader 并执行任务。
	 * 比较所有 worker 的 pendingStatements，选负载最小的。
	 * 负载相同时按 round-robin 选，确保公平性。
	 * @param {object} task
	 */
	enqueue(task) {
		let minLoad = Infinity;
		const candidates = [];
		for (let i = 0; i < this.#workers.length; i++) {
			const load = this.#workers[i].pendingStatements;
			if (load < minLoad) {
				minLoad = load;
				candidates.length = 0;
				candidates.push(i);
			} else if (load === minLoad) {
				candidates.push(i);
			}
		}
		const idx = candidates[this.#rrIndex % candidates.length];
		this.#rrIndex = (this.#rrIndex + 1) >>> 0;
		this.#workers[idx].enqueue(task);
	}

	/** 测试用：获取内部 worker 列表。 */
	get _workers() {
		return this.#workers;
	}

	/** 终止所有 reader 进程。 */
	kill() {
		for (const worker of this.#workers) {
			worker.kill();
		}
	}
}
