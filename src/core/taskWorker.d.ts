import { Metrics } from "./metrics";
import { Logger } from "./executor";

/**
 * 单个 sqlite3 进程 Worker，支持管线化（pipelining）。
 *
 * 内部维护 pending 和 inflight 两个队列：
 * - pending：等待写入 stdin 的任务
 * - inflight：已写入 stdin、等待 stdout 返回的任务
 *
 * 当 pending 中有任务且 inflight 未满时，自动将多个任务的 SQL payload
 * 合并为一次 stdin.write() 发送（管线化），由 sqlite3 顺序执行后，
 * 在 stdout 解析时按 FIFO 顺序匹配 sentinel token 逐一完成。
 */
export class TaskWorker {
	/**
	 * @param options.binary            sqlite3 可执行文件路径
	 * @param options.database          数据库文件路径
	 * @param options.statementTimeout  单条语句超时（毫秒）
	 * @param options.logger            日志记录器
	 * @param options.name              Worker 名称，用于日志和调试
	 * @param options.initMode          子进程初始化模式（参考 ProcessManager）
	 * @param options.batchSize         管线化批量大小，默认 10
	 * @param options.maxInflight       最大 inflight 任务数，默认 50
	 * @param options.metrics           指标收集器
	 */
	constructor(options: {
		binary: string;
		database: string;
		statementTimeout: number;
		logger?: Logger;
		name?: string;
		initMode?: "wal" | "none";
		batchSize?: number;
		maxInflight?: number;
		metrics?: Metrics;
	});

	/** Worker 名称 */
	get name(): string;

	/** 当前是否空闲（无 pending 也无 inflight 任务） */
	get idle(): boolean;

	/** 当前排队（pending + inflight）的语句数量 */
	get pendingStatements(): number;

	/**
	 * 加入一个任务到待发送队列。
	 * 内部会触发泵送逻辑，可能立即与队列中其他任务合批发送。
	 * @param config - 任务配置对象，包含 kind、sql、timeout、token、resolve、reject、onRow 等
	 */
	enqueue(config: object): void;

	/** 立即终止子进程，丢弃所有待处理和已发送的任务 */
	kill(): void;
}
