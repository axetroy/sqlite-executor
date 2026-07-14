import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { finalizePendingTasks, prepareTaskTimeout, handleParsedValue, createSweeper, createFinalizeScheduler, createPumpQueue, rejectAllTasks, handleSentinelTask, handleStderrChunk } from "./pipelineUtils.js";
import { InflightTracker } from "./inflightTracker.js";
import { Queue } from "./queue.js";

describe("finalizePendingTasks", () => {
	test("query 任务调用 settle(null, task.rows)", () => {
		const calls = [];
		const tasks = new Set([
			{ kind: "query", rows: [{ id: 1 }], stderrText: "", consumerError: null },
		]);
		finalizePendingTasks(
			tasks,
			(task, error, value) => calls.push({ error, value }),
			() => calls.push({ pump: true }),
		);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].error, null);
		assert.deepEqual(calls[0].value, [{ id: 1 }]);
		assert.deepEqual(calls[1], { pump: true });
	});

	test("execute 任务调用 settle(null, undefined)", () => {
		const calls = [];
		const tasks = new Set([
			{ kind: "execute", rows: undefined, stderrText: "", consumerError: null },
		]);
		finalizePendingTasks(
			tasks,
			(task, error, value) => calls.push({ error, value }),
			() => calls.push({ pump: true }),
		);
		assert.equal(calls[0].error, null);
		assert.equal(calls[0].value, undefined);
	});

	test("stderrText 非空时 reject 为该文本", () => {
		const calls = [];
		const tasks = new Set([
			{ kind: "query", rows: [], stderrText: "error msg\n", consumerError: null },
		]);
		finalizePendingTasks(
			tasks,
			(task, error, value) => calls.push({ error, value }),
			() => calls.push({ pump: true }),
		);
		assert.ok(calls[0].error instanceof Error);
		assert.ok(calls[0].error.message.includes("error msg"));
	});

	test("consumerError 优先于 rows（stderrText 优先级最高）", () => {
		const calls = [];
		const consumerErr = new Error("consumer broke");
		const tasks = new Set([
			{ kind: "query", rows: [{ id: 1 }], stderrText: "", consumerError: consumerErr },
		]);
		finalizePendingTasks(
			tasks,
			(task, error, value) => calls.push({ error, value }),
			() => calls.push({ pump: true }),
		);
		assert.equal(calls[0].error, consumerErr);
	});

	test("多个任务全部结算，集合被清空", () => {
		const calls = [];
		const tasks = new Set([
			{ kind: "execute", rows: undefined, stderrText: "", consumerError: null },
			{ kind: "query", rows: [1], stderrText: "", consumerError: null },
			{ kind: "stream", rows: undefined, stderrText: "", consumerError: null },
		]);
		finalizePendingTasks(
			tasks,
			(task, error, value) => calls.push({ kind: task.kind, error, value }),
			() => {},
		);
		assert.equal(calls.length, 3);
		assert.equal(tasks.size, 0, "集合应在处理后清空");
	});

	test("空集合不调用 settle（无任务），pumpQueue 仍被调用", () => {
		let settleCalled = false;
		let pumpCalled = false;
		finalizePendingTasks(
			new Set(),
			() => { settleCalled = true; },
			() => { pumpCalled = true; },
		);
		assert.equal(settleCalled, false, "空集合不调用 settle");
		assert.equal(pumpCalled, true, "pumpQueue 仍被调用");
	});
});

describe("prepareTaskTimeout", () => {
	function makeTask(overrides = {}) {
		return {
			settled: false,
			timedout: false,
			timer: null,
			timeout: 100,
			sql: "SELECT 1",
			...overrides,
		};
	}

	test("返回 TimeoutError，标记 timedout", () => {
		const task = makeTask();
		const error = prepareTaskTimeout(task, null);
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes("timed out"));
		assert.equal(task.timedout, true);
	});

	test("指标递增", () => {
		let timeoutCount = 0;
		const metrics = { incrementTasksTimeout: () => { timeoutCount++; } };
		const task = makeTask();
		prepareTaskTimeout(task, metrics);
		assert.equal(timeoutCount, 1);
	});

	test("已结算任务返回 null，不递增指标", () => {
		let timeoutCount = 0;
		const metrics = { incrementTasksTimeout: () => { timeoutCount++; } };
		const task = makeTask({ settled: true });
		const result = prepareTaskTimeout(task, metrics);
		assert.equal(result, null);
		assert.equal(timeoutCount, 0, "已结算任务不应递增指标");
		assert.equal(task.timedout, false, "已结算任务不应修改 timedout");
	});

	test("metrics 为 null 时不崩溃", () => {
		const task = makeTask();
		const result = prepareTaskTimeout(task, null);
		assert.ok(result instanceof Error);
	});

	test("metrics 为 undefined 时不崩溃", () => {
		const task = makeTask();
		const result = prepareTaskTimeout(task, undefined);
		assert.ok(result instanceof Error);
	});
});

describe("createSweeper", () => {
	test("schedule 创建定时器，getSweepTimer 返回非 null", () => {
		const inflight = new InflightTracker();
		const sweeper = createSweeper({
			inflight,
			sweepIntervalMs: 1000,
			handleTaskTimeout: () => {},
		});
		assert.equal(sweeper.getSweepTimer(), null, "尚未 schedule");
		sweeper.schedule();
		assert.ok(sweeper.getSweepTimer() !== null, "schedule 后应有定时器");
		sweeper.clear();
		assert.equal(sweeper.getSweepTimer(), null, "clear 后定时器应清除");
	});

	test("多次 schedule 不会创建多个定时器", () => {
		const inflight = new InflightTracker();
		const sweeper = createSweeper({
			inflight,
			sweepIntervalMs: 1000,
			handleTaskTimeout: () => {},
		});
		sweeper.schedule();
		const timer1 = sweeper.getSweepTimer();
		sweeper.schedule();
		const timer2 = sweeper.getSweepTimer();
		assert.equal(timer1, timer2, "多次 schedule 应返回同一定时器");
		sweeper.clear();
	});

	test("clear 在不活动时不会报错", () => {
		const inflight = new InflightTracker();
		const sweeper = createSweeper({
			inflight,
			sweepIntervalMs: 1000,
			handleTaskTimeout: () => {},
		});
		sweeper.clear(); // 首次 clear 无定时器
		sweeper.clear(); // 再次 clear
		assert.equal(sweeper.getSweepTimer(), null);
	});

	test("超时任务触发 handleTaskTimeout", async () => {
		const inflight = new InflightTracker();
		const timedoutTasks = [];

		// 创建一个已超时的任务
		const task = {
			startTime: performance.now() - 5000, // 5 秒前
			timeout: 100, // 100ms 超时 → 肯定已超时
			settled: false,
		};
		inflight.push(task);

		const sweeper = createSweeper({
			inflight,
			sweepIntervalMs: 10, // 10ms 扫描一次
			handleTaskTimeout: (t) => {
				// 模拟真实行为：标记已结算防止重复触发
				if (t.settled) return;
				t.settled = true;
				timedoutTasks.push(t);
			},
		});

		sweeper.schedule();
		// 等待 sweep 触发多次，但只应结算一次
		await sleep(50);
		sweeper.clear();

		assert.equal(timedoutTasks.length, 1, "超时任务应只被结算一次");
		assert.equal(timedoutTasks[0], task);
	});

	test("未超时任务不触发 handleTaskTimeout", async () => {
		const inflight = new InflightTracker();
		const timedoutTasks = [];

		const task = {
			startTime: performance.now(), // 刚加入
			timeout: 10000, // 10s 超时
		};
		inflight.push(task);

		const sweeper = createSweeper({
			inflight,
			sweepIntervalMs: 10,
			handleTaskTimeout: (t) => timedoutTasks.push(t),
		});

		sweeper.schedule();
		await sleep(50);
		sweeper.clear();

		assert.equal(timedoutTasks.length, 0, "未超时任务不应被触发");
	});
});

describe("createFinalizeScheduler", () => {
	test("调度后触发 finalizePendingTasks", async () => {
		const calls = [];
		const pending = new Set([
			{ kind: "execute", rows: undefined, stderrText: "", consumerError: null },
		]);

		const schedule = createFinalizeScheduler({
			pendingFinalizeTasks: pending,
			settleTask: (t, e, v) => calls.push({ type: "settle", error: e, value: v }),
			pumpQueue: () => calls.push({ type: "pump" }),
		});

		schedule();
		assert.equal(calls.length, 0, "schedule 后不应立即调用 settle");

		// 等待 setImmediate 触发
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(calls.length, 2, "setImmediate 后应完成结算");
		assert.equal(calls[0].type, "settle");
		assert.equal(calls[0].value, undefined);
		assert.equal(calls[1].type, "pump");
	});

	test("多次调度合并为一次 setImmediate", async () => {
		let settleCount = 0;
		const pending = new Set([
			{ kind: "execute", rows: undefined, stderrText: "", consumerError: null },
		]);

		const schedule = createFinalizeScheduler({
			pendingFinalizeTasks: pending,
			settleTask: () => { settleCount++; },
			pumpQueue: () => {},
		});

		schedule();
		schedule();
		schedule();

		await new Promise(resolve => setImmediate(resolve));
		assert.equal(settleCount, 1, "多次调度只应结算一次");
	});
});

describe("handleParsedValue", () => {
	function makeMockInflight(task = null) {
		let current = task;
		return {
			get first() { return current; },
			shift() {
				const t = current;
				current = null;
				return t;
			},
			// toArray 不为 handleParsedValue 使用，但保持兼容
			toArray() { return current ? [current] : []; },
		};
	}

	test("无 inflight 任务时直接返回", () => {
		let called = false;
		handleParsedValue('{"a":1}', makeMockInflight(null), {
			afterSentinel: () => { called = true; },
			rejectAll: () => { called = true; },
		});
		assert.equal(called, false);
	});

	test("原始字符串匹配 sentinel 时调用 afterSentinel", () => {
		const task = { token: "tok-1" };
		let afterCalled = false;
		handleParsedValue(`[{"__sqlite_executor_token__":"tok-1"}]`, makeMockInflight(task), {
			afterSentinel: (t) => {
				afterCalled = true;
				assert.equal(t, task);
			},
			rejectAll: () => {},
		});
		assert.equal(afterCalled, true);
	});

	test("空数组 [] 直接返回，不触发回调", () => {
		let called = false;
		const task = { token: "tok-1" };
		handleParsedValue("[]", makeMockInflight(task), {
			afterSentinel: () => { called = true; },
			rejectAll: () => { called = true; },
		});
		assert.equal(called, false);
	});

	test("JSON 解析失败时调用 rejectAll", () => {
		const task = { token: "tok-1" };
		let rejectCalled = false;
		handleParsedValue("{invalid json}", makeMockInflight(task), {
			afterSentinel: () => {},
			rejectAll: (err) => {
				rejectCalled = true;
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes("Invalid JSON from sqlite3"));
			},
		});
		assert.equal(rejectCalled, true);
	});

	test("sentinel 行匹配时调用 afterSentinel", () => {
		const task = { token: "tok-2" };
		let afterCalled = false;
		handleParsedValue(`[{"__sqlite_executor_token__":"tok-2"}]`, makeMockInflight(task), {
			afterSentinel: (t) => {
				afterCalled = true;
				assert.equal(t, task);
			},
			rejectAll: () => {},
		});
		assert.equal(afterCalled, true);
	});

	test("非标准格式 sentinel 走 isSentinelRow 回退路径", () => {
		// isSentinelRaw 精确匹配要求原始字符串与 buildSentinelStr 完全一致。
		// 若 JSON 存在多余空白符（如冒号前后空格），isSentinelRaw 失败后
		// 应由 JSON.parse + isSentinelRow 兜底匹配。
		const task = { token: "tok-fallback" };
		let afterCalled = false;
		// 注意：冒号前有额外空格，与标准格式不同
		handleParsedValue(`[{"__sqlite_executor_token__" : "tok-fallback"}]`, makeMockInflight(task), {
			afterSentinel: (t) => {
				afterCalled = true;
				assert.equal(t, task);
			},
			rejectAll: () => {},
		});
		assert.equal(afterCalled, true, "isSentinelRow 回退路径应匹配 sentinel");
	});

	test("timedout 任务跳过行收集", () => {
		const rows = [];
		const task = { token: "tok-1", kind: "query", timedout: true, rows };
		handleParsedValue(`[{"id":1}]`, makeMockInflight(task), {
			afterSentinel: () => {},
			rejectAll: () => {},
		});
		assert.equal(rows.length, 0, "timedout 任务不应收集行");
	});

	test("query 任务收集行数据", () => {
		const rows = [];
		const task = { token: "tok-1", kind: "query", rows };
		handleParsedValue(`[{"id":1},{"id":2}]`, makeMockInflight(task), {
			afterSentinel: () => {},
			rejectAll: () => {},
		});
		assert.equal(rows.length, 2);
		assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
	});

	test("stream 任务逐行回调", () => {
		const streamRows = [];
		const task = {
			token: "tok-1",
			kind: "stream",
			onRow: (row) => streamRows.push(row),
			consumerError: null,
		};
		handleParsedValue(`["a","b","c"]`, makeMockInflight(task), {
			afterSentinel: () => {},
			rejectAll: () => {},
		});
		assert.deepEqual(streamRows, ["a", "b", "c"]);
	});

	// ─── advanceNextInflightStartTime 回归测试 ────────────

	test("isSentinelRaw 路径将下一个 inflight 任务的 startTime 前移", () => {
		const inflight = new InflightTracker();
		// startTime 比当前 performance.now() 小，模拟已执行了一段时间的旧任务
		const earlier = Math.max(1, performance.now() - 1000);
		const t1 = { token: "tok-1", startTime: earlier, timeout: 30000 };
		const t2 = { token: "tok-2", startTime: earlier, timeout: 30000 };
		inflight.push(t1, t2);

		// 确保 earlier < before，即 startTime 在调用前确实处于"过去"
		const before = performance.now();
		assert.ok(before > earlier, "precondition: before > earlier");

		handleParsedValue(`[{"__sqlite_executor_token__":"tok-1"}]`, inflight, {
			afterSentinel: () => {},
			rejectAll: () => {},
		});

		assert.equal(inflight.count, 1, "t1 应被移出 inflight");
		assert.ok(t2.startTime >= before, "t2 的 startTime 应被前移到至少当前时刻");
		assert.ok(t2.startTime > earlier, "t2 的 startTime 应大于旧值（已更新）");
	});

	test("isSentinelRow 路径也将下一个 inflight 任务的 startTime 前移", () => {
		const inflight = new InflightTracker();
		const earlier = Math.max(1, performance.now() - 1000);
		const t1 = { token: "tok-fallback", startTime: earlier, timeout: 30000 };
		const t2 = { token: "tok-other", startTime: earlier, timeout: 30000 };
		inflight.push(t1, t2);

		const before = performance.now();
		// isSentinelRaw 因 JSON 含额外空格失败，走 isSentinelRow 回退路径
		handleParsedValue(`[{"__sqlite_executor_token__" : "tok-fallback"}]`, inflight, {
			afterSentinel: () => {},
			rejectAll: () => {},
		});

		assert.equal(inflight.count, 1, "t1 应被移出 inflight");
		assert.ok(t2.startTime >= before, "isSentinelRow 路径下 t2 的 startTime 也应前移");
	});

	test("仅剩一个 inflight 任务时 startTime 不前移（无下一个任务）", () => {
		const inflight = new InflightTracker();
		const t1 = { token: "tok-1", startTime: Math.max(1, performance.now() - 500), timeout: 30000 };
		inflight.push(t1);

		handleParsedValue(`[{"__sqlite_executor_token__":"tok-1"}]`, inflight, {
			afterSentinel: () => {},
			rejectAll: () => {},
		});

		assert.equal(inflight.count, 0, "t1 应被移出 inflight");
		// 无下一个任务，不应报错，不应有副作用
	});

	test("下一个任务 startTime 为 0 时不前移（未 pump 的任务）", () => {
		const inflight = new InflightTracker();
		const t1 = { token: "tok-1", startTime: Math.max(1, performance.now() - 500), timeout: 30000 };
		const t2 = { token: "tok-2", startTime: 0, timeout: 30000 }; // startTime=0 表示尚未 pump
		inflight.push(t1, t2);

		handleParsedValue(`[{"__sqlite_executor_token__":"tok-1"}]`, inflight, {
			afterSentinel: () => {},
			rejectAll: () => {},
		});

		assert.equal(inflight.count, 1, "t1 应被移出 inflight");
		assert.equal(t2.startTime, 0, "startTime=0 的任务不应被前移");
	});

	test("多个 sentinel 依次到达时逐个前移剩余任务的 startTime", async () => {
		const inflight = new InflightTracker();
		const earlier = Math.max(1, performance.now() - 2000);
		const t1 = { token: "tok-a", startTime: earlier, timeout: 30000 };
		const t2 = { token: "tok-b", startTime: earlier, timeout: 30000 };
		const t3 = { token: "tok-c", startTime: earlier, timeout: 30000 };
		inflight.push(t1, t2, t3);

		// 第 1 个 sentinel 到达 → t1 出队，t2.startTime 前移
		const before1 = performance.now();
		handleParsedValue(`[{"__sqlite_executor_token__":"tok-a"}]`, inflight, {
			afterSentinel: () => {},
			rejectAll: () => {},
		});
		assert.ok(t2.startTime >= before1, "t2 的 startTime 应在第 1 次 sentinel 后被前移");
		assert.equal(t2.startTime, inflight.first.startTime, "t2 现在是 inflight 首任务");

		// 短暂等待让时间推进，确保能检测到变化
		await sleep(5);

		// 第 2 个 sentinel 到达 → t2 出队，t3.startTime 前移
		const before2 = performance.now();
		handleParsedValue(`[{"__sqlite_executor_token__":"tok-b"}]`, inflight, {
			afterSentinel: () => {},
			rejectAll: () => {},
		});
		assert.ok(t3.startTime >= before2, "t3 的 startTime 应在第 2 次 sentinel 后被前移");
		assert.equal(inflight.count, 1, "只剩 t3 在 inflight 中");
	});
});

// ─── createPumpQueue ───

describe("createPumpQueue", () => {
	function makeMockProcessManager() {
		let drainCb = null;
		return {
			draining: false,
			written: /** @type {string[]} */ ([]),
			write(data) { this.written.push(data); },
			onDrained(cb) { drainCb = cb; },
			_triggerDrain() { if (drainCb) drainCb(); },
		};
	}

	function makeMockSweeper() {
		return { scheduleCalls: 0, schedule() { this.scheduleCalls++; }, clear() {} };
	}

	test("泵送空队列时什么都不做", () => {
		const queue = new Queue();
		const inflight = new InflightTracker();
		const pm = makeMockProcessManager();
		const sweeper = makeMockSweeper();

		const pump = createPumpQueue({ queue, inflight, processManager: pm, sweeper, batchSize: 10, maxInflight: 50 });
		pump();

		assert.equal(pm.written.length, 0);
		assert.equal(sweeper.scheduleCalls, 0);
	});

	test("泵送单个 execute 任务", () => {
		const queue = new Queue();
		const inflight = new InflightTracker();
		const pm = makeMockProcessManager();
		const sweeper = makeMockSweeper();

		const task = { kind: "execute", sql: "SELECT 1", token: "tok-1" };
		queue.enqueue(task);

		const pump = createPumpQueue({ queue, inflight, processManager: pm, sweeper, batchSize: 10, maxInflight: 50 });
		pump();

		assert.equal(pm.written.length, 1, "应写入一次");
		assert.ok(pm.written[0].includes("SELECT 1"), "payload 应包含 SQL");
		assert.equal(sweeper.scheduleCalls, 1, "sweeper 应被调度");
		assert.equal(inflight.count, 1, "任务应进入 inflight");
		assert.equal(inflight.first, task);
		assert.ok(task.startTime > 0, "应在 pump 时标记 startTime");
		assert.ok(task.batchId != null, "应分配 batchId");
	});

	test("泵送 batch 多个 execute 任务", () => {
		const queue = new Queue();
		const inflight = new InflightTracker();
		const pm = makeMockProcessManager();
		const sweeper = makeMockSweeper();

		queue.enqueue({ kind: "execute", sql: "INSERT INTO t VALUES(1)", token: "tok-1" });
		queue.enqueue({ kind: "execute", sql: "INSERT INTO t VALUES(2)", token: "tok-2" });

		const pump = createPumpQueue({ queue, inflight, processManager: pm, sweeper, batchSize: 10, maxInflight: 50 });
		pump();

		assert.equal(inflight.count, 2, "两个任务都应进入 inflight");
		assert.ok(pm.written[0].startsWith("BEGIN;"), "batch 应以 BEGIN 开头");
	});

	test("stream 任务独占发送", () => {
		const queue = new Queue();
		const inflight = new InflightTracker();
		const pm = makeMockProcessManager();
		const sweeper = makeMockSweeper();

		queue.enqueue({ kind: "execute", sql: "SELECT 1", token: "tok-1" });
		queue.enqueue({ kind: "stream", sql: "SELECT 2", token: "tok-2", onRow: null });

		const pump = createPumpQueue({ queue, inflight, processManager: pm, sweeper, batchSize: 10, maxInflight: 50 });
		pump();

		// stream 碰到前面有 execute → 不打包，只发送 execute
		assert.equal(inflight.count, 1, "stream 前的 execute 独立发送");
		assert.equal(inflight.first?.token, "tok-1");
	});

	test("draining 时不泵送，排空后重试", () => {
		const queue = new Queue();
		const inflight = new InflightTracker();
		const pm = makeMockProcessManager();
		const sweeper = makeMockSweeper();
		let postDrainCalls = 0;

		queue.enqueue({ kind: "execute", sql: "SELECT 1", token: "tok-1" });

		pm.draining = true;
		const pump = createPumpQueue({ queue, inflight, processManager: pm, sweeper, batchSize: 10, maxInflight: 50 });
		pump();

		assert.equal(pm.written.length, 0, "draining 时应跳过泵送");

		pm.draining = false;
		pm._triggerDrain(); // 触发 onDrained 回调 → 重新调用 pump
		assert.equal(pm.written.length, 1, "排空后应完成泵送");
	});

	test("达到 maxInflight 上限时不泵送", () => {
		const queue = new Queue();
		const inflight = new InflightTracker();
		const pm = makeMockProcessManager();
		const sweeper = makeMockSweeper();

		queue.enqueue({ kind: "execute", sql: "SELECT 1", token: "tok-1" });
		// 手动填充 inflight 到上限
		inflight.push({ kind: "execute", startTime: 0, timeout: 99999 });

		const pump = createPumpQueue({ queue, inflight, processManager: pm, sweeper, batchSize: 10, maxInflight: 1 });
		pump();

		assert.equal(pm.written.length, 0, "超过 maxInflight 不应泵送");
	});
});

// ─── rejectAllTasks ───

describe("rejectAllTasks", () => {
	function setup() {
		const inflight = new InflightTracker();
		const queue = new Queue();
		const pendingFinalizeTasks = new Set();
		const settled = /** @type {Array<{ task: object, error: Error|null, value: any }>} */ ([]);
		const settleTask = (task, error, value) => {
			task.settled = true;
			settled.push({ task, error, value });
		};
		const error = new Error("test rejection");
		return { inflight, queue, pendingFinalizeTasks, settled, settleTask, error };
	}

	test("拒绝 inflight + 队列 + pendingFinalize 中的所有任务", () => {
		const { inflight, queue, pendingFinalizeTasks, settled, settleTask, error } = setup();

		const t1 = { id: 1 };
		const t2 = { id: 2 };
		const t3 = { id: 3 };

		inflight.push(t1);
		queue.enqueue(t2);
		pendingFinalizeTasks.add(t3);

		rejectAllTasks({ inflight, queue, pendingFinalizeTasks, settleTask, error });

		assert.equal(settled.length, 3);
		assert.equal(settled[0].task, t2, "队列任务先被结算");
		assert.equal(settled[1].task, t1, "inflight 任务其次");
		assert.equal(settled[2].task, t3, "pendingFinalize 任务最后");
		assert.equal(inflight.count, 0, "inflight 已清空");
		assert.equal(queue.isEmpty(), true, "队列已清空");
		assert.equal(pendingFinalizeTasks.size, 0, "pendingFinalize 已清空");
	});

	test("空集合不报错", () => {
		const { inflight, queue, pendingFinalizeTasks, settled, settleTask, error } = setup();
		rejectAllTasks({ inflight, queue, pendingFinalizeTasks, settleTask, error });
		assert.equal(settled.length, 0);
	});

	test("只有 inflight 任务", () => {
		const { inflight, queue, pendingFinalizeTasks, settled, settleTask, error } = setup();
		const t = { id: 1 };
		inflight.push(t);
		rejectAllTasks({ inflight, queue, pendingFinalizeTasks, settleTask, error });
		assert.equal(settled.length, 1);
		assert.equal(settled[0].task, t);
		assert.ok(settled[0].error, error);
	});

	test("只有队列任务", () => {
		const { inflight, queue, pendingFinalizeTasks, settled, settleTask, error } = setup();
		const t = { id: 1 };
		queue.enqueue(t);
		rejectAllTasks({ inflight, queue, pendingFinalizeTasks, settleTask, error });
		assert.equal(settled.length, 1);
		assert.equal(settled[0].task, t);
	});
});

// ─── handleSentinelTask ───

describe("handleSentinelTask", () => {
	function makeContext() {
		const settleCalls = [];
		const pendingFinalizeTasks = new Set();
		let _scheduleCalls = 0;
		let _pumpCalls = 0;
		return {
			settleTask: (t, e, v) => { settleCalls.push({ t, e, v }); },
			pendingFinalizeTasks,
			scheduleFinalizeCheck: () => { _scheduleCalls++; },
			pumpQueue: () => { _pumpCalls++; },
			settleCalls,
			get scheduleCalls() { return _scheduleCalls; },
			get pumpCalls() { return _pumpCalls; },
		};
	}

	test("timedout 任务只调用 pumpQueue", () => {
		const ctx = makeContext();
		handleSentinelTask({ timedout: true }, ctx);
		assert.equal(ctx.settleCalls.length, 0, "timedout 不应结算");
		assert.equal(ctx.scheduleCalls, 0, "timedout 不应调度延迟结算");
		assert.equal(ctx.pumpCalls, 1, "timedout 应触发泵送");
	});

	test("consumerError 立即 settle 并泵送", () => {
		const ctx = makeContext();
		const err = new Error("consumer broke");
		handleSentinelTask({ timedout: false, consumerError: err }, ctx);
		assert.equal(ctx.settleCalls.length, 1, "consumerError 应结算");
		assert.equal(ctx.settleCalls[0].e, err);
		assert.equal(ctx.pumpCalls, 1);
	});

	test("正常任务进入 pendingFinalize", () => {
		const ctx = makeContext();
		const task = { timedout: false, consumerError: null };
		handleSentinelTask(task, ctx);
		assert.equal(ctx.settleCalls.length, 0, "不应立即结算");
		assert.ok(ctx.pendingFinalizeTasks.has(task), "应加入 pendingFinalize");
		assert.equal(ctx.scheduleCalls, 1, "应调度延迟结算");
		assert.equal(ctx.pumpCalls, 1, "应触发泵送");
	});
});

// ─── handleStderrChunk ───

describe("handleStderrChunk", () => {
	function makeContext() {
		const pendingFinalizeTasks = new Set();
		const inflight = new InflightTracker();
		const pendingStderr = /** @type {string[]} */([]);
		const logger = { errorCalls: /** @type {string[]} */([]), error(msg) { this.errorCalls.push(msg); } };
		return { inflight, pendingFinalizeTasks, pendingStderr, logger };
	}

	test("无匹配任务时通过 logger 输出", () => {
		const ctx = makeContext();
		handleStderrChunk("error msg", ctx);
		assert.equal(ctx.logger.errorCalls.length, 1);
		assert.ok(ctx.logger.errorCalls[0].includes("error msg"));
	});

	test("归因到 inflight 第一个任务", () => {
		const ctx = makeContext();
		const task = { kind: "execute", stderrText: "", batchId: null };
		ctx.inflight.push(task);
		handleStderrChunk("some error", ctx);
		assert.ok(task.stderrText.includes("some error"));
	});

	test("零行归因：pendingFinalize 中 rows.length===0 的 query 优先", () => {
		const ctx = makeContext();
		const goodTask = { kind: "query", rows: [1], stderrText: "" };
		const badTask = { kind: "query", rows: [], stderrText: "" };
		ctx.pendingFinalizeTasks.add(goodTask);
		ctx.pendingFinalizeTasks.add(badTask);
		// inflight 也有任务，但零行归因优先级更高
		ctx.inflight.push({ kind: "execute", stderrText: "" });

		handleStderrChunk("syntax error", ctx);
		assert.equal(badTask.stderrText, "syntax error", "零行任务应获得 stderr");
		assert.equal(goodTask.stderrText, "", "有行任务不应获得 stderr");
	});

	test("batchId 为空时不传播", () => {
		const ctx = makeContext();
		const t1 = { kind: "execute", stderrText: "", batchId: null };
		const t2 = { kind: "execute", stderrText: "", batchId: null };
		ctx.inflight.push(t1);
		ctx.pendingFinalizeTasks.add(t2);

		handleStderrChunk("error", ctx);
		// 优先归因给 inflight 任务（t1），因 batchId 为空不传播给 t2
		assert.ok(t1.stderrText.includes("error"), "inflight 任务获得 stderr（优先归因）");
		assert.equal(t2.stderrText, "", "pendingFinalize 任务不应获得 stderr（未传播）");
	});

	test("非 WAL batch 中 inflight 任务被优先归因，不传播到 pendingFinalize", () => {
		const ctx = makeContext();
		// pendingFinalize 中有一个带 batchId 的非 WAL 任务
		const pendingTask = { kind: "execute", stderrText: "", batchId: "batch-1" };
		ctx.pendingFinalizeTasks.add(pendingTask);
		// inflight 中有一个不同的任务（当前正在执行）
		const inflightTask = { kind: "execute", stderrText: "" };
		ctx.inflight.push(inflightTask);

		handleStderrChunk("batch error", ctx);

		// inflight 任务优先获得 stderr（正在执行，最可能是失败源）
		assert.ok(inflightTask.stderrText.includes("batch error"), "inflight 任务获得 stderr（优先归因）");
		// pendingFinalize 任务不应被传播，它已收到 sentinel 并完成执行
		assert.equal(pendingTask.stderrText, "", "pendingFinalize 任务不应获得 stderr（不传播）");
	});

	// ─── 回归测试：延迟 stderr 竞态 ───
	// 场景：一批非法 SQL 被执行 → sentinel 先于 stderr 到达 → 任务被顺利结算
	// （pendingFinalizeTasks 已清空）→ 新的 inflight 查询开始执行 →
	// 延迟的 stderr 到达 → 当前代码误将 stderr 归因给新的查询（见 #1957）。
	// 此测试直接模拟该时序。
	test("延迟 stderr 不应归因给后续不相关的 inflight 查询（回归 #1957）", () => {
		const ctx = makeContext();

		// ── 设定场景 ──
		// 1. pendingFinalizeTasks 已清空 —— 上一批非法查询任务已结算，没有零行匹配
		// 2. 唯一一个 inflight 任务是后续的新查询（模拟验证查询），rows 尚未到达
		// 3. hasFinalizedZeroRowQuery=true 模拟上一批零行查询已结算的状态，
		//    通知 handleStderrChunk 当前 stderr 可能是延迟到达的残余错误
		const inflightTask = {
			kind: "query",
			rows: [],
			stderrText: "",
			batchId: 42,
			walBatch: false,
		};
		ctx.inflight.push(inflightTask);
		ctx.hasFinalizedZeroRowQuery = true;

		// ── 触发：延迟 stderr 到达 ──
		handleStderrChunk("Parse error near line 1: no such column: FORM\n  SELECT FORM foo;\n", ctx);

		// ── 验证 ──
		// BUG：不应归因给 inflight 任务，应缓冲到 pendingStderr 由零行归因兜底
		assert.equal(inflightTask.stderrText, "", "延迟 stderr 不应污染新 inflight 任务");
		assert.equal(ctx.pendingStderr.length, 1, "stderr 应缓冲到 pendingStderr");
		assert.ok(ctx.pendingStderr[0].includes("Parse error"), "pendingStderr 内容应正确");
	});
});

describe("fuzz: pipelineUtils", () => {
	describe("fuzz: handleStderrChunk", () => {
		test("随机 stderr 模式不崩溃", () => {
			const inflight = new InflightTracker();
			const pendingFinalizeTasks = new Set();
			const logger = { error: () => {} };

			for (let i = 0; i < 500; i++) {
				// 随机填充 inflight 和 pendingFinalize
				if (Math.random() < 0.5) {
					inflight.push({
						kind: Math.random() > 0.5 ? "query" : "execute",
						stderrText: "",
						batchId: Math.random() > 0.5 ? `batch-${i}` : null,
						walBatch: Math.random() > 0.5,
						rows: [],
					});
				}
				if (Math.random() < 0.5) {
					pendingFinalizeTasks.add({
						kind: Math.random() > 0.5 ? "query" : "execute",
						stderrText: "",
						batchId: Math.random() > 0.5 ? `batch-${i}` : null,
						walBatch: Math.random() > 0.5,
						rows: Math.random() > 0.5 ? [{ id: 1 }] : [],
					});
				}

				const chunk = `error message ${i}: ${Math.random().toString(36).slice(2)}`;
				try {
					handleStderrChunk(chunk, { inflight, pendingFinalizeTasks, logger });
				} catch (e) {
					assert.fail(`handleStderrChunk 不应抛出异常: ${e.message}`);
				}

				// 清理
				if (Math.random() < 0.3) {
					inflight.clear();
					pendingFinalizeTasks.clear();
				}
			}
		});

		test("大量并发 stderr 不崩溃", () => {
			const inflight = new InflightTracker();
			const pendingFinalizeTasks = new Set();
			const logger = { error: () => {} };

			// 填充大量 inflight 任务（无 pendingFinalize，避免零行归因优先）
			for (let i = 0; i < 50; i++) {
				inflight.push({
					kind: "execute",
					stderrText: "",
					batchId: "batch-1",
					walBatch: true,
				});
			}

			// 发送大量 stderr
			for (let i = 0; i < 50; i++) {
				handleStderrChunk(`error ${i}`, { inflight, pendingFinalizeTasks, logger });
			}

			// 所有 inflight 任务应收到 stderr（WAL batch 传播）
			inflight.forEach((t) => {
				assert.ok(t.stderrText.length > 0, "WAL batch inflight 任务应收到 stderr");
			});
		});
	});

	describe("fuzz: handleParsedValue", () => {
		test("随机 JSON 值不崩溃", () => {
			const inflight = new InflightTracker();
			const task = { token: "tok-1", kind: "query", rows: [], timedout: false };
			inflight.push(task);

			const jsonValues = [
				'[{"id":1}]',
				'[{"id":1},{"id":2}]',
				"[]",
				"[1,2,3]",
				'["a","b","c"]',
				"[null,true,false]",
				'[{"nested":{"a":1}}]',
				'[{"__sqlite_executor_token__":"tok-1"}]',
				"[[]]",
				"[{}]",
			];

			for (const json of jsonValues) {
				try {
					handleParsedValue(json, inflight, {
						afterSentinel: () => {},
						rejectAll: () => {},
					});
				} catch (e) {
					assert.fail(`handleParsedValue 不应抛出异常: ${e.message}`);
				}
			}
		});

		test("大量数据行收集", () => {
			const inflight = new InflightTracker();
			const rows = [];
			const task = { token: "tok-1", kind: "query", rows, timedout: false };
			inflight.push(task);

			const large = Array.from({ length: 10000 }, (_, i) => ({ id: i }));
			const json = JSON.stringify(large);
			handleParsedValue(json, inflight, {
				afterSentinel: () => {},
				rejectAll: () => {},
			});

			assert.equal(rows.length, 10000);
		});
	});

	describe("fuzz: finalizePendingTasks", () => {
		test("大量任务批量结算", () => {
			const tasks = new Set();
			const settleCalls = [];
			for (let i = 0; i < 500; i++) {
				tasks.add({
					kind: Math.random() > 0.5 ? "query" : "execute",
					rows: Math.random() > 0.5 ? [{ id: i }] : [],
					stderrText: Math.random() > 0.8 ? `error ${i}` : "",
					consumerError: Math.random() > 0.9 ? new Error(`consumer ${i}`) : null,
				});
			}

			finalizePendingTasks(
				tasks,
				(task, error, value) => settleCalls.push({ error, value }),
				() => {},
			);

			assert.equal(settleCalls.length, 500);
			assert.equal(tasks.size, 0);
		});

		test("pendingStderr 缓冲归因", () => {
			const tasks = new Set();
			const settleCalls = [];
			const pendingStderr = ["error from buffer"];

			tasks.add({
				kind: "query",
				rows: [],
				stderrText: "",
				consumerError: null,
			});
			tasks.add({
				kind: "query",
				rows: [{ id: 1 }],
				stderrText: "",
				consumerError: null,
			});

			finalizePendingTasks(
				tasks,
				(task, error, value) => settleCalls.push({ error, value }),
				() => {},
				pendingStderr,
				{ count: 0 },
			);

			// 零行 query 应收到缓冲的 stderr
			assert.ok(settleCalls[0].error instanceof Error);
			assert.ok(settleCalls[0].error.message.includes("error from buffer"));
			// 有行 query 不应收到 stderr
			assert.equal(settleCalls[1].error, null);
		});
	});

	describe("fuzz: createPumpQueue", () => {
		test("大量任务泵送不崩溃", () => {
			const queue = new Queue();
			const inflight = new InflightTracker();
			const pm = {
				draining: false,
				written: [],
				write(data) { this.written.push(data); },
				onDrained() {},
			};
			const sweeper = {
				scheduleCalls: 0,
				schedule() { this.scheduleCalls++; },
				clear() {},
			};

			// 填充 1000 个任务
			for (let i = 0; i < 1000; i++) {
				queue.enqueue({
					kind: i % 3 === 0 ? "query" : "execute",
					sql: `SELECT ${i}`,
					token: `tok-${i}`,
				});
			}

			const pump = createPumpQueue({
				queue, inflight, processManager: pm, sweeper,
				batchSize: 50, maxInflight: 100,
			});

			// 分批泵送
			let totalWritten = 0;
			while (!queue.isEmpty() && inflight.count < 100) {
				pump();
				if (pm.written.length > totalWritten) {
					totalWritten = pm.written.length;
				}
				// 模拟完成一些任务
				if (inflight.count > 50) {
					for (let i = 0; i < 20; i++) {
						inflight.shift();
					}
				}
			}

			assert.ok(pm.written.length > 0, "应有写入");
			assert.ok(sweeper.scheduleCalls > 0, "sweeper 应被调度");
		});
	});

	describe("fuzz: rejectAllTasks", () => {
		test("大量任务拒绝不崩溃", () => {
			const inflight = new InflightTracker();
			const queue = new Queue();
			const pendingFinalizeTasks = new Set();
			const settled = [];

			for (let i = 0; i < 500; i++) {
				inflight.push({ id: i, kind: "inflight" });
			}
			for (let i = 0; i < 500; i++) {
				queue.enqueue({ id: i + 500, kind: "queue" });
			}
			for (let i = 0; i < 500; i++) {
				pendingFinalizeTasks.add({ id: i + 1000, kind: "pending" });
			}

			rejectAllTasks({
				inflight,
				queue,
				pendingFinalizeTasks,
				settleTask: (task, error, value) => settled.push({ task, error, value }),
				error: new Error("mass rejection"),
			});

			assert.equal(settled.length, 1500);
			assert.equal(inflight.count, 0);
			assert.equal(queue.isEmpty(), true);
			assert.equal(pendingFinalizeTasks.size, 0);
		});
	});
});
