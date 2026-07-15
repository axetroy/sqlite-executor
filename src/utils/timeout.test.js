import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { DEFAULT_STATEMENT_TIMEOUT, createTimeoutError } from "./timeout.js";

describe("DEFAULT_STATEMENT_TIMEOUT", () => {
	test("默认超时为 30000 毫秒", () => {
		assert.equal(DEFAULT_STATEMENT_TIMEOUT, 30_000);
	});
});

describe("createTimeoutError", () => {
	test("创建 Error 实例", () => {
		const err = createTimeoutError(5000, "SELECT 1");
		assert.ok(err instanceof Error);
	});

	test("错误消息包含超时时间和 SQL", () => {
		const err = createTimeoutError(5000, "SELECT * FROM users");
		assert.ok(err.message.includes("5000ms"));
		assert.ok(err.message.includes("SELECT * FROM users"));
	});

	test("SQL 原样包含在消息中（由调用方保证已规范化）", () => {
		const err = createTimeoutError(1000, "SELECT 1");
		assert.ok(err.message.includes("SELECT 1"));
	});

	test("createTimeoutError 非负超时值", () => {
		const err = createTimeoutError(0, "SELECT 1");
		assert.ok(err instanceof Error);
		assert.ok(err.message.includes("0ms"));
	});

	test("创建多个超时错误互不干扰", () => {
		const err1 = createTimeoutError(1000, "SELECT 1");
		const err2 = createTimeoutError(2000, "SELECT 2");
		assert.ok(err1.message.includes("1000ms"));
		assert.ok(err1.message.includes("SELECT 1"));
		assert.ok(err2.message.includes("2000ms"));
		assert.ok(err2.message.includes("SELECT 2"));
	});

	test("提供 startTime 时包含人类可读的开始时间和截至时间", () => {
		const realStart = performance.now();
		const err = createTimeoutError(5000, "SELECT 1", realStart);
		// 应包含 start 和 deadline 时间戳
		assert.ok(err.message.includes("start: "));
		assert.ok(err.message.includes("deadline: "));
		// 应包含格式化后的持续时间（非原始毫秒数）
		assert.ok(err.message.includes("5.0s") || err.message.includes("5s"));
		// 仍然包含 SQL
		assert.ok(err.message.includes("SELECT 1"));
	});

	test("提供 startTime 且任务已超时时时间计算正确", () => {
		// 模拟 3 秒前开始的任务（timeout=2000ms，已超时）
		const startTime = performance.now() - 3000;
		const err = createTimeoutError(2000, "SELECT 1", startTime);
		// 截至时间应在开始时间之后的 2s
		assert.ok(err.message.includes("start: "));
		assert.ok(err.message.includes("deadline: "));
		assert.ok(err.message.includes("SELECT 1"));
	});

	test("未提供 startTime 时保持向后兼容格式", () => {
		const err = createTimeoutError(5000, "SELECT 1");
		// 不包含 start/deadline 字段
		assert.ok(!err.message.includes("start: "));
		assert.ok(!err.message.includes("deadline: "));
		// 保持旧的简洁格式
		assert.ok(err.message.includes("5000ms"));
		assert.ok(err.message.includes("SELECT 1"));
	});
});
