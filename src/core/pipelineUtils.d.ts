import { InflightTracker } from "./inflightTracker";
import { Metrics } from "./metrics";
import { Queue } from "./queue";

// ─── finalizePendingTasks ───

/**
 * 批量结算 pendingFinalize 集合中的所有任务。
 * 由 scheduleFinalizeCheck 的 setImmediate 回调调用。
 *
 * @param tasks     - pendingFinalizeTasks 集合
 * @param settle    - 结算回调，形式为 (task, error, value) => void
 * @param pumpQueue - 泵送回调，结算后触发队列发送
 */
export function finalizePendingTasks(
	tasks: Set<object>,
	settle: (task: object, error: Error | null, value: any) => void,
	pumpQueue: () => void,
): void;

// ─── prepareTaskTimeout ───

/**
 * 处理单任务超时：防重复结算、清除定时器、更新指标、创建超时错误。
 *
 * @param task    - 任务对象
 * @param metrics - 可选的指标收集器
 * @returns 已创建的 TimeoutError；若任务已结算则返回 null
 */
export function prepareTaskTimeout(
	task: object,
	metrics: Metrics | null | undefined,
): Error | null;

// ─── createSweeper ───

export interface Sweeper {
	/** 启动 sweep 定时器（如果尚未启动）。 */
	schedule: () => void;
	/** 停止 sweep 定时器。 */
	clear: () => void;
	/** 获取当前 sweep 定时器引用（测试用）。 */
	getSweepTimer: () => number | null;
}

export interface SweeperOptions {
	/** inflight 任务跟踪器 */
	inflight: InflightTracker;
	/** 超时扫描间隔（毫秒） */
	sweepIntervalMs: number;
	/** 超时任务处理回调 */
	handleTaskTimeout: (task: object) => void;
}

/**
 * 创建 sweep 定时器管理器。
 * schedule() 启动定期扫描，检查 inflight 任务是否超时；
 * clear() 停止定时器。
 */
export function createSweeper(options: SweeperOptions): Sweeper;

// ─── createFinalizeScheduler ───

export interface FinalizeSchedulerOptions {
	/** pendingFinalize 任务集合 */
	pendingFinalizeTasks: Set<object>;
	/** 结算回调，形式为 (task, error, value) => void */
	settleTask: (task: object, error: Error | null, value: any) => void;
	/** 泵送回调，结算后触发队列发送 */
	pumpQueue: () => void;
}

/**
 * 创建 pendingFinalize 结算调度器。
 * 通过 setImmediate 延迟一帧执行 finalizePendingTasks，给 stderr chunk 到达的时间窗口。
 *
 * @returns 调度函数，调用后将在下一帧执行 finalizePendingTasks
 */
export function createFinalizeScheduler(options: FinalizeSchedulerOptions): () => void;

// ─── handleParsedValue ───

export interface ParsedValueCallbacks {
	/**
	 * sentinel token 命中后的回调。
	 * inflight.shift() 已在调用前执行，此处负责后续处理（pendingFinalize 等）。
	 */
	afterSentinel: (task: object) => void;
	/**
	 * JSON 解析失败时的回调，用于拒绝所有 inflight 任务。
	 */
	rejectAll: (error: Error) => void;
}

/**
 * 处理一个完整的 JSON 值（来自 sharedValueParser）。
 * 匹配 sentinel token、收集 query 行数据、触发 stream 回调。
 * PipelineEngine 和 TaskWorker 共享此逻辑。
 *
 * @param raw      - 原始 JSON 文本
 * @param inflight - inflight 任务跟踪器
 * @param callbacks - afterSentinel 和 rejectAll 回调
 */
export function handleParsedValue(
	raw: string,
	inflight: InflightTracker,
	callbacks: ParsedValueCallbacks,
): void;

// ─── handleSentinelTask ───

export interface SentinelTaskOptions {
	/** 结算回调，形式为 (task, error, value) => void */
	settleTask: (task: object, error: Error | null, value: any) => void;
	/** pendingFinalize 任务集合 */
	pendingFinalizeTasks: Set<object>;
	/** 触发延迟结算的回调 */
	scheduleFinalizeCheck: () => void;
	/** 泵送回调 */
	pumpQueue: () => void;
}

/**
 * 处理 sentinel token 命中后的任务结算。
 * PipelineEngine 和 TaskWorker 共享此逻辑，统一延迟结算策略。
 *
 * @param task - 已从 inflight shift 的任务
 * @param options - 回调集合
 */
export function handleSentinelTask(task: object, options: SentinelTaskOptions): void;

// ─── handleStderrChunk ───

export interface StderrChunkOptions {
	/** inflight 任务跟踪器 */
	inflight: InflightTracker;
	/** pendingFinalize 任务集合 */
	pendingFinalizeTasks: Set<object>;
	/** 可选的日志记录器 */
	logger?: { error?: (msg: string) => void };
}

/**
 * 处理 sqlite3 的 stderr 输出，将其归因到合适的任务。
 * PipelineEngine 和 TaskWorker 共享此逻辑。
 *
 * @param chunk - stderr 文本块
 * @param options - 上下文依赖
 */
export function handleStderrChunk(chunk: string, options: StderrChunkOptions): void;

// ─── createPumpQueue ───

export interface PumpQueueOptions {
	/** 待发送的任务队列 */
	queue: Queue;
	/** inflight 任务跟踪器 */
	inflight: InflightTracker;
	/** 子进程管理器（提供 draining 判断、write 写入、onDrained 注册） */
	processManager: { draining: boolean; write: (data: string) => void; onDrained: (cb: () => void) => void };
	/** sweep 定时器管理器 */
	sweeper: Sweeper;
	/** 批量发送大小 */
	batchSize: number;
	/** inflight 上限 */
	maxInflight: number;
}

/**
 * 创建泵送函数，将队列中的任务批量发送给 sqlite3 进程。
 * PipelineEngine 和 TaskWorker 共享此工厂，消除 #pumpQueue 方法的重复。
 *
 * @returns 泵送函数，调用后尝试从队列取出 batch 发送
 */
export function createPumpQueue(options: PumpQueueOptions): () => void;

// ─── rejectAllTasks ───

export interface RejectAllOptions {
	/** inflight 任务跟踪器 */
	inflight: InflightTracker;
	/** 待发送的任务队列 */
	queue: Queue;
	/** pendingFinalize 任务集合 */
	pendingFinalizeTasks: Set<object>;
	/** 结算回调，形式为 (task, error, value) => void */
	settleTask: (task: object, error: Error | null, value: any) => void;
	/** 拒绝原因 */
	error: Error;
}

/**
 * 拒绝所有待处理任务（inflight、队列、pendingFinalize）。
 * 提取自 PipelineEngine.rejectAll 和 TaskWorker.#rejectAll，
 * 消除二者间的逻辑重复。
 */
export function rejectAllTasks(options: RejectAllOptions): void;
