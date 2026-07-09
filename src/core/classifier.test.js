import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { classifySQL } from "./classifier.js";

describe("classifySQL", () => {
	test("SELECT 返回 read", () => {
		assert.equal(classifySQL("SELECT * FROM users"), "read");
	});

	test("WITH 返回 read", () => {
		assert.equal(classifySQL("WITH cte AS (SELECT 1) SELECT * FROM cte"), "read");
	});

	test("VALUES 返回 read", () => {
		assert.equal(classifySQL("VALUES (1, 2, 3)"), "read");
	});

	test("EXPLAIN 返回 read", () => {
		assert.equal(classifySQL("EXPLAIN SELECT * FROM users"), "read");
	});

	test("INSERT 返回 write", () => {
		assert.equal(classifySQL("INSERT INTO users (name) VALUES ('Alice')"), "write");
	});

	test("UPDATE 返回 write", () => {
		assert.equal(classifySQL("UPDATE users SET name = 'Bob' WHERE id = 1"), "write");
	});

	test("DELETE 返回 write", () => {
		assert.equal(classifySQL("DELETE FROM users WHERE id = 1"), "write");
	});

	test("CREATE 返回 write", () => {
		assert.equal(classifySQL("CREATE TABLE users (id INTEGER)"), "write");
	});

	test("DROP 返回 write", () => {
		assert.equal(classifySQL("DROP TABLE users"), "write");
	});

	test("ALTER 返回 write", () => {
		assert.equal(classifySQL("ALTER TABLE users ADD COLUMN age INTEGER"), "write");
	});

	test("PRAGMA 返回 write", () => {
		assert.equal(classifySQL("PRAGMA journal_mode=WAL"), "write");
	});

	test("大小写不敏感", () => {
		assert.equal(classifySQL("select * from users"), "read");
		assert.equal(classifySQL("Select * From users"), "read");
		assert.equal(classifySQL("SELECT * FROM users"), "read");
	});

	test("多语句混合返回 write", () => {
		assert.equal(classifySQL("SELECT 1; INSERT INTO t VALUES (2)"), "write");
	});

	test("空字符串返回 write", () => {
		assert.equal(classifySQL(""), "write");
	});

	test("仅空白字符串返回 write", () => {
		assert.equal(classifySQL("   "), "write");
	});

	test("非字符串返回 write", () => {
		assert.equal(classifySQL(123), "write");
	});

	test("前导空白被忽略", () => {
		assert.equal(classifySQL("  SELECT 1"), "read");
	});

	test("换行前导空白被忽略", () => {
		assert.equal(classifySQL("\n\tSELECT 1"), "read");
	});

	test("单个关键词无空格: SELECT", () => {
		assert.equal(classifySQL("SELECT"), "read");
	});

	test("单个关键词无空格: EXPLAIN", () => {
		assert.equal(classifySQL("EXPLAIN"), "read");
	});

	test("单个关键词无空格: INSERT", () => {
		assert.equal(classifySQL("INSERT"), "write");
	});

	test("缓存命中：相同 SQL 第二次调用从缓存返回", () => {
		assert.equal(classifySQL("SELECT 1 AS cache_hit"), "read");
		// 第二次调用应命中 LRU 缓存
		assert.equal(classifySQL("SELECT 1 AS cache_hit"), "read");
	});

	test("缓存命中：写语句同样缓存", () => {
		assert.equal(classifySQL("INSERT INTO t (v) VALUES (1)"), "write");
		// 第二次调用应命中缓存
		assert.equal(classifySQL("INSERT INTO t (v) VALUES (1)"), "write");
	});

	test("多语句全部 read 返回 read", () => {
		assert.equal(classifySQL("SELECT 1; SELECT 2; VALUES (3)"), "read");
	});

	test("仅分号返回 write", () => {
		assert.equal(classifySQL(";;;"), "write");
	});
});

describe("fuzz: classifySQL", () => {
	test("随机 SQL 关键词不崩溃", () => {
		const keywords = [
			"SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER",
			"WITH", "VALUES", "EXPLAIN", "PRAGMA", "ATTACH", "DETACH",
			"REINDEX", "ANALYZE", "VACUUM", "BEGIN", "COMMIT", "ROLLBACK",
			"SAVEPOINT", "RELEASE", "GRANT", "REVOKE", "TRIGGER", "VIEW",
			"INDEX", "TABLE", "TEMP", "TEMPORARY", "IF", "NOT", "EXISTS",
			"UNION", "INTERSECT", "EXCEPT", "ALL", "DISTINCT", "FROM",
			"WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET",
			"JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "NATURAL",
			"ON", "USING", "SET", "INTO", "DEFAULT", "NULL", "PRIMARY",
			"KEY", "FOREIGN", "REFERENCES", "CHECK", "CONSTRAINT", "UNIQUE",
			"AUTOINCREMENT", "ROWID", "INTEGER", "TEXT", "REAL", "BLOB",
			"NUMERIC", "BOOLEAN", "DATE", "DATETIME",
		];
		for (let i = 0; i < 1000; i++) {
			const count = Math.floor(Math.random() * 10) + 1;
			const parts = [];
			for (let j = 0; j < count; j++) {
				const kw = keywords[Math.floor(Math.random() * keywords.length)];
				parts.push(kw);
			}
			const sql = parts.join(" ");
			const result = classifySQL(sql);
			assert.ok(result === "read" || result === "write", `应返回 read 或 write，输入: ${sql}`);
		}
	});

	test("随机大小写不崩溃", () => {
		const sqls = [
			"select * from users",
			"Select * From users",
			"SELECT * FROM users",
			"SeLeCt * FrOm UsErS",
			"insert into t values (1)",
			"INSERT INTO t VALUES (1)",
			"InSeRt InTo T vAlUeS (1)",
		];
		for (const sql of sqls) {
			const result = classifySQL(sql);
			assert.ok(result === "read" || result === "write");
		}
	});

	test("随机多语句混合", () => {
		const stmts = [
			"SELECT 1",
			"INSERT INTO t VALUES (1)",
			"UPDATE t SET a=1",
			"DELETE FROM t",
			"CREATE TABLE t (id INT)",
			"DROP TABLE t",
			"WITH cte AS (SELECT 1) SELECT * FROM cte",
			"VALUES (1, 2)",
			"EXPLAIN SELECT * FROM t",
		];
		for (let i = 0; i < 500; i++) {
			const count = Math.floor(Math.random() * 5) + 1;
			const selected = [];
			for (let j = 0; j < count; j++) {
				selected.push(stmts[Math.floor(Math.random() * stmts.length)]);
			}
			const sql = selected.join("; ");
			const result = classifySQL(sql);
			assert.ok(result === "read" || result === "write");
			// 如果包含任何写语句，结果应为 write
			const hasWrite = selected.some((s) => {
				const kw = s.split(/\s+/)[0].toUpperCase();
				return !["SELECT", "WITH", "VALUES", "EXPLAIN"].includes(kw);
			});
			if (hasWrite) {
				assert.equal(result, "write", `含写语句的多语句应返回 write: ${sql}`);
			}
		}
	});

	test("各种空白前缀和换行", () => {
		const prefixes = ["", " ", "  ", "\n", "\t", "\n\t ", "  \n  "];
		const sqls = ["SELECT 1", "INSERT INTO t VALUES (1)", "UPDATE t SET a=1"];
		for (const prefix of prefixes) {
			for (const sql of sqls) {
				const result = classifySQL(prefix + sql);
				assert.ok(result === "read" || result === "write");
			}
		}
	});

	test("非字符串类型不崩溃", () => {
		const inputs = [null, undefined, 123, true, {}, [], Symbol("test")];
		for (const input of inputs) {
			assert.equal(classifySQL(input), "write", `非字符串应返回 write`);
		}
	});

	test("超长 SQL 不崩溃", () => {
		const long = "SELECT " + "a".repeat(100000);
		const result = classifySQL(long);
		assert.equal(result, "read");
	});

	test("大量分号分隔的空语句", () => {
		const sql = ";".repeat(1000);
		assert.equal(classifySQL(sql), "write");
	});

	test("仅空白和分号", () => {
		assert.equal(classifySQL(" ; ; ; "), "write");
	});

	test("缓存命中：大量不同 SQL 不冲突", () => {
		const sqls = new Set();
		for (let i = 0; i < 500; i++) {
			sqls.add(`SELECT ${i} AS v`);
		}
		for (const sql of sqls) {
			assert.equal(classifySQL(sql), "read");
		}
	});
});
