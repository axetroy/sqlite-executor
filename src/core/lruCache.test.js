import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { LRUCache } from "./lruCache.js";

describe("LRUCache", () => {
	test("get 未命中返回 undefined", () => {
		const c = new LRUCache({ maxSize: 3 });
		assert.equal(c.get("a"), undefined);
	});

	test("set/get 基本功能", () => {
		const c = new LRUCache({ maxSize: 3 });
		c.set("a", "1");
		assert.equal(c.get("a"), "1");
	});

	test("get 命中后推进 LRU 顺序", () => {
		const c = new LRUCache({ maxSize: 2 });
		c.set("a", "1");
		c.set("b", "2");
		c.get("a"); // 提升 a
		c.set("c", "3"); // 应淘汰 b
		assert.equal(c.get("a"), "1");
		assert.equal(c.get("b"), undefined);
		assert.equal(c.get("c"), "3");
	});

	test("淘汰最久未访问条目", () => {
		const c = new LRUCache({ maxSize: 2 });
		c.set("a", "1");
		c.set("b", "2");
		c.set("c", "3"); // 淘汰 a
		assert.equal(c.get("a"), undefined);
		assert.equal(c.get("b"), "2");
		assert.equal(c.get("c"), "3");
	});

	test("超长 key 不缓存", () => {
		const c = new LRUCache({ maxKeyLength: 5 });
		c.set("abcdef", "v");
		assert.equal(c.get("abcdef"), undefined);

		c.set("abcde", "v");
		assert.equal(c.get("abcde"), "v");
	});

	test("超长的 value 不缓存", () => {
		const c = new LRUCache({ maxValueLength: 5 });
		c.set("k", "abcdef");
		assert.equal(c.get("k"), undefined);

		c.set("k", "abcde");
		assert.equal(c.get("k"), "abcde");
	});

	test("非字符串 key 不缓存", () => {
		const c = new LRUCache({ maxSize: 3 });
		c.set(123, "v");
		assert.equal(c.get(123), undefined);
	});

	test("更新已存在的 key", () => {
		const c = new LRUCache({ maxSize: 3 });
		c.set("a", "1");
		c.set("a", "2");
		assert.equal(c.get("a"), "2");
	});

	test("size 返回正确条目数", () => {
		const c = new LRUCache({ maxSize: 3 });
		assert.equal(c.size, 0);
		c.set("a", "1");
		assert.equal(c.size, 1);
		c.set("b", "2");
		assert.equal(c.size, 2);
		c.set("c", "3");
		assert.equal(c.size, 3);
		c.set("d", "4"); // 淘汰 a
		assert.equal(c.size, 3);
	});

	test("clear 清空所有条目", () => {
		const c = new LRUCache({ maxSize: 3 });
		c.set("a", "1");
		c.set("b", "2");
		c.clear();
		assert.equal(c.size, 0);
		assert.equal(c.get("a"), undefined);
	});

	test("maxSize <= 0 自动提升为 1", () => {
		const c = new LRUCache({ maxSize: 0 });
		c.set("a", "1");
		assert.equal(c.get("a"), "1");
		c.set("b", "2");
		assert.equal(c.get("a"), undefined);
		assert.equal(c.get("b"), "2");
	});

	test("maxSize 1 的边界", () => {
		const c = new LRUCache({ maxSize: 1 });
		c.set("a", "1");
		assert.equal(c.get("a"), "1");
		c.set("b", "2");
		assert.equal(c.get("a"), undefined);
		assert.equal(c.get("b"), "2");
	});

	test("超长的数组 value 不缓存", () => {
		const c = new LRUCache({ maxValueLength: 3 });
		c.set("arr", [1, 2, 3, 4]); // 长度为 4 > 3
		assert.equal(c.get("arr"), undefined);

		c.set("arr2", [1, 2, 3]); // 长度为 3 == 3，应缓存
		assert.deepEqual(c.get("arr2"), [1, 2, 3]);
	});

	test("非数组对象的 value 即使超过 maxValueLength 也缓存", () => {
		const c = new LRUCache({ maxValueLength: 5 });
		const obj = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
		c.set("obj", obj);
		assert.equal(c.get("obj"), obj);
	});
});

describe("fuzz: LRUCache", () => {
	test("随机 set/get 不崩溃", () => {
		const c = new LRUCache({ maxSize: 50 });
		for (let i = 0; i < 2000; i++) {
			const key = `key-${Math.floor(Math.random() * 100)}`;
			const value = `val-${Math.floor(Math.random() * 1000)}`;
			c.set(key, value);
			const got = c.get(key);
			if (got !== undefined) {
				assert.equal(got, value);
			}
		}
	});

	test("大量随机操作保持 LRU 语义", () => {
		const c = new LRUCache({ maxSize: 10 });
		const keys = [];
		for (let i = 0; i < 100; i++) {
			const key = `k${i}`;
			c.set(key, i);
			keys.push(key);
		}
		// 只有最后 10 个 key 应保留
		for (let i = 0; i < 90; i++) {
			assert.equal(c.get(`k${i}`), undefined, `k${i} 应被淘汰`);
		}
		for (let i = 90; i < 100; i++) {
			assert.equal(c.get(`k${i}`), i, `k${i} 应保留`);
		}
	});

	test("随机访问模式提升 LRU 顺序", () => {
		const c = new LRUCache({ maxSize: 5 });
		for (let i = 0; i < 5; i++) c.set(`k${i}`, i);
		// 访问顺序: k2, k4, k1, k3, k0
		// 每次 get 将 key 提升到末尾，所以最终顺序（最旧→最新）为: k2, k4, k1, k3, k0
		const accessOrder = [2, 4, 1, 3, 0];
		for (const idx of accessOrder) {
			c.get(`k${idx}`);
		}
		// 添加新 key k5 → 淘汰最旧的 k2
		c.set("k5", 5);
		assert.equal(c.get("k2"), undefined, "k2 最久未访问，应被淘汰");
		assert.equal(c.get("k5"), 5, "k5 应存在");
		assert.equal(c.get("k0"), 0, "k0 最近访问，应保留");
	});

	test("超长 key 和 value 不缓存", () => {
		const c = new LRUCache({ maxKeyLength: 10, maxValueLength: 20 });
		c.set("a".repeat(11), "short");
		assert.equal(c.get("a".repeat(11)), undefined, "超长 key 不应缓存");

		c.set("short", "x".repeat(21));
		assert.equal(c.get("short"), undefined, "超长 value 不应缓存");

		c.set("short", "x".repeat(20));
		assert.equal(c.get("short"), "x".repeat(20), "边界长度应缓存");
	});

	test("大量 set 触发频繁淘汰", () => {
		const c = new LRUCache({ maxSize: 5 });
		for (let i = 0; i < 1000; i++) {
			c.set(`k${i}`, i);
		}
		assert.equal(c.size, 5);
		// 只有最后 5 个 key 应保留
		for (let i = 995; i < 1000; i++) {
			assert.equal(c.get(`k${i}`), i);
		}
	});

	test("重复 set 相同 key 更新值", () => {
		const c = new LRUCache({ maxSize: 3 });
		for (let i = 0; i < 100; i++) {
			c.set("key", i);
		}
		assert.equal(c.get("key"), 99);
		assert.equal(c.size, 1);
	});

	test("clear 后重新使用", () => {
		const c = new LRUCache({ maxSize: 10 });
		for (let i = 0; i < 50; i++) {
			c.set(`k${i}`, i);
		}
		c.clear();
		assert.equal(c.size, 0);
		for (let i = 0; i < 50; i++) {
			assert.equal(c.get(`k${i}`), undefined);
		}
		// 清空后重新使用
		c.set("new", "value");
		assert.equal(c.get("new"), "value");
	});

	test("maxSize=1 边界", () => {
		const c = new LRUCache({ maxSize: 1 });
		for (let i = 0; i < 100; i++) {
			c.set(`k${i}`, i);
			assert.equal(c.size, 1);
			assert.equal(c.get(`k${i}`), i);
		}
	});

	test("非字符串 key 不缓存", () => {
		const c = new LRUCache({ maxSize: 10 });
		c.set(123, "number");
		c.set(true, "boolean");
		c.set(null, "null");
		c.set(undefined, "undefined");
		c.set({}, "object");
		c.set([], "array");
		assert.equal(c.size, 0);
	});

	test("超长数组 value 不缓存", () => {
		const c = new LRUCache({ maxValueLength: 5 });
		c.set("arr", [1, 2, 3, 4, 5, 6]);
		assert.equal(c.get("arr"), undefined);
		c.set("arr2", [1, 2, 3, 4, 5]);
		assert.deepEqual(c.get("arr2"), [1, 2, 3, 4, 5]);
	});
});
