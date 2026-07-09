import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { escapeValue } from "./escape.js";

describe("escapeValue", () => {
	test("转义含单引号的字符串", () => {
		assert.equal(escapeValue("O'Brien"), "'O''Brien'");
	});

	test("支持 null 和 undefined", () => {
		assert.equal(escapeValue(null), "NULL");
		assert.equal(escapeValue(undefined), "NULL");
	});

	test("支持数字和 bigint", () => {
		assert.equal(escapeValue(123), "123");
		assert.equal(escapeValue(123n), "123");
	});

	test("支持布尔值", () => {
		assert.equal(escapeValue(true), "TRUE");
		assert.equal(escapeValue(false), "FALSE");
	});

	test("支持 Date 值", () => {
		const date = new Date("2024-01-15T10:30:00.000Z");
		assert.equal(escapeValue(date), "'2024-01-15T10:30:00.000Z'");
	});

	test("不支持的类型时抛出错误", () => {
		assert.throws(() => escapeValue(Symbol("x")), /Unsupported parameter type/);
	});

	test("空字符串正确转义", () => {
		assert.equal(escapeValue(""), "''");
	});

	test("含换行和制表符的字符串", () => {
		assert.equal(escapeValue("line1\nline2\tend"), "'line1\nline2\tend'");
	});

	test("含反斜杠的字符串", () => {
		assert.equal(escapeValue("path\\to\\file"), "'path\\to\\file'");
	});

	test("unicode 字符串", () => {
		assert.equal(escapeValue("hello 世界"), "'hello 世界'");
	});

	test("fuzz：随机字符串不崩溃", () => {
		const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-!@#$%^&*()\"'\\\\\\n\\r\\t\\x00你好";
		for (let i = 0; i < 500; i++) {
			const len = Math.floor(Math.random() * 50) + 1;
			let s = "";
			for (let j = 0; j < len; j++) {
				s += chars[Math.floor(Math.random() * chars.length)];
			}
			const result = escapeValue(s);
			assert.ok(typeof result === "string", `escapeValue 应返回字符串，输入: ${JSON.stringify(s)}`);
			assert.ok(result.startsWith("'"), `结果应以单引号开头: ${result}`);
			assert.ok(result.endsWith("'"), `结果应以单引号结尾: ${result}`);
		}
	});

	test("fuzz：随机数字和布尔值不崩溃", () => {
		for (let i = 0; i < 200; i++) {
			const val = Math.random() > 0.5
				? (Math.random() * 2 ** 32) - 2 ** 31
				: Math.random() > 0.5;
			const result = escapeValue(val);
			assert.ok(typeof result === "string", `escapeValue 应返回字符串，输入: ${val}`);
		}
	});

	test("fuzz：边界字符串值正确转义", () => {
		const cases = [
			"",
			"'",
			"''",
			"\\",
			"\\\\",
			"\n",
			"\r\n",
			"\t",
			"\x00",
			"a'b",
			"a\\'b",
			"hello 'world' test",
			"    ",
			"\'\"\\\n\r\t",
		];
		for (const c of cases) {
			const result = escapeValue(c);
			assert.ok(typeof result === "string", `escapeValue 应返回字符串，输入: ${JSON.stringify(c)}`);
			assert.ok(result.startsWith("'") && result.endsWith("'"), `结果应被引号包裹: ${result}`);
		}
	});
});

describe("fuzz: escapeValue", () => {
	test("随机混合类型不崩溃", () => {
		for (let i = 0; i < 1000; i++) {
			const choice = Math.random();
			let value;
			if (choice < 0.3) {
				// 随机字符串
				const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-!@#$%^&*()\"'\\\\\\n\\r\\t\\x00你好世界🎉";
				const len = Math.floor(Math.random() * 100) + 1;
				let s = "";
				for (let j = 0; j < len; j++) {
					s += chars[Math.floor(Math.random() * chars.length)];
				}
				value = s;
			} else if (choice < 0.5) {
				value = Math.random() > 0.5 ? null : undefined;
			} else if (choice < 0.7) {
				value = Math.random() > 0.5;
			} else if (choice < 0.85) {
				value = (Math.random() * 2 - 1) * 1e308;
			} else if (choice < 0.95) {
				value = BigInt(Math.floor(Math.random() * 1000000));
			} else {
				value = new Date(Date.now() - Math.floor(Math.random() * 1e12));
			}

			try {
				const result = escapeValue(value);
				const display = typeof value === "bigint" ? value.toString() + "n" : JSON.stringify(value);
				assert.ok(typeof result === "string", `escapeValue 应返回字符串，输入: ${display}`);
				if (typeof value === "string") {
					assert.ok(result.startsWith("'") && result.endsWith("'"), `字符串结果应被引号包裹: ${result}`);
				}
			} catch (e) {
				// Symbol 等不支持的类型应抛出 TypeError
				const display = typeof value === "bigint" ? value.toString() + "n" : JSON.stringify(value);
				assert.ok(e instanceof TypeError, `应抛出 TypeError，输入: ${display}`);
			}
		}
	});

	test("大量单引号字符串", () => {
		const s = "'".repeat(1000);
		const result = escapeValue(s);
		assert.ok(typeof result === "string");
		assert.ok(result.startsWith("'"));
		assert.ok(result.endsWith("'"));
		// 每个单引号被转义为两个，所以结果长度应为 2 + 1000*2 = 2002
		assert.equal(result.length, 2002);
	});

	test("空字符串边界", () => {
		assert.equal(escapeValue(""), "''");
	});

	test("各种特殊字符组合", () => {
		const specials = [
			"\\",
			"\\\\",
			"\\n",
			"\\t",
			"\\r",
			"\\'",
			"\\\"",
			"\0",
			"\x00\x01\x1f",
			"null",
			"NULL",
			"undefined",
			"true",
			"false",
			"123",
			"3.14",
		];
		for (const s of specials) {
			const result = escapeValue(s);
			assert.ok(typeof result === "string");
			assert.ok(result.startsWith("'") && result.endsWith("'"));
		}
	});

	test("超大数字不崩溃", () => {
		assert.equal(escapeValue(Infinity), "Infinity");
		assert.equal(escapeValue(-Infinity), "-Infinity");
		assert.equal(escapeValue(NaN), "NaN");
	});

	test("BigInt 边界值", () => {
		assert.equal(escapeValue(0n), "0");
		assert.equal(escapeValue(BigInt(Number.MAX_SAFE_INTEGER)), String(Number.MAX_SAFE_INTEGER));
	});

	test("Date 边界值", () => {
		const dates = [
			new Date(0),
			new Date(-8640000000000000),
			new Date(8640000000000000),
			new Date("invalid"),
		];
		for (const d of dates) {
			try {
				const result = escapeValue(d);
				assert.ok(typeof result === "string");
			} catch (e) {
				// Invalid Date 可能抛出也可能不抛出
				assert.ok(e instanceof Error);
			}
		}
	});
});
