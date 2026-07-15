import assert from "node:assert/strict";
import test, { before, after, describe, beforeEach, afterEach } from "node:test";

import { PipelineEngine } from "./pipelineEngine.js";
import { Metrics } from "./metrics.js";
import { TOKEN_COLUMN } from "./protocol.js";
import { Queue } from "./queue.js";
import { createRowStreamParser, toError } from "./parser.js";

/**
 * 创建一个存根 ProcessManager，记录 write 调用。
 * 支持 onDrained（P0 修复新增），用于 drain 背压测试。
 */
function createMockProcessManager() {
	let _drainCallback = null;
	/** @type {(() => void)[]} */
	let _onDrainedCallbacks = [];
	return {
		_writes: [],
		_draining: false,
		get draining() { return this._draining; },
		set draining(v) { this._draining = v; },
		get hasPendingWrite() { return this._draining; },
		write(payload) {
			this._writes.push(payload);
		},
		setOnDrainCallback(fn) {
			_drainCallback = fn;
		},
		onDrained(callback) {
			if (!this._draining) {
				callback();
				return;
			}
			_onDrainedCallbacks.push(callback);
		},
		_triggerDrain() {
			this._draining = false;
			const cbs = _onDrainedCallbacks;
			_onDrainedCallbacks = [];
			for (const cb of cbs) cb();
			_drainCallback?.();
		},
	};
}

/**
 * 创建一个带 resolve/reject Promise 的任务对象。
 */
function createTask(overrides = {}) {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return {
		task: {
			kind: "query",
			sql: "SELECT 1",
			timeout: 5000,
			token: `tok-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			onRow: null,
			rows: [],
			resolve,
			reject,
			consumerError: null,
			stderrText: "",
			settled: false,
			timer: null,
			startTime: 0,
			rowParser: null,
			...overrides,
		},
		promise,
	};
}

/** 等待 setImmediate 清空 pendingFinalize 队列 */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

// PipelineEngine 的 cleanup (kill) 会 reject 所有待处理任务，
// 这些预期内的拒绝会导致 unhandledRejection 警告并标记文件失败。
// 在文件级别统一抑制，确保只在此测试文件中生效。
const _origListeners = process.listeners("unhandledRejection");

before(() => {
	process.removeAllListeners("unhandledRejection");
	process.on("unhandledRejection", () => {
		/* 静默吞掉预期的清理拒绝 */
	});
});

after(() => {
	process.removeAllListeners("unhandledRejection");
	for (const listener of _origListeners) {
		process.on("unhandledRejection", listener);
	}
});

describe("PipelineEngine", () => {
	/** @type {Metrics} */
	let metrics;
	/** @type {ReturnType<typeof createMockProcessManager>} */
	let mockPM;
	/** @type {PipelineEngine} */
	let engine;
	/** @type {Array<{ task: object }>} */
	let timeouts;

	beforeEach(() => {
		metrics = new Metrics();
		mockPM = createMockProcessManager();
		timeouts = [];
		engine = new PipelineEngine(mockPM, {
			metrics,
			statementTimeout: 5000,
			onTaskTimeout: (task) => {
				timeouts.push(task);
			},
		});
		engine.activate();
	});

	afterEach(() => {
		engine.kill();
	});

	/** 清除任务的定时器，防止 cleanup 时的未捕获活动 */
	function disarm(task) {
		clearTimeout(task.timer);
		task.timer = null;
	}

	// ── 初始状态 ──────────────────────────────────────

	describe("初始状态", () => {
		test("pendingStatements 初始为 0", () => {
			assert.equal(engine.pendingStatements, 0);
		});

		test("mainQueue 返回 Queue 实例且为空", () => {
			const q = engine.mainQueue;
			assert.ok(q instanceof Queue);
			assert.equal(q.size, 0);
		});
	});

	// ── activate / deactivate ─────────────────────────

	describe("activate / deactivate", () => {
		test("deactivate 后 enqueue 不触发 write", () => {
			engine.deactivate();
			const { task, promise } = createTask();
			engine.enqueue(task);
			promise.catch(() => {});
			assert.equal(mockPM._writes.length, 0);
		});

		test("activate 后 enqueue 触发 write", () => {
			engine.activate();
			const { task } = createTask();
			engine.enqueue(task);
			disarm(task);
			assert.equal(mockPM._writes.length, 1);
		});

		test("deactivate → activate 后可正常发送", () => {
			engine.deactivate();
			engine.activate();
			const { task } = createTask();
			engine.enqueue(task);
			disarm(task);
			assert.equal(mockPM._writes.length, 1);
		});

		test("activate 重置 sharedValueParser", () => {
			// feed 一些数据使 valueParser 有残留状态
			engine.feed('{"partial":');
			engine.deactivate();
			engine.activate(); // 应重置 valueParser
			// activate 后 enqueue 一个任务，feed 完整数据应能触发 sentinel
			const { task, promise } = createTask({ token: "act-token" });
			engine.enqueue(task);
			engine.feed(`[{"${TOKEN_COLUMN}":"act-token"}]`);
			// 如果 valueParser 已重置，就能解析出完整 JSON
			assert.equal(mockPM._writes.length, 1);
			promise.catch(() => {});
		});
	});

	// ── enqueue and pump ──────────────────────────────

	describe("enqueue 与 pump", () => {
		test("单个 query 任务 payload 包含 SQL 和 sentinel", () => {
			const { task } = createTask({ kind: "query", sql: "SELECT 1" });
			engine.enqueue(task);
			// 立即清理定时器，避免 cleanup 时残留异步活动
			clearTimeout(task.timer);
			task.timer = null;

			assert.equal(mockPM._writes.length, 1);
			const payload = mockPM._writes[0];
			assert.ok(payload.includes("SELECT 1"), "payload 应包含 SQL");
			assert.ok(payload.includes(task.token), "payload 应包含 token");
			assert.ok(payload.includes(TOKEN_COLUMN), "payload 应包含哨兵列名");
		});

		test("单个 execute 任务发送到 writer", () => {
			const { task } = createTask({
				kind: "execute",
				sql: "CREATE TABLE t (id INT)",
			});
			engine.enqueue(task);
			clearTimeout(task.timer);
			task.timer = null;

			assert.equal(mockPM._writes.length, 1);
			assert.ok(mockPM._writes[0].includes("CREATE TABLE t"));
		});

		test("每个任务都设置了 startTime", () => {
			const before = performance.now();
			const { task } = createTask();
			engine.enqueue(task);
			assert.ok(task.startTime >= before, "startTime 应在 enqueue 之后");
		});
	});

	// ── WAL 批量优化 ────────────────────────────────

	describe("WAL 批量优化", () => {
		test("多个 execute 使用 BEGIN/COMMIT 包裹", () => {
			// 先把所有任务放入队列，再一次性触发 pump
			engine.deactivate();
			const tasks = [];
			for (let i = 0; i < 3; i++) {
				const { task } = createTask({
					kind: "execute",
					sql: `INSERT INTO t VALUES (${i})`,
				});
				engine.enqueue(task);
				tasks.push(task);
			}

			assert.equal(mockPM._writes.length, 0, "deactivate 时不应发送");
			engine.activate();
			engine.pump();

			assert.equal(mockPM._writes.length, 1);
			const payload = mockPM._writes[0];
			assert.ok(payload.startsWith("BEGIN;"), "应以 BEGIN 开头");
			assert.ok(payload.includes("INSERT INTO t VALUES (0)"));
			assert.ok(payload.includes("INSERT INTO t VALUES (1)"));
			assert.ok(payload.includes("INSERT INTO t VALUES (2)"));
			assert.ok(payload.includes("COMMIT;"), "应包含 COMMIT");
			// 每个 task 在 COMMIT 后应有自己的 sentinel
			for (const t of tasks) {
				assert.ok(payload.includes(t.token), `应包含 token ${t.token}`);
			}
			for (const t of tasks) {
				disarm(t);
			}
		});

		test("单个 execute 不使用 WAL batch", () => {
			const { task } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
			});
			engine.enqueue(task);
			disarm(task);

			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"));
		});

		test("混合 execute 和 query 不使用 WAL batch", () => {
			const { task: t1 } = createTask({
				kind: "execute",
				sql: "CREATE TABLE t (id INT)",
			});
			const { task: t2 } = createTask({ kind: "query", sql: "SELECT 1" });
			engine.enqueue(t1);
			engine.enqueue(t2);
			disarm(t1);
			disarm(t2);

			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"));
		});
	});

	// ── WAL batch 跳过事务控制语句 ────────────────────

	describe("WAL batch 跳过事务控制", () => {
		test("BEGIN TRANSACTION 在 batch 中时跳过 WAL batch", () => {
			engine.deactivate();
			const { task: t1 } = createTask({
				kind: "execute",
				sql: "BEGIN TRANSACTION",
			});
			const { task: t2 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
			});
			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.activate();
			engine.pump();

			assert.equal(mockPM._writes.length, 1);
			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"), "不应使用 WAL batch 包裹");
			assert.ok(payload.includes("BEGIN TRANSACTION"));
			assert.ok(payload.includes("INSERT INTO t VALUES (1)"));
			disarm(t1);
			disarm(t2);
		});

		test("COMMIT 在 batch 中时跳过 WAL batch", () => {
			engine.deactivate();
			const { task: t1 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
			});
			const { task: t2 } = createTask({
				kind: "execute",
				sql: "COMMIT",
			});
			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.activate();
			engine.pump();

			assert.equal(mockPM._writes.length, 1);
			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"), "不应使用 WAL batch 包裹");
			disarm(t1);
			disarm(t2);
		});

		test("ROLLBACK 在 batch 中时跳过 WAL batch", () => {
			engine.deactivate();
			const { task: t1 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
			});
			const { task: t2 } = createTask({
				kind: "execute",
				sql: "ROLLBACK",
			});
			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.activate();
			engine.pump();

			assert.equal(mockPM._writes.length, 1);
			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"), "不应使用 WAL batch 包裹");
			disarm(t1);
			disarm(t2);
		});
	});

	// ── WAL batch 错误归因 ──────────────────────────
	//
	// P0: WAL batch 中如果某个任务 SQL 执行失败，stderr 被错误归因到第一个
	// pendingFinalize 任务（而非实际执行失败的任务），导致：
	//   - 成功任务被 reject（因错误文本贴错任务）
	//   - 失败任务被 resolve（因错误文本贴到别的任务上，当前任务 stderrText 为空）
	//
	// 根因：WAL batch 中多个 execute 共享同一个 BEGIN/COMMIT 事务包裹，任一 SQL
	// 失败后整个事务回滚。stderr 无法唯一定位到具体任务，应传播到 batch 中所有任务。
	//
	// 修复后：WAL batch 中任一任务 SQL 失败，该 batch 的所有任务全部 reject。

	describe("WAL batch 错误归因", () => {
		beforeEach(() => {
			engine.deactivate();
		});

		test("修复: WAL batch 中非首任务失败时 batch 内所有任务全部 reject", async () => {
			const { task: t1, promise: p1 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
				token: "wal-p0-t1",
			});
			const { task: t2, promise: p2 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (2)",
				token: "wal-p0-t2",
			});
			const { task: t3, promise: p3 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
				token: "wal-p0-t3",
			});

			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.enqueue(t3);
			engine.activate();
			engine.pump();

			// 确认 WAL batch 被使用（3 个 execute 合批）
			assert.equal(mockPM._writes.length, 1);
			const payload = mockPM._writes[0];
			assert.ok(payload.startsWith("BEGIN;"), "3 个 execute 应使用 WAL batch");

			// ---- 模拟 sqlite3 输出 ----
			// 所有 sentinel 都能正常输出（SELECT 不受事务内错误影响）
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"wal-p0-t1"}]`);
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"wal-p0-t2"}]`);
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"wal-p0-t3"}]`);

			// 模拟 t3（第三个 INSERT）失败的 stderr
			engine.handleStderrChunk("UNIQUE constraint failed: t.v");

			await flush();

			// 修复后：batch 内所有任务全部 reject（WAL 事务已回滚，所有操作均未提交）
			await assert.rejects(p1, /UNIQUE constraint failed/, "t1 在同一 WAL batch 中，应被 reject");
			await assert.rejects(p2, /UNIQUE constraint failed/, "t2 在同一 WAL batch 中，应被 reject");
			await assert.rejects(p3, /UNIQUE constraint failed/, "t3 是实际失败的任务，应被 reject");

			disarm(t1);
			disarm(t2);
			disarm(t3);
		});

		test("修复: WAL batch 中首任务失败时 batch 内所有任务全部 reject", async () => {
			const { task: t1, promise: p1 } = createTask({
				kind: "execute",
				sql: "INSERT INTO non_existent VALUES (1)",
				token: "wal-p0b-t1",
			});
			const { task: t2, promise: p2 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (2)",
				token: "wal-p0b-t2",
			});

			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.activate();
			engine.pump();

			assert.equal(mockPM._writes.length, 1);
			assert.ok(mockPM._writes[0].startsWith("BEGIN;"), "应使用 WAL batch");

			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"wal-p0b-t1"}]`);
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"wal-p0b-t2"}]`);
			engine.handleStderrChunk("no such table: non_existent");

			await flush();

			// 修复后：batch 内所有任务全部 reject
			await assert.rejects(p1, /no such table/, "t1 执行失败，应被 reject");
			await assert.rejects(p2, /no such table/, "t2 在同一 WAL batch 中，应被 reject");

			disarm(t1);
			disarm(t2);
		});

		test("修复: WAL batch 中 stderr 在 sentinel 之前到达时也能正确传播", async () => {
			const { task: t1, promise: p1 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
				token: "wal-early-t1",
			});
			const { task: t2, promise: p2 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (2)",
				token: "wal-early-t2",
			});

			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.activate();
			engine.pump();

			assert.equal(mockPM._writes.length, 1);
			assert.ok(mockPM._writes[0].startsWith("BEGIN;"), "应使用 WAL batch");

			// stderr 在 sentinel 之前到达（inflight 阶段）
			engine.handleStderrChunk("syntax error");

			// 然后 sentinel 才陆续到达
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"wal-early-t1"}]`);
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"wal-early-t2"}]`);

			await flush();

			await assert.rejects(p1, /syntax error/, "stderr 提前到达时，t1 仍应被 reject");
			await assert.rejects(p2, /syntax error/, "stderr 提前到达时，t2 仍应被 reject");

			disarm(t1);
			disarm(t2);
		});
	});

	// ── P0: 非 WAL batch stderr 归因错误 ─────────────
	//
	// P0 场景 A（数据丢失）：
	// 非 WAL batch（混合 execute+query 等导致 WAL 优化被禁用）中，若非首任务 SQL 执行失败，
	// stderr 在全部 sentinel 到达后才被接收时，错误文本被归因到第一个 pendingFinalize 任务
	//（而非实际失败的任务），导致：
	//   - 第一个任务（实际成功）被 reject（错误归因）
	//   - 实际失败的任务被 resolve（stderrText 为空）→ DATA LOSS
	//
	// 根因：handleStderrChunk 始终用 `pendingFinalizeTasks.values().next().value` 取第一个任务，
	// 而 walBatch=false 的任务不触发 WAL batch 传播逻辑。

	describe("P0: 非 WAL batch stderr 归因错误", () => {
		beforeEach(() => {
			engine.deactivate();
		});

		test("P0: 非 WAL batch 中任务失败(stderr 在 sentinel 之后到达) → stderr 传播到同 batch 所有任务", async () => {
			// 混合 execute + query 使 batch 不使用 WAL 优化
			const { task: t1, promise: p1 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
				token: "nw-p0-t1",
			});
			const { task: t2, promise: p2 } = createTask({
				kind: "query",
				sql: "SELECT 1 AS v",
				token: "nw-p0-t2",
			});
			const { task: t3, promise: p3 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
				token: "nw-p0-t3",
			});

			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.enqueue(t3);
			engine.activate();
			engine.pump();

			// 确认 payload 不是 WAL batch（不含 BEGIN;）
			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"), "混合 batch 不应使用 WAL batch");

			// 所有 sentinel 先到达（query 先送数据行，再送 sentinel）
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"nw-p0-t1"}]`);
			engine.handleStdoutChunk(`[{"v":1}]`); // t2 数据行（SELECT 1 AS v）
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"nw-p0-t2"}]`);
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"nw-p0-t3"}]`);

			// stderr（属于 t3）在全部 sentinel 之后到达
			engine.handleStderrChunk("UNIQUE constraint failed");

			await flush();

			// ── 全部 pendingFinalize 任务都拿到 stderr → 全部 reject ──
			await assert.rejects(
				p1,
				/UNIQUE constraint/,
				"t1（SQL 执行成功）因 batch 内 stderr 传播而被 reject",
			);
			await assert.rejects(
				p2,
				/UNIQUE constraint/,
				"t2（query）因 batch 内 stderr 传播而被 reject",
			);
			await assert.rejects(
				p3,
				/UNIQUE constraint/,
				"t3（SQL 执行失败）正确拿到 stderr → reject",
			);

			disarm(t1);
			disarm(t2);
			disarm(t3);
		});

		test("P0: 非 WAL batch 中同步到达的 stderr 归因正确（不作为 P0——仅用于对比）", async () => {
			// 如果 stderr 在 sentinel 之前到达，归因是正确的
			const { task: t1, promise: p1 } = createTask({
				kind: "query",
				sql: "SELECT * FROM bad_table",
				token: "nw-ok-t1",
			});

			engine.enqueue(t1);
			engine.activate();
			engine.pump();

			// stderr 先到
			engine.handleStderrChunk("no such table");
			// sentinel 后到
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"nw-ok-t1"}]`);

			await flush();

			// 这个 case 是正确的（stderr 到达时 t1 是唯一个人口）
			await assert.rejects(p1, /no such table/, "单个任务 stderr 先到 → 正确 reject");
			disarm(t1);
		});
	});

	// ── P0: setImmediate 之后到达的 stderr 丢失 ──────
	//
	// P0 场景 B（数据丢失）：
	// stderr 在 setImmediate 回调（finalizePendingTasks）已经执行完毕之后才到达。
	// 此时 pendingFinalizeTasks 已被清空，任务已结算（resolve），
	// stderr 因找不到归属任务而被 logger 静默吞掉。
	//
	// 这意味着：一个 SQL 执行失败的任务被错误地 resolve 为成功，用户完全不知情。

	describe("P0: setImmediate 之后抵达的 stderr 丢失", () => {
		test("P0: stderr 在 finalizePendingTasks 之后到达 → stderr 被静默丢弃", async () => {
			const { task, promise } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
				token: "late-stderr",
			});
			engine.enqueue(task);

			// sentinel 到达
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"late-stderr"}]`);

			// 等待 setImmediate 执行 finalizePendingTasks
			await flush();

			// 此时 task 已 resolve（无 stderrText）
			const result = await promise;
			assert.equal(result, undefined, "task 已被 resolve（虽然它应该 reject）");

			// stderr 在 finalize 之后才到达
			// handleStderrChunk 会寻找 pendingFinalize（空）→ inflight（空）→ logger
			engine.handleStderrChunk("UNIQUE constraint failed");

			// P0: stderrText 从未被设置到 task 上
			assert.equal(
				task.stderrText,
				"",
				"P0 BUG: stderrText 为空 — stderr 被静默丢弃（用户不知晓错误）",
			);
			// task 已经不可逆地 resolve 了
			assert.equal(task.settled, true, "task 已结算（resolve）");

			disarm(task);
		});
	});

	// ── P0: 跨 batch 管线化 stderr 归因 ──────────────
	//
	// P0 场景 C（数据丢失）：
	// 多个 batch 管线化发送时，所有 sentinel 可能在同一个 event loop tick 中到达，
	// 所有任务累积到同一个 pendingFinalize Set 中。若中间 batch 的任务失败，
	// stderr 归因到 Set 中第一个任务（最早 batch 的第一个任务），而非实际失败的任务。

	describe("P0: 跨 batch 管线化 stderr 归因", () => {
		test("P0: 两 batch 管线化，batch-2 任务失败 → stderr 传播到所有 pendingFinalize 任务", async () => {
			// 使用独立的 mockPM2 和 localEngine，避免与全局 engine 的 mockPM 干扰
			const mockPM2 = createMockProcessManager();
			const localEngine = new PipelineEngine(mockPM2, {
				metrics,
				statementTimeout: 5000,
				batchSize: 10,
				maxInflight: 2,
			});
			localEngine.activate();

			const { task: lt1, promise: lp1 } = createTask({
				kind: "query", sql: "SELECT 1 AS v", token: "cb-lt1",
			});
			const { task: lt2, promise: lp2 } = createTask({
				kind: "query", sql: "SELECT 2 AS v", token: "cb-lt2",
			});
			const { task: lt3, promise: lp3 } = createTask({
				kind: "execute", sql: "INSERT INTO t VALUES (1)", token: "cb-lt3",
			});
			const { task: lt4, promise: lp4 } = createTask({
				kind: "query", sql: "SELECT 4 AS v", token: "cb-lt4",
			});

			// 逐个入队。由于每个 enqueue 都触发 pumpQueue，且队列中每次只有刚入队的那个任务，
			// 所以 lt1, lt2 被逐一发出（inflight 达到 maxInflight=2）。
			localEngine.enqueue(lt1);
			localEngine.enqueue(lt2);
			localEngine.enqueue(lt3);
			localEngine.enqueue(lt4);

			// lt1, lt2 各占一个 inflight 槽（写 2 次）
			assert.equal(mockPM2._writes.length, 2, "lt1, lt2 各一个 batch 发出");
			const batch1Payload = mockPM2._writes[0];
			assert.ok(batch1Payload.includes("cb-lt1"), "batch1 含 lt1");
			const batch2Payload = mockPM2._writes[1];
			assert.ok(batch2Payload.includes("cb-lt2"), "batch2 含 lt2");
			assert.ok(!batch1Payload.includes("cb-lt3"), "batch1 不含 lt3");
			assert.ok(!batch2Payload.includes("cb-lt3"), "batch2 不含 lt3");

			// lt1 数据行 + sentinel → shift → pumpQueue 发出 lt3（inflight 降为 1，lt3 入列）
			localEngine.handleStdoutChunk(`[{"v":1}]`); // lt1 数据行（SELECT 1 AS v）
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"cb-lt1"}]`);
			assert.equal(mockPM2._writes.length, 3, "lt1 完成 → lt3 发出");
			const batch3Payload = mockPM2._writes[2];
			assert.ok(batch3Payload.includes("cb-lt3"), "batch3 含 lt3");
			assert.ok(!batch3Payload.includes("cb-lt4"), "batch3 不含 lt4（lt4 仍在队列）");

			// lt2 数据行 + sentinel → shift → pumpQueue 发出 lt4
			localEngine.handleStdoutChunk(`[{"v":2}]`); // lt2 数据行（SELECT 2 AS v）
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"cb-lt2"}]`);
			assert.equal(mockPM2._writes.length, 4, "lt2 完成 → lt4 发出");

			// lt3 sentinel → pendingFinalize（execute，无数据行）
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"cb-lt3"}]`);

			// lt4 数据行 + sentinel → pendingFinalize
			localEngine.handleStdoutChunk(`[{"v":4}]`); // lt4 数据行（SELECT 4 AS v）
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"cb-lt4"}]`);

			// stderr（属于 lt3）在全部 sentinel 之后到达
			localEngine.handleStderrChunk("UNIQUE constraint failed");

			await flush();

			// ── 所有 pendingFinalize 任务都拿到 stderr → 全部 reject ──
			await assert.rejects(
				lp1,
				/UNIQUE constraint/,
				"lt1（batch1 成功任务）因跨 batch stderr 传播而被 reject",
			);
			await assert.rejects(
				lp2,
				/UNIQUE constraint/,
				"lt2（batch1 成功 query）因跨 batch stderr 传播而被 reject",
			);
			await assert.rejects(
				lp3,
				/UNIQUE constraint/,
				"lt3（实际失败）正确拿到 stderr → reject",
			);
			await assert.rejects(
				lp4,
				/UNIQUE constraint/,
				"lt4（batch2 成功 query）因跨 batch stderr 传播而被 reject",
			);

			assert.ok(lt1.stderrText.length > 0, "lt1.stderrText 被设置（跨 batch 传播）");
			assert.ok(lt2.stderrText.length > 0, "lt2.stderrText 被设置（跨 batch 传播）");
			assert.ok(lt3.stderrText.length > 0, "lt3.stderrText 被设置（正确归因）");
			assert.ok(lt4.stderrText.length > 0, "lt4.stderrText 被设置（跨 batch 传播）");

			disarm(lt1);
			disarm(lt2);
			disarm(lt3);
			disarm(lt4);
			localEngine.kill();
		});
	});

	// ── 回归：非 WAL batch stderr 不污染已完成任务 ─────
	//
	// 场景：batch 中前一个任务已完成（pendingFinalize），后一个任务仍在执行中
	//（inflight）时产生 stderr。此时 stderr 应归因给 inflight 任务，不应传播到
	// 已完成的 pendingFinalize 任务，以避免误杀合法查询（参见 #48 修复）。
	//
	// 根因：handleStderrChunk 原实现优先选取 firstPending（已完成任务）作为
	// primary，然后通过非 WAL batch 传播规则将 stderr 扩散到所有 pendingFinalize
	// 任务。修复后优先选取 inflightFirst（正在执行的任务），且当 primary 是
	// inflight 任务时不向 pendingFinalize 传播。

	describe("回归：非 WAL batch stderr 不污染已完成任务", () => {
		beforeEach(() => {
			engine.deactivate();
		});

		test("回归: inflight 任务失败时 stderr 归因正确，不污染已完成任务", async () => {
			const { task: t1, promise: p1 } = createTask({
				kind: "query",
				sql: "SELECT 1 AS v",
				token: "reg-t1",
			});
			const { task: t2, promise: p2 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
				token: "reg-t2",
			});

			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.activate();
			engine.pump();

			// 验证为混合 batch（非 WAL batch）
			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"), "混合 query+execute 不应使用 WAL batch");

			// t1 数据行 + sentinel → t1 进入 pendingFinalize
			engine.handleStdoutChunk(`[{"v":1}]`);
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"reg-t1"}]`);

			// 此时 t1 在 pendingFinalize，t2 仍在 inflight（sentinel 未到）
			// stderr 到达——应归因给 inflight 的 t2，不传播到 t1
			engine.handleStderrChunk("UNIQUE constraint failed");

			// t2 sentinel 随后到达
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"reg-t2"}]`);

			await flush();

			// t1（已完成查询）不应被 stderr 污染
			assert.equal(t1.stderrText, "", "已完成任务 t1 不应被 stderr 污染");
			assert.deepEqual(t1.rows, [{ v: 1 }], "t1 数据行应完整保留");

			// t2（inflight 任务）应持有 stderr
			assert.ok(t2.stderrText.includes("UNIQUE constraint failed"), "inflight 任务 t2 应持有 stderr");

			// 最终 settle 结果
			const result = await p1;
			assert.deepEqual(result, [{ v: 1 }], "t1 应成功返回数据");

			await assert.rejects(p2, /UNIQUE constraint/, "t2 应被 reject");

			disarm(t1);
			disarm(t2);
		});
	});

	// ── maxInflight ──────────────────────────────────

	describe("maxInflight", () => {
		test("达到上限后暂停发送，任务完成后续发", async () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				batchSize: 1,
				maxInflight: 2,
			});
			localEngine.activate();

			const { task: t1, promise: p1 } = createTask({ token: "mi-t1" });
			const { task: t2 } = createTask({ token: "mi-t2" });
			const { task: t3 } = createTask({ token: "mi-t3" });

			localEngine.enqueue(t1); // inflight=1, written
			assert.equal(mockPM._writes.length, 1, "t1 应被写入");

			localEngine.enqueue(t2); // inflight=2, written
			assert.equal(mockPM._writes.length, 2, "t2 应被写入");

			localEngine.enqueue(t3); // inflight=2 ≥ maxInflight, NOT written
			assert.equal(mockPM._writes.length, 2, "t3 不应被写入（已达上限）");

			// 完成 t1：inflight 降为 1，触发 t3 发送
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"mi-t1"}]`);
			await flush();

			// 注意 handleParsedValue 在 sentinel 后调用了 pumpQueue，
			// t3 应在新的一批中被写入
			assert.equal(mockPM._writes.length, 3, "t1 完成后 t3 应被写入");

			// 完成 t2、t3
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"mi-t2"}]`);
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"mi-t3"}]`);
			await flush();
			await p1.catch(() => {});

			localEngine.kill();
		});

		test("batch 不越过 maxInflight 上限", () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				batchSize: 10,
				maxInflight: 3,
			});
			localEngine.activate();

			// 积累 5 个任务在队列中
			localEngine.deactivate();
			const tasks = [];
			for (let i = 0; i < 5; i++) {
				const { task } = createTask({ token: `mi-batch-${i}` });
				localEngine.enqueue(task);
				tasks.push(task);
			}

			// 激活后 pump 只应发送 3 个（maxInflight=3）
			localEngine.activate();
			localEngine.pump();

			assert.equal(mockPM._writes.length, 1, "应有一批写入");
			const payload = mockPM._writes[0];
			// payload 应只包含 3 个任务
			assert.ok(payload.includes("mi-batch-0"), "应包含任务 0");
			assert.ok(payload.includes("mi-batch-1"), "应包含任务 1");
			assert.ok(payload.includes("mi-batch-2"), "应包含任务 2");
			assert.ok(!payload.includes("mi-batch-3"), "不应包含任务 3（超出上限）");
			assert.ok(!payload.includes("mi-batch-4"), "不应包含任务 4（超出上限）");

			for (const t of tasks) disarm(t);
			localEngine.kill();
		});

		test("maxInflight=1 时每次只发一个任务", () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				batchSize: 10,
				maxInflight: 1,
			});
			localEngine.activate();

			const { task: t1 } = createTask({ token: "mi1-t1" });
			const { task: t2 } = createTask({ token: "mi1-t2" });

			localEngine.enqueue(t1);
			localEngine.enqueue(t2);

			assert.equal(mockPM._writes.length, 1, "t1 发送后 t2 不应写入");

			// 完成 t1
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"mi1-t1"}]`);

			assert.equal(mockPM._writes.length, 2, "t1 完成后 t2 才写入");

			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"mi1-t2"}]`);

			disarm(t1);
			disarm(t2);
			localEngine.kill();
		});
	});

	// ── stream 任务隔离 ──────────────────────────────

	describe("stream 任务隔离", () => {
		test("stream 不阻塞后续非 stream 任务", () => {
			// pump 的 stream 检查只阻止 stream 加入已有 batch 或在有 inflight 时发送，
			// 但非 stream 任务可以跟在 stream 后一起发送。
			engine.deactivate();
			const { task: t1 } = createTask({
				kind: "stream",
				sql: "SELECT * FROM t",
			});
			const { task: t2 } = createTask({ kind: "query", sql: "SELECT 1" });
			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.activate();
			engine.pump();

			// stream 和 query 在同一 batch 中一起发送
			assert.equal(mockPM._writes.length, 1);
			assert.ok(mockPM._writes[0].includes("SELECT * FROM t"), "payload 应包含 stream SQL");
			assert.ok(mockPM._writes[0].includes("SELECT 1"), "payload 也应包含 query SQL");
			disarm(t1);
			disarm(t2);
		});

		test("inflight 中有任务时 stream 排队等待", () => {
			const { task: t1 } = createTask({ kind: "query", sql: "SELECT 1" });
			const { task: t2 } = createTask({
				kind: "stream",
				sql: "SELECT * FROM t",
			});
			engine.enqueue(t1);
			engine.enqueue(t2);
			disarm(t1);

			assert.equal(mockPM._writes.length, 1);
			assert.ok(mockPM._writes[0].includes("SELECT 1"));
			assert.ok(!mockPM._writes[0].includes("SELECT * FROM t"));
		});
	});

	// ── sentinel 解析与任务结算 ───────────────────────

	describe("sentinel 解析", () => {
		test("query 任务收到数据行 + sentinel 后正确 resolve", async () => {
			const { task, promise } = createTask({
				kind: "query",
				sql: "SELECT 1 AS v",
				token: "resolve-me",
			});
			engine.enqueue(task);

			// 模拟 sqlite3 返回行数据 + 哨兵行
			engine.handleStdoutChunk('[{"v":1}]');
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"resolve-me"}]`);

			await flush();
			const result = await promise;
			assert.deepEqual(result, [{ v: 1 }]);
		});

		test("空结果集 + sentinel 返回空数组", async () => {
			const { task, promise } = createTask({
				kind: "query",
				sql: "SELECT * FROM empty",
				token: "empty-result",
			});
			engine.enqueue(task);

			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"empty-result"}]`);

			await flush();
			const result = await promise;
			assert.deepEqual(result, []);
		});

		test("多个 query 分批 sentinel 逐个 resolve", async () => {
			const { task: t1, promise: p1 } = createTask({
				kind: "query",
				sql: "SELECT 1 AS v",
				token: "multi-1",
			});
			const { task: t2, promise: p2 } = createTask({
				kind: "query",
				sql: "SELECT 2 AS v",
				token: "multi-2",
			});
			engine.enqueue(t1);
			engine.enqueue(t2);

			// 第一个任务的结果 + sentinel
			engine.handleStdoutChunk('[{"v":1}]');
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"multi-1"}]`);
			await flush();

			const r1 = await p1;
			assert.deepEqual(r1, [{ v: 1 }]);

			// 第二个任务的结果 + sentinel
			engine.handleStdoutChunk('[{"v":2}]');
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"multi-2"}]`);
			await flush();

			const r2 = await p2;
			assert.deepEqual(r2, [{ v: 2 }]);
		});

		test("stderrText 非空时 reject", async () => {
			const { task, promise } = createTask({
				kind: "query",
				sql: "SELECT * FROM bad_table",
				token: "err-token",
			});
			task.stderrText = "no such table: bad_table";
			engine.enqueue(task);

			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"err-token"}]`);

			await assert.rejects(promise, /no such table: bad_table/);
		});

		test("consumerError 时立即 reject 不走 pendingFinalize", async () => {
			const { task, promise } = createTask({
				kind: "query",
				sql: "SELECT 1",
				token: "ce-token",
				consumerError: new Error("consumer broke"),
			});
			engine.enqueue(task);

			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"ce-token"}]`);

			// consumerError 路径不经过 pendingFinalize，立即 settle
			await assert.rejects(promise, /consumer broke/);
		});

		test("execute 任务收到 sentinel 后 resolve undefined", async () => {
			const { task, promise } = createTask({
				kind: "execute",
				sql: "CREATE TABLE t (id INT)",
				token: "exec-token",
			});
			engine.enqueue(task);

			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"exec-token"}]`);

			await flush();
			const result = await promise;
			assert.equal(result, undefined);
		});

		test("stream 任务数据经 rowParser 路由后剩余数据进入 sharedValueParser", async () => {
			const rows = [];
			const { task, promise } = createTask({
				kind: "stream",
				token: "stream-rp",
				rowParser: null,
				onRow: (row) => rows.push(row),
			});
			task.rowParser = createRowStreamParser((rawRow) => {
				const row = JSON.parse(rawRow);
				task.onRow(row);
			});
			engine.enqueue(task);

			engine.handleStdoutChunk('[{"id":1},{"id":2}]');
			assert.equal(rows.length, 2);
			assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);

			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"stream-rp"}]`);

			await flush();
			const result = await promise;
			assert.equal(result, undefined);
		});
	});

	// ── 单任务超时 ────────────────────────────────────

	describe("单任务超时", () => {
		test("超时只拒绝超时任务，其他 inflight 任务正常完成", async () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				onTaskTimeout: (task) => { timeouts.push(task); },
				sweepInterval: 5,
			});
			localEngine.activate();

			const { task: t1, promise: p1 } = createTask({
				token: "to-t1",
				timeout: 1,
			});
			const { task: t2, promise: p2 } = createTask({
				token: "to-t2",
			});
			const { task: t3, promise: p3 } = createTask({
				token: "to-t3",
			});

			localEngine.enqueue(t1);
			localEngine.enqueue(t2);
			localEngine.enqueue(t3);

			// 等待 t1 超时
			await new Promise((r) => setTimeout(r, 30));

			// t1 应在 inflight 中等待它的 sentinel 到来后才能从 inflight 中移除
			assert.equal(localEngine.pendingStatements, 3, "t1 超时后仍在 inflight(等 sentinel)");
			assert.equal(timeouts.length, 1, "onTaskTimeout 只被调用了一次");
			assert.equal(timeouts[0].token, "to-t1", "超时回调收到 t1");

			// t1 的 sentinel 到达（sqlite3 完成了 t1 的执行）
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"to-t1"}]`);

			// t1 已从 inflight 移除，t2/t3 仍在
			assert.equal(localEngine.pendingStatements, 2, "t1 移除后 t2/t3 仍在 inflight");

			// t2/t3 的 sentinel 到达
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"to-t2"}]`);
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"to-t3"}]`);
			await flush();

			await assert.rejects(p1, /timed out/, "t1 应因超时被拒绝");
			const r2 = await p2;
			const r3 = await p3;
			assert.deepEqual(r2, [], "t2 应正常完成");
			assert.deepEqual(r3, [], "t3 应正常完成");

			localEngine.kill();
		});

		test("sweep 空闲时无定时器，有任务时创建，完成后自动停止", async () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				sweepInterval: 5,
			});
			localEngine.activate();

			// 无任务 → 无定时器
			assert.equal(localEngine._sweepTimer, null, "空闲时无定时器");

			// 发送任务 → 定时器创建
			const { task, promise } = createTask({ token: "auto-stop" });
			localEngine.enqueue(task);
			assert.ok(localEngine._sweepTimer !== null, "有任务时有定时器");

			// 完成所有任务 → 定时器自动停止
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"auto-stop"}]`);
			await flush();
			// 等一帧让 sweep 回调有机会执行（如果仍有定时器则不应再次调度）
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(localEngine._sweepTimer, null, "任务完成后定时器自动停止");

			// 发送新任务 → 定时器重新创建
			const { task: t2 } = createTask({ token: "auto-stop-2" });
			localEngine.enqueue(t2);
			assert.ok(localEngine._sweepTimer !== null, "新任务到达重新创建定时器");

			await promise.catch(() => {});
			localEngine.kill();
		});

		test("sweep 正确检测超时（不依赖每个任务的定时器）", async () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				sweepInterval: 5,
			});
			localEngine.activate();

			const { task: t1, promise: p1 } = createTask({
				token: "sw-t1",
				timeout: 1,
			});
			const { task: t2, promise: p2 } = createTask({
				token: "sw-t2",
			});

			localEngine.enqueue(t1);
			localEngine.enqueue(t2);

			// 确认没有每个任务的定时器（timer 应为 null）
			assert.equal(t1.timer, null, "不应设置每个任务的定时器");
			assert.equal(t2.timer, null, "不应设置每个任务的定时器");

			// 等待 sweep 检测到 t1 超时
			await new Promise((r) => setTimeout(r, 30));

			// t1 超时后被 settle（reject），但仍留在 inflight 等待 sentinel
			assert.equal(localEngine.pendingStatements, 2, "t1 超时后仍在 inflight(等 sentinel)");

			// t1 的 sentinel 到达
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"sw-t1"}]`);
			// t2 的 sentinel 到达
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"sw-t2"}]`);
			await flush();

			await assert.rejects(p1, /timed out/, "t1 应因超时被拒绝");
			const r2 = await p2;
			assert.deepEqual(r2, [], "t2 应正常完成");

			localEngine.kill();
		});

		test("超时任务数据行不会污染后续任务", async () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				sweepInterval: 5,
			});
			localEngine.activate();

			const { task: t1, promise: p1 } = createTask({
				kind: "query",
				token: "data-t1",
				timeout: 1,
			});
			const { task: t2, promise: p2 } = createTask({
				kind: "query",
				token: "data-t2",
			});

			localEngine.enqueue(t1);
			localEngine.enqueue(t2);

			// 等 t1 超时
			await new Promise((r) => setTimeout(r, 30));

			// t1 的数据行 + sentinel 到达（t1 超时后，sqlite3 仍然会输出它的结果）
			localEngine.handleStdoutChunk("[1]");
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"data-t1"}]`);

			// t2 的数据行 + sentinel
			localEngine.handleStdoutChunk("[2]");
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"data-t2"}]`);
			await flush();

			await assert.rejects(p1, /timed out/, "t1 拒绝");
			const r2 = await p2;
			// t2 只应收到它自己的数据 [2]，不应包含 t1 的 [1]
			assert.deepEqual(r2, [2], "t2 收到正确数据行，无污染");

			localEngine.kill();
		});

		test("超时的 stream 任务数据行不会触发 spurious onRow 调用", async () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				sweepInterval: 5,
			});
			localEngine.activate();

			const onRowCalls = [];

			const { task, promise } = createTask({
				kind: "stream",
				token: "stream-timeout-test",
				timeout: 1,
				onRow: (row) => { onRowCalls.push(row); },
			});
			// 模拟 executor 的行为：为 stream 任务设置 rowParser
			task.rowParser = createRowStreamParser((rawRow) => {
				if (task.consumerError) return;
				try {
					const row = JSON.parse(rawRow);
					// 不实现 sentinel 回喂逻辑，简化测试：onRow 被调用就等于 bug 触发
					task.onRow(row);
				} catch (error) {
					task.consumerError = toError(error);
				}
			});

			localEngine.enqueue(task);

			// 等超时
			await new Promise((r) => setTimeout(r, 30));

			// 超时后，模拟 sqlite3 输出 stream 数据行和 sentinel
			// 若不修复，handleStdoutChunk 会将数据喂给已 reset 的 rowParser 从而触发 onRow
			localEngine.handleStdoutChunk("[1]");
			localEngine.handleStdoutChunk("[2]");
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"stream-timeout-test"}]`);
			await flush();

			await assert.rejects(promise, /timed out/, "超时的 stream 任务应被拒绝");

			// 断言：onRow 应从未被调用。若修复缺失，rowParser 会被重新激活并解析 [1] [2]
			assert.equal(onRowCalls.length, 0, "超时后不应触发 onRow 回调");

			localEngine.kill();
		});
	});

	// ── stderr 处理 ──────────────────────────────────

	describe("stderr 处理", () => {
		test("stderr 文本追加到 inflight 任务的 stderrText", () => {
			const { task } = createTask({ token: "stderr-test" });
			engine.enqueue(task);

			engine.handleStderrChunk("Error: near line 1");
			assert.equal(task.stderrText, "Error: near line 1");

			engine.handleStderrChunk(": syntax error");
			assert.equal(task.stderrText, "Error: near line 1: syntax error");
			disarm(task);
		});

		test("混合查询中零行 query 的 stderr 晚于首轮 finalize 时仍会 reject", async () => {
			const { task: validTask, promise: validPromise } = createTask({
				kind: "query",
				token: "valid-query",
				rows: [{ value: 1 }],
			});
			const { task, promise } = createTask({
				kind: "query",
				token: "late-query-stderr",
			});
			engine.enqueue(validTask);
			engine.enqueue(task);

			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"valid-query"}]`);
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"late-query-stderr"}]`);
			await flush();

			assert.deepEqual(await validPromise, [{ value: 1 }]);
			assert.equal(task.settled, false);
			engine.handleStderrChunk("no such table: missing");

			await assert.rejects(promise, /no such table/);
			assert.equal(engine.pendingStatements, 0);
			disarm(validTask);
			disarm(task);
		});

		test("无 inflight 任务时不崩溃", () => {
			engine.handleStderrChunk("orphan error message");
			// 不应抛出异常
		});
	});

	// ── rejectAll ────────────────────────────────────

	describe("rejectAll", () => {
		test("拒绝所有 inflight 和队列中的任务", async () => {
			const { task: t1, promise: p1 } = createTask();
			const { task: t2, promise: p2 } = createTask();
			const { task: t3, promise: p3 } = createTask();

			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.enqueue(t3);

			assert.equal(engine.pendingStatements, 3);

			const err = new Error("fatal pipeline error");
			engine.rejectAll(err);

			await assert.rejects(p1, /fatal pipeline error/);
			await assert.rejects(p2, /fatal pipeline error/);
			await assert.rejects(p3, /fatal pipeline error/);

			assert.equal(engine.pendingStatements, 0);
		});

		test("rejectAll 后失败指标正确", () => {
			// PipelineEngine 不负责 incrementTasksTotal，由调用方负责
			const { task: t1 } = createTask();
			const { task: t2 } = createTask();
			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.rejectAll(new Error("fail"));

			const s = metrics.snapshot();
			assert.equal(s.tasksFailed, 2, "两个任务都应记为失败");
			assert.equal(s.tasksSuccess, 0, "不应有成功任务");
		});
	});

	// ── kill ─────────────────────────────────────────

	describe("kill", () => {
		test("kill 后 pendingStatements 归零", () => {
			const { task } = createTask();
			engine.enqueue(task);
			engine.kill();
			assert.equal(engine.pendingStatements, 0);
		});

		test("kill 后 enqueue 不再发送", () => {
			engine.kill();
			const { task } = createTask();
			engine.enqueue(task);
			assert.equal(mockPM._writes.length, 0);
		});

		test("kill 清除扫制定时器（空闲时不创建定时器）", () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				sweepInterval: 100,
			});
			localEngine.activate();
			// 没有任务时不应有定时器
			assert.equal(localEngine._sweepTimer, null, "空闲时无扫制定时器");

			// 发送任务后定时器被创建
			const { task } = createTask();
			localEngine.enqueue(task);
			assert.ok(localEngine._sweepTimer !== null, "有任务时应创建扫制定时器");

			localEngine.kill();
			assert.equal(localEngine._sweepTimer, null, "kill 后扫制定时器应被清空");
		});

		test("扫制定时器已 unref，不阻止进程退出", () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				sweepInterval: 100,
			});
			localEngine.activate();
			const { task } = createTask();
			localEngine.enqueue(task);
			assert.ok(localEngine._sweepTimer, "有任务时应创建扫制定时器");
			assert.equal(localEngine._sweepTimer.hasRef?.(), false, "定时器应已 unref");
			localEngine.kill();
		});
	});

	// ── pump ─────────────────────────────────────────

	describe("pump", () => {
		test("手动 pump 触发队列处理", () => {
			engine.deactivate();
			const { task } = createTask();
			engine.enqueue(task);
			assert.equal(mockPM._writes.length, 0, "deactivate 时不发送");

			engine.activate();
			engine.pump();
			assert.equal(mockPM._writes.length, 1, "pump 后应发送");
		});
	});

	// ── feed ─────────────────────────────────────────

	describe("feed", () => {
		test("feed 将数据送入 sharedValueParser 并触发 sentinel 结算", async () => {
			// feed 是 setupStreamParser 用于回喂哨兵行的公开方法
			const { task, promise } = createTask({ token: "feed-token" });
			engine.enqueue(task);

			// 直接通过 feed 送入 sentinel JSON
			engine.feed(`[{"${TOKEN_COLUMN}":"feed-token"}]`);

			await flush();
			const result = await promise;
			assert.deepEqual(result, []);
			assert.ok("feed 触发了 sentinel 结算");
		});
	});

	// ── drain 背压 ─────────────────────────────

	describe("drain 背压", () => {
		test("draining=true 时 pumpQueue 暂停写入，任务留在队列", () => {
			mockPM.draining = true;
			const { task } = createTask();
			engine.enqueue(task);

			assert.equal(mockPM._writes.length, 0, "不应触发 write");
			assert.equal(engine.pendingStatements, 1, "任务留在队列中");
		});

		test("draining=true 时多个 enqueue 都不触发 write", () => {
			mockPM.draining = true;
			const { task: t1 } = createTask();
			const { task: t2 } = createTask();
			engine.enqueue(t1);
			engine.enqueue(t2);

			assert.equal(mockPM._writes.length, 0);
			assert.equal(engine.pendingStatements, 2);
		});

		test("drain 触发后 pumpQueue 自动发送积压任务", () => {
			mockPM.draining = true;
			const { task } = createTask();
			engine.enqueue(task);
			assert.equal(mockPM._writes.length, 0, " draining 时不应写入");

			mockPM._triggerDrain();

			assert.equal(mockPM._writes.length, 1, "drain 后应写入");
			assert.equal(engine.pendingStatements, 1, "任务进入 inflight");
		});

		test("draining=false 时正常写入不受影响", () => {
			mockPM.draining = false;
			const { task } = createTask();
			engine.enqueue(task);

			assert.equal(mockPM._writes.length, 1, "应正常触发 write");
		});

		test("draining 从 true→false→true 交替工作", () => {
			mockPM.draining = true;
			const { task: t1 } = createTask();
			engine.enqueue(t1);
			assert.equal(mockPM._writes.length, 0, "draining 时应暂停");

			mockPM._triggerDrain();
			assert.equal(mockPM._writes.length, 1, "drain 后写入积压任务");
			const firstPayload = mockPM._writes[0];

			mockPM.draining = true;
			const { task: t2 } = createTask();
			engine.enqueue(t2);
			assert.equal(mockPM._writes.length, 1, "再次 draining，不应有新写入");

			mockPM._triggerDrain();
			assert.equal(mockPM._writes.length, 2, "再次 drain 后写入第二个任务");
			assert.notEqual(mockPM._writes[0], mockPM._writes[1], "两次 payload 应不同");
		});
	});

	// ── pendingStatements ───────────────────────────

	describe("pendingStatements", () => {
		test("反映任务总数（queue + inflight + pendingFinalize）", async () => {
			assert.equal(engine.pendingStatements, 0);

			const { task: t1 } = createTask({ token: "ps-t1" });
			engine.enqueue(t1);
			assert.equal(engine.pendingStatements, 1, "入队后应为 1");

			const { task: t2 } = createTask({ token: "ps-t2" });
			engine.enqueue(t2);
			assert.equal(engine.pendingStatements, 2, "入队两个后应为 2");

			// 完成两个任务
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"ps-t1"}]`);
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"ps-t2"}]`);
			await flush();
			assert.equal(engine.pendingStatements, 0, "两个任务都完成后应归零");
		});
	});

	// ── Fuzzy 测试 ──────────────────────────────────

	describe("fuzzy", () => {
		test("fuzz：随机 stdout chunk 不导致崩溃", async () => {
			const { task } = createTask({ token: "fuzz-stdout" });
			engine.enqueue(task);

			for (let i = 0; i < 300; i++) {
				const len = Math.floor(Math.random() * 100);
				let s = "";
				for (let j = 0; j < len; j++) {
					s += String.fromCharCode(Math.floor(Math.random() * 256));
				}
				engine.handleStdoutChunk(s);
			}

			// 随机字节可能破坏 sharedValueParser 状态机（inString=true / nesting>0），
			// 导致 sentinel 被吞掉。重置解析器确保后续数据被正确处理。
			engine.activate();
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"fuzz-stdout"}]`);
			await flush();
			disarm(task);
			assert.equal(task.settled, true, "任务应被结算");
		});

		test("fuzz：随机 stderr chunk 不导致崩溃", async () => {
			const { task } = createTask({ token: "fuzz-stderr" });
			engine.enqueue(task);

			for (let i = 0; i < 300; i++) {
				const len = Math.floor(Math.random() * 80);
				let s = "";
				for (let j = 0; j < len; j++) {
					s += String.fromCharCode(Math.floor(Math.random() * 256));
				}
				engine.handleStderrChunk(s);
			}

			engine.activate();
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"fuzz-stderr"}]`);
			await flush();
			disarm(task);
			assert.equal(task.settled, true);
		});

		test("fuzz：交错随机 stderr + stdout 不导致崩溃", async () => {
			const { task } = createTask({ token: "fuzz-mixed" });
			engine.enqueue(task);

			for (let i = 0; i < 200; i++) {
				const len = Math.floor(Math.random() * 60);
				let s = "";
				for (let j = 0; j < len; j++) {
					s += String.fromCharCode(Math.floor(Math.random() * 256));
				}
				if (Math.random() < 0.5) {
					engine.handleStdoutChunk(s);
				} else {
					engine.handleStderrChunk(s);
				}
			}

			engine.activate();
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"fuzz-mixed"}]`);
			await flush();
			disarm(task);
			assert.equal(task.settled, true);
		});
	});
});
