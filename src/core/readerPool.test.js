import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { ReaderPool } from "./readerPool.js";
import downloadSQLite3 from "../../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..", "..");
const SQLite3BinaryFile = path.join(root, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));

/* eslint-disable no-underscore-dangle */

/**
 * @type {ReaderPool}
 */
let pool;

beforeEach(async () => {
	await downloadSQLite3();
	pool = new ReaderPool({
		binary: SQLite3BinaryFile,
		database: ":memory:",
		poolSize: 2,
		statementTimeout: 30000,
	});
});

afterEach(async () => {
	pool.kill();
});

describe("ReaderPool", () => {
	describe("基本功能", () => {
		test("正确创建指定数量的 reader", () => {
			assert.equal(pool.size, 2);
		});

		test("pendingStatements 返回所有 worker 待处理任务数", async () => {
			assert.equal(pool.pendingStatements, 0);
			let deferredResolve;
			const p = new Promise((resolve) => { deferredResolve = resolve; });
			pool.enqueue({
				kind: "query",
				sql: "SELECT 1",
				timeout: 10000,
				token: "ps-tok",
				onRow: null,
				resolve: deferredResolve,
				reject: deferredResolve,
			});
			assert.equal(pool.pendingStatements, 1);
			// 确保 worker 资源被释放，否则后续测试可能受影响
			const worker = pool._workers.find(w => w.pendingStatements > 0);
			worker?.kill();
		});

		test("poolSize=0 抛 RangeError", () => {
			assert.throws(
				() => new ReaderPool({
					binary: SQLite3BinaryFile,
					database: ":memory:",
					poolSize: 0,
					statementTimeout: 30000,
				}),
				/RangeError/,
			);
		});

		test("least-busy 分发任务: 同步负载均衡", () => {
			// 同步入队 4 个任务，验证 least-busy 策略将任务均匀分到 2 个 worker
			// 预期: task1→w0, task2→w1, task3→w0, task4→w1 → 各 2 个
			const promises = [];
			for (let i = 0; i < 4; i++) {
				promises.push(new Promise((resolve, reject) => {
					pool.enqueue({
						kind: "query",
						sql: `SELECT ${i} AS v`,
						timeout: 10000,
						token: `lb-tok-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}));
			}
			assert.equal(pool._workers[0].pendingStatements, 2);
			assert.equal(pool._workers[1].pendingStatements, 2);
			return Promise.all(promises);
		});

		test("least-busy 优先选择负载低的 worker", () => {
			const noop = () => {};
			// 先入队 1 个任务 → w0（负载相同，rrIndex=0 选 w0）
			pool.enqueue({
				kind: "query",
				sql: "SELECT 1",
				timeout: 10000,
				token: "lb-priority-1",
				onRow: null,
				resolve: noop,
				reject: noop,
			});
			// w0 负载 1，w1 负载 0
			assert.equal(pool._workers[0].pendingStatements, 1);
			assert.equal(pool._workers[1].pendingStatements, 0);

			// 再入队 → w0 负载 1，w1 负载 0，应选 w1
			pool.enqueue({
				kind: "query",
				sql: "SELECT 2",
				timeout: 10000,
				token: "lb-priority-2",
				onRow: null,
				resolve: noop,
				reject: noop,
			});
			assert.equal(pool._workers[0].pendingStatements, 1);
			assert.equal(pool._workers[1].pendingStatements, 1);
		});

		test("least-busy 多个候选负载相同时 round-robin 选", () => {
			const noop = () => {};
			// 入队 2 个任务使各 worker 负载均为 1
			pool.enqueue({
				kind: "query",
				sql: "SELECT 1", timeout: 10000, token: "lb-multi-1",
				onRow: null, resolve: noop, reject: noop,
			});
			pool.enqueue({
				kind: "query",
				sql: "SELECT 2", timeout: 10000, token: "lb-multi-2",
				onRow: null, resolve: noop, reject: noop,
			});
			// 各 worker 负载均为 1
			assert.equal(pool._workers[0].pendingStatements, 1);
			assert.equal(pool._workers[1].pendingStatements, 1);

			// 第 3 个任务: 负载相同（各 1），rrIndex 在上一次入队后为 2 → candidates[2%2]=0 → 选 w0
			pool.enqueue({
				kind: "query",
				sql: "SELECT 3", timeout: 10000, token: "lb-multi-3",
				onRow: null, resolve: noop, reject: noop,
			});
			assert.equal(pool._workers[0].pendingStatements, 2);
			assert.equal(pool._workers[1].pendingStatements, 1);
		});

		test("并发执行多个查询", async () => {
			const promises = [];
			for (let i = 0; i < 6; i++) {
				promises.push(
					new Promise((resolve, reject) => {
						pool.enqueue({
							kind: "query",
							sql: `SELECT ${i} AS v`,
							timeout: 10000,
							token: `con-tok-${i}`,
							onRow: null,
							resolve,
							reject,
						});
					}),
				);
			}
			const all = await Promise.all(promises);
			const vals = all.map((r) => r[0].v);
			assert.deepEqual(vals, [0, 1, 2, 3, 4, 5]);
		});
	});

	describe("生命周期管理", () => {
		test("kill 后拒绝待处理任务", async () => {
			const p = new Promise((resolve, reject) => {
				pool.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 10000,
					token: "kill-tok",
					onRow: null,
					resolve,
					reject,
				});
			});
			pool.kill();
			await assert.rejects(p, /killed/i);
		});

		test("reader 进程异常退出后拒绝待处理任务", async () => {
			const worker = pool._workers[0];
			worker._process.stdout.removeAllListeners("data");
			const p = new Promise((resolve, reject) => {
				pool.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 30000,
					token: "crash-tok",
					onRow: null,
					resolve,
					reject,
				});
			});
			// Windows 不支持信号名 "SIGKILL"，用信号号 9（在所有平台上皆可用）
			worker._process.kill(9);
			await assert.rejects(p, /exited unexpectedly/);
		});
	});
});
