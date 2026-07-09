import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { interpolateSQL, interpolateFromTemplate } from "./interpolate.js";
import { normalizeSQLTemplate } from "./normalize.js";

describe("interpolateSQL", () => {
	test("按顺序插值占位符", () => {
		const sql = interpolateSQL("SELECT * FROM users WHERE name = ? AND age = ?", ["Alice", 18]);
		assert.equal(sql, "SELECT * FROM users WHERE name = 'Alice' AND age = 18");
	});

	test("不替换引号字符串或注释中的占位符", () => {
		const sql = interpolateSQL("SELECT '?', \"?\", ? -- ? in comment\n/* ? block */", [1]);
		assert.equal(sql, "SELECT '?', \"?\", 1 -- ? in comment\n/* ? block */");
	});

	test("参数不足时抛出错误", () => {
		assert.throws(() => interpolateSQL("SELECT ?, ?", [1]), /Too few parameters provided/);
	});

	test("参数过多时抛出错误", () => {
		assert.throws(() => interpolateSQL("SELECT ?", [1, 2]), /Too many parameters provided/);
	});

	test("未闭合的引号字符串或注释时抛出错误", () => {
		assert.throws(() => interpolateSQL("SELECT 'abc ?", []), /Unterminated single-quoted string/);
		assert.throws(() => interpolateSQL('SELECT "abc ?', []), /Unterminated double-quoted identifier\/string/);
		assert.throws(() => interpolateSQL("/* comment ?", []), /Unterminated block comment/);
	});

	test("没有占位符时原样返回", () => {
		assert.equal(interpolateSQL("SELECT 1", []), "SELECT 1");
	});

	test("不含 ? 且无参数时不报错", () => {
		assert.equal(interpolateSQL("SELECT 1", []), "SELECT 1");
	});

	test("不含 ? 但有参数时抛出 Too many parameters", () => {
		assert.throws(() => interpolateSQL("SELECT 1", [42]), /Too many parameters provided/);
	});

	test("含 ? 但传空数组报错", () => {
		assert.throws(() => interpolateSQL("SELECT ?", []), /Too few parameters provided/);
	});

	test("转义单引号 '' 在字符串内不作为结束标记", () => {
		const sql = interpolateSQL("SELECT 'it''s ? ok' AS msg, ? AS val", [42]);
		assert.equal(sql, "SELECT 'it''s ? ok' AS msg, 42 AS val");
	});

	test("转义双引号 \"\" 在标识符内不作为结束标记", () => {
		const sql = interpolateSQL('SELECT "my""col" AS "alias""x", ? AS v', [99]);
		assert.equal(sql, 'SELECT "my""col" AS "alias""x", 99 AS v');
	});
});

describe("interpolateFromTemplate", () => {
	test("使用预解析模板插值", () => {
		const template = normalizeSQLTemplate("SELECT * FROM users WHERE id = ? AND name = ?");
		const sql = interpolateFromTemplate(template, [1, "Alice"]);
		assert.equal(sql, "SELECT * FROM users WHERE id = 1 AND name = 'Alice';");
	});

	test("无 ? 时原样返回 normalized", () => {
		const template = normalizeSQLTemplate("SELECT 1");
		const sql = interpolateFromTemplate(template, []);
		assert.equal(sql, "SELECT 1;");
	});

	test("参数不足时抛出错误", () => {
		const template = normalizeSQLTemplate("SELECT ?, ?");
		assert.throws(() => interpolateFromTemplate(template, [1]), /Too few parameters provided/);
	});

	test("参数过多时抛出错误", () => {
		const template = normalizeSQLTemplate("SELECT ?");
		assert.throws(() => interpolateFromTemplate(template, [1, 2]), /Too many parameters provided/);
	});

	test("字符串内的 ? 不被替换", () => {
		const template = normalizeSQLTemplate("SELECT '?' AS q, ? AS p");
		const sql = interpolateFromTemplate(template, [1]);
		assert.equal(sql, "SELECT '?' AS q, 1 AS p;");
	});

	test("interpolateFromTemplate 包含规范化后的分号", () => {
		const raw = "SELECT * FROM t WHERE a = ? AND b = ?";
		const template = normalizeSQLTemplate(raw);
		const sql = interpolateFromTemplate(template, [1, 2]);
		assert.equal(sql, "SELECT * FROM t WHERE a = 1 AND b = 2;");
	});
});

describe("fuzz: interpolateSQL", () => {
	test("随机 SQL 模板和参数不崩溃", () => {
		const templates = [
			"SELECT ?",
			"SELECT ?, ?",
			"SELECT * FROM t WHERE id = ? AND name = ?",
			"INSERT INTO t VALUES (?, ?, ?)",
			"UPDATE t SET a = ? WHERE b = ?",
			"DELETE FROM t WHERE id = ?",
			"SELECT '?' AS q, ? AS p",
			"SELECT ? -- comment\nFROM t",
			"SELECT /* block */ ? FROM t",
			"SELECT ?; SELECT ?",
			"SELECT ? UNION ALL SELECT ?",
		];
		for (const template of templates) {
			const paramCount = (template.match(/\?/g) || []).length;
			for (let i = 0; i < 50; i++) {
				const params = Array.from({ length: paramCount }, () => {
					const choice = Math.random();
					if (choice < 0.3) {
						const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-!@#$%^&*()\"'\\\\\\n\\r\\t";
						const len = Math.floor(Math.random() * 20) + 1;
						let s = "";
						for (let j = 0; j < len; j++) s += chars[Math.floor(Math.random() * chars.length)];
						return s;
					} else if (choice < 0.5) return Math.random() > 0.5 ? null : undefined;
					else if (choice < 0.7) return Math.random() > 0.5;
					else if (choice < 0.85) return Math.floor(Math.random() * 10000);
					else return Math.random() * 10000;
				});
				try {
					const result = interpolateSQL(template, params);
					assert.ok(typeof result === "string", `interpolateSQL 应返回字符串`);
				} catch (e) {
					assert.ok(e instanceof Error, `应抛出 Error，模板: ${template}, params: ${JSON.stringify(params)}`);
				}
			}
		}
	});

	test("大量 ? 占位符不崩溃", () => {
		const placeholders = Array.from({ length: 200 }, () => "?").join(", ");
		const sql = `SELECT ${placeholders}`;
		const params = Array.from({ length: 200 }, (_, i) => `val-${i}`);
		const result = interpolateSQL(sql, params);
		assert.ok(typeof result === "string");
		for (let i = 0; i < 200; i++) {
			assert.ok(result.includes(`'val-${i}'`), `结果应包含参数 val-${i}`);
		}
	});

	test("字符串内大量转义引号", () => {
		const sql = "SELECT 'it''s ' || ? || ' ok'";
		const result = interpolateSQL(sql, ["really"]);
		assert.equal(result, "SELECT 'it''s ' || 'really' || ' ok'");
	});

	test("混合注释和占位符", () => {
		const cases = [
			{ sql: "SELECT ? -- comment", params: [1], expected: "SELECT 1 -- comment" },
			{ sql: "SELECT /* ? */ ?", params: [1], expected: "SELECT /* ? */ 1" },
			{ sql: "SELECT '?' AS q, ? AS p", params: [42], expected: "SELECT '?' AS q, 42 AS p" },
			{ sql: "SELECT \"?\" AS q, ? AS p", params: [99], expected: 'SELECT "?" AS q, 99 AS p' },
		];
		for (const { sql, params, expected } of cases) {
			const result = interpolateSQL(sql, params);
			assert.equal(result, expected);
		}
	});

	test("参数类型混合不崩溃", () => {
		const sql = "SELECT ?, ?, ?, ?, ?";
		const params = [
			"string",
			42,
			true,
			null,
			3.14,
		];
		const result = interpolateSQL(sql, params);
		assert.equal(result, "SELECT 'string', 42, TRUE, NULL, 3.14");
	});

	test("大量参数不崩溃", () => {
		const count = 500;
		const sql = Array.from({ length: count }, () => "?").join(", ");
		const fullSql = `SELECT ${sql}`;
		const params = Array.from({ length: count }, (_, i) => i);
		const result = interpolateSQL(fullSql, params);
		assert.ok(typeof result === "string");
		for (let i = 0; i < count; i++) {
			assert.ok(result.includes(String(i)), `结果应包含 ${i}`);
		}
	});
});
