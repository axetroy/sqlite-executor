#!/usr/bin/env node

/**
 * 跨平台测试运行器。
 *
 * Node.js 20 (<20.12) 的 --test 不支持 glob 模式，
 * 而 Node 22+ 原生支持。本脚本递归查找 src/ 下所有
 * *.test.js 并显式传给 node --test，保证各版本兼容。
 */

import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = join(__dirname, "..");
const srcDir = join(root, "src");

/** 递归查找所有 *.test.js */
function findTestFiles(dir) {
	const entries = readdirSync(dir, { withFileTypes: true });
	const result = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			result.push(...findTestFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".test.js")) {
			result.push(full);
		}
	}
	return result;
}

const files = findTestFiles(srcDir);

if (files.length === 0) {
	console.error("No test files found under src/");
	process.exit(1);
}

/**
 * 根据 Node.js 版本返回合适的 --test-isolation 标志。
 *
 * 背景: Node.js 测试运行器默认按文件隔离启动子进程，通过 V8 structured clone
 * 经 IPC 传回结果，存在偶发 Bug（nodejs/node#56802），数据损坏时抛出
 * "Unable to deserialize cloned data"。设置 isolation=none 可禁用 IPC 路径。
 *
 * | Node.js 版本         | 标志                                                        |
 * |----------------------|-------------------------------------------------------------|
 * | < 22.8.0             | 不支持（如 v20），跳过                                      |
 * | >= 22.8.0 且 < 24   | --experimental-test-isolation=none                          |
 * | >= 24                | --test-isolation=none（稳定名）                             |
 *
 * @returns {string} 隔离标志（空字符串表示不添加）
 */
function getIsolationFlag() {
	const parts = process.version.slice(1).split(".").map(Number);
	const major = parts[0];
	const minor = parts[1];

	if (major < 22) return "";
	if (major === 22 && minor < 8) return "";

	return major >= 24 ? "--test-isolation=none" : "--experimental-test-isolation=none";
}

const isolationFlag = getIsolationFlag();

// 转发额外参数（如 --test-update-snapshots）
const extraArgs = process.argv.slice(2).join(" ");

const times = Number(process.env.TEST_TIMES ?? 1);

for (let i = 0; i < times; i++) {
	try {
		const cmd = `node ${extraArgs}${isolationFlag ? ` ${isolationFlag}` : ""} --test ${files.map((f) => `"${f}"`).join(" ")}`;
		execSync(cmd, { stdio: "inherit", shell: true });
	} catch {
		// execSync 已经打印了子进程的错误输出
		process.exit(1);
	}
}
