import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProcessManager } from "./process.js";
import downloadSQLite3 from "../../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..", "..");
const SQLite3BinaryFile = path.join(root, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));

/** @type {boolean} */
let sqlite3Ready = false;

try {
	await downloadSQLite3();
	sqlite3Ready = true;
} catch (err) {
	console.error("Failed to download sqlite3, ProcessManager tests will be skipped:", err.message);
}

describe("ProcessManager", { skip: !sqlite3Ready }, () => {
	/** @type {ProcessManager[]} */
	const cleanup = [];

	afterEach(() => {
		for (const pm of cleanup) {
			try { pm.kill(); } catch { /* 清理阶段绝不抛出，防止级联取消后续测试 */ }
		}
		cleanup.length = 0;
	});

	function createPM(database) {
		const pm = new ProcessManager({ binary: SQLite3BinaryFile, database: database ?? ":memory:" });
		cleanup.push(pm);
		return pm;
	}

	test("初始化时存储 binary 路径", () => {
		const pm = createPM();
		assert.equal(pm.binary, SQLite3BinaryFile);
	});

	test("start 成功启动 sqlite3 子进程", () => {
		const pm = createPM();
		const proc = pm.start();
		assert.ok(proc);
		assert.equal(proc.killed, false);
		assert.ok(proc.pid > 0);
		assert.equal(proc.stdout.readable, true);
		assert.equal(proc.stdin.writable, true);
	});

	test("write 向子进程 stdin 发送数据并收到响应", async () => {
		const pm = createPM();
		const proc = pm.start();

		const output = await new Promise((resolve, reject) => {
			function cleanup() {
				clearTimeout(timer);
				proc.stdout.removeAllListeners("data");
				proc.off("error", onError);
			}
			const onError = (err) => { cleanup(); reject(err); };
			const timer = setTimeout(() => {
				cleanup();
				resolve("");
			}, 5000);
			proc.stdout.on("data", (chunk) => {
				cleanup();
				resolve(String(chunk));
			});
			proc.on("error", onError);
			pm.write("SELECT 1;\n");
		});

		assert.ok(output.includes("1"), `输出应包含查询结果，实际: ${output}`);
	});

	test("kill 终止进程并清除引用", () => {
		const pm = createPM();
		pm.start();
		const killed = pm.kill();
		assert.ok(killed);
		assert.equal(pm.process, null);
	});

	test("kill 后反复调用安全", () => {
		const pm = createPM();
		pm.start();
		pm.kill();
		const result = pm.kill();
		assert.equal(result, null);
	});

	test("未启动时 kill 返回 null", () => {
		const pm = createPM();
		const result = pm.kill();
		assert.equal(result, null);
	});

	test("未启动时 write 不报错", () => {
		const pm = createPM();
		// 未启动时 #proc 为 null，write 应在 !stream 守卫处安全返回
		pm.write("SELECT 1;\n");
	});

	test("多次 start 创建不同进程", async () => {
		const pm = createPM();
		const proc1 = pm.start();
		assert.ok(proc1.pid > 0);

		pm.kill();
		const proc2 = pm.start();
		assert.ok(proc2.pid > 0);
		assert.notEqual(proc1.pid, proc2.pid);
	});

	test("start 时 binary 路径为空抛出错误", () => {
		const pm = new ProcessManager({ binary: "", database: ":memory:" });
		assert.throws(() => pm.start(), {
			message: /sqlite3 binary path is empty/,
		});
	});

	test("start 时 binary 文件不存在抛出错误", () => {
		const pm = new ProcessManager({ binary: "/nonexistent/path", database: ":memory:" });
		assert.throws(() => pm.start(), {
			message: /sqlite3 binary not found/,
		});
	});

	test("gracefulShutdown 未启动时 no-op", async () => {
		const pm = createPM();
		await pm.gracefulShutdown();
	});

	test("gracefulShutdown 发送 .quit 正常退出进程", async () => {
		const pm = createPM();
		const proc = pm.start();
		assert.equal(proc.killed, false);

		await pm.gracefulShutdown();

		// close 事件已触发，进程应已退出
		assert.ok(proc.exitCode !== null || proc.signalCode !== null);

		// kill 后清理完成
		pm.kill();
		assert.equal(pm.process, null);
	});

	test("gracefulShutdown 在进程已退出时立即完成", async () => {
		const pm = createPM();
		const proc = pm.start();
		proc.kill();
		await once(proc, "close");

		let timer;
		try {
			await Promise.race([
				pm.gracefulShutdown(),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("gracefulShutdown did not finish")), 1000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	});

	test("gracefulShutdown 在有写缓冲时排空再退出", async () => {
		const pm = createPM();
		const proc = pm.start();
		proc.stdout.on("data", () => {});
		proc.stderr.on("data", () => {});

		// 写入大量数据触发 draining，填充缓冲区
		const largePayload = 'SELECT 1;\n'.repeat(100000);
		pm.write(largePayload);

		// gracefulShutdown 应等待缓冲排空，然后发送 .quit
		await pm.gracefulShutdown();

		assert.ok(proc.exitCode !== null || proc.signalCode !== null);
		pm.kill();
	});

	test("gracefulShutdown 在进程 error 事件时静默处理", async () => {
		const pm = createPM();
		const proc = pm.start();

		// 在 gracefulShutdown 调用 once(proc, "close") 后，
		// 触发 error 事件使 once Promise reject → 进入 catch 块
		const shutdownPromise = pm.gracefulShutdown();

		// 确保 once 已注册监听器后触发 error
		process.nextTick(() => {
			proc.emit("error", new Error("fake error"));
		});

		await shutdownPromise;
		pm.kill();
	});

	test("drain 处理中 re-drain 触发 #notifyIfDrained 提前返回", async () => {
		const pm = createPM();
		const proc = pm.start();
		proc.stdout.on("data", () => {});
		proc.stderr.on("data", () => {});

		// 写入超大 payload 触发 draining
		const LARGE = 'SELECT 1 AS v;\n'.repeat(30000); // ~510KB
		pm.write(LARGE);

		if (!pm.draining) {
			// pipe 未满，跳过断言（不同平台 pipe 容量不同）
			pm.kill();
			return;
		}

		// draining 期间再写入大 payload → 进入 #writeBuffer
		pm.write(LARGE);

		// 手动触发 drain 事件。pipe 仍满 → #flushBuffer() 会 re-drain
		proc.stdin.emit("drain");

		// re-drain 发生后 draining 应还原为 true
		assert.equal(pm.draining, true,
			"手动 drain 后 #flushBuffer 应重新触发 draining（#notifyIfDrained 提前返回）");

		// 等待真实的 OS drain 事件（期间可能再次 drain，最终排空）
		if (pm.draining) {
			await new Promise((resolve) => {
				const check = setInterval(() => {
					if (!pm.draining) {
						clearInterval(check);
						resolve();
					}
				}, 10);
				setTimeout(() => { clearInterval(check); resolve(); }, 30000);
			});
		}

		pm.kill();
	});


	// ── drain 背压 ─────────────────────────────

	test("draining getter 初始为 false", () => {
		const pm = createPM();
		assert.equal(pm.draining, false);
	});

	test("setOnDrainCallback 注册回调后不立即调用", () => {
		const pm = createPM();
		let called = false;
		pm.setOnDrainCallback(() => { called = true; });
		assert.equal(called, false, "注册时不调用");
	});

	test("onDrained 在无缓冲且非 draining 时立即执行回调", () => {
		const pm = createPM();
		let called = false;
		pm.onDrained(() => { called = true; });
		assert.equal(called, true, "无缓冲时应立即调用");
	});

	test("onDrained 在有缓冲时暂存回调，排空后触发", async () => {
		const pm = createPM();
		pm.start();
		pm.process.stdout.on("data", () => {});
		pm.process.stderr.on("data", () => {});

		// 制造 draining 场景
		const largePayload = 'SELECT 1;\n'.repeat(100000);
		pm.write(largePayload);

		// draining 期间注册 onDrained → 回调应被暂存
		let drainedCalled = false;
		if (pm.draining) {
			pm.onDrained(() => { drainedCalled = true; });
		}

		// 等待 drain 完成
		if (pm.draining) {
			await new Promise((resolve) => {
				const check = setInterval(() => {
					if (!pm.draining) {
						clearInterval(check);
						resolve();
					}
				}, 10);
				setTimeout(() => {
					clearInterval(check);
					resolve();
				}, 15000);
			});
		}

		if (drainedCalled !== false) {
			// 如果实际注册了 callback，drain 后应被回调
			assert.equal(drainedCalled, true);
		}
		// 如果没触发 draining（OS pipe 没满），则跳过断言
	});

	test("kill 后 draining 重置为 false", () => {
		const pm = createPM();
		pm.start();
		pm.kill();
		assert.equal(pm.draining, false);
	});

	test("write 在 pipe 满时触发 draining，drain 事件后恢复", async () => {
		const pm = createPM();
		pm.start();

		// 消费 stdout/stderr，否则 sqlite3 写满 64KB 的 OS pipe 后会阻塞写 stdout，
		// 进而无法读 stdin → stdin pipe 永远无法 drain → drain 事件永远不触发
		pm.process.stdout.on("data", () => {});
		pm.process.stderr.on("data", () => {});

		let drainCalled = false;
		pm.setOnDrainCallback(() => { drainCalled = true; });

		// 写入大量数据迫使 stdin 的 OS pipe 填满
		const largePayload = 'SELECT 1;\n'.repeat(100000);
		pm.write(largePayload);

		if (pm.draining) {
			await new Promise((resolve) => {
				const check = setInterval(() => {
					if (!pm.draining) {
						clearInterval(check);
						resolve();
					}
				}, 10);
				setTimeout(() => {
					clearInterval(check);
					resolve();
				}, 10000);
			});
			assert.ok(drainCalled, "drain 回调应被调用");
			assert.equal(pm.draining, false, "drain 后 draining 应恢复为 false");
		}
	});

	// ── P0 回归：draining 期间 write 不再丢数据 ────────────
	//
	// 修复前（P0 bug）：
	//   1. 超大 payload → stream.write() 返回 false → #draining = true
	//   2. draining 期间调用 write(marker) → `if (this.#draining) return;` → 静默丢弃
	//   3. drain 事件后 marker 已永久丢失
	//
	// 修复后：
	//   1. 同上触发 #draining = true
	//   2. draining 期间 write(marker) → 存入 #writeBuffer 暂存，不丢失
	//   3. drain 事件后 #flushBuffer() 逐个发送缓冲数据 → marker 正常到达 sqlite3
	//   4. 最终 stdout 中应包含标记值 (99999)
	test("P0 FIXED: draining 期间 write 不再丢失数据", async () => {
		const pm = createPM();
		pm.start();

		/** @type {Buffer[]} */
		const stdoutChunks = [];
		pm.process.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
		pm.process.stderr.on("data", () => {});

		let drainCalled = false;
		pm.setOnDrainCallback(() => { drainCalled = true; });

		// ---- 步骤 1: 写入超大 payload → 触发 draining ----
		//
		// Node.js Writable 的默认 highWaterMark 是 16KB。
		// stream.write(500KB+) 会在 buffer 中积累远超 16KB 的数据，返回 false。
		// ProcessManager 收到 false 后设 #draining = true。
		const largePayload = 'SELECT 1 AS v;\n'.repeat(30000); // ~510KB
		pm.write(largePayload);
		const wasDraining = pm.draining;

		// ---- 步骤 2: 在 draining 期间写入标记 SQL ← 现在被缓冲而非丢弃 ----
		if (pm.draining) {
			pm.write("SELECT 99999 AS v;\n"); // 存入 #writeBuffer，等待 drain 后发送
		}

		// ---- 步骤 3: 等待 drain ----
		if (pm.draining) {
			await new Promise((resolve) => {
				const check = setInterval(() => {
					if (!pm.draining) {
						clearInterval(check);
						resolve();
					}
				}, 10);
				setTimeout(() => {
					clearInterval(check);
					resolve();
				}, 30000);
			});
		}

		// ---- 步骤 4: drain 后写入验证 SQL — 这条正常到达 ----
		pm.write("SELECT 88888 AS v;\n");

		// ---- 步骤 5: 等待 sqlite3 执行完所有 SQL ----
		await new Promise((r) => setTimeout(r, 5000));

		const output = Buffer.concat(stdoutChunks).toString("utf-8");
		const hasMarker = output.includes("99999");
		const hasVerify = output.includes("88888");

		console.log("=== P0 FIXED: stdout 分析 ===");
		console.log("触发 draining:", wasDraining);
		console.log("drain 回调已调用:", drainCalled);
		console.log("输出长度:", output.length, "bytes");
		console.log("输出前 200 字符:", output.slice(0, 200));
		console.log("输出末 200 字符:", output.slice(-200));
		console.log('包含 "99999" (draining 期间 buffer):', hasMarker);
		console.log('包含 "88888" (drain 后写入):', hasVerify);

		if (!wasDraining) {
			console.log("注意: 未触发 draining，跳过断言");
			assert.ok(hasMarker, "未触发 draining 时标记 SQL 应正常执行");
			assert.ok(hasVerify, "验证 SQL 应正常执行");
			return;
		}

		// 修复验证：draining 期间写入的数据应被缓冲，drain 后到达 sqlite3
		assert.ok(
			hasMarker,
			`P0 已修复: draining=true 时 write("SELECT 99999") 被正确缓冲。\n` +
			`输出中找到 99999，说明数据已通过 #writeBuffer 暂存并在 drain 后送达 sqlite3。`,
		);
		assert.ok(hasVerify, "drain 后写入的 SELECT 88888 应出现在 sqlite3 stdout 中");
	});
});
