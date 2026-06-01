import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { which } from "./which.js";

const isWindows = os.platform() === "win32";

describe("which", () => {
	test("空命令返回 null", () => {
		assert.equal(which(""), null);
	});

	test("空命令返回 null（多条空格）", () => {
		// also triggers the early-return at the top
		assert.equal(which("   "), null);
	});

	describe("绝对路径", () => {
		test("Windows 绝对路径 + 已有扩展名 → 找到", (t) => {
			t.mock.method(os, "platform", () => "win32");
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-ext-"));
			const filePath = path.join(tmpDir, "tool.cmd");
			fs.writeFileSync(filePath, "@echo off\n");
			try {
				assert.equal(which(filePath), path.resolve(filePath));
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test("Windows 绝对路径 + 已有扩展名但文件不存在 → null", (t) => {
			t.mock.method(os, "platform", () => "win32");
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-ext-miss-"));
			const filePath = path.join(tmpDir, "missing.cmd");
			// 不创建文件，文件不存在
			try {
				assert.equal(which(filePath), null);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test("Windows 绝对路径 + 无扩展名 → 尝试 PATHEXT 找到", (t) => {
			t.mock.method(os, "platform", () => "win32");
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-noext-"));
			// 创建 tool.cmd（无扩展名的 command→尝试 .CMD 扩展名）
			const cmdPath = path.join(tmpDir, "tool.cmd");
			fs.writeFileSync(cmdPath, "@echo off\n");
			const bare = path.join(tmpDir, "tool");
			try {
				const found = which(bare);
				assert.ok(found);
				assert.equal(found.toLowerCase(), cmdPath.toLowerCase());
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test("Windows 绝对路径 + 无扩展名 → PATHEXT 均不匹配 → null", (t) => {
			t.mock.method(os, "platform", () => "win32");
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-noext-"));
			// 创建 tool.xyz（不在 PATHEXT 中，也不对应裸文件）
			const xyzPath = path.join(tmpDir, "tool.xyz");
			fs.writeFileSync(xyzPath, "xyz\n");
			const bare = path.join(tmpDir, "tool");
			try {
				assert.equal(which(bare), null);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test("绝对路径文件不存在 → null", () => {
			const filePath = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);
			assert.equal(which(filePath), null);
		});

		test("UNIX 绝对路径 + 可执行 → 找到（mock platform）", (t) => {
			t.mock.method(os, "platform", () => "linux");
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-unix-abs-"));
			const filePath = path.join(tmpDir, "tool");
			fs.writeFileSync(filePath, "echo test\n");
			fs.chmodSync(filePath, 0o755);
			try {
				assert.equal(which(filePath), path.resolve(filePath));
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test("UNIX 绝对路径文件不存在 → null（mock platform）", (t) => {
			t.mock.method(os, "platform", () => "linux");
			const filePath = path.join(os.tmpdir(), `nonexistent-unix-${Date.now()}`);
			assert.equal(which(filePath), null);
		});
	});

	describe("PATH 查找", () => {
		test("从 PATH 中找到可执行文件", () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-path-"));
			const name = "my-tool";
			const filename = isWindows ? `${name}.cmd` : name;
			const filePath = path.join(tmpDir, filename);
			const originalPath = process.env.PATH;

			fs.writeFileSync(filePath, "echo from path\n");
			if (!isWindows) fs.chmodSync(filePath, 0o755);
			process.env.PATH = `${tmpDir}${path.delimiter}${originalPath || ""}`;

			try {
				const resolved = which(name);
				assert.equal(resolved, filePath);
			} finally {
				process.env.PATH = originalPath;
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test("PATH 中空目录段被跳过", () => {
			const originalPath = process.env.PATH;
			process.env.PATH = `;;${path.delimiter}${originalPath || ""}`;
			try {
				// 找一个肯定存在的命令
				const found = which("node");
				assert.ok(found, "应在 PATH 中找到 node");
				const basename = path.basename(found).toLowerCase();
				assert.ok(
					basename === "node.exe" || basename === "node.cmd" || basename === "node",
					`期望 node 可执行文件，实际得到: ${found}`,
				);
			} finally {
				process.env.PATH = originalPath;
			}
		});

		test("命令未找到时返回 null", () => {
			const originalPath = process.env.PATH;
			process.env.PATH = "";
			try {
				assert.equal(which("definitely-not-exist"), null);
			} finally {
				process.env.PATH = originalPath;
			}
		});

		test("UNIX PATH 查找找到（mock platform）", (t) => {
			t.mock.method(os, "platform", () => "linux");
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-unix-path-"));
			const filePath = path.join(tmpDir, "unixtool");
			fs.writeFileSync(filePath, "echo unix\n");
			fs.chmodSync(filePath, 0o755);
			const originalPath = process.env.PATH;
			process.env.PATH = tmpDir;
			try {
				assert.equal(which("unixtool"), filePath);
			} finally {
				process.env.PATH = originalPath;
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test("UNIX PATH 查找找不到 → null（mock platform）", (t) => {
			t.mock.method(os, "platform", () => "linux");
			const originalPath = process.env.PATH;
			process.env.PATH = "";
			try {
				assert.equal(which("nonexistent-unix-tool"), null);
			} finally {
				process.env.PATH = originalPath;
			}
		});
	});

	describe("getPathExts", () => {
		test("Windows 下返回 PATHEXT 中的扩展名列表", (t) => {
			t.mock.method(os, "platform", () => "win32");
			const origPathext = process.env.PATHEXT;
			process.env.PATHEXT = ".ZZZ;.YYY";
			try {
				const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-exts-"));
				const zzzFile = path.join(tmpDir, "test.zzz");
				const yyyFile = path.join(tmpDir, "test.yyy");
				fs.writeFileSync(zzzFile, "");
				fs.writeFileSync(yyyFile, "");
				try {
					// .ZZZ 在 PATHEXT 中排在前面，应优先找到 test.zzz
					const found = which(path.join(tmpDir, "test"));
					assert.ok(found);
					assert.equal(found.toLowerCase(), zzzFile.toLowerCase());
				} finally {
					fs.rmSync(tmpDir, { recursive: true, force: true });
				}
			} finally {
				process.env.PATHEXT = origPathext;
			}
		});

		test("PATHEXT 环境变量不存在时使用默认值", (t) => {
			t.mock.method(os, "platform", () => "win32");
			const origPathext = process.env.PATHEXT;
			delete process.env.PATHEXT;
			try {
				const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-defext-"));
				const exeFile = path.join(tmpDir, "tool.exe");
				fs.writeFileSync(exeFile, "");
				try {
					const found = which(path.join(tmpDir, "tool"));
					assert.ok(found);
					assert.equal(found.toLowerCase(), exeFile.toLowerCase());
				} finally {
					fs.rmSync(tmpDir, { recursive: true, force: true });
				}
			} finally {
				process.env.PATHEXT = origPathext;
			}
		});
	});
});
