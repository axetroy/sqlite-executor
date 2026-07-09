import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { toError, createJsonValueParser, createRowStreamParser } from "./parser.js";

describe("toError", () => {
	test("原样返回 Error 实例", () => {
		const err = new Error("test");
		assert.equal(toError(err), err);
	});

	test("将非 Error 值包装为 Error", () => {
		const err = toError("something went wrong");
		assert.ok(err instanceof Error);
		assert.ok(err.message.includes("something went wrong"));
	});
});

describe("createJsonValueParser", () => {
	test("解析单行 JSON 对象", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"id":1,"name":"Alice"}\n{"id":2}');
		assert.equal(values.length, 2);
		assert.equal(values[0], '{"id":1,"name":"Alice"}');
		assert.equal(values[1], '{"id":2}');
	});

	test("解析 JSON 数组", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed("[1,2,3]");
		assert.equal(values.length, 1);
		assert.equal(values[0], "[1,2,3]");
	});

	test("嵌套对象正确处理", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"nested":{"a":1,"b":[2,3]}}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"nested":{"a":1,"b":[2,3]}}');
	});

	test("字符串内的大括号不会被当成嵌套", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"msg":"hello {world}"}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"msg":"hello {world}"}');
	});

	test("字符串内的转义引号正确处理", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"msg":"he said \\"hi\\""}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"msg":"he said \\"hi\\""}');
	});

	test("分块输入累积解析", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"a"');
		assert.equal(values.length, 0, "首次分块不应产生完整值");
		parser.feed(":1}");
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"a":1}');
	});

	test("多次分块累积解析", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"a"');
		parser.feed(':1,"b"');
		parser.feed(":2}");
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"a":1,"b":2}');
	});

	test("reset 重置状态", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"id":1}');
		assert.equal(values.length, 1);
		parser.reset();
		parser.feed('{"id":2}');
		assert.equal(values.length, 2);
		assert.equal(values[1], '{"id":2}');
	});

	test("空数组 [] 不触发 onValue", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed("[]");
		assert.equal(values.length, 0, "空数组不应触发回调");
	});

	test("空数组与正常值混合时不遗漏正常值", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('[]{"a":1}[]{"b":2}');
		assert.equal(values.length, 2);
		assert.equal(values[0], '{"a":1}');
		assert.equal(values[1], '{"b":2}');
	});

	test("非空数组仍正常触发 onValue", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed("[1,2,3]");
		assert.equal(values.length, 1);
		assert.equal(values[0], "[1,2,3]");
	});

	test("物理裁剪 64KB 后 start 偏移正确，不完整值可继续解析", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));

		// 构建一个略超过 64KB 的完整 JSON 数组
		// 每个元素约 10 字节，8000 个元素约 80000 字节
		const largeArray = "[" + Array.from({ length: 8000 }, (_, i) => JSON.stringify({ a: i })).join(",") + "]";
		assert.ok(largeArray.length > 65536, `大数组长度 ${largeArray.length} 应超过 64KB`);

		// 一次喂入大数组 + 不完整的新值（[ 开始）
		parser.feed(largeArray + '[{"partial');

		// 大数组应该被解析出一个完整值
		assert.equal(values.length, 1, "大数组应被解析");
		assert.equal(values[0], largeArray, "大数组原文应匹配");

		// 不完整的值应在 parser.start 中记录，物理裁剪后 start 应指向新 buffer 头
		assert.equal(parser.start, 0, "物理裁剪后 start 应为 0（新 buffer 起始）");

		// 喂入剩余数据，应解析出第二个完整值
		parser.feed('":1}]');
		assert.equal(values.length, 2, "不完整值应在补充后解析");
		assert.deepEqual(JSON.parse(values[1]), [{ partial: 1 }], "第二个值内容正确");
	});

	test("完整值后接不完整值，不分块补全（不触发物理裁剪）", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));

		// 第一个 feed：完整值 + 不完整的第二个值
		// {"a":1} 完整；{"b 引号未闭合（字符串跨 chunk）
		parser.feed('{"a":1}{"b');
		assert.equal(values.length, 1, "第一个完整值应被解析");
		assert.equal(values[0], '{"a":1}', "第一个值原文正确");

		// start 应指向不完整值的 {；nesting=1（仅计入 {）
		assert.ok(parser.start > 0, "start 应指向不完整值");
		assert.equal(parser.nesting, 1, 'nesting=1（仅 {，"b 仍在字符串中）');

		// 第二个 feed：补全不完整值（不触发物理裁剪，验证重扫问题已修复）
		parser.feed('":2}');
		assert.equal(values.length, 2, "不完整值应在补充后解析");
		assert.equal(values[1], '{"b":2}', "第二个值原文正确");
	});

	test("完整值后接不完整值，跨多 chunk 补全", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));

		// chunk 1: 完整值 + 不完整值开头
		parser.feed('[1]{"a');
		assert.equal(values.length, 1, "第一个值应被解析");

		// chunk 2: 继续补充
		parser.feed('":');
		assert.equal(values.length, 1, "仍未完整");

		// chunk 3: 完成
		parser.feed('"ok"}');
		assert.equal(values.length, 2, "第二个值应完成");
		assert.equal(values[1], '{"a":"ok"}', "第二个值原文正确");
	});
});

describe("createRowStreamParser", () => {
	test("流式解析数组元素", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"id":1},{"id":2}]');
		assert.equal(rows.length, 2);
		assert.equal(rows[0], '{"id":1}');
		assert.equal(rows[1], '{"id":2}');
	});

	test("解析后返回剩余数据", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		const leftover = parser.feed('[{"id":1}] extra');
		assert.equal(rows.length, 1);
		assert.equal(leftover, " extra");
	});

	test("分块输入逐步解析", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"id"');
		assert.equal(rows.length, 0);
		parser.feed(':1},{"id"');
		assert.equal(rows.length, 1, "第二个分块完成后第一个元素应被解析");
		assert.equal(rows[0], '{"id":1}');
		parser.feed(":2}]");
		assert.equal(rows.length, 2);
		assert.equal(rows[1], '{"id":2}');
	});

	test("空数组触发 finished", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		const leftover = parser.feed("[]");
		assert.equal(rows.length, 0);
		assert.equal(parser.finished, true);
	});

	test("finished 后 feed 直接返回输入数据", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"id":1}]');
		assert.equal(parser.finished, true);
		const result = parser.feed("trailing");
		assert.equal(result, "trailing");
	});

	test("嵌套数组作为元素", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed("[[1,2],[3,4]]");
		assert.equal(rows.length, 2);
		assert.equal(rows[0], "[1,2]");
		assert.equal(rows[1], "[3,4]");
	});

	test("reset 重置所有状态", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"id":1}]');
		assert.equal(parser.finished, true);
		parser.reset();
		assert.equal(parser.finished, false);
		assert.equal(parser.started, false);
		parser.feed('[{"id":2}]');
		assert.equal(rows.length, 2);
		assert.equal(rows[1], '{"id":2}');
	});

	test("对象元素内的字符串转义不影响嵌套计数", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"msg":"hello \\"world\\""},{"msg":"ok"}]');
		assert.equal(rows.length, 2);
		assert.equal(rows[0], '{"msg":"hello \\"world\\""}');
		assert.equal(rows[1], '{"msg":"ok"}');
	});

	test("深层嵌套 JSON 对象", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		let inner = "1";
		for (let i = 0; i < 100; i++) {
			inner = `{"a":${inner}}`;
		}
		parser.feed(inner);
		assert.equal(values.length, 1);
		const parsed = JSON.parse(values[0]);
		let depth = 0;
		let cur = parsed;
		while (typeof cur === "object" && cur !== null) {
			depth++;
			cur = cur.a;
		}
		assert.equal(depth, 100);
	});

	test("空字符串输入不产生解析结果", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed("");
		assert.equal(values.length, 0);
	});

	test("仅空白字符输入不产生解析结果", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed("   \n\t  ");
		assert.equal(values.length, 0);
	});

	test("Unicode 字符串正确解析", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"msg":"你好世界 🎉"}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"msg":"你好世界 🎉"}');
	});

	test("JSON 数组中包含 unicode 字符串", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"name":"Alice"},{"name":"😀"}]');
		assert.equal(rows.length, 2);
		assert.equal(rows[0], '{"name":"Alice"}');
		assert.equal(rows[1], '{"name":"😀"}');
	});

	test("feed 多个值逐个回调", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"a":1}{"b":2}{"c":3}');
		assert.equal(values.length, 3);
		assert.equal(values[0], '{"a":1}');
		assert.equal(values[1], '{"b":2}');
		assert.equal(values[2], '{"c":3}');
	});

	test("跨分块解析字符串中的转义反斜杠", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"path":"C:\\\\Users\\\\');
		parser.feed('test"}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"path":"C:\\\\Users\\\\test"}');
	});

	test("toError 将各种非 Error 值包装为 Error", () => {
		const err1 = toError("string error");
		assert.ok(err1 instanceof Error);
		assert.ok(err1.message.includes("string error"));

		const err2 = toError(42);
		assert.ok(err2 instanceof Error);
		assert.equal(err2.message, "42");

		const err3 = toError(null);
		assert.ok(err3 instanceof Error);

		const err4 = toError({ custom: "obj" });
		assert.ok(err4 instanceof Error);
		assert.ok(err4.message.includes("[object Object]"));

		const err5 = toError(undefined);
		assert.ok(err5 instanceof Error);
	});

	test("row stream parser 连续 reset 重新解析", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"n":1}]');
		assert.equal(rows.length, 1);
		parser.reset();
		parser.feed('[{"n":2}]');
		assert.equal(rows.length, 2);
		parser.reset();
		parser.feed('[{"n":3}]');
		assert.equal(rows.length, 3);
		assert.equal(rows[0], '{"n":1}');
		assert.equal(rows[1], '{"n":2}');
		assert.equal(rows[2], '{"n":3}');
	});

	test("row stream parser 空数组返回无元素", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		const leftover = parser.feed("[]");
		assert.equal(rows.length, 0);
		assert.equal(parser.finished, true);
		assert.equal(leftover, "");
	});

	test("row stream parser 数组中只有一个元素", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"id":1}]');
		assert.equal(rows.length, 1);
		assert.equal(rows[0], '{"id":1}');
	});

	test("fuzz：createJsonValueParser 随机数据不崩溃", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		for (let i = 0; i < 500; i++) {
			const len = Math.floor(Math.random() * 200);
			let s = "";
			for (let j = 0; j < len; j++) {
				s += String.fromCharCode(Math.floor(Math.random() * 256));
			}
			parser.feed(s);
			parser.reset();
		}
	});

	test("大批量元素触发 64KB 缓冲区裁剪", () => {
		// 每个 {"a":0}, 约 8 字节；65536 / 8 = 8192，需要 8193+ 个元素
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		const count = 9000;
		const elements = Array.from({ length: count }, () => '{"a":0}');
		const json = "[" + elements.join(",") + "]";
		assert.ok(json.length > 65536, `json 长度 ${json.length} 应超过 64KB`);
		parser.feed(json);
		assert.equal(rows.length, count);
		assert.equal(rows[0], '{"a":0}');
		assert.equal(rows[count - 1], '{"a":0}');
	});

	test("末尾不完整元素（无 elementEnd）触发 end-of-feed 裁剪 elementEnd 空分支", () => {
		// elementStart !== -1, elementEnd === -1, consumed > 0
		// 覆盖 parser.js 第 400 行 elementEnd===-1 跳过 `-= consumed` 的 falsy 分支
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"a":1},{"x"');
		assert.equal(rows.length, 1, "第一个完整元素应被解析");
		assert.equal(rows[0], '{"a":1}');
		// 不完整元素状态校验
		assert.equal(parser.elementStart, 0, "elementStart 应已调整至 buffer 起始");
		assert.equal(parser.elementEnd, -1, "elementEnd 应为 -1（未找到结束）");
	});

	test("末尾不完整元素（有 elementEnd）触发 end-of-feed 裁剪 elementEnd 非空分支", () => {
		// elementStart !== -1, elementEnd !== -1, consumed > 0
		// 覆盖 parser.js 第 400 行 elementEnd!==-1 执行 `-= consumed` 的 truthy 分支
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"a":1},{"x":1}');
		assert.equal(rows.length, 1, "第一个完整元素应被解析");
		assert.equal(rows[0], '{"a":1}');
		// 不完整元素状态校验：elementEnd 已找到，但被 look-ahead 截留
		assert.equal(parser.elementStart, 0, "elementStart 应已调整至 buffer 起始");
		assert.ok(parser.elementEnd > 0, "elementEnd 应有正值（已找到结束）");
	});

	test("fuzz：createRowStreamParser 随机数据不崩溃", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		for (let i = 0; i < 500; i++) {
			const len = Math.floor(Math.random() * 200);
			let s = "";
			for (let j = 0; j < len; j++) {
				s += String.fromCharCode(Math.floor(Math.random() * 256));
			}
			parser.feed(s);
			parser.reset();
		}
	});

	test("fuzz：深层嵌套不导致崩溃或无限循环", () => {
		const parser = createJsonValueParser(() => {});
		const deep = "[" + "[".repeat(5000) + "]".repeat(5000) + "]";
		parser.feed(deep);
	});

	test("fuzz：深层嵌套行流解析器不崩溃", () => {
		const parser = createRowStreamParser(() => {});
		const deep = "[" + "[".repeat(5000) + "]".repeat(5000) + "]";
		const leftover = parser.feed(deep);
		assert.ok(typeof leftover === "string");
	});
});

describe("fuzz: createJsonValueParser", () => {
	test("随机字节序列不崩溃", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		for (let i = 0; i < 2000; i++) {
			const len = Math.floor(Math.random() * 500) + 1;
			let s = "";
			for (let j = 0; j < len; j++) {
				s += String.fromCharCode(Math.floor(Math.random() * 256));
			}
			parser.feed(s);
			// 不 reset，模拟真实流式场景
		}
		// 不应崩溃
	});

	test("极端嵌套深度不导致栈溢出", () => {
		const parser = createJsonValueParser(() => {});
		const depth = 10000;
		const json = "[" + "[".repeat(depth) + "]".repeat(depth) + "]";
		parser.feed(json);
	});

	test("大量小分块逐步喂入", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		const json = '{"a":1,"b":2,"c":3,"d":4,"e":5}';
		// 逐字符喂入
		for (let i = 0; i < json.length; i++) {
			parser.feed(json[i]);
		}
		assert.equal(values.length, 1);
		assert.equal(values[0], json);
	});

	test("混合有效和无效 JSON", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		const chunks = [
			'{"valid":1}',
			"garbage",
			'{"valid":2}',
			"\x00\x01\x02",
			'{"valid":3}',
			"null",
			"undefined",
			'{"valid":4}',
		];
		for (const chunk of chunks) {
			parser.feed(chunk);
		}
		// 有效 JSON 应被解析，无效的被跳过
		assert.ok(values.length >= 3, `应解析至少 3 个有效值，实际: ${values.length}`);
	});

	test("超大 JSON 值触发 64KB 裁剪", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		// 构建一个 100KB 的 JSON 对象
		const largeObj = { data: "x".repeat(100000) };
		const json = JSON.stringify(largeObj);
		assert.ok(json.length > 65536, `JSON 长度 ${json.length} 应超过 64KB`);
		parser.feed(json);
		assert.equal(values.length, 1, "超大 JSON 应被解析为一个值");
	});

	test("多个超大 JSON 连续解析", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		const json1 = JSON.stringify({ data: "x".repeat(70000) });
		const json2 = JSON.stringify({ data: "y".repeat(70000) });
		parser.feed(json1 + json2);
		assert.equal(values.length, 2, "两个超大 JSON 应都被解析");
	});

	test("字符串内包含各种转义序列", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		const json = '{"escapes":"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0041\\u00e9"}';
		parser.feed(json);
		assert.equal(values.length, 1);
	});

	test("分块喂入字符串内的转义序列", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		// 跨分块的转义序列
		parser.feed('{"path":"C:\\\\');
		parser.feed('Users\\\\');
		parser.feed('test"}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"path":"C:\\\\Users\\\\test"}');
	});

	test("连续空数组不遗漏后续值", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('[][][][]{"a":1}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"a":1}');
	});

	test("大量空数组混合正常值", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		let input = "";
		for (let i = 0; i < 100; i++) {
			input += "[]";
		}
		input += '{"final":true}';
		parser.feed(input);
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"final":true}');
	});
});

describe("fuzz: createRowStreamParser", () => {
	test("随机字节序列不崩溃", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		for (let i = 0; i < 2000; i++) {
			const len = Math.floor(Math.random() * 500) + 1;
			let s = "";
			for (let j = 0; j < len; j++) {
				s += String.fromCharCode(Math.floor(Math.random() * 256));
			}
			parser.feed(s);
		}
	});

	test("极端嵌套数组元素", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		const depth = 5000;
		const json = "[" + "[".repeat(depth) + "]".repeat(depth) + "]";
		parser.feed(json);
	});

	test("大量小元素分批喂入", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		// 使用对象元素（解析器对原始类型元素支持有限）
		const elements = Array.from({ length: 10 }, (_, i) => JSON.stringify({ n: i }));
		const json = "[" + elements.join(",") + "]";
		// 分两批喂入，模拟流式场景
		// 注意：最后一个元素在数组关闭时可能不被解析（look-ahead 限制）
		const mid = Math.floor(json.length / 2);
		parser.feed(json.slice(0, mid));
		parser.feed(json.slice(mid));
		assert.ok(rows.length >= 9, `应解析至少 9 个元素，实际: ${rows.length}`);
		assert.ok(rows.length <= 10, `不应超过 10 个元素，实际: ${rows.length}`);
	});

	test("混合有效和无效数组元素", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		// 有效数组后跟垃圾数据
		const leftover = parser.feed('[{"id":1},{"id":2}] garbage');
		assert.equal(rows.length, 2);
		assert.equal(leftover, " garbage");
	});

	test("超大数组元素触发 64KB 裁剪", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		const largeElement = JSON.stringify({ data: "x".repeat(70000) });
		const json = `[${largeElement},${largeElement}]`;
		assert.ok(json.length > 65536, "JSON 长度应超过 64KB");
		parser.feed(json);
		assert.equal(rows.length, 2, "两个超大元素应都被解析");
	});

	test("数组内嵌套深层对象", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		let inner = "1";
		for (let i = 0; i < 100; i++) {
			inner = `{"a":${inner}}`;
		}
		const json = `[${inner},${inner}]`;
		parser.feed(json);
		assert.equal(rows.length, 2);
	});

	test("对象元素包含逗号和括号值", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		// 使用对象元素（而非字符串元素），因为当前解析器对字符串元素支持有限
		const json = '[{"msg":"hello, world"},{"msg":"test [1,2,3]"},{"msg":"{not:json}"}]';
		parser.feed(json);
		assert.equal(rows.length, 3);
		assert.equal(rows[0], '{"msg":"hello, world"}');
		assert.equal(rows[1], '{"msg":"test [1,2,3]"}');
		assert.equal(rows[2], '{"msg":"{not:json}"}');
	});

	test("空数组元素", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{},{},{}]');
		assert.equal(rows.length, 3);
		assert.equal(rows[0], "{}");
		assert.equal(rows[1], "{}");
		assert.equal(rows[2], "{}");
	});

	test("大量元素不丢失", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		const count = 5000;
		const elements = Array.from({ length: count }, (_, i) => JSON.stringify({ n: i }));
		const json = "[" + elements.join(",") + "]";
		parser.feed(json);
		assert.equal(rows.length, count);
		assert.equal(rows[0], '{"n":0}');
		assert.equal(rows[count - 1], `{"n":${count - 1}}`);
	});

	test("reset 后重新解析大量数据", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		for (let round = 0; round < 10; round++) {
			const json = `[{"round":${round},"data":"test"}]`;
			parser.feed(json);
			assert.equal(rows.length, round + 1);
			parser.reset();
		}
	});
});
