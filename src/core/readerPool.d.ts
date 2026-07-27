import { Logger } from "./executor";

/**
 * 只读 Worker 连接池。
 *
 * 管理多个 TaskWorker 实例，所有 worker 共享同一数据库文件。
 * 通过 Least Busy（最小负载）分配读任务，实现读操作的水平扩展。
 *
 * 注意：ReaderPool 中的 worker 不初始化 WAL 模式（`initMode: "none"`），
 * 直接继承数据库文件头中的 journal 模式，避免与 writer 竞争 WAL 初始化锁。
 */
export class ReaderPool {
	/**
	 * @param options.binary            sqlite3 可执行文件路径
	 * @param options.database          数据库文件路径
	 * @param options.poolSize          Worker 数量
	 * @param options.statementTimeout  单条语句超时（毫秒）
	 * @param options.logger            日志记录器
	 */
	constructor(options: {
		binary: string;
		database: string;
		poolSize: number;
		statementTimeout: number;
		logger?: Logger;
	});

	/** 池中 Worker 数量 */
	get size(): number;

	/** 所有 Worker 排队中的语句总数 */
	get pendingStatements(): number;

	/**
	 * 分发一个读任务到负载最小的 Worker（Least Busy）。
	 * @param task - 任务配置对象
	 */
	enqueue(task: object): void;

	/** 终止所有 Worker */
	kill(): void;
}
