import { Metrics } from "./metrics";

/**
 * 将解析结果收集到任务的 rows 数组中。
 * 用于非流式查询，将子进程返回的 JSON 行追加到 task.rows。
 *
 * @param task   - 任务对象，需包含 rows 数组
 * @param parsed - 解析出的单行数据
 */
export function collectQueryRows(task: { rows: any[] }, parsed: any): void;

/**
 * 将解析结果通过任务的 onRow 回调逐行推送给消费者。
 * 用于流式查询，不缓存全部结果。
 * 如果 task.consumerError 已设置，则跳过后续推送。
 *
 * @param task   - 任务对象，需包含 onRow 回调和可选的 consumerError
 * @param parsed - 解析出的单行数据
 */
export function processStreamRows(task: { onRow: Function; consumerError?: Error | null }, parsed: any): void;

/**
 * 完成一个任务：调用 resolve 或 reject，并更新指标。
 * 任务可以是 query、execute 或 stream 类型。
 *
 * @param task    - 待完成的任务对象
 * @param error   - 错误对象（为 null 表示成功）
 * @param value   - 成功时的结果值
 * @param metrics - 可选的指标收集器，用于统计任务耗时和结果
 * @param options - 可选的附加选项，如 resetRowParser 是否重置行解析器
 */
export function settleTask(
	task: any,
	error: Error | null,
	value: any,
	metrics?: Metrics | null,
	options?: { resetRowParser?: boolean },
): void;
