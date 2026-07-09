import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { collectQueryRows, processStreamRows, settleTask } from "./settleUtils.js";
import { Metrics } from "./metrics.js";

describe("collectQueryRows", () => {
	test("将数组元素追加到 task.rows", () => {
		const task = { rows: [{ id: 1 }] };
		collectQueryRows(task, [{ id: 2 }, { id: 3 }]);
		assert.deepEqual(task.rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
	});

	test("空数组不修改 rows", () => {
		const task = { rows: [{ id: 1 }] };
		collectQueryRows(task, []);
		assert.deepEqual(task.rows, [{ id: 1 }]);
	});

	test("非数组输入时不修改 rows", () => {
		const task = { rows: [{ id: 1 }] };
		collectQueryRows(task, { id: 2 });
		assert.deepEqual(task.rows, [{ id: 1 }]);

		collectQueryRows(task, null);
		assert.deepEqual(task.rows, [{ id: 1 }]);

		collectQueryRows(task, "string");
		assert.deepEqual(task.rows, [{ id: 1 }]);

		collectQueryRows(task, undefined);
		assert.deepEqual(task.rows, [{ id: 1 }]);
	});

	test("多次收集累积到 rows", () => {
		const task = { rows: [] };
		collectQueryRows(task, [{ a: 1 }]);
		collectQueryRows(task, [{ a: 2 }, { a: 3 }]);
		collectQueryRows(task, [{ a: 4 }]);
		assert.deepEqual(task.rows, [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]);
	});
});

describe("processStreamRows", () => {
	test("对数组每个元素调用 onRow", () => {
		const called = [];
		const task = {
			onRow: (row) => called.push(row),
			consumerError: null,
		};
		processStreamRows(task, [{ id: 1 }, { id: 2 }]);
		assert.deepEqual(called, [{ id: 1 }, { id: 2 }]);
	});

	test("非数组输入不调用 onRow", () => {
		let called = false;
		const task = {
			onRow: () => { called = true; },
			consumerError: null,
		};
		processStreamRows(task, { id: 1 });
		assert.equal(called, false);

		processStreamRows(task, null);
		assert.equal(called, false);

		processStreamRows(task, "text");
		assert.equal(called, false);
	});

	test("consumerError 时停止后续回调", () => {
		const called = [];
		const task = {
			onRow: (row) => {
				called.push(row.id);
				if (row.id === 2) throw new Error("consumer stopped");
			},
			consumerError: null,
		};
		processStreamRows(task, [{ id: 1 }, { id: 2 }, { id: 3 }]);
		assert.deepEqual(called, [1, 2]);
		assert.ok(task.consumerError instanceof Error);
		assert.ok(task.consumerError.message.includes("consumer stopped"));
	});

	test("consumerError 已设置时跳过所有回调", () => {
		const called = [];
		const task = {
			onRow: (row) => called.push(row),
			consumerError: new Error("previous error"),
		};
		processStreamRows(task, [{ id: 1 }, { id: 2 }]);
		assert.deepEqual(called, []);
	});

	test("空数组不调用 onRow", () => {
		const called = [];
		const task = {
			onRow: (row) => called.push(row),
			consumerError: null,
		};
		processStreamRows(task, []);
		assert.deepEqual(called, []);
	});
});

describe("settleTask", () => {
	test("任务成功时调用 resolve 并更新指标", () => {
		const metrics = new Metrics();
		let resolvedValue;
		const task = {
			timer: null,
			startTime: 100,
			rowParser: null,
			resolve: (v) => { resolvedValue = v; },
			reject: () => { assert.fail("不应调用 reject"); },
		};

		settleTask(task, null, "success", metrics);

		assert.equal(resolvedValue, "success");
		const s = metrics.snapshot();
		assert.equal(s.tasksSuccess, 1);
		assert.equal(s.tasksFailed, 0);
	});

	test("任务失败时调用 reject 并更新指标", () => {
		const metrics = new Metrics();
		let rejectedError;
		const task = {
			timer: null,
			startTime: 100,
			rowParser: null,
			resolve: () => { assert.fail("不应调用 resolve"); },
			reject: (err) => { rejectedError = err; },
		};

		const err = new Error("task failed");
		settleTask(task, err, undefined, metrics);

		assert.equal(rejectedError, err);
		const s = metrics.snapshot();
		assert.equal(s.tasksFailed, 1);
		assert.equal(s.tasksSuccess, 0);
	});

	test("非 Error 值被包装为 Error", () => {
		let rejectedError;
		const task = {
			timer: null,
			startTime: 100,
			rowParser: null,
			resolve: () => {},
			reject: (err) => { rejectedError = err; },
		};

		settleTask(task, "string error", undefined, null);

		assert.ok(rejectedError instanceof Error);
		assert.ok(rejectedError.message.includes("string error"));
	});

	test("metrics 为 null 时不崩溃", () => {
		const task = {
			timer: null,
			startTime: 100,
			rowParser: null,
			resolve: () => {},
			reject: () => {},
		};

		settleTask(task, null, "ok", null);
		settleTask(task, new Error("fail"), undefined, null);
		// 不应抛出异常
	});

	test("startTime 为 0 时 duration 计为 0", () => {
		const metrics = new Metrics();
		const task = {
			timer: null,
			startTime: 0,
			rowParser: null,
			resolve: () => {},
			reject: () => {},
		};

		settleTask(task, null, "ok", metrics);

		assert.equal(metrics.totalDuration, 0);
	});

	test("resetRowParser 选项调用 rowParser.reset()", () => {
		let resetCalled = false;
		const task = {
			timer: null,
			startTime: 100,
			rowParser: { reset: () => { resetCalled = true; } },
			resolve: () => {},
			reject: () => {},
		};

		settleTask(task, null, "ok", null, { resetRowParser: true });
		assert.equal(resetCalled, true);
	});

	test("resetRowParser 为 false 时不调用 reset", () => {
		let resetCalled = false;
		const task = {
			timer: null,
			startTime: 100,
			rowParser: { reset: () => { resetCalled = true; } },
			resolve: () => {},
			reject: () => {},
		};

		settleTask(task, null, "ok", null, { resetRowParser: false });
		assert.equal(resetCalled, false);
	});

	test("rowParser 为 null 时 resetRowParser 不崩溃", () => {
		const task = {
			timer: null,
			startTime: 100,
			rowParser: null,
			resolve: () => {},
			reject: () => {},
		};

		settleTask(task, null, "ok", null, { resetRowParser: true });
		// 不应抛出异常
	});

});

describe("fuzz: settleTask", () => {
	test("随机任务对象不崩溃", () => {
		const metrics = new Metrics();
		for (let i = 0; i < 1000; i++) {
			const task = {
				settled: Math.random() > 0.8,
				timer: Math.random() > 0.5 ? setTimeout(() => {}, 100000) : null,
				startTime: Math.random() > 0.3 ? Math.floor(Math.random() * 10000) : 0,
				rowParser: Math.random() > 0.5 ? { reset: () => {} } : null,
				resolve: () => {},
				reject: () => {},
			};
			const error = Math.random() > 0.5 ? new Error("random fail") : null;
			const value = Math.random() > 0.5 ? { data: Math.random() } : undefined;
			try {
				settleTask(task, error, value, metrics, { resetRowParser: Math.random() > 0.5 });
			} catch (e) {
				assert.fail(`settleTask 不应抛出异常: ${e.message}`);
			}
			if (task.timer) clearTimeout(task.timer);
		}
	});

	test("重复 settle 安全（幂等性）", () => {
		const task = {
			settled: false,
			timer: null,
			startTime: 100,
			rowParser: null,
			resolve: () => {},
			reject: () => {},
		};
		settleTask(task, null, "ok", null);
		settleTask(task, null, "ok", null);
		settleTask(task, new Error("fail"), undefined, null);
		// 不应抛出异常
		assert.equal(task.settled, true);
	});

	test("大量并发 settle 不冲突", () => {
		const metrics = new Metrics();
		const tasks = [];
		for (let i = 0; i < 100; i++) {
			tasks.push({
				settled: false,
				timer: null,
				startTime: i * 10,
				rowParser: null,
				resolve: () => {},
				reject: () => {},
			});
		}
		for (const task of tasks) {
			settleTask(task, null, "ok", metrics);
		}
		const s = metrics.snapshot();
		assert.equal(s.tasksSuccess, 100);
		assert.equal(s.tasksFailed, 0);
	});

	test("collectQueryRows 大量数据", () => {
		const task = { rows: [] };
		const large = Array.from({ length: 10000 }, (_, i) => ({ id: i }));
		collectQueryRows(task, large);
		assert.equal(task.rows.length, 10000);
	});

	test("processStreamRows 大量数据", () => {
		let count = 0;
		const task = {
			onRow: () => { count++; },
			consumerError: null,
		};
		const large = Array.from({ length: 10000 }, (_, i) => ({ id: i }));
		processStreamRows(task, large);
		assert.equal(count, 10000);
	});

	test("processStreamRows 在 consumerError 后停止", () => {
		let count = 0;
		const task = {
			onRow: (row) => {
				count++;
				if (row.id === 50) throw new Error("stop");
			},
			consumerError: null,
		};
		const large = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
		processStreamRows(task, large);
		assert.equal(count, 51);
		assert.ok(task.consumerError);
	});
});
