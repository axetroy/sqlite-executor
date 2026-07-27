import { Metrics } from './metrics.js'
import {  ReaderPool } from './readerPool.js'

/** 日志接口，可选实现多个级别 */
export interface Logger {
	log?(...messages: unknown[]): void;
	info?(...messages: unknown[]): void;
	warn?(...messages: unknown[]): void;
	error?(...messages: unknown[]): void;
	debug?(...messages: unknown[]): void;
}

/** SQLiteExecutor 构造选项 */
export interface SQLiteExecutorOptions {
	/** sqlite3 可执行文件路径，默认自动查找 */
	binary?: string;
	/** 数据库文件路径，默认 ":memory:" */
	database?: string;
	/** 日志记录器 */
	logger?: Logger;
	/**
	 * 单条语句超时时间（毫秒），默认 30000。
	 * 设为 0 可禁用超时。
	 */
	statementTimeout?: number;
	/** 子进程崩溃后是否自动重启，默认 true */
	autoRestart?: boolean;
	/**
	 * 只读 Worker 池大小。
	 * - 设为 0（默认）：不使用读写分离，所有操作走同一个 writer 进程
	 * - 设为 >0：启用读写分离，读操作分发到 reader pool
	 * - `:memory:` 数据库忽略此选项（始终为 0）
	 */
	poolSize?: number;
	/**
	 * 运行时指标收集器。
	 * 未指定时自动创建内部实例。
	 */
	metrics?: Metrics;
}

/** 单条语句的执行选项 */
export interface StatementOptions {
	/** 覆盖超时时间（毫秒） */
	timeout?: number;
}

/** 事务选项 */
export interface TransactionOptions {
	/** 事务锁模式 */
	mode?: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE";
}

/** 事务句柄，在事务回调中代替 SQLiteExecutor 执行语句 */
export interface TransactionHandle {
	execute(sql: string, params?: any[], options?: StatementOptions): Promise<void>;
	query<T = any>(sql: string, params?: any[], options?: StatementOptions): Promise<T[]>;
	stream<T = any>(sql: string, params?: any[], options?: StatementOptions): AsyncIterable<T>;
}

/**
 * SQLiteExecutor - 异步 SQLite 执行器。
 *
 * 通过衍生 sqlite3 子进程（JSON 模式）执行 SQL 语句。
 * 支持连接池、自动重启、超时控制、读写分离和流式查询。
 */
export declare class SQLiteExecutor implements AsyncDisposable, Disposable {
	constructor(options?: SQLiteExecutorOptions);

	/** 当前排队等待执行的语句数量 */
	get pendingStatements(): number;

	/**
	 * 只读 Worker 池实例。
	 * - 启用读写分离时（poolSize > 0 且非 :memory:）返回 ReaderPool
	 * - 否则返回 null
	 */
	get readerPool(): ReaderPool | null;

	/** 运行时指标收集器。 */
	get metrics(): Metrics;

	/** 执行写操作（INSERT/UPDATE/CREATE 等），返回无行结果 */
	execute(sql: string, params?: any[], options?: StatementOptions): Promise<void>;

	/** 执行查询并返回所有结果行数组 */
	query<T = any>(sql: string, params?: any[], options?: StatementOptions): Promise<T[]>;

	/** 流式执行查询，返回 AsyncIterable，可配合 `for await` 逐行消费 */
	stream<T = any>(sql: string, params?: any[], options?: StatementOptions): AsyncIterable<T>;

	/** 在事务中执行回调，所有操作在同一连接上完成 */
	transaction<T>(fn: (tx: TransactionHandle) => Promise<T>, options?: TransactionOptions): Promise<T>;

	/** 关闭所有子进程，释放资源 */
	close(): Promise<void>;

	[Symbol.asyncDispose](): Promise<void>;
	[Symbol.dispose](): void;
}
