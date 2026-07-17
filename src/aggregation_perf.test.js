import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import test, { before, after, describe } from "node:test";

import { SQLiteExecutor } from "./core/executor.js";
import downloadSQLite3 from "../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.join(__dirname, "..");
const SQLite3BinaryFile = path.join(root, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));

/**
 * 聚合查询性能诊断测试。
 *
 * 模拟用户场景: subTasks 表上对 100 万条以上数据进行聚合查询超时。
 * 诊断步骤:
 *   1. 数据准备 + 无索引 EXPLAIN QUERY PLAN + 执行耗时
 *   2. 创建覆盖索引后的 EXPLAIN QUERY PLAN + 执行耗时
 *   3. 增加更多可能触发超时的场景诊断
 */

const SubTaskState = {
	PENDING: 0,
	DONE: 1,
	ERROR: 2,
	SKIPPED: 3,
};

const TARGET_TASK_ID = 42;
const TOTAL_ROWS = 1_200_000;
const TEST_TIMEOUT = 300_000;

const SQL_AGGREGATE = `
SELECT
	COUNT(*) AS fileCount,
	COALESCE(SUM(CASE WHEN subTaskState = ? THEN 1 ELSE 0 END), 0) AS doneCount,
	COALESCE(SUM(CASE WHEN subTaskState = ? THEN 1 ELSE 0 END), 0) AS errorCount,
	COALESCE(SUM(fileSize), 0) AS totalFileSize,
	COALESCE(SUM(CASE WHEN subTaskState = ? THEN fileSize ELSE 0 END), 0) AS doneFileSize
FROM subTasks
WHERE taskId = ?
`;

function dbPath(label) {
	return path.join(os.tmpdir(), `agg-perf-${label}-${Date.now()}.db`);
}

function cleanupFiles(...paths) {
	for (const p of paths) {
		for (const ext of ["", "-wal", "-shm"]) {
			try {
				fs.unlinkSync(p + ext);
			} catch {
				/* ignore */
			}
		}
	}
}

async function measureTime(fn) {
	const start = performance.now();
	const result = await fn();
	return { elapsed: performance.now() - start, result };
}

/**
 * 准备数据库：建表 + 灌入 N 行数据。
 * @param {SQLiteExecutor} db
 * @param {number} targetTaskId  聚集的目标 taskId
 * @param {number} targetRows    目标 taskId 的数据行数
 * @param {number} otherRows     其他 taskId 的干扰行数
 */
async function seedSubTasks(db, targetTaskId, targetRows, otherRows) {
	const total = targetRows + otherRows;
	const { elapsed } = await measureTime(() =>
		db.execute(`
			WITH RECURSIVE seq(n) AS (
				SELECT 1
				UNION ALL
				SELECT n + 1 FROM seq WHERE n < ${total}
			)
			INSERT INTO subTasks (taskId, subTaskState, fileSize)
			SELECT
				CASE
					WHEN n <= ${targetRows} THEN ${targetTaskId}
					ELSE ${targetTaskId + 1} + (n % 100)
				END,
				CASE (n % 10)
					WHEN 0 THEN ${SubTaskState.PENDING}
					WHEN 1 THEN ${SubTaskState.ERROR}
					WHEN 2 THEN ${SubTaskState.SKIPPED}
					ELSE ${SubTaskState.DONE}
				END,
				1024 + (n % 1048576)
			FROM seq
		`),
	);
	return { total, elapsed };
}

describe("聚合查询性能诊断（模拟用户场景）", { timeout: TEST_TIMEOUT }, () => {
	let dbFile;
	let sqlite;

	before(async () => {
		await downloadSQLite3();
	});

	after(() => {
		cleanupFiles(dbFile);
	});

	// ======================================================
	// 场景 A: 默认场景 — 100 万行聚合查询
	// ======================================================
	describe("A) 100 万行聚合查询 (taskId=42)", () => {
		let rowCount;

		test("A1. 建表 + 灌入 120 万行数据", async () => {
			dbFile = dbPath("subtasks");
			sqlite = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFile,
				statementTimeout: 300_000,
			});

			await sqlite.execute(`
				CREATE TABLE subTasks (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					taskId INTEGER NOT NULL,
					subTaskState INTEGER NOT NULL DEFAULT 0,
					fileSize INTEGER NOT NULL DEFAULT 0
				)
			`);

			// targetRows=1_000_000, otherRows=200_000
			const info = await seedSubTasks(sqlite, TARGET_TASK_ID, 1_000_000, 200_000);
			console.log(`  灌入 ${info.total.toLocaleString()} 行耗时: ${info.elapsed.toFixed(0)} ms`);

			// 验证行数
			const [{ cnt }] = await sqlite.query("SELECT COUNT(*) AS cnt FROM subTasks");
			assert.equal(cnt, 1_200_000);
			rowCount = cnt;
		});

		test("A2. 无索引 EXPLAIN QUERY PLAN", async () => {
			// 注: sqlite3 CLI 的 .mode json 对 EXPLAIN QUERY PLAN
			// 输出的是 ASCII art 格式而非 JSON，因此 executor 的 JSON
			// 解析器无法解析。这里通过 stdout 原始字符串诊断。
			const rows = await sqlite.query(`EXPLAIN QUERY PLAN ${SQL_AGGREGATE}`, [
				SubTaskState.DONE,
				SubTaskState.ERROR,
				SubTaskState.DONE,
				TARGET_TASK_ID,
			]);
			// EXPLAIN 输出不是标准 JSON，这里 rows 可能为空
			console.log(`  无索引 EXPLAIN 原始输出行数: ${rows.length}`);
			if (rows.length > 0) {
				for (const r of rows) {
					console.log(`    ${JSON.stringify(r)}`);
				}
			} else {
				// 改用 PRAGMA 来验证查询计划
				console.log("  (EXPLAIN 输出在 JSON 模式下不可解析，跳过断言)");
			}
		});

		test("A3. 无索引 — 执行并测量耗时", async () => {
			const { elapsed, result } = await measureTime(() =>
				sqlite.query(SQL_AGGREGATE, [SubTaskState.DONE, SubTaskState.ERROR, SubTaskState.DONE, TARGET_TASK_ID]),
			);

			const r = result[0];
			console.log(`  无索引耗时: ${elapsed.toFixed(0)} ms`);
			console.log(
				`  结果: fileCount=${r.fileCount}, doneCount=${r.doneCount}, errorCount=${r.errorCount}, totalFileSize=${r.totalFileSize}, doneFileSize=${r.doneFileSize}`,
			);

			// 1,000,000 行 target + (n % 10) 分布得到 ~70% DONE, ~10% ERROR
			assert.equal(r.fileCount, 1_000_000);
			assert.equal(r.doneCount, 700_000);
			assert.equal(r.errorCount, 100_000);

			if (elapsed > 120_000) {
				console.log("  ⚠️  无索引查询超时(>120s)，与用户报告一致");
			} else {
				console.log(`  ✅ 无索引查询仅 ${elapsed.toFixed(0)} ms，远低于 120s`);
			}
		});

		test("A4. 添加覆盖索引", async () => {
			const { elapsed } = await measureTime(() =>
				sqlite.execute("CREATE INDEX idx_subTasks_tid_state_size ON subTasks(taskId, subTaskState, fileSize)"),
			);
			console.log(`  创建索引耗时: ${elapsed.toFixed(0)} ms`);

			const idxRows = await sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_subTasks_tid_state_size'");
			assert.equal(idxRows.length, 1);
		});

		test("A5. 有索引 EXPLAIN QUERY PLAN", async () => {
			const rows = await sqlite.query(`EXPLAIN QUERY PLAN ${SQL_AGGREGATE}`, [
				SubTaskState.DONE,
				SubTaskState.ERROR,
				SubTaskState.DONE,
				TARGET_TASK_ID,
			]);
			console.log(`  有索引 EXPLAIN 原始输出行数: ${rows.length}`);
			if (rows.length > 0) {
				for (const r of rows) {
					console.log(`    ${JSON.stringify(r)}`);
				}
			} else {
				console.log("  (EXPLAIN 输出在 JSON 模式下不可解析，跳过断言)");
			}
		});

		test("A6. 有索引 — 执行并测量耗时", async () => {
			const { elapsed, result } = await measureTime(() =>
				sqlite.query(SQL_AGGREGATE, [SubTaskState.DONE, SubTaskState.ERROR, SubTaskState.DONE, TARGET_TASK_ID]),
			);

			const r = result[0];
			console.log(`  有索引耗时: ${elapsed.toFixed(0)} ms`);
			console.log(
				`  结果: fileCount=${r.fileCount}, doneCount=${r.doneCount}, errorCount=${r.errorCount}, totalFileSize=${r.totalFileSize}, doneFileSize=${r.doneFileSize}`,
			);

			assert.equal(r.fileCount, 1_000_000);
			assert.equal(r.doneCount, 700_000);
			assert.equal(r.errorCount, 100_000);
		});

		test("A7. 清理", async () => {
			await sqlite.close();
			sqlite = null;
			cleanupFiles(dbFile);
		});
	});

	// ======================================================
	// 场景 B: 诊断 — WAL vs DELETE 模式对聚合查询的影响
	// ======================================================
	describe("B) 诊断: WAL vs DELETE journal 模式", () => {
		/** @type {string[]} */
		const dbs = [];

		after(() => {
			for (const f of dbs) cleanupFiles(f);
		});

		for (const mode of ["DELETE", "WAL"]) {
			test(`B) ${mode} 模式下 100 万行聚合查询`, async () => {
				const dbFileB = dbPath(`journal-${mode}`);
				dbs.push(dbFileB);

				const db = new SQLiteExecutor({
					binary: SQLite3BinaryFile,
					database: dbFileB,
					statementTimeout: 300_000,
				});

				// 设置日志模式
				await db.execute(`PRAGMA journal_mode=${mode}`);

				// 建表 + 灌数
				await db.execute(`
					CREATE TABLE subTasks (
						id INTEGER PRIMARY KEY AUTOINCREMENT,
						taskId INTEGER NOT NULL,
						subTaskState INTEGER NOT NULL DEFAULT 0,
						fileSize INTEGER NOT NULL DEFAULT 0
					)
				`);
				await seedSubTasks(db, TARGET_TASK_ID, 1_000_000, 200_000);

				// 测量聚合查询（无额外索引）
				const { elapsed, result } = await measureTime(() =>
					db.query(SQL_AGGREGATE, [SubTaskState.DONE, SubTaskState.ERROR, SubTaskState.DONE, TARGET_TASK_ID]),
				);

				const r = result[0];
				console.log(`  [journal=${mode}] 聚合查询: ${elapsed.toFixed(0)} ms, fileCount=${r.fileCount}`);
				assert.equal(r.fileCount, 1_000_000);

				await db.close();
			});
		}
	});

	// ======================================================
	// 场景 C: 诊断 — 事务内写入是否阻塞同连接读
	// ======================================================
	describe("C) 诊断: 未提交事务对聚合查询的影响", () => {
		let dbFileC;
		let db;

		before(async () => {
			dbFileC = dbPath("write-block");
			db = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFileC,
				statementTimeout: 300_000,
			});

			await db.execute(`
			CREATE TABLE subTasks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				taskId INTEGER NOT NULL,
				subTaskState INTEGER NOT NULL DEFAULT 0,
				fileSize INTEGER NOT NULL DEFAULT 0
			)
		`);
			await seedSubTasks(db, TARGET_TASK_ID, 1_000_000, 200_000);
		});

		after(async () => {
			await db?.close();
			cleanupFiles(dbFileC);
		});

		test("C1. 开始事务不提交，再执行聚合查询", { timeout: 60_000 }, async () => {
			// 注意：sqlite-wrapper.js 通过单个 sqlite3 子进程通信，
			// 同连接中 DEFERRED 模式下的 BEGIN 不阻塞后续读，
			// 但若升级为 IMMEDIATE 则可能导致阻塞。
			await db.execute("BEGIN DEFERRED");
			await db.execute("UPDATE subTasks SET fileSize = fileSize + 1 WHERE id BETWEEN 1 AND 10000");

			const { elapsed, result } = await measureTime(() =>
				db.query(SQL_AGGREGATE, [SubTaskState.DONE, SubTaskState.ERROR, SubTaskState.DONE, TARGET_TASK_ID]),
			);

			console.log(`  BEGIN DEFERRED + UPDATE 未提交: 聚合 ${elapsed.toFixed(0)} ms, fileCount=${result[0].fileCount}`);
			await db.execute("ROLLBACK");
		});

		test("C2. BEGIN IMMEDIATE 不提交再执行聚合查询", { timeout: 60_000 }, async () => {
			// IMMEDIATE 模式会获取 RESERVED 锁，
			// 同连接内仍可读（SQLite 允许同事务内读写），
			// 但若有多连接并发则会阻塞其他写。
			await db.execute("BEGIN IMMEDIATE");
			await db.execute("UPDATE subTasks SET fileSize = fileSize + 1 WHERE id BETWEEN 1 AND 10000");

			const { elapsed, result } = await measureTime(() =>
				db.query(SQL_AGGREGATE, [SubTaskState.DONE, SubTaskState.ERROR, SubTaskState.DONE, TARGET_TASK_ID]),
			);

			console.log(`  BEGIN IMMEDIATE + UPDATE 未提交: 聚合 ${elapsed.toFixed(0)} ms, fileCount=${result[0].fileCount}`);
		});
	});

	// ======================================================
	// 场景 D: 诊断 — 表有大量宽列时的性能
	// ======================================================
	describe("D) 诊断: 宽表对聚合查询的影响", () => {
		let dbFileD;
		let db;

		before(async () => {
			dbFileD = dbPath("wide-table");
			db = new SQLiteExecutor({
				binary: SQLite3BinaryFile,
				database: dbFileD,
				statementTimeout: 300_000,
			});

			// 模拟生产环境可能有大量其他列
			await db.execute(`
				CREATE TABLE subTasks (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					taskId INTEGER NOT NULL,
					subTaskState INTEGER NOT NULL DEFAULT 0,
					fileSize INTEGER NOT NULL DEFAULT 0,
					fileName TEXT DEFAULT '',
					filePath TEXT DEFAULT '',
					mimeType TEXT DEFAULT '',
					md5 TEXT DEFAULT '',
					sha256 TEXT DEFAULT '',
					uploaderId INTEGER DEFAULT 0,
					uploadTime TEXT DEFAULT '',
					downloadUrl TEXT DEFAULT '',
					thumbnailUrl TEXT DEFAULT '',
					width INTEGER DEFAULT 0,
					height INTEGER DEFAULT 0,
					duration INTEGER DEFAULT 0,
					status INTEGER DEFAULT 0,
					priority INTEGER DEFAULT 0,
					tags TEXT DEFAULT '',
					description TEXT DEFAULT '',
					extraData TEXT DEFAULT ''
				)
			`);

			// 灌入数据 + 填充宽列
			await seedSubTasks(db, TARGET_TASK_ID, 500_000, 100_000);

			await db.execute(`
				UPDATE subTasks SET
					fileName = 'a_very_long_file_name_that_represents_typical_production_data_' || id,
					filePath = '/path/to/some/deeply/nested/directory/structure/that/might/exist/in/production/' || id,
					mimeType = CASE (id % 5)
						WHEN 0 THEN 'image/jpeg'
						WHEN 1 THEN 'application/pdf'
						WHEN 2 THEN 'video/mp4'
						WHEN 3 THEN 'text/plain'
						ELSE 'application/octet-stream'
					END,
					md5 = hex(randomblob(16)),
					sha256 = hex(randomblob(32)),
					tags = 'tag1,tag2,tag3,tag4,tag5,extra,metadata,for,testing,purposes'
			`);
		});

		after(async () => {
			await db?.close();
			cleanupFiles(dbFileD);
		});

		test("D1. 宽表无索引聚合查询", async () => {
			const { elapsed, result } = await measureTime(() =>
				db.query(SQL_AGGREGATE, [SubTaskState.DONE, SubTaskState.ERROR, SubTaskState.DONE, TARGET_TASK_ID]),
			);
			console.log(`  宽表无索引耗时: ${elapsed.toFixed(0)} ms, fileCount=${result[0].fileCount}`);
		});

		test("D2. 宽表添加覆盖索引后", async () => {
			await db.execute("CREATE INDEX idx_subTasks_tid_state_size ON subTasks(taskId, subTaskState, fileSize)");

			const { elapsed, result } = await measureTime(() =>
				db.query(SQL_AGGREGATE, [SubTaskState.DONE, SubTaskState.ERROR, SubTaskState.DONE, TARGET_TASK_ID]),
			);
			console.log(`  宽表有索引耗时: ${elapsed.toFixed(0)} ms, fileCount=${result[0].fileCount}`);
		});
	});
});
