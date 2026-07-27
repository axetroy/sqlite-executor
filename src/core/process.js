import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { which } from "../which.js";

/** @type {number} */
const GRACEFUL_SHUTDOWN_TIMEOUT = 5_000;

/**
 * 管理 sqlite3 子进程的生命周期。
 * 负责启动/stderr/stdin/stdout 管道配置，以及进程的终止与清理。
 */
export class ProcessManager {
	#binary;
	#database;
	#proc = null;
	#initMode;
	#draining = false;
	/** @type {string[]} draining 期间暂存的写入数据，drain 事件后逐个发送 */
	#writeBuffer = [];
	/** @type {(() => void)[]} 通过 onDrained() 注册的回调，缓冲排空后一次触发 */
	#drainCallbacks = [];
	#onDrain;
	#readonly = false;

	/**
	 * @param {{ binary?: string, database?: string, initMode?: "wal" | "none", readonly?: boolean, onDrain?: () => void }} options
	 */
	constructor({ binary, database, initMode = "wal", readonly = false, onDrain } = {}) {
		this.#binary = which(binary) ?? binary;
		this.#database = database;
		this.#initMode = initMode;
		this.#readonly = readonly;
		this.#onDrain = onDrain ?? (() => {});
	}

	/** drain 状态为 true 时表示 OS pipe 已满，应暂停写入 stdin。 */
	get draining() {
		return this.#draining;
	}

	/** 注册 drain 回调，当 pipe 重新可写时被调用。 */
	setOnDrainCallback(fn) {
		this.#onDrain = fn;
	}

	/**
	 * 注册一个"缓冲排空"回调。
	 * 若当前无缓冲且非 draining，回调会被立即同步调用；
	 * 否则暂存，等内部缓冲全部排空、draining 为 false 后一次触发全部回调。
	 * @param {() => void} callback
	 */
	onDrained(callback) {
		if (!this.#draining && this.#writeBuffer.length === 0) {
			callback();
			return;
		}
		this.#drainCallbacks.push(callback);
	}

	get binary() {
		return this.#binary;
	}

	get process() {
		return this.#proc;
	}

	/**
	 * 启动 sqlite3 子进程。
	 * 使用 `-json` 模式启动。
	 * 对于文件数据库，initMode="wal" 时自动启用 WAL 模式 + busy_timeout。
	 * @returns {import("node:child_process").ChildProcess}
	 */
	start() {
		if (!this.#binary) {
			throw new Error("sqlite3 binary path is empty. Provide a valid --binary / binary option.");
		}
		if (path.isAbsolute(this.#binary) && !fs.existsSync(this.#binary)) {
			throw new Error(`sqlite3 binary not found: ${this.#binary}. Make sure sqlite3 is installed or provide a valid --binary / binary option.`);
		}

		const args = ["-json"];
		if (this.#readonly) args.push("-readonly");
		if (this.#database) args.push(this.#database);
		if (this.#database && this.#database !== ":memory:" && this.#initMode === "wal") {
			args.push("-cmd", ".out NUL");
			args.push("-cmd", "PRAGMA journal_mode=WAL;");
			args.push("-cmd", "PRAGMA busy_timeout=5000;");
			args.push("-cmd", ".out stdout");
		}

		const proc = spawn(this.#binary, args, {
			stdio: "pipe",
			shell: false,
			windowsHide: true,
		});

		proc.stdin?.setDefaultEncoding("utf-8");
		proc.stdout?.setEncoding("utf-8");
		proc.stderr?.setEncoding("utf-8");

		// 处理 stdin pipe 在进程退出后被关闭时的 EPIPE 错误。
		// 场景：进程被外部 kill（SIGTERM/KILL）、OS 级进程终止，
		// close 事件尚未到达事件循环时，pump() 可能尝试写入已关闭的 stdin。
		// 错误被吃掉，不传播为 uncaughtException。
		// PipelineEngine 的 pump 会在 close 事件抵达后通过
		// #handleProcessFailure → #pipeline.rejectAll() 正确拒绝所有待处理任务。
		proc.stdin?.on("error", () => {
			// EPIPE 是预期的（进程已退出，stdin pipe 被关闭），静默忽略。
			// 任何 stdin 写入错误都不应传播为 uncaughtException。
		});

		this.#proc = proc;
		return proc;
	}

	/**
	 * 向子进程的 stdin 写入数据。
	 *
	 * 当 Node.js 内部 buffer 超过 highWaterMark（默认 16KB）时 `stream.write()` 返回 false，
	 * 表示 OS pipe 缓冲区已满，应暂停写入等待 drain 事件。
	 *
	 * 旧行为（P0 bug）：
	 * - 在 `#draining = true` 时直接 `return`，静默丢弃后续写入的数据。
	 *
	 * 当前行为（修复）：
	 * - `#draining = true` 时，后续 `write()` 调用将数据存入 `#writeBuffer` 暂存。
	 * - drain 事件触发后：
	 *   1. 清 `#draining`
	 *   2. 调 `#flushBuffer()` 逐个发送缓冲中的数据（可能再次触发 draining，剩余数据继续暂存）
	 *   3. 调 `#notifyIfDrained()` 通知所有 `onDrained` 注册方
	 *   4. 调 `#onDrain()`（上游 pumpQueue 的入口）
	 * - 这样在任何 pipe 容量下都不会丢失数据，写入自动节流。
	 *
	 * @param {string} data
	 */
	write(data) {
		const stream = this.#proc?.stdin;
		if (!stream) return;

		if (this.#draining) {
			this.#writeBuffer.push(data);
			return;
		}

		if (!stream.write(data)) {
			this.#draining = true;
			stream.once("drain", () => {
				this.#draining = false;
				this.#flushBuffer();
				this.#notifyIfDrained();
				this.#onDrain();
			});
		}
	}

	/**
	 * 逐个发送写缓冲区中的数据。
	 * 每项调用 `this.write()`，若 `stream.write()` 再次返回 false，
	 * `#draining` 会重新变为 true，剩余数据继续暂存，等待下一次 drain。
	 */
	#flushBuffer() {
		const buffer = this.#writeBuffer;
		this.#writeBuffer = [];
		for (const data of buffer) {
			this.write(data);
		}
	}

	/**
	 * 当缓冲全部排空且 `#draining = false` 时，触发所有 `onDrained` 回调。
	 * 每个回调最多触发一次（触发后从 `#drainCallbacks` 移除）。
	 */
	#notifyIfDrained() {
		if (this.#draining) return;
		const callbacks = this.#drainCallbacks;
		this.#drainCallbacks = [];
		for (const cb of callbacks) {
			cb();
		}
	}

	/**
	 * 优雅关闭：等待写缓冲区排空，然后向子进程发送 `.quit` 命令并等待其自行退出。
	 * 如果在超时时间内未退出，则强制 kill。
	 * @returns {Promise<void>}
	 */
	async gracefulShutdown() {
		const proc = this.#proc;
		if (!proc) return;
		if (proc.exitCode !== null || proc.signalCode !== null) return;

		// 等待当前缓冲数据（由 drain 期间堆积的 write() 调用产生）全部写入 pipe
		if (this.#draining || this.#writeBuffer.length > 0) {
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, GRACEFUL_SHUTDOWN_TIMEOUT);
				this.onDrained(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}

		if (proc.exitCode !== null || proc.signalCode !== null) return;

		await new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				proc.off("close", finish);
				proc.off("error", finish);
				resolve();
			};
			const forceClose = () => {
				try {
					proc.kill();
				} catch {}
				finish();
			};
			const timer = setTimeout(forceClose, GRACEFUL_SHUTDOWN_TIMEOUT);

			proc.once("close", finish);
			proc.once("error", finish);

			if (proc.exitCode !== null || proc.signalCode !== null) {
				finish();
				return;
			}

			try {
				if (!proc.stdin) {
					forceClose();
					return;
				}
				proc.stdin.write(".quit\n", (error) => {
					if (error) forceClose();
				});
			} catch {
				forceClose();
			}
		});
	}

	/**
	 * 终止子进程并清理所有监听器与管道。
	 * @returns {import("node:child_process").ChildProcess | null} 被终止的进程引用（如果没有正在运行的进程则为 null）
	 */
	kill() {
		const proc = this.#proc;
		if (!proc) return null;
		this.#proc = null;
		this.#draining = false;
		this.#writeBuffer = [];
		this.#drainCallbacks = [];
		proc.stdout?.removeAllListeners();
		proc.stderr?.removeAllListeners();
		proc.removeAllListeners();
		proc.stdin?.destroy();
		proc.kill();
		return proc;
	}
}
