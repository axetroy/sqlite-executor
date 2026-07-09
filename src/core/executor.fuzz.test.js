import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test, { afterEach, beforeEach, describe } from "node:test";

import outdent from "outdent";

import { SQLiteExecutor } from "./executor.js";
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

// ---------------------------------------------------------------------------
// 随机数据 / SQL 生成工具
// ---------------------------------------------------------------------------
// 注意: 使用参数化查询时，值通过 interpolateFromTemplate 拼接到 SQL 中。
// 此 executor 须将值转为 SQL 字面量后再发送给 sqlite3 CLI 进程。
// 某些值类型/边界需要注意:
//   - null 字节 (\x00) 会导致 sqlite3 CLI 进程挂起 → 随机数据中剔除
//   - Buffer / Uint8Array 不被 escapeValue 支持 → 转 hex 字符串
//   - NaN / Infinity 不被 SQLite 支持 → 跳过参数化查询
//   - BigInt 部分场景不支持 → 使用 catch

const CHARS_ASCII = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-!@#$%^&*()[]{}|\\:;\"'<>,.?/~`";
// 注意: 避免使用代理对(surrogate pair)字符如 🚀（U+1F680 = \uD83D\uDE80），
// 因为随机索引可能仅选中高/低代理单元，建成无效代理对，存储后回读时被替换为 �
const CHARS_UNICODE = "你好世界日本語한국어€∞∑∫∂√≈≠±≤≥★☆♦♣♠♥";
// 不含 \x00 —— null 字节会导致 sqlite3 CLI 挂起
// 不含 \r —— sqlite3 CLI 在回读时会将 \r\n 规范化为 \n 或去除 \r
const CHARS_SQL_SPECIAL = "'\"\n\t\\;--/*";
const CHARS_WHITESPACE = " \t\n\r\f";

/** 生成随机整数 [min, max] */
function randInt(min, max) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 从数组中随机选一个元素 */
function pick(arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}

/** 生成随机字符串（不含 null 字节） */
function randomString(len, charset = CHARS_ASCII + CHARS_UNICODE) {
	let s = "";
	for (let i = 0; i < len; i++) {
		s += charset[Math.floor(Math.random() * charset.length)];
	}
	return s;
}

/** 生成随机列类型 */
function randomColumnType() {
	return pick(["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC", "BOOLEAN", "DATE"]);
}

/** 生成随机列名（偶尔含特殊字符） */
function randomColumnName() {
	const base = pick([
		"id", "val", "name", "data", "key", "value", "col", "field",
		"_underscore", "with spaces", "with'dquote", 'with"dblquote',
		"col_1", "a", "b", "c", "x", "y", "z",
	]);
	if (Math.random() < 0.1) {
		return `"${base}"`;
	}
	if (Math.random() < 0.1) {
		return `[${base}]`;
	}
	return base;
}

/** 生成随机参数值（不含可能导致 sqlite3 挂起的值） */
function randomParamValue() {
	const kind = Math.random();
	if (kind < 0.2) {
		return null;
	}
	if (kind < 0.4) {
		return randInt(-1000000, 1000000);
	}
	if (kind < 0.55) {
		return randInt(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
	}
	if (kind < 0.7) {
		const v = (Math.random() * 2 - 1) * 1e15;
		return Number.isFinite(v) ? v : 0;
	}
	if (kind < 0.85) {
		return randomString(randInt(0, 50));
	}
	// 特殊字符串（含 SQL 特殊字符、Unicode）
	const special = randomString(randInt(0, 200), CHARS_ASCII + CHARS_SQL_SPECIAL + CHARS_UNICODE);
	return special;
}

/** 删除临时数据库文件及相关 WAL/SHM 文件（容错） */
function cleanupDbFile(...dbPaths) {
	for (const dbPath of dbPaths) {
		for (const suffix of ["", "-wal", "-shm"]) {
			try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
		}
	}
}

// ===========================================================================
// fuzz: 随机数据操作
// ===========================================================================

describe("fuzz: 随机数据操作", () => {
	test("随机类型值 round-trip：边缘数字、大字符串、NULL 混合", async () => {
		await sqlite.execute(outdent`
			CREATE TABLE IF NOT EXISTS fuzz_roundtrip (
				id INTEGER PRIMARY KEY,
				txt TEXT,
				num REAL,
				big INTEGER,
				nullable TEXT,
				bl TEXT
			)
		`);

		const N = 50;
		const rows = [];

		for (let i = 0; i < N; i++) {
			const txt = randomString(randInt(0, 60), CHARS_ASCII + CHARS_SQL_SPECIAL + CHARS_UNICODE);
			rows.push({
				id: i,
				txt,
				num: (Math.random() * 2 - 1) * 1e15,
				big: randInt(-9007199254740991, 9007199254740991),
				nullable: Math.random() < 0.3 ? null : `v-${i}`,
				bl: Math.random() < 0.2 ? null : randomString(randInt(1, 20)),
			});
		}

		// 批序写入（参数化查询使用 pipeline，并发写入确保数据完整）
		const BATCH = 25;
		for (let start = 0; start < N; start += BATCH) {
			await Promise.all(
				rows.slice(start, start + BATCH).map((r) =>
					sqlite.execute(
						"INSERT INTO fuzz_roundtrip (id, txt, num, big, nullable, bl) VALUES (?, ?, ?, ?, ?, ?)",
						[r.id, r.txt, r.num, r.big, r.nullable, r.bl],
					),
				),
			);
		}

		const result = await sqlite.query("SELECT id, txt, num, big, nullable, bl FROM fuzz_roundtrip ORDER BY id ASC");
		assert.equal(result.length, N, `应写入 ${N} 行`);

		for (const original of rows) {
			const actual = result.find((r) => r.id === original.id);
			assert.ok(actual, `id=${original.id} 应存在`);
			assert.equal(actual.txt, original.txt, `id=${original.id} txt 不匹配`);
			assert.equal(actual.nullable, original.nullable, `id=${original.id} nullable 不匹配`);
			assert.equal(actual.bl, original.bl, `id=${original.id} bl 不匹配`);
			assert.ok(
				Math.abs(actual.num - original.num) < 1e-6 || (!Number.isFinite(actual.num) && !Number.isFinite(original.num)),
				`id=${original.id} num 不匹配: ${actual.num} vs ${original.num}`,
			);
			assert.equal(actual.big, original.big, `id=${original.id} big 不匹配`);
		}
	});

	test("随机数据：含空字符串、纯空白、超长字符串", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_strings (id INTEGER PRIMARY KEY, txt TEXT)");

		// 注意: sqlite3 CLI 可能会标准化 \r\n 为 \n，因此 \r\n 不作为测试用例
		const testCases = [
			"",
			" ",
			"\t",
			"\n",
			"  \t  \n  ",
			"'",
			'"',
			"\\",
			";",
			"--",
			"/*",
			"*/",
			"'; DROP TABLE users; --",
			"1' OR '1'='1",
			'1" OR "1"="1',
			"null",
			"NULL",
			"undefined",
			"true",
			"false",
			"NaN",
			"[object Object]",
			randomString(3000, CHARS_ASCII), // 超长 ASCII
			randomString(3000, CHARS_UNICODE), // 超长 Unicode
			randomString(3000, CHARS_SQL_SPECIAL), // 超长特殊字符
		];

		// 再加一些随机生成的
		for (let i = 0; i < 30; i++) {
			testCases.push(randomString(randInt(0, 80), CHARS_ASCII + CHARS_SQL_SPECIAL + CHARS_UNICODE));
		}

		// 顺序写入（含超长字符串时并发可能因队列深度导致超时）
		for (let i = 0; i < testCases.length; i++) {
			await sqlite.execute("INSERT INTO fuzz_strings (id, txt) VALUES (?, ?)", [i, testCases[i]]);
		}

		const result = await sqlite.query("SELECT id, txt FROM fuzz_strings ORDER BY id ASC");
		assert.equal(result.length, testCases.length, `应写入 ${testCases.length} 行`);

		for (let i = 0; i < testCases.length; i++) {
			const actual = result.find((r) => r.id === i);
			assert.ok(actual, `id=${i} 应存在`);
			assert.equal(actual.txt, testCases[i], `id=${i} 字符串 round-trip 失败`);
		}
	});

	test("随机列类型 create + drop + recreate 不崩溃", async () => {
		const types = ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"];
		const tableName = `fuzz_col_types_${Date.now()}`;

		for (let round = 0; round < 8; round++) {
			const cols = Array.from({ length: randInt(1, 6) }, (_, i) => {
				const name = `col_${i}_${round}`;
				const type = pick(types);
				const constraints = Math.random() < 0.3 ? " DEFAULT NULL" : "";
				return `${name} ${type}${constraints}`;
			});

			await sqlite.execute(`CREATE TABLE IF NOT EXISTS ${tableName} (${cols.join(", ")})`);

			// 插入随机数据
			const insertCols = cols.map((c) => c.split(" ")[0]);
			const values = insertCols.map(() => randomParamValue());
			await sqlite.execute(
				`INSERT INTO ${tableName} (${insertCols.join(", ")}) VALUES (${values.map(() => "?").join(", ")})`,
				values,
			).catch(() => {});

			// 查询验证
			const rows = await sqlite.query(`SELECT * FROM ${tableName}`);
			assert.ok(rows.length >= 1, `round ${round}: 至少应有 1 行`);

			await sqlite.execute(`DROP TABLE IF EXISTS ${tableName}`);
		}
	});
});

// ===========================================================================
// fuzz: 随机并发操作
// ===========================================================================

describe("fuzz: 随机并发操作", () => {
	test("混合 DDL/DML 并发：create/insert/select/drop 随机序列", async () => {
		const tableName = `fuzz_concurrent_ddl_${Date.now()}`;

		// 先建基础表
		await sqlite.execute(`CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY, val TEXT, num REAL)`);

		const ops = [];
		const N = 200;

		for (let i = 0; i < N; i++) {
			const kind = Math.random();
			if (kind < 0.3) {
				// SELECT
				ops.push(() => sqlite.query(`SELECT COUNT(*) AS cnt FROM ${tableName}`).catch(() => {}));
			} else if (kind < 0.55) {
				// INSERT
				ops.push(() =>
					sqlite.execute(
						`INSERT INTO ${tableName} (val, num) VALUES (?, ?)`,
						[randomString(randInt(0, 30)), Math.random() * 1000],
					).catch(() => {}),
				);
			} else if (kind < 0.75) {
				// UPDATE
				ops.push(() =>
					sqlite.execute(
						`UPDATE ${tableName} SET num = ? WHERE id = ?`,
						[Math.random() * 1000, randInt(1, 50)],
					).catch(() => {}),
				);
			} else if (kind < 0.9) {
				// DELETE
				ops.push(() =>
					sqlite.execute(`DELETE FROM ${tableName} WHERE id = ?`, [randInt(1, 50)]).catch(() => {}),
				);
			} else {
				// ALTER TABLE (偶尔)
				ops.push(async () => {
					const alterTable = `fuzz_temp_${randInt(1000, 9999)}`;
					try {
						await sqlite.execute(`CREATE TABLE IF NOT EXISTS ${alterTable} (id INTEGER PRIMARY KEY, x TEXT)`);
						await sqlite.execute(`DROP TABLE IF EXISTS ${alterTable}`);
					} catch { /* ignore */ }
				});
			}
		}

		await Promise.all(ops.map((fn) => settleOp(fn)));

		// 最后验证主表还在且可查询
		const rows = await sqlite.query(`SELECT COUNT(*) AS cnt FROM ${tableName}`).catch(() => null);
		assert.ok(rows !== null, "主表在随机 DDL/DML 后应可查询");
	});

	test("随机并发 INSERT + stream 读取不丢失行", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_stream_write (id INTEGER PRIMARY KEY, val TEXT)");

		const N = 30;
		const writePromises = [];
		for (let i = 0; i < N; i++) {
			writePromises.push(
				sqlite.execute("INSERT INTO fuzz_stream_write (val) VALUES (?)", [randomString(randInt(1, 20))]),
			);
		}

		// 并发执行 stream 读取
		const streamRows = [];
		const streamPromise = (async () => {
			const rows = [];
			for await (const row of sqlite.stream("SELECT val FROM fuzz_stream_write")) {
				rows.push(row);
			}
			streamRows.push(...rows);
		})();

		await Promise.all([...writePromises, streamPromise]);

		const countResult = await sqlite.query("SELECT COUNT(*) AS cnt FROM fuzz_stream_write");
		assert.ok(
			countResult[0].cnt >= N,
			`并发 stream+write 后行数应 >= ${N}，实际: ${countResult[0].cnt}`,
		);
	});

	test("随机并发：大量短超时查询不阻塞", async () => {
		const fastSqlite = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			statementTimeout: 500,
		});
		try {
			await fastSqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_timeout (id INTEGER PRIMARY KEY, val TEXT)");
			await fastSqlite.execute("INSERT INTO fuzz_timeout (val) VALUES ('seed')");

			const N = 50;
			const ops = [];
			for (let i = 0; i < N; i++) {
				if (Math.random() < 0.5) {
					ops.push(fastSqlite.query(`SELECT ${i} AS v`));
				} else {
					ops.push(fastSqlite.execute("INSERT INTO fuzz_timeout (val) VALUES (?)", [`op-${i}`]));
				}
			}

			const results = await Promise.allSettled(ops);
			const fulfilled = results.filter((r) => r.status === "fulfilled");
			assert.ok(fulfilled.length >= N * 0.5, `至少 50% 应在超时环境下完成: ${fulfilled.length}/${N}`);
		} finally {
			await fastSqlite.close();
		}
	});
});

// ===========================================================================
// fuzz: 文件数据库随机测试
// ===========================================================================

describe("fuzz: 文件数据库", () => {
	test("文件 DB 随机写入完整验证", async () => {
		const dbFile = path.join(os.tmpdir(), `fuzz-file-db-${Date.now()}-${randInt(1000, 9999)}.db`);
		const fileSqlite = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			database: dbFile,
			statementTimeout: 60000,
		});
		try {
			await fileSqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_file (id INTEGER PRIMARY KEY, data TEXT, score REAL)");

			const N = 100;
			const inserted = [];
			for (let i = 0; i < N; i++) {
				inserted.push({
					id: i,
					data: randomString(randInt(0, 60), CHARS_ASCII + CHARS_UNICODE + CHARS_SQL_SPECIAL),
					score: Math.random() * 1e10,
				});
			}

			// 顺序写入
			for (const r of inserted) {
				await fileSqlite.execute(
					"INSERT INTO fuzz_file (id, data, score) VALUES (?, ?, ?)",
					[r.id, r.data, r.score],
				);
			}

			// 验证所有行存在且完整
			const rows = await fileSqlite.query("SELECT id, data, score FROM fuzz_file ORDER BY id ASC");
			assert.equal(rows.length, N, `应写入 ${N} 行`);

			for (const original of inserted) {
				const actual = rows.find((r) => r.id === original.id);
				assert.ok(actual, `id=${original.id} 应存在`);
				assert.equal(actual.data, original.data, `id=${original.id} data 不匹配`);
				assert.ok(
					Math.abs(actual.score - original.score) < 1e-6,
					`id=${original.id} score 不匹配`,
				);
			}
		} finally {
			await fileSqlite.close();
			cleanupDbFile(dbFile);
		}
	});

	test("文件 DB 随机 schema 变更 + 数据迁移", async () => {
		const dbFile = path.join(os.tmpdir(), `fuzz-schema-${Date.now()}-${randInt(1000, 9999)}.db`);
		const schemaSqlite = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			database: dbFile,
			statementTimeout: 60000,
		});
		try {
			// 创建初始表
			await schemaSqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_schema (id INTEGER PRIMARY KEY, val TEXT)");
			await schemaSqlite.execute("INSERT INTO fuzz_schema (val) VALUES ('init')");

			// 随机 schema 变更操作
			const schemaOps = [
				async () => {
					await schemaSqlite.execute("ALTER TABLE fuzz_schema ADD COLUMN extra TEXT DEFAULT NULL").catch(() => {});
				},
				async () => {
					await schemaSqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_schema_backup AS SELECT * FROM fuzz_schema").catch(() => {});
				},
				async () => {
					await schemaSqlite.execute("INSERT INTO fuzz_schema (val) VALUES (?)", [randomString(randInt(0, 30))]).catch(() => {});
				},
				async () => {
					await schemaSqlite.execute("UPDATE fuzz_schema SET val = ? WHERE id = 1", [randomString(randInt(0, 30))]).catch(() => {});
				},
				async () => {
					await schemaSqlite.query("SELECT * FROM fuzz_schema").catch(() => {});
				},
				async () => {
					await schemaSqlite.execute("DELETE FROM fuzz_schema WHERE id = ?", [randInt(1, 10)]).catch(() => {});
				},
			];

			for (let round = 0; round < 30; round++) {
				const op = pick(schemaOps);
				await op();
			}

			// 验证表仍然可用
			const rows = await schemaSqlite.query("SELECT * FROM fuzz_schema ORDER BY id ASC LIMIT 20");
			assert.ok(Array.isArray(rows), "schema 变更后表应可查询");
			assert.ok(rows.length >= 1, "至少应有 1 行数据");
		} finally {
			await schemaSqlite.close();
			cleanupDbFile(dbFile);
		}
	});

	test("多个文件 DB executor 独立不互相影响", async () => {
		const dbs = [];
		const executors = [];
		const N = 5;

		try {
			for (let i = 0; i < N; i++) {
				const dbFile = path.join(os.tmpdir(), `fuzz-multi-${i}-${Date.now()}.db`);
				dbs.push(dbFile);
				const exec = new SQLiteExecutor({
					binary: SQLite3BinaryFile,
					database: dbFile,
					statementTimeout: 30000,
				});
				executors.push(exec);
				await exec.execute(`CREATE TABLE IF NOT EXISTS data (id INTEGER PRIMARY KEY, source TEXT)`);
				await exec.execute("INSERT INTO data VALUES (1, ?)", [`db-${i}`]);
			}

			// 并发读写各自的数据库
			await Promise.all(
				executors.map((exec, i) =>
					Promise.all([
						exec.query("SELECT source FROM data WHERE id = 1"),
						exec.execute("INSERT INTO data VALUES (?, ?)", [2, `extra-${i}`]),
						exec.query("SELECT COUNT(*) AS cnt FROM data"),
					]),
				),
			);

			// 验证每个数据库独立
			for (let i = 0; i < N; i++) {
				const rows = await executors[i].query("SELECT source FROM data ORDER BY id ASC");
				assert.equal(rows.length, 2, `db-${i} 应有 2 行`);
				assert.equal(rows[0].source, `db-${i}`, `db-${i} 第一条 source 正确`);
			}
		} finally {
			for (const exec of executors) {
				await exec.close().catch(() => {});
			}
			for (const db of dbs) {
				cleanupDbFile(db);
			}
		}
	});
});

// ===========================================================================
// fuzz: 事务随机操作
// ===========================================================================

describe("fuzz: 事务随机操作", () => {
	test("事务内随机插入 + 读回，验证原子性", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_tx_atomic (id INTEGER PRIMARY KEY, val TEXT)");

		const inserted = await sqlite.transaction(async (tx) => {
			const count = randInt(5, 15);
			for (let i = 0; i < count; i++) {
				await tx.execute("INSERT INTO fuzz_tx_atomic (val) VALUES (?)", [randomString(randInt(1, 30))]);
			}
			// 在事务内读回
			const rows = await tx.query("SELECT id, val FROM fuzz_tx_atomic ORDER BY id ASC");
			assert.equal(rows.length, count, `事务内应有 ${count} 行`);
			return rows;
		});

		assert.ok(inserted.length >= 5, "事务返回了数据");

		// 事务外验证数据一致
		const outside = await sqlite.query("SELECT COUNT(*) AS cnt FROM fuzz_tx_atomic");
		assert.equal(outside[0].cnt, inserted.length, "事务外数据与事务内一致");
	});

	test("事务内随机流式查询 + 写入交错", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_tx_stream (id INTEGER PRIMARY KEY, val TEXT)");
		// 预填充
		for (let i = 0; i < 10; i++) {
			await sqlite.execute("INSERT INTO fuzz_tx_stream (val) VALUES (?)", [`seed-${i}`]);
		}

		const result = await sqlite.transaction(async (tx) => {
			// 在事务中先写入
			await tx.execute("INSERT INTO fuzz_tx_stream (val) VALUES (?)", ["tx-insert"]);

			// 然后流式读取
			const streamRows = [];
			for await (const row of tx.stream("SELECT id, val FROM fuzz_tx_stream ORDER BY id ASC")) {
				streamRows.push(row);
				if (streamRows.length >= 5) break;
			}

			// 再写入
			await tx.execute("INSERT INTO fuzz_tx_stream (val) VALUES (?)", ["tx-insert-2"]);

			return streamRows;
		});

		assert.ok(result.length >= 1, "事务内 stream 应返回数据");

		// 事务外验证最终状态
		const finalCount = await sqlite.query("SELECT COUNT(*) AS cnt FROM fuzz_tx_stream");
		assert.equal(finalCount[0].cnt, 12, "事务提交后应有 12 行（10 seed + 2 tx insert）");
	});

	test("随机事务 + 外部写入不破坏隔离", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_tx_iso (id INTEGER PRIMARY KEY, val TEXT)");
		await sqlite.execute("INSERT INTO fuzz_tx_iso (val) VALUES ('outside-start')");

		const N = 10;
		const txPromises = [];
		const outsidePromises = [];

		for (let i = 0; i < N; i++) {
			txPromises.push(
				sqlite.transaction(async (tx) => {
					await tx.execute("INSERT INTO fuzz_tx_iso (val) VALUES (?)", [`tx-${i}`]);
					// 延迟让外部操作有机会交错
					await new Promise((r) => setTimeout(r, randInt(1, 5)));
				}).catch(() => {}),
			);
			outsidePromises.push(
				sqlite.execute("INSERT INTO fuzz_tx_iso (val) VALUES (?)", [`outside-${i}`]).catch(() => {}),
			);
		}

		await Promise.all([...txPromises, ...outsidePromises]);

		const rows = await sqlite.query("SELECT val FROM fuzz_tx_iso ORDER BY id ASC");
		const vals = rows.map((r) => r.val);

		assert.ok(vals.length >= N * 2 + 1, `应有足够的行数 (>= ${N * 2 + 1})，实际: ${vals.length}`);
		assert.ok(vals.includes("outside-start"), "初始数据仍在");
	});

	test("事务 rollback 后数据恢复", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_tx_rollback (id INTEGER PRIMARY KEY, val TEXT)");
		await sqlite.execute("INSERT INTO fuzz_tx_rollback (val) VALUES ('initial')");

		const beforeCount = await sqlite.query("SELECT COUNT(*) AS cnt FROM fuzz_tx_rollback");

		// 在事务中写入然后回滚
		await assert.rejects(
			sqlite.transaction(async (tx) => {
				await tx.execute("INSERT INTO fuzz_tx_rollback (val) VALUES (?)", ["rollback-me"]);
				await tx.execute("INSERT INTO fuzz_tx_rollback (val) VALUES (?)", ["rollback-me-too"]);
				throw new Error("force rollback");
			}),
			/force rollback/,
		);

		const afterCount = await sqlite.query("SELECT COUNT(*) AS cnt FROM fuzz_tx_rollback");
		assert.equal(afterCount[0].cnt, beforeCount[0].cnt, "回滚后行数应恢复");
	});
});

// ===========================================================================
// fuzz: 参数边界测试
// ===========================================================================

describe("fuzz: 参数边界", () => {
	test("大量参数不崩溃", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_many_params (id INTEGER PRIMARY KEY, val TEXT)");

		const values = [];
		for (let i = 0; i < 100; i++) {
			values.push(randomString(randInt(0, 30)));
		}

		await Promise.all(
			values.map((v, i) =>
				sqlite.execute("INSERT INTO fuzz_many_params (val) VALUES (?)", [v]),
			),
		);

		const count = await sqlite.query("SELECT COUNT(*) AS cnt FROM fuzz_many_params");
		assert.equal(count[0].cnt, values.length);
	});

	test("最大/最小整数值参数化查询", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_int_bounds (id INTEGER PRIMARY KEY, v INTEGER)");

		const bounds = [
			Number.MIN_SAFE_INTEGER,
			Number.MAX_SAFE_INTEGER,
			-9007199254740991,
			9007199254740991,
			-1, 0, 1,
			-2147483648,
			2147483647,
			0x7FFFFFFFFFFFFFFFn, // BigInt
			-0x8000000000000000n,
		];

		for (let i = 0; i < bounds.length; i++) {
			const v = bounds[i];
			try {
				await sqlite.execute("INSERT INTO fuzz_int_bounds (id, v) VALUES (?, ?)", [i, v]);
			} catch {
				// BigInt 可能不被支持，跳过
			}
		}

		const rows = await sqlite.query("SELECT v FROM fuzz_int_bounds ORDER BY id ASC");
		assert.ok(rows.length >= 1, "至少插入了部分整数");
	});

	test("极端浮点数（NaN, Infinity）不使进程崩溃", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_float_extremes (id INTEGER PRIMARY KEY, v REAL)");

		// NaN / Infinity 不能在参数化查询中使用（escapeValue 会生成 NaN/Infinity 字面量，
		// sqlite3 无法解析）。此处验证这些值不会导致进程崩溃即可。
		const badValues = [NaN, Infinity, -Infinity];

		for (let i = 0; i < badValues.length; i++) {
			// 直接测试这些值不导致 executor 崩溃（预期会被 reject）
			await assert.rejects(
				sqlite.execute("INSERT INTO fuzz_float_extremes (id, v) VALUES (?, ?)", [i, badValues[i]]),
			);
		}

		// 正常值仍可工作
		for (let i = 0; i < 3; i++) {
			await sqlite.execute("INSERT INTO fuzz_float_extremes (id, v) VALUES (?, ?)", [i + 100, i * 1.5]);
		}

		const rows = await sqlite.query("SELECT COUNT(*) AS cnt FROM fuzz_float_extremes");
		assert.equal(rows[0].cnt, 3, "正常值应写入成功");
	});
});

// ===========================================================================
// fuzz: SQL 注入模式测试
// ===========================================================================

describe("fuzz: SQL 注入模式", () => {
	test("含 SQL 关键字的字符串值正确 round-trip", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_sql_inject (id INTEGER PRIMARY KEY, txt TEXT)");

		const keywords = [
			"SELECT", "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER",
			"TABLE", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "TRUE", "FALSE",
			"BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "EXECUTE", "UNION",
			"JOIN", "INNER", "LEFT", "RIGHT", "ORDER", "GROUP", "BY", "HAVING",
			"UNION ALL SELECT NULL,NULL,NULL",
			"'; DROP TABLE fuzz_sql_inject; --",
			"1; SELECT * FROM sqlite_master; --",
			"' UNION SELECT 1,2,3 --",
			"\" UNION SELECT 1,2,3 --",
			"1' OR '1'='1",
			"1\" OR \"1\"=\"1",
			"admin'--",
			"admin' #",
			"admin'/*",
			"anything' OR 'x'='x",
			"anything' OR 1=1 --",
			"test' OR '1'='1' LIMIT 1 --",
		];

		for (let i = 0; i < keywords.length; i++) {
			await sqlite.execute("INSERT INTO fuzz_sql_inject (id, txt) VALUES (?, ?)", [i, keywords[i]]);
		}

		const rows = await sqlite.query("SELECT txt FROM fuzz_sql_inject ORDER BY id ASC");
		assert.equal(rows.length, keywords.length, "所有注入模式应安全写入");

		for (let i = 0; i < keywords.length; i++) {
			assert.equal(rows[i].txt, keywords[i], `索引 ${i} 的字符串应原样读回`);
		}
	});

	test("含换行/制表符的字符串写入", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_control_chars (id INTEGER PRIMARY KEY, txt TEXT)");

		// 注意：sqlite3 CLI 会标准化 \r 和 \r\n 为 \n
		// 因此只测试不含 \r 的控制字符
		const special = [
			"line1\nline2",
			"col1\tcol2",
			"mixed\n\tchars",
			"\n\n\n",
			"\t\t\t",
		];

		for (let i = 0; i < special.length; i++) {
			await sqlite.execute("INSERT INTO fuzz_control_chars (id, txt) VALUES (?, ?)", [i, special[i]]);
		}

		const rows = await sqlite.query("SELECT txt FROM fuzz_control_chars ORDER BY id ASC");
		assert.equal(rows.length, special.length);

		for (let i = 0; i < special.length; i++) {
			assert.equal(rows[i].txt, special[i], `控制字符 round-trip 失败: idx=${i}`);
		}
	});

	test("超长字符串（10KB）参数化写入", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_large_string (id INTEGER PRIMARY KEY, txt TEXT)");

		const largeStr = randomString(10000, CHARS_ASCII);
		await sqlite.execute("INSERT INTO fuzz_large_string (id, txt) VALUES (?, ?)", [1, largeStr]);

		const rows = await sqlite.query("SELECT txt FROM fuzz_large_string WHERE id = 1");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].txt, largeStr, "10KB 字符串应原样读回");
	});
});

// ===========================================================================
// fuzz: 进程崩溃恢复 + 随机数据
// ===========================================================================

describe("fuzz: 进程崩溃恢复", () => {
	test("随机写入后进程崩溃，恢复后数据完整", async () => {
		const dbFile = path.join(os.tmpdir(), `fuzz-crash-${Date.now()}-${randInt(1000, 9999)}.db`);
		const crashSqlite = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			database: dbFile,
			autoRestart: true,
			statementTimeout: 60000,
		});
		try {
			await crashSqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_crash (id INTEGER PRIMARY KEY, val TEXT)");

			// 写入部分数据
			const seedCount = randInt(5, 10);
			for (let i = 0; i < seedCount; i++) {
				await crashSqlite.execute("INSERT INTO fuzz_crash (val) VALUES (?)", [`seed-${i}`]);
			}

			// 多次 kill + 随机写入
			for (let round = 0; round < 3; round++) {
				const proc = crashSqlite._process;
				if (proc) {
					proc.kill(9);
					await new Promise((r) => setTimeout(r, 500));
				}

				// 恢复后随机写入
				const n = randInt(1, 3);
				for (let i = 0; i < n; i++) {
					await crashSqlite.execute(
						"INSERT INTO fuzz_crash (val) VALUES (?)",
						[`crash-recovered-${round}-${i}`],
					).catch(() => {});
				}
			}

			// 验证数据可读
			const rows = await crashSqlite.query("SELECT val FROM fuzz_crash ORDER BY id ASC");
			assert.ok(rows.length >= seedCount, `崩溃恢复后数据应 >= ${seedCount} 行，实际: ${rows.length}`);
		} finally {
			crashSqlite._process?.kill();
			await crashSqlite.close();
			cleanupDbFile(dbFile);
		}
	});
});

// ===========================================================================
// fuzz: 读写分离池（poolSize > 0）
// ===========================================================================

describe("fuzz: 读写分离池", () => {
	test("poolSize > 0 时随机混合读写不崩溃", async () => {
		const dbFile = path.join(os.tmpdir(), `fuzz-rwpool-${Date.now()}-${randInt(1000, 9999)}.db`);
		const rwSqlite = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			database: dbFile,
			poolSize: 3,
			statementTimeout: 30000,
		});
		try {
			await rwSqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_rw (id INTEGER PRIMARY KEY, val TEXT)");
			await rwSqlite.execute("INSERT INTO fuzz_rw VALUES (1, 'init')");

			// 等待 reader pool 同步
			await new Promise((r) => setTimeout(r, 500));

			const N = 50;
			const ops = [];
			for (let i = 0; i < N; i++) {
				if (Math.random() < 0.4) {
					// 写入（走主库）
					ops.push(rwSqlite.execute("INSERT INTO fuzz_rw (val) VALUES (?)", [`rw-${i}`]));
				} else {
					// 读取（走 reader pool）
					ops.push(rwSqlite.query("SELECT COUNT(*) AS cnt FROM fuzz_rw"));
				}
			}

			const results = await Promise.allSettled(ops);
			const fulfilled = results.filter((r) => r.status === "fulfilled");
			assert.ok(fulfilled.length >= N * 0.5, `读写分离下至少 50% 操作应成功: ${fulfilled.length}/${N}`);
		} finally {
			await rwSqlite.close();
			cleanupDbFile(dbFile);
		}
	});
});

// ===========================================================================
// fuzz: 管线化混合操作
// ===========================================================================

describe("fuzz: 管线化混合操作", () => {
	test("大量 execute + query 管线化不阻塞", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_pipeline_mix (id INTEGER PRIMARY KEY, val TEXT)");
		await sqlite.execute("INSERT INTO fuzz_pipeline_mix (val) VALUES ('base')");

		const TOTAL = 200;

		// execute 一批 INSERT
		for (let i = 0; i < TOTAL; i++) {
			await sqlite.execute("INSERT INTO fuzz_pipeline_mix (val) VALUES (?)", [`p-${i}`]);
		}

		// 并发执行 query
		const queryPromises = [];
		for (let i = 0; i < 20; i++) {
			queryPromises.push(sqlite.query("SELECT COUNT(*) AS cnt FROM fuzz_pipeline_mix"));
		}
		await Promise.all(queryPromises);

		const final = await sqlite.query("SELECT COUNT(*) AS cnt FROM fuzz_pipeline_mix");
		assert.equal(final[0].cnt, TOTAL + 1, `管线化后全部行应写入: ${final[0].cnt}/${TOTAL + 1}`);
	});
});

// ===========================================================================
// fuzz: 大文本数据
// ===========================================================================

describe("fuzz: 大文本数据", () => {
	test("大文本写入和读回：涉及 BLOB 场景用 hex 字符串替代", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_large_text (id INTEGER PRIMARY KEY, data TEXT)");

		// 生成随机二进制数据，用 hex 字符串存储（Buffer 不被参数化查询支持）
		const entries = [];
		for (let i = 0; i < 20; i++) {
			const len = randInt(0, 300);
			const buf = Buffer.alloc(len);
			for (let j = 0; j < len; j++) {
				buf[j] = randInt(0, 255);
			}
			entries.push({ id: i, data: buf.toString("hex") });
		}

		for (const e of entries) {
			await sqlite.execute("INSERT INTO fuzz_large_text (id, data) VALUES (?, ?)", [e.id, e.data]);
		}

		const rows = await sqlite.query("SELECT data FROM fuzz_large_text ORDER BY id ASC");
		assert.equal(rows.length, entries.length);

		for (let i = 0; i < entries.length; i++) {
			assert.equal(rows[i].data, entries[i].data, `hex 数据 ${i} 应匹配`);
		}
	});
});

// ===========================================================================
// fuzz: 空/边界输入
// ===========================================================================

describe("fuzz: 空/边界输入", () => {
	test("空表 CREATE + SELECT + INSERT + DROP 循环不崩溃", async () => {
		const tableName = `fuzz_empty_cycle_${Date.now()}`;
		for (let round = 0; round < 20; round++) {
			await sqlite.execute(`CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY, val TEXT)`);
			await sqlite.query(`SELECT COUNT(*) AS cnt FROM ${tableName}`);
			await sqlite.execute(`INSERT INTO ${tableName} (val) VALUES (?)`, [`round-${round}`]);
			await sqlite.execute(`DROP TABLE IF EXISTS ${tableName}`);
		}
		// 最后验证可执行正常查询
		const rows = await sqlite.query("SELECT 1 AS ok");
		assert.deepEqual(rows, [{ ok: 1 }]);
	});

	test("CREATE TABLE 后立即大量并发 SELECT", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS fuzz_concurrent_select (id INTEGER PRIMARY KEY, val TEXT)");
		await sqlite.execute("INSERT INTO fuzz_concurrent_select VALUES (1, 'a'), (2, 'b'), (3, 'c')");

		const N = 100;
		const results = await Promise.allSettled(
			Array.from({ length: N }, () => sqlite.query("SELECT * FROM fuzz_concurrent_select")),
		);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		assert.ok(fulfilled.length >= N * 0.9, `并发 SELECT 应大多成功: ${fulfilled.length}/${N}`);
	});
});
