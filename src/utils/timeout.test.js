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
		assert.ok(err.message.includes("5s"));
		assert.ok(err.message.includes("5000ms"));
		assert.ok(err.message.includes("SELECT * FROM users"));
	});

	test("错误消息包含人类可读的开始时间和截止时间", () => {
		const startedAt = Date.UTC(2025, 0, 2, 3, 4, 5, 6);
		const err = createTimeoutError(90_500, "SELECT 1", startedAt);
		assert.ok(err.message.includes("1m 30s 500ms (90500ms)"));
		assert.ok(err.message.includes("started at 2025-01-02 03:04:05.006 UTC"));
		assert.ok(err.message.includes("deadline at 2025-01-02 03:05:35.506 UTC"));
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

	test("兼容 performance.now() 格式的 startTime", () => {
		const realStart = performance.now();
		const err = createTimeoutError(5000, "SELECT 1", realStart);
		assert.ok(err.message.includes("started at "));
		assert.ok(err.message.includes("deadline at "));
		assert.ok(err.message.includes("5s"));
		assert.ok(err.message.includes("SELECT 1"));
	});

	test("未提供 startTime 时也包含完整时间信息", () => {
		const err = createTimeoutError(5000, "SELECT 1");
		assert.ok(err.message.includes("started at "));
		assert.ok(err.message.includes("deadline at "));
		assert.ok(err.message.includes("5000ms"));
		assert.ok(err.message.includes("SELECT 1"));
	});

	test("传递 diagnostics 时错误消息包含诊断信息", () => {
		const err = createTimeoutError(5000, "SELECT 1", undefined, {
			queueSize: 5,
			inflightCount: 1,
			pendingFinalizeCount: 0,
			totalPending: 6,
		});
		assert.ok(err.message.includes("diagnostics:"));
		assert.ok(err.message.includes("queueSize=5"));
		assert.ok(err.message.includes("inflightCount=1"));
		assert.ok(err.message.includes("pendingFinalizeCount=0"));
		assert.ok(err.message.includes("totalPending=6"));
	});

	test("传递部分 diagnostics 时缺失字段显示为 ?", () => {
		const err = createTimeoutError(5000, "SELECT 1", undefined, {
			queueSize: 3,
		});
		assert.ok(err.message.includes("queueSize=3"));
		assert.ok(err.message.includes("inflightCount=?"));
		assert.ok(err.message.includes("pendingFinalizeCount=?"));
		assert.ok(err.message.includes("totalPending=?"));
	});
});
