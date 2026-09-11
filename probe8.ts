const j = async (label: string, url: string, init?: RequestInit) => {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
    const t = await r.text();
    console.log(`${label.padEnd(30)} ${r.status} ${t.length}b  ${t.slice(0, 180).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`${label.padEnd(30)} FAIL ${(e as Error).message.slice(0, 50)}`);
  }
};
console.log("--- ModelScope endpoints ---");
await j("GET dolphin/models", "https://modelscope.cn/api/v1/dolphin/models?PageSize=10&PageNumber=1");
await j("GET models list", "https://modelscope.cn/api/v1/models?PageSize=10&PageNumber=1&SortBy=CreatedTime");
await j("PUT dolphin/models", "https://modelscope.cn/api/v1/dolphin/models", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    PageSize: 10,
    PageNumber: 1,
    SortBy: "CreatedTime",
    Target: "",
    SingleCriterion: [],
    Criterion: [],
  }),
});
await j("GET model detail", "https://modelscope.cn/api/v1/models/deepseek-ai/DeepSeek-V3");

console.log("\n--- benchmark HTML content ---");
for (const [n, u, needle] of [
  ["matharena", "https://matharena.ai/", "gpt"],
  ["simplebench", "https://simple-bench.com/", "Gemini"],
  ["weirdml", "https://htihle.github.io/weirdml.html", "Claude"],
] as const) {
  const body = await (await fetch(u, { headers: { "user-agent": "Mozilla/5.0" } })).text();
  const hit = body.toLowerCase().indexOf(needle.toLowerCase());
  console.log(
    `${n.padEnd(12)} contains "${needle}": ${hit >= 0}  ${hit >= 0 ? JSON.stringify(body.slice(Math.max(0, hit - 120), hit + 120).replace(/\s+/g, " ")) : ""}`,
  );
}
