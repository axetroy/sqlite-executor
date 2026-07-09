import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { normalizeSQL, normalizeSQLTemplate } from "./normalize.js";

describe("normalizeSQL", () => {
	test("去除首尾空白、规范化空格并强制保留末尾分号", () => {
		const sql = normalizeSQL("\n  SELECT   *   FROM users   WHERE id = 1   ;; \n");
		assert.equal(sql, "SELECT * FROM users WHERE id = 1 ;");
	});

	test("保持单行语句规范化", () => {
		assert.equal(normalizeSQL("SELECT 1"), "SELECT 1;");
	});

	test("折叠空白前去除行注释", () => {
		const sql = normalizeSQL("CREATE TABLE t (\n  id INTEGER, -- primary key\n  name TEXT    -- display name\n);");
		assert.equal(sql, "CREATE TABLE t ( id INTEGER, name TEXT );");
	});

	test("不去除单引号字符串内的 --", () => {
		const sql = normalizeSQL("SELECT '--not a comment'");
		assert.equal(sql, "SELECT '--not a comment';");
	});

	test("不去除双引号标识符内的 --", () => {
		const sql = normalizeSQL('SELECT "--not a comment"');
		assert.equal(sql, 'SELECT "--not a comment";');
	});

	test("处理某些行仅有行注释的 SQL", () => {
		const sql = normalizeSQL("-- header comment\nSELECT 1;");
		assert.equal(sql, "SELECT 1;");
	});

	test("处理含行注释的多语句 SQL", () => {
		const sql = normalizeSQL("INSERT INTO t VALUES (1); -- first row\nINSERT INTO t VALUES (2); -- second row");
		assert.equal(sql, "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);");
	});

	test("去除块注释 /* */", () => {
		const sql = normalizeSQL("SELECT /* comment */ 1");
		assert.equal(sql, "SELECT 1;");
	});

	test("块注释跨行被去除，末尾空格规范化保留", () => {
		const sql = normalizeSQL("SELECT 1 /* line1\nline2 */ ;");
		assert.equal(sql, "SELECT 1 ;");
	});

	test("字符串内的 /* 不被当作块注释开始", () => {
		const sql = normalizeSQL("SELECT '/* not a comment'");
		assert.equal(sql, "SELECT '/* not a comment';");
	});

	test("字符串内的 */ 不被当作块注释结束", () => {
		const sql = normalizeSQL("SELECT '*/ not a comment end'");
		assert.equal(sql, "SELECT '*/ not a comment end';");
	});

	test("行注释和块注释都被去除", () => {
		const sql = normalizeSQL("SELECT 1; -- row\n/* block */ SELECT 2");
		assert.equal(sql, "SELECT 1; SELECT 2;");
	});

	test("只有空白和注释的 SQL 返回 ;", () => {
		assert.equal(normalizeSQL("  -- just a comment\n  /* another */  "), ";");
	});

	test("空字符串返回 ;", () => {
		assert.equal(normalizeSQL(""), ";");
	});

	test("重复分号被折叠为单个", () => {
		assert.equal(normalizeSQL("SELECT 1;;;"), "SELECT 1;");
	});

	test("Unicode 字符串内容无损", () => {
		const sql = normalizeSQL("SELECT '你好世界 🎉'");
		assert.equal(sql, "SELECT '你好世界 🎉';");
	});

	test("超长 SQL 触发 buffer 扩容", () => {
		const long = "SELECT " + "very_long_column_name ".repeat(80) + "FROM t";
		const result = normalizeSQL(long);
		assert.ok(result.endsWith(";"));
		assert.ok(result.includes("FROM t"));
	});
});

describe("normalizeSQLTemplate", () => {
	test("无 ? 时返回 normalized 和 paramCount=0", () => {
		const t = normalizeSQLTemplate("SELECT * FROM users");
		assert.equal(t.normalized, "SELECT * FROM users;");
		assert.equal(t.paramCount, 0);
		assert.deepEqual(t.segments, ["SELECT * FROM users;"]);
	});

	test("含 ? 时正确追踪位置", () => {
		const t = normalizeSQLTemplate("SELECT * FROM users WHERE id = ? AND name = ?");
		assert.equal(t.normalized, "SELECT * FROM users WHERE id = ? AND name = ?;");
		assert.equal(t.paramCount, 2);
		assert.equal(t.segments.length, 3);
		assert.equal(t.segments[0], "SELECT * FROM users WHERE id = ");
		assert.equal(t.segments[1], " AND name = ");
		assert.equal(t.segments[2], ";");
	});

	test("字符串内的 ? 不被追踪", () => {
		const t = normalizeSQLTemplate("SELECT '?' AS q");
		assert.equal(t.normalized, "SELECT '?' AS q;");
		assert.equal(t.paramCount, 0);
	});

	test("注释内的 ? 不被追踪", () => {
		const t = normalizeSQLTemplate("SELECT 1 -- ?\nFROM t WHERE id = ?");
		assert.equal(t.normalized, "SELECT 1 FROM t WHERE id = ?;");
		assert.equal(t.paramCount, 1);
	});

	test("只有一个 ?", () => {
		const t = normalizeSQLTemplate("DELETE FROM t WHERE id = ?");
		assert.equal(t.paramCount, 1);
		assert.equal(t.segments[0], "DELETE FROM t WHERE id = ");
		assert.equal(t.segments[1], ";");
	});

	test("双引号标识符内的转义 \"\" 被保留", () => {
		// normalizeSQL: 在 STATE_DOUBLE_QUOTE 中遇到 "" 应输出一个 "
		const sql = normalizeSQL('SELECT "my""col" FROM t');
		assert.equal(sql, 'SELECT "my""col" FROM t;');
	});

	test("normalizeSQLTemplate 含双引号转义 \"\"", () => {
		const t = normalizeSQLTemplate('SELECT "my""col" FROM t WHERE id = ?');
		assert.equal(t.normalized, 'SELECT "my""col" FROM t WHERE id = ?;');
		assert.equal(t.paramCount, 1);
	});

	test("多次调用缓存命中返回相同对象", () => {
		const a = normalizeSQLTemplate("SELECT 1");
		const b = normalizeSQLTemplate("SELECT 1");
		assert.equal(a, b);
	});

	test("与 normalizeSQL 结果一致", () => {
		const raw = "  SELECT   *   FROM   users  WHERE  id  =  1  ;; ";
		assert.equal(normalizeSQLTemplate(raw).normalized, normalizeSQL(raw));
	});
});

describe("fuzz: normalizeSQL", () => {
	test("随机 SQL 字符串不崩溃", () => {
		const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-!@#$%^&*()[]{}<>.,;:'\"\\/\\n\\r\\t`~|";
		for (let i = 0; i < 1000; i++) {
			const len = Math.floor(Math.random() * 100) + 1;
			let s = "";
			for (let j = 0; j < len; j++) {
				s += chars[Math.floor(Math.random() * chars.length)];
			}
			const result = normalizeSQL(s);
			assert.ok(typeof result === "string", `normalizeSQL 应返回字符串，输入: ${JSON.stringify(s)}`);
			assert.ok(result.endsWith(";"), `结果应以分号结尾: ${result}`);
		}
	});

	test("随机 SQL 模板不崩溃", () => {
		const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-!@#$%^&*()[]{}<>.,;:'\"\\~`?";
		for (let i = 0; i < 1000; i++) {
			const len = Math.floor(Math.random() * 80) + 1;
			let s = "";
			for (let j = 0; j < len; j++) {
				s += chars[Math.floor(Math.random() * chars.length)];
			}
			const result = normalizeSQLTemplate(s);
			assert.ok(typeof result.normalized === "string", `normalized 应为字符串`);
			assert.ok(Array.isArray(result.segments), `segments 应为数组`);
			assert.ok(typeof result.paramCount === "number", `paramCount 应为数字`);
			assert.ok(result.paramCount >= 0, `paramCount 应 >= 0`);
			assert.equal(result.segments.length, result.paramCount + 1, `segments 长度应为 paramCount + 1`);
		}
	});

	test("极端嵌套注释不崩溃", () => {
		// 深层嵌套块注释（SQLite 不支持嵌套注释，但解析器应安全处理）
		// 注意：/* /* */ 中内层的 */ 会关闭外层的 /*，所以结果不是纯注释
		let sql = "SELECT 1";
		for (let i = 0; i < 100; i++) {
			sql = `/* ${sql} */`;
		}
		const result = normalizeSQL(sql);
		assert.ok(typeof result === "string", "应返回字符串");
		assert.ok(result.endsWith(";"), "结果应以分号结尾");
	});

	test("大量连续空白字符", () => {
		const spaces = " ".repeat(10000);
		const sql = `SELECT${spaces}1${spaces}FROM${spaces}t`;
		const result = normalizeSQL(sql);
		assert.equal(result, "SELECT 1 FROM t;");
	});

	test("大量连续分号", () => {
		const sql = "SELECT 1" + ";".repeat(1000);
		const result = normalizeSQL(sql);
		assert.equal(result, "SELECT 1;");
	});

	test("混合极端空白和注释", () => {
		const sql = "  \t\n\r  -- line\n  /* block */  \n  SELECT  \t  1  ;;  \n  ";
		const result = normalizeSQL(sql);
		// 块注释后的空白可能产生一个空格，但结果应以分号结尾
		assert.ok(typeof result === "string", "应返回字符串");
		assert.ok(result.endsWith(";"), "结果应以分号结尾");
		assert.ok(result.includes("SELECT 1"), "结果应包含 SELECT 1");
	});

	test("字符串内包含各种特殊字符", () => {
		const specials = [
			"SELECT 'hello''world'",
			"SELECT 'test\\'s'",
			'SELECT "my""col"',
			"SELECT '--not comment'",
			"SELECT '/* not block */'",
			"SELECT '?placeholder'",
			"SELECT 'line1\nline2'",
			"SELECT 'tab\there'",
		];
		for (const sql of specials) {
			const result = normalizeSQL(sql);
			assert.ok(typeof result === "string", `应返回字符串: ${sql}`);
			assert.ok(result.endsWith(";"), `结果应以分号结尾: ${result}`);
		}
	});

	test("大量 ? 占位符", () => {
		const placeholders = Array.from({ length: 500 }, (_, i) => `?`).join(", ");
		const sql = `SELECT ${placeholders}`;
		const result = normalizeSQLTemplate(sql);
		assert.equal(result.paramCount, 500, `应有 500 个占位符`);
		assert.equal(result.segments.length, 501, `应有 501 个 segments`);
	});

	test("Unicode 边界字符", () => {
		const unicodeCases = [
			"SELECT '\\u0000'",
			"SELECT '\\uffff'",
			"SELECT '你好世界🎉测试'",
			"SELECT '\\n\\r\\t\\b\\f'",
			"SELECT '\\x00\\x1f\\x7f'",
		];
		for (const sql of unicodeCases) {
			const result = normalizeSQL(sql);
			assert.ok(typeof result === "string", `应返回字符串: ${sql}`);
			assert.ok(result.endsWith(";"), `结果应以分号结尾: ${result}`);
		}
	});

	test("空字符串和纯空白", () => {
		assert.equal(normalizeSQL(""), ";");
		assert.equal(normalizeSQL("   "), ";");
		assert.equal(normalizeSQL("\n\t\r  "), ";");
	});

	test("仅注释的 SQL", () => {
		assert.equal(normalizeSQL("--"), ";");
		assert.equal(normalizeSQL("/* */"), ";");
		assert.equal(normalizeSQL("-- comment\n/* block */"), ";");
	});

	test("超长 SQL 不崩溃", () => {
		const long = "SELECT " + "a".repeat(100000) + " FROM t";
		const result = normalizeSQL(long);
		assert.ok(typeof result === "string");
		assert.ok(result.endsWith(";"));
	});

	test("未闭合的字符串和注释不崩溃（防御性）", () => {
		const edgeCases = [
			"SELECT 'unclosed",
			'SELECT "unclosed',
			"SELECT /* unclosed block",
			"SELECT 'unclosed\nwith newline",
			"SELECT -- line comment without newline",
		];
		for (const sql of edgeCases) {
			// 这些输入可能抛出异常（未闭合字符串），也可能返回结果
			// 关键是它们不应导致无限循环或崩溃
			try {
				const result = normalizeSQL(sql);
				assert.ok(typeof result === "string");
			} catch (e) {
				assert.ok(e instanceof Error, "应抛出 Error");
			}
		}
	});
});
