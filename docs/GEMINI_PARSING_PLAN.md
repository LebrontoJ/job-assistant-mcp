# Gemini JD 解析方案与实现记录

## 实现状态（2026-11-06）

已实现 `src/parsing/` 服务、Gemini structured output、Zod 与原文校验、MCP 双工具共享、缓存和并发合并、取消与超时兜底、trace 统计及 UI 状态。离线模式保持本地规则；个人资料的 Markdown 分块和索引流程未改动。

已提供 8 条人工标注的合成开发样本与 `pnpm eval:jd` / `pnpm eval:jd --live` 比较入口。自动测试使用 fake SDK；实际 Gemini 调用只使用合成 JD。该开发集不足以代表真实职位分布，后续需扩展独立标注样本。实测结果见 [JD_PARSING_EVAL.md](JD_PARSING_EVAL.md)。

## 原始实现与本次范围

- `src/server/jd.ts` 的 `parseJd()` 使用正则、英文标题识别和固定技能表解析 JD。
- `src/server/server.ts` 的 `parse_jd` 和 `match_resume` 分别调用 `parseJd()`；`src/agent/task.ts` 在一个任务里依次调用这两个工具。
- 简历侧没有结构化 `parseResume()`：`src/rag/index.ts` 读取 Markdown，再由 `src/rag/chunk.ts` 分块，供检索、引用和事实校验使用。
- 已安装 `@google/genai` 和 Zod，已有 Gemini 客户端、缓存、限速、重试及 trace。现有 `LLMClient.chat()` 尚未暴露结构化输出 schema。

本次仅升级 JD 解析：使用免费额度的 Gemini API 作为主路径，现有 `parseJd()` 正则解析作为兜底。候选人 Markdown 个人资料已能通过现有分块、检索和引用流程满足当前需求，继续沿用该流程。

简历结构化抽取、侧车数据、导入解析服务及 PDF/DOCX/OCR 均不在本次范围内。运行入口根据配置启用 JD API 解析；`createServer()` 未注入解析器时保持纯规则行为。

## 目标流程

JD 输入校验 → 缓存 / 同输入请求合并 → Gemini 结构化抽取 → Zod 与原文依据校验 → 返回结构化结果。

API 未配置、超时、限流、服务异常、拒答、截断、非法 JSON、schema 或依据校验失败时，执行本地兜底。用户主动取消则向上传播取消，不启动兜底。

模型负责信息抽取；匹配判定、经历真实性校验仍使用现有检索和 grounding 流程。

## 1. JD 解析服务

已增加 `src/parsing/`：

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 解析接口、结果元信息、失败原因 |
| `gemini.ts` | 专用结构化抽取适配器，可注入 SDK client |
| `service.ts` | 预算、缓存、请求合并、依据校验、兜底 |
| `factory.ts` | 环境变量校验与依赖组装 |
| `jd.ts` | JD schema、prompt、原有规则适配 |

先采用专用 Gemini 抽取适配器，复用 `@google/genai`，不扩大整个 agent 的 `LLMClient` 协议。缓存和 trace 的机制可复用，但不直接套用对话缓存键或默认长重试策略。

内部结果：`JdParseResult = { data: ParsedJd; meta: ParseMeta }`。仅围绕 JD 实现，不预先抽象多文档解析框架。

`ParseMeta` 包含 `method: gemini | rules`、实际 model、prompt/schema 版本、cacheHit、耗时、token usage、warnings 和受控的 fallbackReason。

失败原因使用枚举，例如 `missing_key`、`timeout`、`rate_limited`、`provider_error`、`blocked`、`truncated`、`invalid_output`、`unsupported_evidence`，不向 UI 泄露原始 SDK 错误正文。

## 2. JD 解析接入

1. 保留同步 `parseJd()` 的签名与行为，作为规则基线和兜底，现有规则测试继续适用。
2. 将 `ParsedJd` 对应为 Zod schema；缺失标量为 null，缺失列表为 []，限制字符串长度、数组项数及枚举值。
3. 使用 Gemini JSON structured output，显式指定 JSON MIME type 和 schema；收到响应后仍执行 Zod 校验。
4. prompt 明确区分硬性要求、加分项、职责；支持中文和无标准标题的段落；不翻译或扩写要求，不臆造公司、工作方式、年限或技能。
5. 模型内部输出关键字段 / 条目的原文依据。服务验证依据确实存在于输入，再转换为现有 `ParsedJd`。首版技能要求原文直接出现，并校验拉丁技能词边界，不做隐式别名扩展。原文出现校验不能独自证明否定、要求分类等语义判断正确。
6. 不盲目把规则与模型的数组取并集；这会把规则误判和模型误判同时保留。首版以经校验的模型结果为主，失败时整体退回规则结果。
7. `createServer()` 增加可注入的解析依赖；`parse_jd` 与 `match_resume` 共用同一个 service 实例。未注入时维持纯规则行为，测试不需要真实 API key。
8. `src/server/index.ts`、`src/app/index.ts` 统一组装；`APP_MODE=extractive` 强制本地解析，保持离线体验。
9. 工具返回维持原有 JD / match 字段在顶层，新增可选 `parsing` 元信息；`TaskReport` 可选携带解析信息，在 UI 提示是否降级。同步核查所有消费者与快照。

特别处理空结果：空数组不必然是错误。依据输入中是否存在可核对的要求条目判断；不能只因模型没识别到 requirements 就将普通公司介绍误判为解析失败。

## 3. 配置与免费配额

当前配置（模型和预算可按实际项目调整）：

```dotenv
JD_PARSER_MODE=auto
JD_PARSER_MODEL=gemini-3.1-flash-lite
JD_PARSER_TIMEOUT_MS=10000
JD_PARSER_CACHE_DIR=.cache/parsing/jd
# 复用 GEMINI_API_KEY；限速参数按实际项目额度配置
```

- `auto`：配置 key 且允许联网时 Gemini 优先，失败本地兜底；未配置 key 直接本地兜底。
- `rules`：强制使用现有 `parseJd()`，不调用 Gemini。上述配置仅控制 JD 解析，不影响个人资料分块、检索或 embedding 配置。
- 模型单独配置，避免 agent 切换到 Anthropic 时连带改变解析供应商。`.env.example` 当前模型是初始候选，免费可用性以实际项目 AI Studio 为准。
- 免费约束由实际使用的 Google 项目计费层级保证；应用不自动升级计费、不切换付费模型、不做跨模型重试。环境变量本身不能阻止已开通计费的项目产生费用。
- 首版默认不做模型重试；429 / 5xx 等立即降级。若实测需要重试，最多一次，且排队、API 和退避共用总预算，不能叠加现有默认四次重试。
- 当前工具默认 15 秒：解析内部预算初设 10 秒，为工具封装和本地兜底留余量。超时必须中止底层 SDK 请求；MCP 取消信号也要传入服务。
- 缓存键包含 JD 内容哈希、provider/model、prompt/schema 版本；并发同输入合并，避免 `parse_jd` 与 `match_resume` 发出两次请求。
- 成功结果可持久缓存；失败降级结果在内存共享 30 秒，让相邻的解析 / 匹配工具复用结果，窗口结束后允许恢复 API 使用。请求合并时，一个订阅者取消不应错误取消其他订阅者的工作。
- JD 解析的 API 次数与 token 单独计入 trace 汇总，便于与 agent 用量对照。当前不主动排队限速，收到 429 立即兜底；不会沿用对话客户端的长重试等待。跨进程统一配额调度暂未实现。

## 4. 可观测性与数据处理

- 记录解析方式、模型、缓存命中、API 次数、token、耗时、降级原因；纳入现有 task/tool correlation，避免服务内部调用在 trace 中消失。
- 默认不在日志中记录 JD 正文或完整模型输出；缓存目录加入忽略规则，支持关闭缓存与清理。
- JD 解析仅发送 JD 文本，不附带候选人个人资料。现有 live 草稿生成和 Gemini embedding 的数据流继续由原有配置控制。
- UI 展示简短状态，例如“Gemini 解析”或“API 超时，已使用规则解析”，并展示当前结果的实际来源。

## 5. 验证与交付顺序

### A：JD API 优先与规则兜底

交付 schema、专用 Gemini adapter、service、配置和两个 MCP 工具接入。更新 `docs/PLAN.md` 中“server model-free”的设计约定和工具描述，明确解析可以调用模型、匹配结论仍来自检索。

### B：可靠性与质量比较

交付缓存、并发合并、取消、预算、trace/UI 元信息。构建人工标注的中英文 JD 集，包含非标准标题、纯段落、新技能、多个年限要求和提示注入。

单元测试用 fake SDK 覆盖正常 JSON、非法 JSON、schema 错误、截断、拒答、429、5xx、超时、取消、缺 key、缓存命中/失效和失败后恢复。MCP 集成测试验证同一个任务只发一次 API 请求、两个工具消费同一解析结果、未配置时原有流程可用。

比较规则与 Gemini 的字段准确率、硬性要求/加分项抽取 precision/recall、无依据字段率、技能抽取、降级率、API 请求数、token 与 p50/p95。质量评估分别报告 API 成功子集和包含兜底的端到端结果，不将兜底成功冒充模型抽取成功。

已覆盖的工程验收：自动测试不调用真实 API；同文档同版本成功缓存零新增请求；单任务未命中缓存正常情况一次解析请求；所有约定的提供方失败都能在工具预算内降级；取消不降级；原有离线测试与 grounding 测试通过；个人资料的分块结果、chunk id、检索及引用行为保持兼容。质量提升需由标注集证明，不能仅用 schema 合法率代替。

## 官方参考

- [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)：使用支持的 schema 子集，应用仍需验证字段语义。
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)：上线时核对目标模型免费层和数据使用条款。
- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)：以项目 AI Studio 中的实际配额为准。

## 实现边界

- 未承诺仅靠环境变量保证免费；需使用具有免费额度的 Google 项目，程序不会开通计费或自动切换模型。
- API 解析缺少可用 provider usage 时只能记录零已知 token；有 usage 的拒答、非法 JSON 或依据校验失败会保留用量。
- 缓存 key 使用统一 prompt/schema 版本 `JD_PARSER_VERSION`；修改抽取协议时需要递增该版本。磁盘缓存可关闭或清理，内存最多保留 128 个结果。
- 解析器不会校验所有语义关系；未识别的信息可以为空，质量仍需以标注评测和原文核查判断。
