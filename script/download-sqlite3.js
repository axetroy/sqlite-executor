import fs from "node:fs";
import { EOL } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";
import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = join(__dirname, "..");

async function downloadFileWithProgress(url, outputPath) {
	const writer = fs.createWriteStream(outputPath);

	const { data, headers } = await axios({
		method: "get",
		url: url,
		responseType: "stream",
		// 整体超时 60 秒（含下载流式数据），防止 CI 网络慢时无限挂起
		signal: AbortSignal.timeout(60000),
	});

	const totalLength = headers["content-length"];
	let downloadedLength = 0;
	let lastPercent = 0;

	data.on("data", (chunk) => {
		downloadedLength += chunk.length;
		const percent = Math.floor((downloadedLength / totalLength) * 100);

		// 避免频繁打印
		if (percent !== lastPercent && percent % 5 === 0) {
			process.stdout.write(`下载进度: ${percent}%` + EOL);
			lastPercent = percent;
		}
	});

	data.pipe(writer);

	return new Promise((resolve, reject) => {
		writer.on("finish", () => {
			process.stdout.write("\n");
			resolve();
		});
		writer.on("error", reject);
	});
}

function getSQLte3URL() {
	const arch = process.arch;
	switch (process.platform) {
		case "win32": {
			return "https://www.sqlite.org/2025/sqlite-tools-win-x64-3490100.zip";
		}
		case "darwin": {
			if (arch === "arm64") {
				return "https://www.sqlite.org/2025/sqlite-tools-osx-arm64-3490100.zip";
			}
			return "https://www.sqlite.org/2025/sqlite-tools-osx-x64-3490100.zip";
		}
		case "linux": {
			if (arch === "arm64") {
				return "https://www.sqlite.org/2025/sqlite-tools-linux-arm64-3490100.zip";
			}
			return "https://www.sqlite.org/2025/sqlite-tools-linux-x64-3490100.zip";
		}
		default: {
			throw new Error("Unsupported platform: " + process.platform);
		}
	}
}

const printDownloadInfo = (() => {
	let printed = false;

	return () => {
		if (printed) return;

		console.log("SQLite3 already exists, skipping download.");

		printed = true;
	};
})();

/**
 * 在目录树中查找 sqlite3 可执行文件。
 * zip 解压后会包含一层版本目录（如 sqlite-tools-linux-x64-3490100/）。
 */
function findSqlite3(dir) {
	const sqlite3Name = "sqlite3" + (process.platform === "win32" ? ".exe" : "");
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			const candidate = path.join(dir, entry.name, sqlite3Name);
			if (fs.existsSync(candidate)) return candidate;
		}
		const candidate = path.join(dir, sqlite3Name);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * 缓存下载/解压 Promise，避免同一 Worker 内重复下载。
 * 不跨 Worker 共享（Node.js --test 每个文件独立 Worker）。
 * @type {Promise<void> | null}
 */
let downloadPromise = null;

async function main() {
	if (downloadPromise) return downloadPromise;

	const sqlite3Name = "sqlite3" + (process.platform === "win32" ? ".exe" : "");
	const sqlite3Path = join(ROOT, "bin", sqlite3Name);

	if (fs.existsSync(sqlite3Path)) {
		printDownloadInfo();
		return;
	}

	// 文件锁：用目录原子创建作为跨 Worker 互斥锁，防止多个 Worker 同时下载
	const lockDir = join(ROOT, "bin", ".sqlite3-download.lock");
	try {
		fs.mkdirSync(lockDir);
	} catch (err) {
		if (err.code === "EEXIST") {
			// 另一个 Worker 正在下载，等待二进制文件出现（最多等 60 秒）
			const deadline = Date.now() + 60000;
			while (!fs.existsSync(sqlite3Path)) {
				if (Date.now() > deadline) {
					throw new Error("Timed out waiting for sqlite3 binary to be downloaded by another worker");
				}
				await new Promise((r) => setTimeout(r, 500));
			}
			printDownloadInfo();
			return;
		}
		throw err;
	}

	downloadPromise = (async () => {
		console.log("Downloading SQLite3...");

		// 在 bin/ 下创建唯一的工作目录，避免多个 Worker 并行下载时共享文件冲突
		const workDir = fs.mkdtempSync(join(ROOT, "bin", ".sqlite3-dl-"));
		const zipPath = join(workDir, "sqlite3-tool.zip");

		try {
			const url = getSQLte3URL();

			await downloadFileWithProgress(url, zipPath).catch((error) => {
				throw error;
			});

			console.log("SQLite3 downloaded successfully.");

			const extractedDir = join(workDir, "extracted");
			fs.mkdirSync(extractedDir);

			const zip = new AdmZip(zipPath);
			zip.extractAllTo(extractedDir, true);

			const sqlite3InDir = findSqlite3(extractedDir);
			if (!sqlite3InDir) throw new Error("sqlite3 binary not found in extracted zip");

			if (process.platform !== "win32") {
				fs.chmodSync(sqlite3InDir, 0o755);
			}

			// 原子重命名：不会触发 Linux ETXTBSY（不写入正在执行的二进制文件）
			fs.renameSync(sqlite3InDir, sqlite3Path);

			console.log("Setting up SQLite3...");
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	})();

	try {
		await downloadPromise;
	} finally {
		downloadPromise = null;
		// 释放锁（其他 Worker 此时已能检测到 sqlite3Path）
		try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
	}
}

// if main module
if (fileURLToPath(import.meta.url) === process.argv[1]) {
	// Execute the main function
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

export default main;
