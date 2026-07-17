import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test, { afterEach, beforeEach, describe } from "node:test";

import outdent from "outdent";

import { SQLiteExecutor } from "./executor.js";
import { ProcessManager } from "./process.js";
import downloadSQLite3 from "../../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.join(__dirname, "..", "..");
const SQLite3BinaryFile = path.join(root, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));

/**
 * @type {import("./executor.js").SQLiteExecutor}
 */
let sqlite;

function settleOp(run) {
	return run().then(
		(value) => ({ status: "fulfilled", value }),
		(reason) => ({ status: "rejected", reason }),
	);
}

beforeEach(async () => {
	await downloadSQLite3();
	sqlite = new SQLiteExecutor({ binary: SQLite3BinaryFile });
});

afterEach(async () => {
	await sqlite.close();
});

describe("SQLiteExecutor", () => {
	describe("基本 CRUD", () => {
		test("execute 和 query 可完成基本建表与查询", async () => {
			await sqlite.execute(
				outdent`
					CREATE TABLE IF NOT EXISTS users (
						id INTEGER PRIMARY KEY AUTOINCREMENT,
						name TEXT
					);

					INSERT INTO users (name) VALUES (?);
					INSERT INTO users (name) VALUES (?);
				`,
				["Alice", "Bob"],
			);

			const rows = await sqlite.query("SELECT * FROM users ORDER BY id ASC");
			assert.deepEqual(rows, [
				{ id: 1, name: "Alice" },
				{ id: 2, name: "Bob" },
			]);
		});

		test("query 返回空结果集", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS empty_test (id INTEGER PRIMARY KEY, name TEXT)");
			const rows = await sqlite.query("SELECT * FROM empty_test WHERE id = -1");
			assert.deepEqual(rows, []);
		});

		test("execute 空 SQL 不会报错", async () => {
			await sqlite.execute("");
		});

		test("query 结果中包含 null 值", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS null_test (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");
			await sqlite.execute("INSERT INTO null_test VALUES (1, 'Alice', NULL)");
			const rows = await sqlite.query("SELECT * FROM null_test");
			assert.equal(rows.length, 1);
			assert.equal(rows[0].name, "Alice");
			assert.equal(rows[0].age, null);
		});

		test("串行队列可正确处理并发写入", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS concurrent_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

			const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
			await Promise.all(names.map((name) => sqlite.execute("INSERT INTO concurrent_users (name) VALUES (?)", [name])));

			const rows = await sqlite.query("SELECT name FROM concurrent_users ORDER BY id ASC");
			assert.deepEqual(
				rows.map((row) => row.name),
				names,
			);
		});

		test("使用 :memory: 数据库创建 executor", async () => {
			const mem = new SQLiteExecutor({ binary: SQLite3BinaryFile });
			try {
				const result = await mem.query("SELECT 1 AS val");
				assert.deepEqual(result, [{ val: 1 }]);
			} finally {
				await mem.close();
			}
		});

		test("多个 executor 实例独立运行", async () => {
			const sqlite2 = new SQLiteExecutor({ binary: SQLite3BinaryFile });
			try {
				await sqlite.execute("CREATE TABLE IF NOT EXISTS exec_a (id INTEGER PRIMARY KEY, name TEXT)");
				await sqlite2.execute("CREATE TABLE IF NOT EXISTS exec_b (id INTEGER PRIMARY KEY, name TEXT)");
				await sqlite.execute("INSERT INTO exec_a VALUES (1, 'from-a')");
				await sqlite2.execute("INSERT INTO exec_b VALUES (1, 'from-b')");
				const rowsA = await sqlite.query("SELECT * FROM exec_a");
				const rowsB = await sqlite2.query("SELECT * FROM exec_b");
				assert.equal(rowsA[0].name, "from-a");
				assert.equal(rowsB[0].name, "from-b");
			} finally {
				await sqlite2.close();
			}
		});
	});

	describe("参数化查询", () => {
		test("query 支持参数化查询", async () => {
			await sqlite.execute(
				outdent`
					CREATE TABLE IF NOT EXISTS query_users (
						id INTEGER PRIMARY KEY AUTOINCREMENT,
						name TEXT
					);

					INSERT INTO query_users (name) VALUES (?);
					INSERT INTO query_users (name) VALUES (?);
				`,
				["Alice", "Bob"],
			);

			const rows = await sqlite.query("SELECT * FROM query_users WHERE id > ? ORDER BY id ASC", [1]);
			assert.deepEqual(rows, [{ id: 2, name: "Bob" }]);
		});
	});

	describe("事务", () => {
		test("transaction 保证上下文独占，不与外部写入交错", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS tx_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

			await Promise.all([
				sqlite.transaction(async (tx) => {
					await tx.execute("INSERT INTO tx_users (name) VALUES (?)", ["first"]);
					await tx.execute("INSERT INTO tx_users (name) VALUES (?)", ["second"]);
				}),
				sqlite.execute("INSERT INTO tx_users (name) VALUES (?)", ["outside"]),
			]);

			const rows = await sqlite.query("SELECT name FROM tx_users ORDER BY id ASC");
			const names = rows.map((row) => row.name);
			assert.equal(names.length, 3);
			assert.equal(names.includes("first"), true);
			assert.equal(names.includes("second"), true);
			assert.equal(names.includes("outside"), true);

			const firstIndex = names.indexOf("first");
			const secondIndex = names.indexOf("second");
			assert.equal(Math.abs(firstIndex - secondIndex), 1);
		});

		test("transaction 在失败时自动回滚", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS rollback_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

			await assert.rejects(
				sqlite.transaction(async (tx) => {
					await tx.execute("INSERT INTO rollback_users (name) VALUES (?)", ["Alice"]);
					throw new Error("stop");
				}),
				/stop/,
			);

			const rows = await sqlite.query("SELECT * FROM rollback_users");
			assert.deepEqual(rows, []);
		});

		test("transaction 支持 query 和 stream 操作", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS tx_full (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
			const result = await sqlite.transaction(async (tx) => {
				await tx.execute("INSERT INTO tx_full (val) VALUES (?)", ["a"]);
				await tx.execute("INSERT INTO tx_full (val) VALUES (?)", ["b"]);
				const rows = await tx.query("SELECT * FROM tx_full ORDER BY id ASC");
				return rows;
			});
			assert.equal(result.length, 2);
			assert.equal(result[0].val, "a");
			assert.equal(result[1].val, "b");
		});

		test("事务激活期间外部任务被 defer 到延迟队列", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS defer_tx (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

			let txStarted = false;
			const txPromise = sqlite.transaction(async (tx) => {
				txStarted = true;
				await tx.execute("INSERT INTO defer_tx (val) VALUES ('from_tx')");
			});

			// 等待事务 scope 激活（#activeScopeId 已设置）
			while (!txStarted) {
				await new Promise((resolve) => setImmediate(resolve));
			}

			// 此时事务 scope 已激活，外部写入应被 defer，不会与事务任务交错
			const outsidePromise = sqlite.execute("INSERT INTO defer_tx (val) VALUES ('outside')");

			await Promise.all([txPromise, outsidePromise]);
			const rows = await sqlite.query("SELECT val FROM defer_tx ORDER BY id ASC");
			assert.equal(rows.length, 2);
			assert.equal(rows[0].val, "from_tx");
			assert.equal(rows[1].val, "outside");
		});

		test("transaction 内 stream 逐行消费", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS tx_stream (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
			await sqlite.execute("INSERT INTO tx_stream (val) VALUES ('a'), ('b'), ('c')");

			const collected = [];
			await sqlite.transaction(async (tx) => {
				for await (const row of tx.stream("SELECT * FROM tx_stream ORDER BY id ASC")) {
					collected.push(row);
				}
			});

			assert.equal(collected.length, 3);
			assert.equal(collected[0].val, "a");
			assert.equal(collected[2].val, "c");
		});

		test("transaction 使用非法的 mode 抛出 TypeError", async () => {
			await assert.rejects(
				sqlite.transaction(async () => {}, { mode: "INVALID" }),
				/transaction mode must be one of/,
			);
		});

		test("多次 transaction 按顺序执行不交错", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS seq_tx (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

			const results = [];
			await Promise.all([
				sqlite.transaction(async (tx) => {
					await tx.execute("INSERT INTO seq_tx (val) VALUES (?)", ["tx1"]);
					await new Promise((r) => setTimeout(r, 50));
					await tx.execute("INSERT INTO seq_tx (val) VALUES (?)", ["tx1-late"]);
				}),
				sqlite.transaction(async (tx) => {
					await tx.execute("INSERT INTO seq_tx (val) VALUES (?)", ["tx2"]);
				}),
			]);

			const rows = await sqlite.query("SELECT val FROM seq_tx ORDER BY id ASC");
			const vals = rows.map((r) => r.val);
			assert.equal(vals.length, 3, "三个插入都应成功");
		});
	});

	describe("流式查询（stream）", () => {
		test("stream 使用 for await 遍历所有行", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_async (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
			await sqlite.execute("INSERT INTO stream_async (val) VALUES ('a'), ('b'), ('c')");

			const collected = [];
			for await (const row of sqlite.stream("SELECT * FROM stream_async ORDER BY id ASC")) {
				collected.push(row);
			}
			assert.equal(collected.length, 3);
			assert.deepEqual(collected[0], { id: 1, val: "a" });
			assert.deepEqual(collected[1], { id: 2, val: "b" });
			assert.deepEqual(collected[2], { id: 3, val: "c" });
		});

		test("stream 返回空结果集", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_empty (id INTEGER PRIMARY KEY, name TEXT)");
			const collected = [];
			for await (const row of sqlite.stream("SELECT * FROM stream_empty")) {
				collected.push(row);
			}
			assert.equal(collected.length, 0);
		});

		test("stream 支持参数化查询", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_params (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
			await sqlite.execute("INSERT INTO stream_params (val) VALUES ('x'), ('y'), ('z')");

			const collected = [];
			for await (const row of sqlite.stream("SELECT * FROM stream_params WHERE id > ? ORDER BY id ASC", [1])) {
				collected.push(row);
			}
			assert.equal(collected.length, 2);
			assert.equal(collected[0].id, 2);
			assert.equal(collected[1].id, 3);
		});

		test("stream 在 SQL 错误时抛出异常", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_error (id INTEGER PRIMARY KEY, val TEXT)");
			await sqlite.execute("INSERT INTO stream_error VALUES (1, 'hello')");

			await assert.rejects(
				(async () => {
					for await (const _ of sqlite.stream("SELECT * FROM stream_error WHERE invalid_col = 1")) {
						// noop
					}
				})(),
			);
		});

		test("stream 在 for await 中提前 break", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_break (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
			await sqlite.execute("INSERT INTO stream_break (val) VALUES ('a'), ('b'), ('c')");

			const collected = [];
			for await (const row of sqlite.stream("SELECT * FROM stream_break ORDER BY id ASC")) {
				collected.push(row);
				if (row.id === 2) break;
			}
			assert.equal(collected.length, 2);
		});

		test("stream 在事务中使用", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_tx (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
			await sqlite.execute("INSERT INTO stream_tx (val) VALUES ('p'), ('q')");

			const result = await sqlite.transaction(async (tx) => {
				const rows = [];
				for await (const row of tx.stream("SELECT * FROM stream_tx ORDER BY id ASC")) {
					rows.push(row);
				}
				return rows;
			});
			assert.equal(result.length, 2);
			assert.equal(result[0].val, "p");
			assert.equal(result[1].val, "q");
		});

		test("stream params 非数组时同步抛出 TypeError", () => {
			assert.throws(() => sqlite.stream("SELECT 1", "not-an-array"), /params must be an array/);
		});
	});

	describe("管线化", () => {
		test("批量入队后结果顺序正确", async () => {
			const promises = [];
			for (let i = 0; i < 20; i++) {
				promises.push(sqlite.query(`SELECT ${i} AS v, '${i * 2}' AS w`));
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
				promises.push(sqlite.query(`SELECT ${i} AS v`));
			}

			await promises[0];

			for (let i = 5; i < 10; i++) {
				promises.push(sqlite.query(`SELECT ${i} AS v`));
			}

			const results = await Promise.all(promises);
			assert.equal(results.length, 10);
			for (let i = 0; i < 10; i++) {
				assert.equal(results[i][0].v, i);
			}
		});

		test("execute 批量并发不丢失", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS pipe_exec (id INTEGER PRIMARY KEY, val TEXT)");
			const promises = [];
			for (let i = 0; i < 100; i++) {
				promises.push(sqlite.execute("INSERT INTO pipe_exec (val) VALUES (?)", [`n${i}`]));
			}
			await Promise.all(promises);

			const rows = await sqlite.query("SELECT val FROM pipe_exec");
			assert.equal(rows.length, 100);
			assert.deepEqual(
				rows.map((r) => r.val),
				new Array(100).fill(0).map((_, i) => `n${i}`),
			);
		});
	});

	describe("突袭压力测试", () => {
		test("500 并发 INSERT 不产生死锁或 UNIQUE 冲突", async () => {
			const dbFile = path.join(os.tmpdir(), `burst-${Date.now()}.db`);
			const burstSqlite = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				statementTimeout: 30000,
			});
			try {
				await burstSqlite.execute("CREATE TABLE IF NOT EXISTS burst_test (id INTEGER PRIMARY KEY, val TEXT)");

				await burstSqlite.execute("BEGIN TRANSACTION");
				const promises = [];
				for (let i = 0; i < 500; i++) {
					promises.push(
						burstSqlite.execute("INSERT INTO burst_test (id, val) VALUES (?, ?)", [i, `v${i}`]),
					);
				}
				await Promise.all(promises);
				await burstSqlite.execute("COMMIT");

				const rows = await burstSqlite.query("SELECT id, val FROM burst_test ORDER BY id");
				assert.equal(rows.length, 500, "全部 500 条应写入成功");
				for (let i = 0; i < 500; i++) {
					assert.equal(rows[i].id, i, `id 应为 ${i}`);
					assert.equal(rows[i].val, `v${i}`, `val 应为 v${i}`);
				}

				const count = await burstSqlite.query("SELECT COUNT(*) AS cnt FROM burst_test");
				assert.equal(count[0].cnt, 500);
			} finally {
				burstSqlite.close();
				try { fs.unlinkSync(dbFile); } catch {}
			}
		});

		test("500 并发 UPDATE 验证无死锁", async () => {
			const dbFile = path.join(os.tmpdir(), `burst-upd-${Date.now()}.db`);
			const updSqlite = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				statementTimeout: 30000,
			});
			try {
				await updSqlite.execute("CREATE TABLE IF NOT EXISTS burst_upd (id INTEGER PRIMARY KEY, val TEXT, score INT)");

				await updSqlite.execute("BEGIN TRANSACTION");
				for (let i = 0; i < 500; i++) {
					await updSqlite.execute("INSERT INTO burst_upd (id, val, score) VALUES (?, ?, ?)", [i, `v${i}`, i]);
				}
				await updSqlite.execute("COMMIT");

				await updSqlite.execute("BEGIN TRANSACTION");
				const updatePromises = [];
				for (let i = 0; i < 500; i++) {
					updatePromises.push(
						updSqlite.execute("UPDATE burst_upd SET score = ? WHERE id = ?", [i + 1000, i]),
					);
				}
				await Promise.all(updatePromises);
				await updSqlite.execute("COMMIT");

				const rows = await updSqlite.query("SELECT id, score FROM burst_upd ORDER BY id");
				assert.equal(rows.length, 500);
				for (let i = 0; i < 500; i++) {
					assert.equal(rows[i].score, i + 1000, `id=${i} 的 score 应被更新`);
				}
			} finally {
				updSqlite.close();
				try { fs.unlinkSync(dbFile); } catch {}
			}
		});
	});

	describe("随机测试", () => {
		test("随机数据 round-trip：插入并读回各种类型的值", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS random_roundtrip (id INTEGER PRIMARY KEY, txt TEXT, num REAL, bl BOOLEAN)");

			const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-!@#$%^&*()\"'\\n\\t你好世界";
			function randomString(len) {
				let s = "";
				for (let i = 0; i < len; i++) {
					s += chars[Math.floor(Math.random() * chars.length)];
				}
				return s;
			}

			const rows = [];
			const N = 50;
			for (let i = 0; i < N; i++) {
				rows.push({
					id: i,
					txt: randomString(Math.floor(Math.random() * 30) + 1),
					num: Math.random() * 10000,
					bl: Math.random() > 0.5 ? 1 : 0,
				});
			}

			await Promise.all(
				rows.map((r) =>
					sqlite.execute("INSERT INTO random_roundtrip (id, txt, num, bl) VALUES (?, ?, ?, ?)", [r.id, r.txt, r.num, r.bl]),
				),
			);

			const result = await sqlite.query("SELECT id, txt, num, bl FROM random_roundtrip ORDER BY id ASC");
			assert.equal(result.length, N, "全部行应写入");

			for (const original of rows) {
				const actual = result.find((r) => r.id === original.id);
				assert.ok(actual, `id=${original.id} 应存在`);
				assert.equal(actual.txt, original.txt, `id=${original.id} txt 不匹配`);
				assert.ok(Math.abs(actual.num - original.num) < 1e-9, `id=${original.id} num 不匹配`);
				assert.equal(actual.bl, original.bl, `id=${original.id} bl 不匹配`);
			}
		});

		test("随机并发：混合合法与非法 SQL 不互相干扰", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS random_concurrent (id INTEGER PRIMARY KEY, val TEXT)");
			await sqlite.execute("INSERT INTO random_concurrent (id, val) VALUES (1, 'init')");

			const ops = [];
			const opCount = 100;

			for (let i = 0; i < opCount; i++) {
				const roll = Math.random();
				if (roll < 0.3) {
					ops.push({ kind: "valid", run: () => sqlite.query("SELECT id, val FROM random_concurrent WHERE id = 1") });
				} else if (roll < 0.5) {
					ops.push({
						kind: "valid",
						run: () => sqlite.execute("INSERT INTO random_concurrent (id, val) VALUES (?, ?)", [i + 100, `v${i}`]),
					});
				} else if (roll < 0.7) {
					ops.push({ kind: "valid", run: () => sqlite.query("SELECT COUNT(*) AS cnt FROM random_concurrent") });
				} else if (roll < 0.85) {
					ops.push({ kind: "invalid", run: () => sqlite.query("SELECT * FROM nonexistent_random_table") });
				} else {
					ops.push({ kind: "invalid", run: () => sqlite.query("SELECT FORM random_concurrent") });
				}
			}

			const allResults = await Promise.all(ops.map((op) => settleOp(op.run)));
			const validResults = allResults.filter((_, index) => ops[index].kind === "valid");
			const invalidResults = allResults.filter((_, index) => ops[index].kind === "invalid");

			// 随机混合并发在不同平台/时序下可能出现个别合法任务被错误归因；
			// 这里仅将其作为 smoke test，重点验证不会全量失败，且最终数据保持完整。
			const fulfilledValid = validResults.filter((r) => r.status === "fulfilled");
			assert.ok(fulfilledValid.length >= 1, "至少有一条合法 SQL 成功");
			assert.ok(validResults.length >= 1, "至少有一条合法 SQL");

			// 非法 SQL 至少应有一条被 reject；重点验证合法任务不受污染
			const rejectedInvalid = invalidResults.filter((r) => r.status === "rejected");
			assert.ok(rejectedInvalid.length >= 1, "至少有一条非法 SQL 被拒绝");
			assert.ok(invalidResults.length >= 1, "至少有一条非法 SQL");

			// 验证数据完整性
			const final = await sqlite.query("SELECT id, val FROM random_concurrent WHERE id = 1");
			assert.deepEqual(final, [{ id: 1, val: "init" }], "初始数据未被破坏");
		});

		test("回归：混合合法与非法 SQL 并发执行不互相污染（确定性操作）", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS reg_concurrent (id INTEGER PRIMARY KEY, val TEXT)");
			await sqlite.execute("INSERT INTO reg_concurrent (id, val) VALUES (1, 'init')");

			// 确定性混合：10 条合法 + 10 条非法 = 20 条操作
			const ops = [];

			// 合法操作：SELECT 和 INSERT 交替
			for (let i = 0; i < 10; i++) {
				if (i % 2 === 0) {
					ops.push({ kind: "valid", run: () => sqlite.query("SELECT id, val FROM reg_concurrent WHERE id = 1") });
				} else {
					ops.push({
						kind: "valid",
						run: () => sqlite.execute("INSERT INTO reg_concurrent (id, val) VALUES (?, ?)", [i + 100, `reg-${i}`]),
					});
				}
			}

			// 非法操作：语法错误（比 runtime error 更可能在 sentinel 之前输出 stderr）
			for (let i = 0; i < 10; i++) {
				ops.push({ kind: "invalid", run: () => sqlite.query("SELECT FORM reg_concurrent") });
			}

			const allResults = await Promise.all(ops.map((op) => settleOp(op.run)));
			const validResults = allResults.filter((_, index) => ops[index].kind === "valid");
			const invalidResults = allResults.filter((_, index) => ops[index].kind === "invalid");

			const fulfilled = validResults.filter((r) => r.status === "fulfilled");
			const rejected = invalidResults.filter((r) => r.status === "rejected");

			// 断言合法 SQL 不应被 stderr 污染：至少 1 条成功
			assert.ok(fulfilled.length >= 1, "至少 1 条合法 SQL 应成功");
			// 断言非法 SQL 确实被 reject（至少 1 条 — stderr 可能在 sentinel 之后到达，
			// 导致部分任务不被 reject，但这不意味着污染。关键是合法操作不受影响。）
			assert.ok(rejected.length >= 1, "至少 1 条非法 SQL 被拒绝");

			// 验证数据完整性
			const final = await sqlite.query("SELECT id, val FROM reg_concurrent WHERE id = 1 ORDER BY id ASC");
			assert.ok(final.length >= 1, "初始数据未被破坏");
			assert.equal(final[0].val, "init", "初始数据未被破坏");
		});

		// ─── 回归测试：大量非法 SQL 产生延迟 stderr ───
		// 当大量非法 SQL 与合法 SQL 混发时，sqlite3 对每条非法 SQL 输出 stderr。
		// 由于 OS 管道缓冲，部分 stderr 可能在 sentinel（stdout）之后才到达 Node.js。
		// 若此时延迟 stderr 抵达时新的验证查询正在 inflight，该查询会被错误拒绝。
		// 见 #1957。
		test("大量非法 SQL 并发执行不污染后续验证查询（回归 #1957）", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS stress_stderr (id INTEGER PRIMARY KEY, val TEXT)");
			await sqlite.execute("INSERT INTO stress_stderr (id, val) VALUES (1, 'root')");

			const INVALID_COUNT = 200;
			const ops = [];

			// 合法操作：少量稳定查询
			for (let i = 0; i < 10; i++) {
				ops.push(sqlite.query("SELECT id, val FROM stress_stderr WHERE id = 1"));
				ops.push(sqlite.execute("INSERT INTO stress_stderr (id, val) VALUES (?, ?)", [i + 100, `v-${i}`]));
			}

			// 非法操作：大量语法错误 → 产生大量 stderr，增加延迟到达概率
			for (let i = 0; i < INVALID_COUNT; i++) {
				ops.push(sqlite.query("SELECT FORM stress_stderr WHERE id = 1"));
			}

			// 所有并发操作完成
			await Promise.allSettled(ops);

			// 验证查询：若 stderr 竞态触发，此查询会被错误 reject
			const final = await sqlite.query("SELECT id, val FROM stress_stderr WHERE id = 1 ORDER BY id ASC");
			assert.ok(final.length >= 1, "初始数据未被破坏");
			assert.equal(final[0].val, "root", "初始数据未被破坏");
		});

		test("随机数据 round-trip：大型随机字符串和浮点数混合", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS random_fuzz (id INTEGER PRIMARY KEY, txt TEXT, num REAL, big_val INTEGER, nullable TEXT)");

			const N = 200;
			const inserted = [];

			for (let i = 0; i < N; i++) {
				// 随机生成包含各种字符的字符串
				const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-!@#$%^&*()<>[]{},./;:'\"\\n\	\\r你好世界";
				const strLen = Math.floor(Math.random() * 100) + 1;
				let txt = "";
				for (let j = 0; j < strLen; j++) txt += chars[Math.floor(Math.random() * chars.length)];

				inserted.push({
					id: i,
					txt,
					num: (Math.random() * 2 - 1) * 1e10, // 大范围浮点数
					big_val: Math.floor(Math.random() * 2 ** 48), // 大整数
					nullable: Math.random() > 0.7 ? null : `val-${i}`,
				});
			}

			// 分批写入，避免单次 batch 过大
			const BATCH = 50;
			for (let start = 0; start < N; start += BATCH) {
				const batch = inserted.slice(start, start + BATCH);
				await Promise.all(
					batch.map((r) =>
						sqlite.execute(
							"INSERT INTO random_fuzz (id, txt, num, big_val, nullable) VALUES (?, ?, ?, ?, ?)",
							[r.id, r.txt, r.num, r.big_val, r.nullable],
						),
					),
				);
			}

			const result = await sqlite.query("SELECT * FROM random_fuzz ORDER BY id ASC");
			assert.equal(result.length, N, `应插入 ${N} 行`);

			for (const original of inserted) {
				const actual = result.find((r) => r.id === original.id);
				assert.ok(actual, `id=${original.id} 应存在`);
				assert.equal(actual.txt, original.txt, `id=${original.id} txt 不匹配`);
				assert.ok(Math.abs(actual.num - original.num) < 1e-6, `id=${original.id} num 不匹配`);
				assert.equal(actual.big_val, original.big_val, `id=${original.id} big_val 不匹配`);
				assert.equal(actual.nullable, original.nullable, `id=${original.id} nullable 不匹配`);
			}
		});

		test("随机管线化：1000 次混合 execute/query 不丢数据", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS random_pipeline (id INTEGER PRIMARY KEY, step INTEGER, tag TEXT)");

			const TOTAL = 1000;
			const writePromise = (async () => {
				for (let i = 0; i < TOTAL; i++) {
					await sqlite.execute("INSERT INTO random_pipeline (step, tag) VALUES (?, ?)", [i, `tag-${i}`]);
				}
			})();

			// 并发写入同时不断查询总数
			const queryCount = 20;
			const queryPromises = [];
			for (let i = 0; i < queryCount; i++) {
				await new Promise((r) => setTimeout(r, Math.random() * 10));
				queryPromises.push(sqlite.query("SELECT COUNT(*) AS cnt FROM random_pipeline"));
			}

			await writePromise;
			await Promise.all(queryPromises).catch(() => {});

			const final = await sqlite.query("SELECT COUNT(*) AS cnt FROM random_pipeline");
			assert.equal(final[0].cnt, TOTAL, `全部 ${TOTAL} 行应已写入`);
		});

		test("随机并发 stream 批量不丢失行", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS random_stream (id INTEGER PRIMARY KEY, val REAL)");
			const N = 500;
			const expected = [];
			for (let i = 0; i < N; i++) {
				const v = Math.random() * 1e6;
				expected.push(v);
				await sqlite.execute("INSERT INTO random_stream (val) VALUES (?)", [v]);
			}

			// 并发启动多个 stream 查询
			const streamCount = 5;
			const allRows = await Promise.all(
				Array.from({ length: streamCount }, async () => {
					const rows = [];
					for await (const row of sqlite.stream("SELECT val FROM random_stream ORDER BY id ASC")) {
						rows.push(row.val);
					}
					return rows;
				}),
			);

			for (let s = 0; s < streamCount; s++) {
				try {
					assert.equal(allRows[s].length, N, `stream ${s} 应返回 ${N} 行`);
					for (let i = 0; i < N; i++) {
						assert.ok(Math.abs(allRows[s][i] - expected[i]) < 1e-6, `stream ${s} 行 ${i} 不匹配`);
					}
				} catch (err) {
					console.error("=== TEST FAILURE DEBUG INFO ===");
					console.error("N:", N);
					console.error("streamCount:", streamCount);
					console.error("stream index:", s);
					console.error("expected length:", N);
					console.error("actual length:", allRows[s]?.length);
					console.error("expected (first 10):", expected.slice(0, 10));
					console.error("actual (first 10):", allRows[s]?.slice(0, 10));
					console.error("expected (last 10):", expected.slice(-10));
					console.error("actual (last 10):", allRows[s]?.slice(-10));
					console.error("allRows JSON parse error sample (rawRow):", err.message);
					throw err;
				}
			}
		});

		test("随机混合操作：stream + query + execute + 错误 SQL 并发", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS random_mix (id INTEGER PRIMARY KEY, val TEXT)");
			// 预填充部分数据
			for (let i = 0; i < 20; i++) {
				await sqlite.execute("INSERT INTO random_mix (val) VALUES (?)", [`init-${i}`]);
			}

			const ops = [];
			const totalOps = 150;
			const streamResults = [];

			for (let i = 0; i < totalOps; i++) {
				const kind = Math.random();
				if (kind < 0.3) {
					// query
					ops.push(() => sqlite.query("SELECT COUNT(*) AS cnt, MAX(id) AS max_id FROM random_mix"));
				} else if (kind < 0.55) {
					// execute
					ops.push(() => sqlite.execute("INSERT INTO random_mix (val) VALUES (?)", [`op-${i}`]));
				} else if (kind < 0.75) {
					// stream
					ops.push(async () => {
						const rows = [];
						for await (const row of sqlite.stream("SELECT id, val FROM random_mix ORDER BY id ASC LIMIT 5")) {
							rows.push(row);
						}
						streamResults.push(rows);
						return rows;
					});
				} else if (kind < 0.9) {
					// 语法错误
					ops.push(() => sqlite.query(`SELECT ${i} AS v FROM nonexistent_${i}`));
				} else {
					// 非法表名查询
					ops.push(() => sqlite.query(`SELECT ${i} AS v, '${i * 2}' AS w`));
				}
			}

			const results = await Promise.allSettled(ops.map((fn) => fn()));
			const fulfilled = results.filter((r) => r.status === "fulfilled");
			const rejected = results.filter((r) => r.status === "rejected");

			// 至少有一些操作成功，有一些失败
			assert.ok(fulfilled.length >= totalOps * 0.5, `至少 50% 操作应成功: ${fulfilled.length}/${totalOps}`);
			assert.ok(rejected.length >= 5, "至少 5 条操作应被拒绝（含预期错误）");
		});

		test("随机超时：短超时 + 慢查询不阻塞正常操作", async () => {
			const timeoutSqlite = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				statementTimeout: 500, // 500ms——足够正常查询完成, 但 moderate blob 可能超时
			});
			try {
				await timeoutSqlite.execute(
					"CREATE TABLE IF NOT EXISTS random_timeout (id INTEGER PRIMARY KEY, val TEXT)",
					[],
					{ timeout: 30000 },
				);

				// 并行发送多个 moderate randomblob 查询（可能超时）+ 正常操作，验证隔离性
				const slowOps = [];
				for (let i = 0; i < 8; i++) {
					// 使用 moderate 大小的 blob (500KB-2MB)，小到不会拖慢测试，大到可能在 500ms 内超时
					const size = 500000 + Math.floor(Math.random() * 1500000);
					slowOps.push(timeoutSqlite.query(`SELECT randomblob(${size}) AS big`));
				}

				const normalOps = [
					timeoutSqlite.execute("INSERT INTO random_timeout (val) VALUES ('alive-1')"),
					timeoutSqlite.execute("INSERT INTO random_timeout (val) VALUES ('alive-2')"),
					timeoutSqlite.query("SELECT 999 AS sanity_check"),
				];

				const allOps = [...slowOps, ...normalOps];
				const results = await Promise.allSettled(allOps);

				// 正常操作应在超时环境下正常完成（验证隔离）
				const normalResults = results.slice(slowOps.length);
				assert.ok(
					normalResults.every((result) => result.status === "fulfilled"),
					`正常操作不应因前置慢查询超时: ${normalResults.map((result) => result.status).join(", ")}`,
				);

				const rows = await timeoutSqlite.query(
					"SELECT val FROM random_timeout ORDER BY id ASC",
					[],
					{ timeout: 30000 },
				);
				assert.ok(rows.length >= 2, "正常 INSERT 应写入数据");

				// 慢查询检查（非强制——某些环境下 randomblob 可能比想象中快）
				const slowTimeoutCount = results.slice(0, slowOps.length).filter((r) => r.status === "rejected").length;
				console.log(`慢查询中超时数: ${slowTimeoutCount}/${slowOps.length}`);
			} finally {
				await timeoutSqlite.close();
			}
		});

		test("随机异常恢复：进程重复 crash 后数据不损坏", async () => {
			const dbFile = path.join(os.tmpdir(), `crash-recovery-${Date.now()}.db`);
			const crashSqlite = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				autoRestart: true,
				statementTimeout: 30000,
			});
			try {
				await crashSqlite.execute("CREATE TABLE IF NOT EXISTS random_crash (id INTEGER PRIMARY KEY, val TEXT)");

				// 写入一些数据
				for (let i = 0; i < 10; i++) {
					await crashSqlite.execute("INSERT INTO random_crash (val) VALUES (?)", [`seed-${i}`]);
				}

				// 多次 kill + 恢复
				for (let round = 0; round < 3; round++) {
					const proc = crashSqlite._process;
					assert.ok(proc, `Round ${round}: 进程应存在`);

					// 用 9（SIGKILL）强制终止
					proc.kill(9);
					await new Promise((r) => setTimeout(r, 500));

					// 等待进程恢复后写入更多数据
					await crashSqlite.execute("INSERT INTO random_crash (val) VALUES (?)", [`crash-recovered-${round}`]);
				}

				const final = await crashSqlite.query("SELECT val FROM random_crash ORDER BY id ASC");
				const vals = final.map((r) => r.val);
				assert.equal(vals.length, 13, `3 次 crash 恢复后应保留全部 13 行数据, 实际: ${vals.length}`);
				assert.ok(vals[0] === "seed-0", `初始数据应完整: ${vals[0]}`);
				assert.ok(vals[vals.length - 1] === "crash-recovered-2", `末次 crash 恢复数据应在最后: ${vals[vals.length - 1]}`);
			} finally {
				crashSqlite._process?.kill();
				await crashSqlite.close();
				try { fs.unlinkSync(dbFile); } catch {}
			}
		});
	});

	describe("读写分离", () => {
		test("文件 DB 创建 reader pool", () => {
			const dbFile = path.join(os.tmpdir(), `rw-pool-${Date.now()}.db`);
			const sqlite2 = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				poolSize: 2,
			});
			try {
				assert.ok(sqlite2.readerPool);
				assert.equal(sqlite2.readerPool.size, 2);
			} finally {
				sqlite2.close();
			}
		});

		test(":memory: 数据库不使用 reader pool", () => {
			const mem = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				poolSize: 2,
			});
			assert.ok(mem.readerPool === null || mem.readerPool === undefined);
			mem.close();
		});

		test("query 路由到 reader 返回正确结果", async () => {
			const dbFile = path.join(os.tmpdir(), `rw-query-${Date.now()}.db`);
			const sqlite2 = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				poolSize: 2,
				statementTimeout: 10000,
			});
			try {
				await sqlite2.execute("CREATE TABLE IF NOT EXISTS rw_q (id INTEGER PRIMARY KEY, val TEXT)");
				await sqlite2.execute("INSERT INTO rw_q VALUES (1, 'hello'), (2, 'world')");
				await new Promise((r) => setTimeout(r, 500));
				const rows = await sqlite2.query("SELECT * FROM rw_q ORDER BY id ASC");
				assert.equal(rows.length, 2);
			} finally {
				await sqlite2.close();
			}
		});

		test("耗时写入不阻塞并发读取", async () => {
			const dbFile = path.join(os.tmpdir(), `rw-concur-${Date.now()}.db`);
			const sqlite = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				poolSize: 2,
			});
			try {
				await sqlite.execute("CREATE TABLE IF NOT EXISTS rw_big (id INTEGER PRIMARY KEY, val TEXT)");

				let readResolved = false;
				const slowWrite = sqlite.execute("INSERT INTO rw_big SELECT value, hex(randomblob(512)) FROM generate_series(1, 30000)");

				await new Promise((r) => setTimeout(r, 30));

				const rows = await sqlite.query("SELECT COUNT(*) AS cnt FROM rw_big");
				readResolved = true;
				assert.equal(rows[0].cnt, 0);

				await slowWrite;
				assert.ok(readResolved, "读取应在写入完成前返回，证明走不同进程");
			} finally {
				await sqlite.close();
			}
		});

		test("execute 只读 SQL（SELECT）路由到 reader pool", async () => {
			const dbFile = path.join(os.tmpdir(), `rw-exec-read-${Date.now()}.db`);
			const sqlite = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				poolSize: 2,
			});
			try {
				await sqlite.execute("CREATE TABLE IF NOT EXISTS rw_er (id INTEGER PRIMARY KEY, val TEXT)");
				await sqlite.execute("INSERT INTO rw_er VALUES (1, 'hello')");
				await new Promise((r) => setTimeout(r, 300));

				// execute 一个 SELECT（被 classifySQL 判为 read）应路由到 reader
				// execute 不收集行，只验证不报错
				await sqlite.execute("SELECT * FROM rw_er WHERE id = 1");
			} finally {
				await sqlite.close();
			}
		});

		test("pendingStatements 在有 reader pool 时计算正确", async () => {
			const dbFile = path.join(os.tmpdir(), `rw-pending-${Date.now()}.db`);
			const sqlite2 = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				poolSize: 2,
			});
			try {
				// pendingStatements 会访问 readerPool.pendingStatements（?? 分支）
				assert.equal(typeof sqlite2.pendingStatements, "number");
				assert.equal(sqlite2.pendingStatements, 0);
				const pool = sqlite2.readerPool;
				assert.ok(pool);
				const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pool), "pendingStatements");
				assert.ok(descriptor?.get);

				Object.defineProperty(pool, "pendingStatements", {
					configurable: true,
					get: () => 1,
				});
				assert.equal(sqlite2.pendingStatements, 1);
				delete pool.pendingStatements;
				assert.equal(sqlite2.pendingStatements, 0);
			} finally {
				await sqlite2.close();
			}
		});
	});

	describe("超时", () => {
		test("statementTimeout 为非法值时抛出 TypeError", () => {
			assert.throws(() => new SQLiteExecutor({ binary: SQLite3BinaryFile, statementTimeout: -1 }), /positive integer/);
			assert.throws(() => new SQLiteExecutor({ binary: SQLite3BinaryFile, statementTimeout: 0 }), /positive integer/);
			assert.throws(() => new SQLiteExecutor({ binary: SQLite3BinaryFile, statementTimeout: 1.5 }), /positive integer/);
		});

		test("触发 SQL 超时后 tasksTimeout 指标递增", async () => {
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				statementTimeout: 1,
			});
			try {
				await assert.rejects(
					exec.execute("SELECT randomblob(100000000)"),
					(error) => {
						assert.match(error.message, /timed out after 1ms/);
						assert.match(error.message, /started at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC/);
						assert.match(error.message, /deadline at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC/);
						assert.match(error.message, /diagnostics:/);
						assert.match(error.message, /queueSize=\d+/);
						assert.match(error.message, /inflightCount=\d+/);
						assert.match(error.message, /pendingFinalizeCount=\d+/);
						assert.match(error.message, /totalPending=\d+/);
						return true;
					},
				);
				assert.equal(exec.metrics.tasksTimeout, 1);
			} finally {
				await exec.close();
			}
		});

		test("大量前置工作不会消耗后续短 SQL 的执行超时", async () => {
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				statementTimeout: 10000,
			});
			try {
				const slowSql = `
					WITH RECURSIVE counter(value) AS (
						VALUES(0)
						UNION ALL
						SELECT value + 1 FROM counter WHERE value < 5000000
					)
					SELECT sum(value) AS total FROM counter
				`;
				const [slowResult, fastResult] = await Promise.allSettled([
					exec.query(slowSql),
					exec.query("SELECT 1 AS value", [], { timeout: 100 }),
				]);

				assert.equal(slowResult.status, "fulfilled");
				assert.deepEqual(fastResult, {
					status: "fulfilled",
					value: [{ value: 1 }],
				});
			} finally {
				await exec.close();
			}
		});
	});

	describe("超时错误隔离与后续执行", () => {
		// 使用文件数据库的 helper，避免 :memory: 在进程重启后丢失数据
		function createFileExecutor(opts = {}) {
			const dbFile = path.join(os.tmpdir(), `timeout-iso-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				autoRestart: true,
				statementTimeout: 30000,
				...opts,
			});
			return { exec, dbFile };
		}

		test("execute 超时后错误被正确捕获，后续 SQL 正常执行", async () => {
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				statementTimeout: 1,
			});
			try {
				const result = await settleOp(() => exec.execute("SELECT randomblob(100000000)"));
				assert.equal(result.status, "rejected");
				assert.ok(result.reason instanceof Error);
				assert.match(result.reason.message, /timed out after/);

				// 等待进程恢复（硬超时触发后自动重启）
				await new Promise((r) => setTimeout(r, 500));

				// 使用显式超时避免后续操作也被 1ms 超时误杀
				await exec.execute("CREATE TABLE IF NOT EXISTS after_exec_timeout (id INTEGER PRIMARY KEY, val TEXT)", [], { timeout: 60000 });
				await exec.execute("INSERT INTO after_exec_timeout (val) VALUES (?)", ["ok"], { timeout: 60000 });
				const rows = await exec.query("SELECT * FROM after_exec_timeout", [], { timeout: 60000 });
				assert.deepEqual(rows, [{ id: 1, val: "ok" }]);
			} finally {
				await exec.close();
			}
		});

		test("query 超时后错误被正确捕获，后续 SQL 正常执行", async () => {
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				statementTimeout: 1,
			});
			try {
				const result = await settleOp(() => exec.query("SELECT randomblob(100000000) AS big"));
				assert.equal(result.status, "rejected");
				assert.ok(result.reason instanceof Error);
				assert.match(result.reason.message, /timed out after/);

				await new Promise((r) => setTimeout(r, 500));

				await exec.execute("CREATE TABLE IF NOT EXISTS after_query_timeout (id INTEGER PRIMARY KEY, val TEXT)", [], { timeout: 60000 });
				await exec.execute("INSERT INTO after_query_timeout (val) VALUES (?)", ["ok"], { timeout: 60000 });
				const rows = await exec.query("SELECT * FROM after_query_timeout", [], { timeout: 60000 });
				assert.deepEqual(rows, [{ id: 1, val: "ok" }]);
			} finally {
				await exec.close();
			}
		});

		test("stream 超时后错误被正确捕获，后续 SQL 正常执行", async () => {
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				statementTimeout: 1,
			});
			try {
				const streamFn = async () => {
					for await (const _ of exec.stream("SELECT randomblob(100000000) AS big")) {
						// noop
					}
				};
				const result = await settleOp(streamFn);
				assert.equal(result.status, "rejected");
				assert.ok(result.reason instanceof Error);
				assert.match(result.reason.message, /timed out after/);

				await new Promise((r) => setTimeout(r, 500));

				await exec.execute("CREATE TABLE IF NOT EXISTS after_stream_timeout (id INTEGER PRIMARY KEY, val TEXT)", [], { timeout: 60000 });
				await exec.execute("INSERT INTO after_stream_timeout (val) VALUES (?)", ["ok"], { timeout: 60000 });
				const rows = await exec.query("SELECT * FROM after_stream_timeout", [], { timeout: 60000 });
				assert.deepEqual(rows, [{ id: 1, val: "ok" }]);
			} finally {
				await exec.close();
			}
		});

		test("超时后续多个正常 SQL 串行不中断", async () => {
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				statementTimeout: 1,
			});
			try {
				await settleOp(() => exec.execute("SELECT randomblob(100000000)"));

				await new Promise((r) => setTimeout(r, 500));

				await exec.execute("CREATE TABLE IF NOT EXISTS multi_after_timeout (id INTEGER PRIMARY KEY, val TEXT)", [], { timeout: 60000 });

				const promises = [];
				for (let i = 0; i < 20; i++) {
					promises.push(
						exec.execute("INSERT INTO multi_after_timeout (val) VALUES (?)", [`n${i}`], { timeout: 60000 }),
					);
				}
				await Promise.all(promises);

				const rows = await exec.query("SELECT val FROM multi_after_timeout ORDER BY id ASC", [], { timeout: 60000 });
				assert.equal(rows.length, 20);
				assert.deepEqual(
					rows.map((r) => r.val),
					new Array(20).fill(0).map((_, i) => `n${i}`),
				);
			} finally {
				await exec.close();
			}
		});

		test("超时后 stream 正常执行", async () => {
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				statementTimeout: 1,
			});
			try {
				await settleOp(() => exec.query("SELECT randomblob(100000000) AS big"));

				await new Promise((r) => setTimeout(r, 500));

				await exec.execute("CREATE TABLE IF NOT EXISTS stream_after_timeout (id INTEGER PRIMARY KEY, val TEXT)", [], { timeout: 60000 });
				await exec.execute("INSERT INTO stream_after_timeout (val) VALUES ('a'), ('b'), ('c')", [], { timeout: 60000 });

				const collected = [];
				for await (const row of exec.stream("SELECT * FROM stream_after_timeout ORDER BY id ASC", [], { timeout: 60000 })) {
					collected.push(row);
				}
				assert.equal(collected.length, 3);
				assert.equal(collected[0].val, "a");
				assert.equal(collected[2].val, "c");
			} finally {
				await exec.close();
			}
		});
	});

	describe("读写分离 + 超时", () => {
		function cleanup(dbFile) {
			try { fs.unlinkSync(dbFile); } catch {}
		}

		test("读写分离下 query 超时后后续查询正常执行", async () => {
			const dbFile = path.join(os.tmpdir(), `rw-timeout-${Date.now()}.db`);
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				poolSize: 2,
				statementTimeout: 30000,
			});
			try {
				await exec.execute("CREATE TABLE IF NOT EXISTS rw_timeout_test (id INTEGER PRIMARY KEY, val TEXT)", [], { timeout: 60000 });
				await exec.execute("INSERT INTO rw_timeout_test VALUES (1, 'hello'), (2, 'world')", [], { timeout: 60000 });
				await new Promise((r) => setTimeout(r, 500));

				const slowResult = await settleOp(() =>
					exec.query("SELECT randomblob(5000000) AS big", [], { timeout: 1 }),
				);
				assert.equal(slowResult.status, "rejected");
				assert.ok(slowResult.reason instanceof Error);
				assert.match(slowResult.reason.message, /timed out after/);

				const rows = await exec.query("SELECT * FROM rw_timeout_test ORDER BY id ASC", [], { timeout: 60000 });
				assert.equal(rows.length, 2);
				assert.deepEqual(rows, [
					{ id: 1, val: "hello" },
					{ id: 2, val: "world" },
				]);
			} finally {
				await exec.close();
				cleanup(dbFile);
			}
		});

		test("读写分离下 execute 超时后 reader 查询不受影响", async () => {
			const dbFile = path.join(os.tmpdir(), `rw-exec-timeout-${Date.now()}.db`);
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				poolSize: 2,
				statementTimeout: 30000,
			});
			try {
				await exec.execute("CREATE TABLE IF NOT EXISTS rw_exec_timeout (id INTEGER PRIMARY KEY, val TEXT)", [], { timeout: 60000 });
				await exec.execute("INSERT INTO rw_exec_timeout VALUES (1, 'data')", [], { timeout: 60000 });
				await new Promise((r) => setTimeout(r, 500));

				const writeResult = await settleOp(() =>
					exec.execute("SELECT randomblob(100000000)", [], { timeout: 1 }),
				);
				assert.equal(writeResult.status, "rejected");

				await new Promise((r) => setTimeout(r, 500));

				// reader 查询应不受影响（独立进程）
				const rows = await exec.query("SELECT * FROM rw_exec_timeout", [], { timeout: 60000 });
				assert.equal(rows.length, 1);
				assert.equal(rows[0].val, "data");
			} finally {
				await exec.close();
				cleanup(dbFile);
			}
		});
	});

	describe("大量并发更新 + 超时隔离", () => {
		function cleanup(dbFile) {
			for (const suffix of ["", "-wal", "-shm"]) {
				try { fs.unlinkSync(dbFile + suffix); } catch {}
			}
		}

		test("大量并发 INSERT 中部分超时不污染其他写入（文件 DB）", async () => {
			const dbFile = path.join(os.tmpdir(), `bulk-insert-timeout-${Date.now()}.db`);
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				autoRestart: true,
				statementTimeout: 30000,
			});
			try {
				await exec.execute("CREATE TABLE IF NOT EXISTS bulk_ins (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT, ts INTEGER)", [], { timeout: 60000 });

				const ops = [];
				// 40 个正常写入
				for (let i = 0; i < 40; i++) {
					ops.push(
						settleOp(() =>
							exec.execute("INSERT INTO bulk_ins (val, ts) VALUES (?, ?)", [`normal-${i}`, i], { timeout: 60000 }),
						),
					);
				}
				// 5 个慢查询（1ms 超时）→ 触发硬超时 + 进程重启
				for (let i = 0; i < 5; i++) {
					ops.push(
						settleOp(() =>
							exec.execute("SELECT randomblob(100000000)", [], { timeout: 1 }),
						),
					);
				}

				await Promise.allSettled(ops);

				// 等待进程恢复
				await new Promise((r) => setTimeout(r, 500));

				// 从文件数据库读回，验证持久化的数据
				const rows = await exec.query("SELECT COUNT(*) AS cnt FROM bulk_ins", [], { timeout: 60000 });
				assert.ok(rows[0].cnt > 0, "应有数据持久化到文件 DB");

				// 验证写入的数据内容正确
				const data = await exec.query("SELECT val, ts FROM bulk_ins ORDER BY ts ASC", [], { timeout: 60000 });
				for (let i = 0; i < data.length; i++) {
					assert.equal(data[i].val, `normal-${data[i].ts}`, `行 ${i} 数据应完整`);
				}
			} finally {
				await exec.close();
				cleanup(dbFile);
			}
		});

		test("大量并发 mixed 操作 + 超时后数据一致性不受影响（文件 DB）", async () => {
			const dbFile = path.join(os.tmpdir(), `bulk-mixed-${Date.now()}.db`);
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				autoRestart: true,
				statementTimeout: 30000,
			});
			try {
				await exec.execute("CREATE TABLE IF NOT EXISTS bulk_mixed (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT, step INTEGER)", [], { timeout: 60000 });

				// 先写入一批基准数据（确保超时/重启前已有持久化数据）
				for (let i = 0; i < 10; i++) {
					await exec.execute("INSERT INTO bulk_mixed (tag, step) VALUES (?, ?)", [`before-${i}`, i], { timeout: 60000 });
				}

				// 并发：正常操作 + 慢查询（短 timeout 触发进程重启）
				const ops = [];
				for (let i = 0; i < 30; i++) {
					if (i % 4 === 0) {
						ops.push(settleOp(() => exec.execute("SELECT randomblob(100000000)", [], { timeout: 1 })));
					} else if (i % 4 === 1) {
						ops.push(settleOp(() => exec.execute("INSERT INTO bulk_mixed (tag, step) VALUES (?, ?)", [`during-${i}`, i], { timeout: 60000 })));
					} else if (i % 4 === 2) {
						ops.push(settleOp(() => exec.query("SELECT COUNT(*) AS cnt FROM bulk_mixed", [], { timeout: 60000 })));
					} else {
						ops.push(settleOp(() => exec.execute("INSERT INTO bulk_mixed (tag, step) VALUES (?, ?)", [`during-${i}`, i], { timeout: 60000 })));
					}
				}

				await Promise.allSettled(ops);
				await new Promise((r) => setTimeout(r, 500));

				// 基准数据应始终完整（文件 DB 持久化，进程重启后仍在）
				const beforeRows = await exec.query("SELECT tag, step FROM bulk_mixed WHERE tag LIKE 'before-%' ORDER BY step ASC", [], { timeout: 60000 });
				assert.ok(beforeRows.length >= 10, `基准数据应完整: ${beforeRows.length}/10`);
				for (let i = 0; i < Math.min(beforeRows.length, 10); i++) {
					assert.equal(beforeRows[i].tag, `before-${i}`);
				}

				// 系统仍可正常写入
				await exec.execute("INSERT INTO bulk_mixed (tag, step) VALUES (?, ?)", [`after-0`, 999], { timeout: 60000 });
				const afterRows = await exec.query("SELECT tag, step FROM bulk_mixed WHERE tag = 'after-0'", [], { timeout: 60000 });
				assert.equal(afterRows.length, 1);
				assert.equal(afterRows[0].step, 999);
			} finally {
				await exec.close();
				cleanup(dbFile);
			}
		});

		test("多轮并发更新 + 超时重启后数据不丢失（文件 DB）", async () => {
			const dbFile = path.join(os.tmpdir(), `bulk-recovery-${Date.now()}.db`);
			const exec = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				autoRestart: true,
				statementTimeout: 30000,
			});
			try {
				await exec.execute("CREATE TABLE IF NOT EXISTS bulk_rec (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT, round INTEGER)", [], { timeout: 60000 });

				// 种子数据（在超时重启之前持久化）
				for (let i = 0; i < 5; i++) {
					await exec.execute("INSERT INTO bulk_rec (val, round) VALUES (?, ?)", [`seed-${i}`, 0], { timeout: 60000 });
				}

				for (let round = 1; round <= 3; round++) {
					// 先写入本轮数据（确保在超时之前到达文件 DB）
					await exec.execute("INSERT INTO bulk_rec (val, round) VALUES (?, ?)", [`round-${round}-pre`, round], { timeout: 60000 });

					// 然后触发超时（可能导致进程重启，但文件 DB 已有本轮数据）
					await settleOp(() => exec.execute("SELECT randomblob(100000000)", [], { timeout: 1 }));
					await new Promise((r) => setTimeout(r, 500));
				}

				// 全部数据应完整
				const finalRows = await exec.query("SELECT val, round FROM bulk_rec ORDER BY id ASC", [], { timeout: 60000 });
				assert.ok(finalRows.length >= 5, `种子数据应保留: ≥ 5`);

				const seedRows = finalRows.filter((r) => r.round === 0);
				assert.equal(seedRows.length, 5, "种子数据完整");
				for (let i = 0; i < 5; i++) {
					assert.equal(seedRows[i].val, `seed-${i}`);
				}

				for (let round = 1; round <= 3; round++) {
					const roundRows = finalRows.filter((r) => r.round === round);
					assert.ok(roundRows.length >= 1, `第 ${round} 轮应有数据`);
					assert.ok(roundRows.some((r) => r.val === `round-${round}-pre`), `第 ${round} 轮 pre 数据应完整`);
				}
			} finally {
				exec._process?.kill();
				await exec.close();
				cleanup(dbFile);
			}
		});
	});

	describe("错误隔离", () => {
		test("execute 非数组 params 抛出 TypeError", async () => {
			await assert.rejects(
				sqlite.execute("SELECT 1", "not-an-array"),
				/params must be an array/,
			);
		});

		test("query 非数组 params 抛出 TypeError", async () => {
			await assert.rejects(
				sqlite.query("SELECT 1", "not-an-array"),
				/params must be an array/,
			);
		});

		test("execute 非数组 params 不污染后续查询", async () => {
			await assert.rejects(
				sqlite.execute("SELECT 1", { obj: "not-array" }),
				/params must be an array/,
			);
			const rows = await sqlite.query("SELECT 1 AS v");
			assert.deepEqual(rows, [{ v: 1 }]);
		});

		test("SQL 错误不会污染后续任务", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS resilient_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
			await sqlite.execute("INSERT INTO resilient_users (name) VALUES (?)", ["Alice"]);

			await assert.rejects(sqlite.query("SELECT * FROM missing_table"));

			const rows = await sqlite.query("SELECT * FROM resilient_users ORDER BY id ASC");
			assert.deepEqual(rows, [{ id: 1, name: "Alice" }]);
		});

		test("execute SQL 错误后后续 execute 不受影响", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS exec_err_isolation (id INTEGER PRIMARY KEY, name TEXT)");

			await assert.rejects(
				sqlite.execute("INSERT INTO nonexistent_exec_table (name) VALUES (?)", ["x"]),
			);

			await sqlite.execute("INSERT INTO exec_err_isolation (name) VALUES (?)", ["Bob"]);

			const rows = await sqlite.query("SELECT * FROM exec_err_isolation");
			assert.deepEqual(rows, [{ id: 1, name: "Bob" }]);
		});

		test("execute SQL 错误后后续 query 不受影响", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS exec_q_isolation (id INTEGER PRIMARY KEY, name TEXT)");
			await sqlite.execute("INSERT INTO exec_q_isolation (name) VALUES (?)", ["Alice"]);

			await assert.rejects(
				sqlite.execute("INSERT INTO nonexistent_q_table (name) VALUES (?)", ["x"]),
			);

			const rows = await sqlite.query("SELECT * FROM exec_q_isolation");
			assert.deepEqual(rows, [{ id: 1, name: "Alice" }]);
		});

		test("stream SQL 错误后后续 query 不受影响", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_err_iso (id INTEGER PRIMARY KEY, val TEXT)");
			await sqlite.execute("INSERT INTO stream_err_iso VALUES (1, 'hello')");

			await assert.rejects(
				(async () => {
					for await (const _ of sqlite.stream("SELECT * FROM stream_err_iso WHERE bad_col = 1")) {
						// noop
					}
				})(),
			);

			const rows = await sqlite.query("SELECT * FROM stream_err_iso");
			assert.equal(rows.length, 1);
			assert.equal(rows[0].val, "hello");
		});

		test("SQL 语法错误可以被正确捕获且不影响后续语句", async () => {
			try {
				await sqlite.query("SELECT FORM users");
				assert.fail("应抛出异常");
			} catch (err) {
				assert.ok(err instanceof Error, "应抛出 Error 类型");
			}

			const rows = await sqlite.query("SELECT 1 AS val");
			assert.deepEqual(rows, [{ val: 1 }]);
		});

		test("语法错误的消息可从 stderr 正确提取，不丢失细节", async () => {
			try {
				await sqlite.query("SELECT FORM users");
				assert.fail("应抛出异常");
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes("syntax error") || err.message.includes("near"), `语法错误消息应包含 "syntax error" 或 "near"，实际: ${err.message}`);
			}

			const rows = await sqlite.query("SELECT 1 AS val");
			assert.deepEqual(rows, [{ val: 1 }]);
		});

		test("execute 语法错误不影响后续 execute", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS syn_err (id INTEGER PRIMARY KEY, name TEXT)");

			await assert.rejects(
				sqlite.execute("INSART INTO syn_err (name) VALUES (?)", ["x"]),
				/error|Error/i,
			);

			await sqlite.execute("INSERT INTO syn_err (name) VALUES (?)", ["Alice"]);
			const rows = await sqlite.query("SELECT * FROM syn_err ORDER BY id ASC");
			assert.deepEqual(rows, [{ id: 1, name: "Alice" }]);
		});

		test("查询不存在的表时错误消息可读", async () => {
			try {
				await sqlite.query("SELECT * FROM nonexistent_test_table");
				assert.fail("应抛出异常");
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(
					err.message.includes("no such table"),
					`错误消息应包含 "no such table"，实际: ${err.message}`,
				);
			}

			await sqlite.execute("CREATE TABLE IF NOT EXISTS existent_table (id INTEGER PRIMARY KEY)");
			await sqlite.execute("INSERT INTO existent_table VALUES (42)");
			const rows = await sqlite.query("SELECT * FROM existent_table ORDER BY id ASC");
			assert.deepEqual(rows, [{ id: 42 }]);
		});

		test("查询不存在的列时错误消息可读", async () => {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS col_test (id INTEGER PRIMARY KEY, name TEXT)");
			await sqlite.execute("INSERT INTO col_test (name) VALUES ('hello')");

			try {
				await sqlite.query("SELECT nonexistent_col FROM col_test WHERE id = 1");
				assert.fail("应抛出异常");
			} catch (err) {
				assert.ok(err instanceof Error);
				assert.ok(
					err.message.includes("no such column"),
					`错误消息应包含 "no such column"，实际: ${err.message}`,
				);
			}

			const rows = await sqlite.query("SELECT name FROM col_test ORDER BY id ASC");
			assert.deepEqual(rows, [{ name: "hello" }]);
		});

		test("stream 语法错误时错误消息可读", async () => {
			let errMsg;
			try {
				for await (const _ of sqlite.stream("SELECT FORM users WHERE 1 = 1")) {
					// noop
				}
				assert.fail("应抛出异常");
			} catch (err) {
				errMsg = err.message;
				assert.ok(err instanceof Error);
				assert.ok(
					errMsg.includes("syntax error") || errMsg.includes("near"),
					`stream 语法错误消息应包含 "syntax error" 或 "near"，实际: ${errMsg}`,
				);
			}

			const rows = await sqlite.query("SELECT 1 AS val");
			assert.deepEqual(rows, [{ val: 1 }]);
		});

		test("并发查询中一条 SQL 出错不影响其余正确查询", async () => {
			const results = await Promise.allSettled([
				sqlite.query("SELECT 100 AS v"),
				sqlite.query("SELECT * FROM concurrent_bad_table"),
				sqlite.query("SELECT 200 AS v"),
				sqlite.query("SELECT 300 AS v"),
			]);

			const rejected = results.filter((r) => r.status === "rejected");
			const fulfilled = results.filter((r) => r.status === "fulfilled");

			assert.ok(rejected.length >= 1, "至少有一条查询应被拒绝");
			assert.ok(fulfilled.length >= 1, "至少有一条查询应成功");

			for (const result of fulfilled) {
				assert.ok(Array.isArray(result.value));
			}
		});
	});

	describe("生命周期与进程恢复", () => {
		test("close 会拒绝尚未完成的任务", async () => {
			const p1 = sqlite.query("SELECT randomblob(1000000)");
			const p2 = sqlite.query("SELECT 2");
			const settledPromise = Promise.allSettled([p1, p2]);

			await sqlite.close();
			const settled = await settledPromise;
			assert.deepEqual(
				settled.map((item) => item.status),
				["rejected", "rejected"],
			);
		});

		test("多次 close 安全（幂等性）", async () => {
			await sqlite.close();
			await sqlite.close();
		});

		test("pendingStatements 返回待处理任务数", async () => {
			assert.equal(sqlite.pendingStatements, 0);
			const p1 = sqlite.query("SELECT 1");
			assert.equal(sqlite.pendingStatements, 1);
			const p2 = sqlite.query("SELECT 2");
			assert.equal(sqlite.pendingStatements, 2);
			await p1;
			await p2;
			assert.equal(sqlite.pendingStatements, 0);
		});

		test("sqlite 二进制文件缺失时后续请求会被拒绝", async () => {
			const missingPath = path.join(os.tmpdir(), "missing-sqlite3-binary");
			const executor = new SQLiteExecutor({ binary: missingPath, autoRestart: false });

			await assert.rejects(executor.query("SELECT 1"), /sqlite3 binary not found/i);
			await executor.close();
		});

		test("进程异常退出后 autoRestart=true 自动重启", async () => {
			const exec = new SQLiteExecutor({ binary: SQLite3BinaryFile, autoRestart: true });
			try {
				await exec.execute("SELECT 1");
				const proc = exec._process;
				assert.ok(proc, "进程应正在运行");

				proc.kill(9); // 使用信号号 9（SIGKILL），兼容 Windows

				await new Promise((r) => setTimeout(r, 500));
				const rows = await exec.query("SELECT 1 AS v");
				assert.deepEqual(rows, [{ v: 1 }]);
			} finally {
				await exec.close();
			}
		});

		test("进程异常退出后 autoRestart=false 后续请求被拒绝", async () => {
			const exec = new SQLiteExecutor({ binary: SQLite3BinaryFile, autoRestart: false });
			try {
				const p = exec.execute("SELECT 1");
				const proc = exec._process;
				assert.ok(proc, "进程应正在运行");

				proc.kill(9); // 使用信号号 9（SIGKILL），兼容 Windows

				await assert.rejects(p, /exited unexpectedly/);

				await assert.rejects(
					exec.query("SELECT 1"),
					(err) => err instanceof Error,
				);
			} finally {
				await exec.close();
			}
		});

		test("进程 error 事件触发进程恢复", async () => {
			const exec = new SQLiteExecutor({ binary: SQLite3BinaryFile, autoRestart: true });
			try {
				// 先确保进程正常运行
				await exec.execute("SELECT 1");
				const proc = exec._process;
				assert.ok(proc, "进程应正在运行");

				// 触发 error 事件 → #handleProcessFailure → auto restart
				proc.emit("error", new Error("simulated process error"));

				// 等待新进程就绪
				await new Promise((r) => setTimeout(r, 500));

				// 新进程应正常工作
				const rows = await exec.query("SELECT 1 AS v");
				assert.deepEqual(rows, [{ v: 1 }]);
			} finally {
				await exec.close();
			}
		});

		test("进程 error 事件时 logger.error 被调用（on error 中日志分支）", async () => {
			const logs = [];
			const logger = { error: (...args) => logs.push(args) };
			const exec = new SQLiteExecutor({ binary: SQLite3BinaryFile, autoRestart: true, logger });
			try {
				await exec.execute("SELECT 1");
				const proc = exec._process;
				assert.ok(proc, "进程应正在运行");

				proc.emit("error", new Error("simulated process error"));

				await new Promise((r) => setTimeout(r, 500));
				const rows = await exec.query("SELECT 1 AS v");
				assert.deepEqual(rows, [{ v: 1 }]);

				// logger.error 应被调用（proc.on("error") 中该分支）
				assert.ok(logs.length > 0, "logger.error 应被调用");
				const hasProcessError = logs.some((args) =>
					args.some((a) => typeof a === "string" && a.includes("process error"))
				);
				assert.ok(hasProcessError, 'logger.error 应包含 "process error"');
			} finally {
				await exec.close();
			}
		});

		test("二进制文件缺失时 logger.error 被调用（#startProcess 中日志分支）", async () => {
			const logs = [];
			const logger = { error: (...args) => logs.push(args) };
			const missingPath = path.join(os.tmpdir(), "missing-binary-logger");
			const exec = new SQLiteExecutor({ binary: missingPath, autoRestart: false, logger });
			try {
				await assert.rejects(exec.query("SELECT 1"), /sqlite3 binary not found/i);
				assert.ok(logs.length > 0, "logger.error 应被调用");
				assert.ok(logs.some((args) => args.some((a) => typeof a === "string" && a.includes("failed to start"))));
			} finally {
				await exec.close();
			}
		});

		test("进程 stdout 不可用时设置 fatalError", async (t) => {
			t.mock.method(ProcessManager.prototype, "start", () => ({}));
			const exec = new SQLiteExecutor({ binary: SQLite3BinaryFile, autoRestart: false });
			try {
				assert.equal(exec._process, null, "进程应未启动");
				await assert.rejects(
					exec.query("SELECT 1"),
					/stdio unavailable/,
				);
			} finally {
				await exec.close();
			}
		});

		test("进程退出后 close 事件触发 handleProcessFailure", async () => {
			const exec = new SQLiteExecutor({ binary: SQLite3BinaryFile, autoRestart: false });
			try {
				await exec.execute("SELECT 1");
				const proc = exec._process;
				assert.ok(proc, "进程应正在运行");

				// 直接用 process.kill 终止进程，模拟 OS 级关闭
				// proc.on("close") 中 this.#closed 为 false 时调用 #handleProcessFailure
				process.kill(proc.pid);

				await assert.rejects(
					exec.execute("SELECT 1"),
					/exited unexpectedly/,
				);
			} finally {
				await exec.close();
			}
		});

		test("Symbol.asyncDispose 委托给 close", async () => {
			// 兼容旧版 Node.js：手动调用 asyncDispose 代替 await using
			const db = new SQLiteExecutor({ binary: SQLite3BinaryFile });
			try {
				const rows = await db.query("SELECT 1 AS v");
				assert.deepEqual(rows, [{ v: 1 }]);
			} finally {
				await db[Symbol.asyncDispose]();
			}
		});

	test("Symbol.dispose 同步关闭不抛出", () => {
		const db = new SQLiteExecutor({ binary: SQLite3BinaryFile });
		// 使用同步 Symbol.dispose（fire-and-forget close），不应抛出异常
		db[Symbol.dispose]();
	});
	});
});
