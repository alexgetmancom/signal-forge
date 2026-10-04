import { expect, test } from "bun:test";
import { collectQwenBlog, qwenPosts } from "../src/sources/qwen.js";

test("Qwen retains ids, Unicode titles and order while ignoring text and nested lookalikes", async () => {
  const articles = [
    {
      id: "first",
      content: 'a }{ "[]" trap with a \\ and "title":"wrong"',
      extra: { id: "wrong", title: "wrong" },
      title: "Qwen 中文 🚀",
    },
    { title: "Second", content: "full post", id: "second" },
    { id: "unusable", title: 3 },
    { title: "Missing id" },
  ];
  const body = JSON.stringify({
    success: true,
    extra: { articles: [{ id: "wrong", title: "wrong" }] },
    data: { articles },
  });
  const expected = articles.flatMap((article) =>
    typeof article.id === "string" && typeof article.title === "string"
      ? [{ id: article.id, name: article.title, maker: "Qwen", url: `https://qwen.ai/blog?id=${article.id}` }]
      : [],
  );
  expect(qwenPosts(Buffer.from(body))).toEqual(expected);
  const collection = await collectQwenBlog(async (url, init) => {
    expect(String(url)).toBe("https://qwen.ai/api/v2/article/retrieval?type=qwen_ai&language=en-US");
    expect(new Headers(init?.headers).get("user-agent")).toBe("SignalForge/0.1");
    return new Response(body);
  });
  expect(collection.records).toEqual(expected);
  expect(collection.raw).toBe("first\nsecond");
});

test("Qwen decodes escaped keys and values and checks the JSON it skips", () => {
  const body =
    '{"data":{"articl\\u0065s":[{"content":"x\\n\\u0041", "i\\u0064":"a", "title":"\\u4e2d\\u6587", "extra":{"n":-1.5e3,"b":true,"c":null,"d":false,"nested":[[],{},"x"]}}]}}';
  expect(qwenPosts(Buffer.from(body))).toMatchObject([{ id: "a", name: "中文" }]);
});

test("a partial or malformed body fails even after it supplied every selected field", () => {
  for (const body of [
    '{"data":{"articles":[{"id":"a","title":"A","content":"cut',
    '{"data":{"articles":[{"id":"a","title":"A"}]}',
    '{"data":{"articles":[{"id":"a","title":"A","content":"\\q"}]}}',
    '{"data":{"articles":[{"id":"a","title":"A","content":"\\uXX00"}]}}',
    '{"data":{"articles":[{"id":"a","title":"A","extra":01}]}}',
    '{"data":{"articles":[{"id":"a","title":"A",}]}}',
    '{"data":{"articles":[{"id":"a","title":"A"},]}}',
    '{"data":{"articles":[{"id":"a" "title":"A"}]}}',
    '{"data":{"articles":[{"id":"a","title":"A"}]}},{}',
    '{"data":{"articles":[{"id":"a","title":"A","title":"B"}]}}',
    '{"data":{"articles":[{"id":"a","title":"A","content":"control\ncharacter"}]}}',
  ]) {
    expect(() => qwenPosts(Buffer.from(body))).toThrow();
    try {
      qwenPosts(Buffer.from(body));
    } catch (error) {
      expect(error).toMatchObject({ kind: "protocol" });
    }
  }
  expect(() => qwenPosts(Uint8Array.of(255))).toThrow("not valid UTF-8");
});

test("Qwen refuses a missing list, an empty observation and an HTTP refusal", async () => {
  for (const body of [{}, { data: { articles: {} } }, { data: { unrelated: [] } }])
    expect(() => qwenPosts(Buffer.from(JSON.stringify(body)))).toThrow("no article list");
  await expect(collectQwenBlog(async () => Response.json({ data: { articles: [] } }))).rejects.toMatchObject({
    kind: "missing-content",
  });
  await expect(collectQwenBlog(async () => new Response(null, { status: 403 }))).rejects.toMatchObject({ status: 403 });
});
