import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { TaskWorker } from "./taskWorker.js";
import { Metrics } from "./metrics.js";
import downloadSQLite3 from "../../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..", "..");
const SQLite3BinaryFile = path.join(root, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));

/* eslint-disable no-underscore-dangle */

/**
 * @type {TaskWorker}
 */
let worker;

beforeEach(async () => {
	await downloadSQLite3();
	worker = new TaskWorker({
		binary: SQLite3BinaryFile,
		database: ":memory:",
		statementTimeout: 30000,
		name: "test-worker",
	});
});

afterEach(async () => {
	worker.kill();
});

describe("TaskWorker", () => {
	describe("基本操作", () => {
		test("execute SQL 并完成", async () => {
			const result = await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "execute",
					sql: "CREATE TABLE t (id INTEGER)",
					timeout: 10000,
					token: "tok-1",
					onRow: null,
					resolve,
					reject,
				});
			});
			assert.equal(result, undefined);
		});

		test("query 返回结果行", async () => {
			await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "execute",
					sql: "CREATE TABLE t2 (id INTEGER, val TEXT)",
					timeout: 10000,
					token: "tok-2",
					onRow: null,
					resolve,
					reject,
				});
			});

			const rows = await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 1 AS a UNION SELECT 2 AS a",
					timeout: 10000,
					token: "tok-3",
					onRow: null,
					resolve,
					reject,
				});
			});
			assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
		});

		test("idle 在无任务时返回 true", () => {
			assert.equal(worker.idle, true);
		});

		test("name getter 返回构造时传入的名称", () => {
			assert.equal(worker.name, "test-worker");
		});

		test("未指定 name 时使用默认值 'worker'", () => {
			const tw = new TaskWorker({
				binary: SQLite3BinaryFile,
				database: ":memory:",
				statementTimeout: 30000,
			});
			assert.equal(tw.name, "worker");
			tw.kill();
		});
	});

	describe("串行与批量", () => {
		test("串行执行多个任务", async () => {
			const results = [];
			for (let i = 0; i < 5; i++) {
				const rows = await new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "query",
						sql: `SELECT ${i} AS v`,
						timeout: 10000,
						token: `tok-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				});
				results.push(rows[0].v);
			}
			assert.deepEqual(results, [0, 1, 2, 3, 4]);
		});

		test("批量 execute 任务串行执行", async () => {
			await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "execute",
					sql: "CREATE TABLE t_batch_exec (id INTEGER PRIMARY KEY, val TEXT)",
					timeout: 10000,
					token: "tok-be-setup",
					onRow: null,
					resolve,
					reject,
				});
			});

			const promises = [];
			for (let i = 0; i < 5; i++) {
				promises.push(new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "execute",
						sql: `INSERT INTO t_batch_exec VALUES (${i + 1}, 'v${i + 1}')`,
						timeout: 10000,
						token: `tok-be-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}));
			}
			await Promise.all(promises);

			const rows = await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT * FROM t_batch_exec ORDER BY id",
					timeout: 10000,
					token: "tok-be-check",
					onRow: null,
					resolve,
					reject,
				});
			});

			assert.equal(rows.length, 5);
		});
	});

	describe("管线化", () => {
		test("批量入队后结果顺序正确", async () => {
			await new Promise((resolve, reject) => {
				worker.enqueue({ kind: "execute", sql: "CREATE TABLE t_pipe (id INTEGER, val TEXT)", timeout: 10000, token: "tok-setup", onRow: null, resolve, reject });
			});

			const promises = [];
			for (let i = 0; i < 20; i++) {
				promises.push(new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "query",
						sql: `SELECT ${i} AS v, '${i * 2}' AS w`,
						timeout: 10000,
						token: `tok-pipe-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}));
			}

			const results = await Promise.all(promises);
			assert.equal(results.length, 20);
			for (let i = 0; i < 20; i++) {
				assert.equal(results[i][0].v, i);
				assert.equal(results[i][0].w, String(i * 2));
			}
		});

		test("在写入中途追加新任务", async () => {
			const promises = [];
			for (let i = 0; i < 5; i++) {
				promises.push(new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "query",
						sql: `SELECT ${i} AS v`,
						timeout: 10000,
						token: `tok-append-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}));
			}

			await promises[0];

			for (let i = 5; i < 10; i++) {
				promises.push(new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "query",
						sql: `SELECT ${i} AS v`,
						timeout: 10000,
						token: `tok-append-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}));
			}

			const results = await Promise.all(promises);
			assert.equal(results.length, 10);
			for (let i = 0; i < 10; i++) {
				assert.equal(results[i][0].v, i);
			}
		});
	});

	describe("错误处理", () => {
		test("SQL 错误时 reject", async () => {
			await assert.rejects(
				new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "query",
						sql: "SELECT * FROM nonexistent",
						timeout: 10000,
						token: "tok-error",
						onRow: null,
						resolve,
						reject,
					});
				}),
			);
		});
	});

	describe("状态查询", () => {
		test("pendingStatements 返回待处理数", async () => {
			assert.equal(worker.pendingStatements, 0);
			const p1 = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 10000,
					token: "tok-ps-1",
					onRow: null,
					resolve,
					reject,
				});
			});
			assert.equal(worker.pendingStatements, 1);
			const p2 = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 2",
					timeout: 10000,
					token: "tok-ps-2",
					onRow: null,
					resolve,
					reject,
				});
			});
			assert.equal(worker.pendingStatements, 2);
			await p1;
			await p2;
		});

		test("_sweepTimer 在无任务时返回 null", () => {
			assert.equal(worker._sweepTimer, null);
		});
	});

	describe("生命周期管理", () => {
		test("kill 后拒绝待处理任务", async () => {
			const p = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 10000,
					token: "tok-kill",
					onRow: null,
					resolve,
					reject,
				});
			});
			worker.kill();
			await assert.rejects(p, /killed/i);
		});

		test("进程异常退出（SIGKILL）后拒绝待处理任务", async () => {
			worker._process.stdout.removeAllListeners("data");
			const p = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 30000,
					token: "tok-crash",
					onRow: null,
					resolve,
					reject,
				});
			});
			worker._process.kill(9); // 使用信号号 9（SIGKILL），兼容 Windows
			await assert.rejects(p, /exited unexpectedly/);
		});

		test("进程 error 事件拒绝待处理任务", async () => {
			const p = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 10000,
					token: "tok-err-ev",
					onRow: null,
					resolve,
					reject,
				});
			});
			worker._process.emit("error", new Error("simulated process error"));
			await assert.rejects(p, /simulated process error/);
		});

		test("logger.error 在进程 error 事件中被调用", async () => {
			const errorLogs = [];
			const logger = {
				error: (msg, err) => errorLogs.push({ msg, err }),
			};
			const tw = new TaskWorker({
				binary: SQLite3BinaryFile,
				database: ":memory:",
				statementTimeout: 30000,
				name: "tw-log-test",
				logger,
			});

			const p = new Promise((resolve, reject) => {
				tw.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 10000,
					token: "tok-log-test",
					onRow: null,
					resolve,
					reject,
				});
			});

			tw._process.emit("error", new Error("simulated error"));

			await assert.rejects(p, /simulated error/);
			assert.equal(errorLogs.length, 1);
			assert.ok(errorLogs[0].msg.includes("tw-log-test"), `消息应包含 worker 名称: ${errorLogs[0].msg}`);
			assert.equal(errorLogs[0].err.message, "simulated error");

			tw.kill();
		});

		test("close 事件 signal 为 null 时使用 'none'", async () => {
			const tw = new TaskWorker({
				binary: SQLite3BinaryFile,
				database: ":memory:",
				statementTimeout: 30000,
				name: "tw-close-null",
			});

			const p = new Promise((resolve, reject) => {
				tw.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 10000,
					token: "tok-close-null",
					onRow: null,
					resolve,
					reject,
				});
			});

			// 模拟进程正常退出（signal 为 null）
			tw._process.emit("close", 0, null);

			await assert.rejects(
				p,
				(err) => {
					assert.ok(err.message.includes("signal=none"), `应包含 signal=none: ${err.message}`);
					return true;
				},
			);

			tw.kill();
		});

		test("error 事件中进程被替换时触发 stale 进程守卫", async () => {
			const tw = new TaskWorker({
				binary: SQLite3BinaryFile,
				database: ":memory:",
				statementTimeout: 30000,
				name: "tw-stale-error",
			});
			const proc = tw._process;

			// 阻止 kill 移除事件监听器，模拟旧 listener 残留
			const origRemoveAll = proc.removeAllListeners.bind(proc);
			proc.removeAllListeners = () => proc;

			tw.kill(); // #proc → null, 但 error/close 监听器仍在

			// 在旧进程上触发 error → #processManager.process === null !== proc → 守卫 return
			// 守卫返回后不会 rejectAll（防止双重重拒绝）
			proc.emit("error", new Error("stale process error"));

			// 恢复清理
			proc.removeAllListeners = origRemoveAll;
			proc.removeAllListeners();
		});

		test("close 事件中进程被替换时触发 stale 进程守卫", async () => {
			const tw = new TaskWorker({
				binary: SQLite3BinaryFile,
				database: ":memory:",
				statementTimeout: 30000,
				name: "tw-stale-close",
			});
			const proc = tw._process;

			const origRemoveAll = proc.removeAllListeners.bind(proc);
			proc.removeAllListeners = () => proc;

			tw.kill();

			proc.emit("close", 0, null);

			proc.removeAllListeners = origRemoveAll;
			proc.removeAllListeners();
		});
	});

	describe("超时", () => {
		test("超时只拒绝超时任务，其他 inflight 任务正常完成", { timeout: 30000 }, async () => {
			// sweep timer 默认 100ms，将超时检测延迟最多 100ms。
			// 为加速测试，使用短 sweepInterval (5ms) 配合 5MB blob，
			// 确保 sweep 在 SQL 完成前检测到 10ms timeout。
			const tw = new TaskWorker({
				binary: SQLite3BinaryFile,
				database: ":memory:",
				statementTimeout: 30000,
				name: "tw-timeout",
				sweepInterval: 5,
			});

			const p1 = new Promise((resolve, reject) => {
				tw.enqueue({
					kind: "execute",
					sql: "SELECT randomblob(5000000)",
					timeout: 10,
					token: "tok-to-1",
					onRow: null,
					resolve,
					reject,
				});
			});

			const p2 = new Promise((resolve, reject) => {
				tw.enqueue({
					kind: "query",
					sql: "SELECT 1 AS v",
					timeout: 30000,
					token: "tok-to-2",
					onRow: null,
					resolve,
					reject,
				});
			});

			const p3 = new Promise((resolve, reject) => {
				tw.enqueue({
					kind: "query",
					sql: "SELECT 2 AS v",
					timeout: 30000,
					token: "tok-to-3",
					onRow: null,
					resolve,
					reject,
				});
			});

			const results = await Promise.allSettled([p1, p2, p3]);

			assert.equal(results[0].status, "rejected", "t1 应超时");
			assert.ok(results[0].reason.message.includes("timed out"), `t1 错误应为超时: ${results[0].reason.message}`);
			assert.equal(results[1].status, "fulfilled", "t2 应正常完成");
			assert.deepEqual(results[1].value, [{ v: 1 }], "t2 结果正确");
			assert.equal(results[2].status, "fulfilled", "t3 应正常完成");
			assert.deepEqual(results[2].value, [{ v: 2 }], "t3 结果正确");

			tw.kill();
		});
	});

	describe("Metrics 集成", () => {
		test("传入 metrics 后 enqueue 递增指标", async () => {
			const metrics = new Metrics();
			const tw = new TaskWorker({
				binary: SQLite3BinaryFile,
				database: ":memory:",
				statementTimeout: 30000,
				name: "tw-metrics",
				metrics,
			});
			try {
				await new Promise((resolve, reject) => {
					tw.enqueue({
						kind: "query",
						sql: "SELECT 1 AS v",
						timeout: 10000,
						token: "tok-metrics",
						onRow: null,
						resolve,
						reject,
					});
				});
				// enqueue 时 metrics.incrementTasksTotal 被调用
				assert.equal(metrics.tasksTotal, 1);
				assert.equal(metrics.queryCount, 1);
			} finally {
				tw.kill();
			}
		});
	});

	describe("JSON 解析错误", () => {
		test("stdout 输出非 JSON 数据触发 rejectAll", async () => {
			const tw = new TaskWorker({
				binary: SQLite3BinaryFile,
				database: ":memory:",
				statementTimeout: 30000,
				name: "tw-json-err",
			});

			const p = new Promise((resolve, reject) => {
				tw.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 10000,
					token: "tok-json-err",
					onRow: null,
					resolve,
					reject,
				});
			});

			// 在 sqlite3 进程回应之前向 stdout 注入非法 JSON
			tw._process.stdout.emit("data", "{invalid}");

			await assert.rejects(p, /Invalid JSON from sqlite3/);
			tw.kill();
		});
	});

	describe("流式查询 consumerError", () => {
		test("stream onRow 抛出异常触发立即 reject", async () => {
			const tw = new TaskWorker({
				binary: SQLite3BinaryFile,
				database: ":memory:",
				statementTimeout: 30000,
				name: "tw-consumer-err",
			});

			const p = new Promise((resolve, reject) => {
				tw.enqueue({
					kind: "stream",
					sql: "SELECT 1 AS v UNION SELECT 2 AS v",
					timeout: 10000,
					token: "tok-consumer",
					onRow: () => { throw new Error("consumer broke"); },
					resolve,
					reject,
				});
			});

			await assert.rejects(p, /consumer broke/);
			tw.kill();
		});
	});

	describe("并发与压力", () => {
		test("200 并发突袭 INSERT 不产生 UNIQUE 冲突", async () => {
			await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "execute",
					sql: "CREATE TABLE IF NOT EXISTS burst_worker (id INTEGER PRIMARY KEY, val TEXT)",
					timeout: 30000,
					token: "tok-bw-setup",
					onRow: null,
					resolve,
					reject,
				});
			});

			const promises = [];
			for (let i = 0; i < 200; i++) {
				promises.push(new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "execute",
						sql: `INSERT INTO burst_worker (id, val) VALUES (${i}, 'w${i}')`,
						timeout: 30000,
						token: `tok-bw-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}));
			}
			await Promise.all(promises);

			const rows = await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT id, val FROM burst_worker ORDER BY id",
					timeout: 30000,
					token: "tok-bw-check",
					onRow: null,
					resolve,
					reject,
				});
			});

			assert.equal(rows.length, 200, "200 条应全部写入");
			for (let i = 0; i < 200; i++) {
				assert.equal(rows[i].id, i, `id=${i}`);
				assert.equal(rows[i].val, `w${i}`, `val=w${i}`);
			}
		});
	});
});
