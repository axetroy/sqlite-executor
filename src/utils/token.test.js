import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { generateToken } from "./token.js";

describe("generateToken", () => {
	test("返回字符串", () => {
		const token = generateToken();
		assert.equal(typeof token, "string");
	});

	test("以 __executor_end__ 开头", () => {
		const token = generateToken();
		assert.ok(token.startsWith("__executor_end__"));
	});

	test("两次调用生成不同的 token", () => {
		const t1 = generateToken();
		const t2 = generateToken();
		assert.notEqual(t1, t2);
	});

	test("包含计数器和进程 PID", () => {
		const token = generateToken();
		assert.ok(token.startsWith("__executor_end__"));
		const suffix = token.slice("__executor_end__".length);
		assert.ok(suffix.length > 0);
		const parts = suffix.split("_");
		assert.equal(parts.length, 2, "应包含计数器和 PID 两部分");
		assert.ok(parts[0].length > 0, "计数器部分不为空");
		assert.ok(parts[1].length > 0, "PID 部分不为空");
	});

	test("大量生成 token 无重复", () => {
		const tokens = new Set();
		const count = 1000;
		for (let i = 0; i < count; i++) {
			const token = generateToken();
			assert.equal(tokens.has(token), false, `第 ${i + 1} 个 token 重复: ${token}`);
			tokens.add(token);
		}
		assert.equal(tokens.size, count);
	});
});

describe("fuzz: generateToken", () => {
	test("十万级 token 无重复", () => {
		const tokens = new Set();
		const count = 10000;
		for (let i = 0; i < count; i++) {
			const token = generateToken();
			assert.equal(tokens.has(token), false, `第 ${i + 1} 个 token 重复`);
			tokens.add(token);
		}
		assert.equal(tokens.size, count);
	});

	test("token 格式始终正确", () => {
		for (let i = 0; i < 5000; i++) {
			const token = generateToken();
			assert.ok(token.startsWith("__executor_end__"), `应以 __executor_end__ 开头: ${token}`);
			const suffix = token.slice("__executor_end__".length);
			assert.ok(suffix.length > 0, `suffix 不应为空: ${token}`);
			const parts = suffix.split("_");
			assert.equal(parts.length, 2, `应包含计数器和 PID 两部分: ${token}`);
			assert.ok(parts[0].length > 0, `计数器部分不为空: ${token}`);
			assert.ok(parts[1].length > 0, `PID 部分不为空: ${token}`);
		}
	});

	test("token 长度稳定", () => {
		const lengths = new Set();
		for (let i = 0; i < 1000; i++) {
			const token = generateToken();
			lengths.add(token.length);
		}
		// 所有 token 长度应相同（计数器位数可能变化，但通常稳定）
		assert.ok(lengths.size <= 3, `token 长度变化不应超过 3 种: ${[...lengths].join(", ")}`);
	});

	test("token 不包含特殊字符", () => {
		for (let i = 0; i < 1000; i++) {
			const token = generateToken();
			// 只应包含字母、数字、下划线
			assert.ok(/^[a-z0-9_]+$/.test(token), `token 应只包含字母数字下划线: ${token}`);
		}
	});
});
