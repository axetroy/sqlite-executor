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

// 转发额外参数（如 --test-update-snapshots）
const extraArgs = process.argv.slice(2).join(" ");

const times = Number(process.env.TEST_TIMES ?? 1);

for (let i = 0; i < times; i++) {
	try {
		execSync(`node ${extraArgs} --test ${files.map((f) => `"${f}"`).join(" ")}`, { stdio: "inherit", shell: true });
	} catch {
		// execSync 已经打印了子进程的错误输出
		process.exit(1);
	}
}
