# 思想流 NPC(thought-stream NPCs)架构规格

> 状态:草案 v0.1(2026-07)。灵感来源:headlong 的两个同名项目——
> [laude-institute/headlong](https://github.com/laude-institute/headlong)(持久 agent 微型 harness:
> 永不休眠的自导思考循环、"人类消息不开会话只是一条观察"、一个心智服务多人)与
> [andyk/headlong](https://github.com/andyk/headlong)(自回归思想生成:思想流为一等公民、
> 人类可共编、环境守护进程执行"行动想法"并把结果作为"观察"回流)。
> 本 spec 把这两个范式与本引擎已有的三条轨道(代谢经济 / 可验证推理 / 分层持久化)合成为
> 引擎层能力;宿主(0gtown / onchainpal)opt-in。
>
> 关联规格:`ai-npc-architecture.md`(SharedWorld/STF 总架构)、
> `npc-economy-and-gcc.md`(代谢与 GCC)、aigg-src
> `docs/superpowers/specs/2026-07-08-fusion-orchestration-design.md`(fusion:
> 一次思考如何算得便宜且可验证——与本文正交,本文管思考何时发生、如何成流)。

---

## 1. 一句话

把 NPC 的心智从"被 `talk()` 触发的请求-响应"改为**一条持续的、类型化的、
可验证的思想流**:访客消息和世界事件都只是流里的观察,回复和行动是流里的
行动想法,思考节奏由代谢(GCC 余额)定价,每条思想是一次 attested 推理,
整条流经分层持久化锚定到 DSN。

headlong 证明了"持久意识"的产品力,但它没有成本调速器,也没有可验证性。
这两样恰好是本引擎已有的:**Metabolism 是思考节奏的天然阀门,
ai3-inference 的每响应签名让"意识流"逐条可证**。合成物——
"可验证的持续意识"——是 headlong 和 0G 都没有的形态。产品语义随之升级:
**供奉买的不再是一次豪华回答,而是持续存在的意识时长与频率**。

## 2. 与现有系统的关系(不重造,只换循环形状)

| 现有件 | 在思想流里的角色 |
|---|---|
| `SharedWorld.talk()` | 保留为兼容外壳;内部改写为"注入 observation → 调度器出 reply 行动"。旧宿主语义不变(TS0 对齐门) |
| structured intent/effect + 确定性 STF | 行动想法的执行层:action thought → intent → `applyTx` → effect 作为 observation 回流。**已同构,零改造** |
| `Metabolism`(充盈/清醒/饥饿) | 从"单次思考的模型档位"扩展为**思考调度器的节奏源**(§4) |
| FairTick / PlanExecutor | 被自导思考归并:FairTick 的确定性自治成为 starving 档的零成本底噪;PlanExecutor 的"意图→走过去→对话"成为 reflection→action 的一种产物 |
| aigg-memory(select/observe/Dream) | select 喂思考上下文;流本身就是 observe 的输入;Dream = 对流的离线整合(reflection 的批处理形态) |
| ai3-inference attestation | 每条 LLM 生成的思想携带其推理的 `Attestation`(§6) |
| 分层持久化(warm FS → DSN → head-CID) | 流的存储与锚定,单位从"对话轮"变为"思想" |
| Ford 原则 narrate(onchainpal) | 人类共编思想流的权限模型现成(§7) |
| fusion advisor profile(infra 层) | 持续思考的成本引擎:执行器思想跑便宜档,顾问咨询稀疏化 |

## 3. 数据模型

```ts
interface Thought {
  seq: number;                 // 流内单调序号
  at: number;                  // unix ms
  kind: 'observation' | 'reflection' | 'action' | 'result';
  //  observation: 外界落进来的(访客消息/世界事件/effect 回流/运营注入)
  //  reflection : 自导思考的产物(无外部触发)
  //  action     : 需要执行的意图(说话也是行动:reply 是 action 的一种)
  //  result     : action 执行后的回执(成功/失败/effect 摘要)
  body: string;                // 思想文本(action 时附 structured intent)
  intent?: AgentIntent;        // kind='action' 时的结构化意图
  source: 'world' | 'visitor' | 'self' | 'operator' | 'engine';
  counterpart?: string;        // 关联的访客/NPC id(观察与回复的对端)
  attestation?: Attestation;   // LLM 生成的思想携带(reflection/action);
                               // observation/result 无(它们不是推理产物)
  prevHash: Hex;               // keccak256(上一条思想的规范序列化) — 哈希链
}
```

- **append-only + 哈希链**:每条思想引用前条哈希,流不可无痕改写;锚定时
  只需锚最新 head(§6)。
- **一条时间线**:per-counterpart 关系记忆保留(作为 select 的检索维度),
  但心智只有一条流——多访客同时说话就是多条相邻 observation,由 NPC 的
  下一次思考决定回应谁(laude 版的"one mind, many people")。
- 存储:`Store` seam 落 warm FS(`thoughts/<npcId>.jsonl`),复用现有分层。

## 4. 思考调度器(代谢门控)

调度器取代"只在被搭话时思考":

| 代谢档 | 自导节奏(默认) | 反应性 | 成本引擎 |
|---|---|---|---|
| 充盈 bright | 每 `cadenceBrightMs`(默认 60s)一次 reflection | 即时 | T2 执行器;顾问咨询按 fusion advisor 纪律 |
| 清醒 steady | 每 `cadenceSteadyMs`(默认 5min)一次 | 即时 | 同上,禁顾问 |
| 饥饿 starving | **零 LLM**:只有 FairTick 式确定性底噪 | `hungerIntent` 脚本应答 | 0 |
| 休眠 dormant(余额 0) | 无 | 无(可见"沉睡"状态) | 0 |

硬性纪律(继承 0gtown 的运营教训):
- **无人观看时自导节奏降为 0 或 dream-only**(`clients.size === 0` 早退的
  流版本);持久意识是给观众的,不是给空房间烧钱的。env:
  `THOUGHT_STREAM_IDLE=off|dream|full`(默认 off)。
- 每 NPC 每日自导思考预算 `THOUGHT_BUDGET_GCC`,超出即降档——余额富裕也
  不许失控。
- 一次自导思考 = 一次推理调用(prompt = select(记忆) + 流尾窗口),产出
  0..1 条 reflection 和 0..n 条 action;空产出("没什么可想")合法且常见,
  记为心跳不记为思想。

## 5. 行动想法与环境循环

```
调度器/observation 到达
  → 思考(LLM, 带流尾上下文)
  → reflection / action 落流
  → 环境循环取未执行 action → 转 intent → STF applyTx
  → effect 摘要作为 result 落流(下一次思考自然看见)
```

- 说话即行动:回复访客是 `action{say}`,经现有 WS 服务端推送下发——协议
  已支持(street/planact 先例),**回复因此天然异步**:NPC 可以晚点答、
  合并答、不答。宿主 UI 需接受"说了话不一定立刻有回音"(TS0 兼容门保证
  旧宿主仍走同步路径)。
- action 失败不重试于同 tick,failure 落 result,让下一次思考自己决定。
- 禁递归:思想不能生成"修改调度器/预算/自身 harness"的 action
  (laude 版 "shells all the way down" 明确为非目标,§9)。

## 6. 可验证性(与 ai3-inference 的合成点)

- **逐条**:LLM 生成的思想(reflection/action)携带产生它的推理
  `Attestation`(T1/T2/T3 徽章语义与等级 taxonomy 照搬 fusion spec §2);
  scripted 档的底噪思想无 attestation,如实展示。
- **成流**:哈希链使"这条流没有被事后改写"可验;
  `THOUGHT_ANCHOR=1` 时按 `THOUGHT_ANCHOR_MS`(默认 5min)把
  `{npcId, headSeq, headHash}` 连同增量 blob 归档 DSN,head-CID 走现有
  链锚(onchainpal 的 Kv 表 / 0gtown 的 storage 锚)。
- **运营注入可审计**:operator 注入的思想(§7)`source:'operator'` 且无
  attestation,在流里永远与 NPC 自己的思想可区分——共编不等于伪造。
- 前端"证明抽屉"扩展:点开 NPC 头顶的"在想什么",看到流尾若干条思想,
  每条可展开验证(浏览器端 `verifyResponseSignature`,同构模块已在
  `@ai3-inference/verify`)。

## 7. 人类共编(Ford 门控)

- 新命令 `inject_thought`(WS):向指定 NPC 流注入一条 observation 或
  reflection。权限完全复用 narrate 的 Ford 原则门:sudo 或证明持有
  owner 钱包;guest-pool 派生地址不算数。
- 用途:创作(给 NPC 埋动机)、调试(复现思考路径)、运营(全镇广播事件)。
- 注入不触发立即思考(它只是流里的一条),但调度器对"有新 observation"
  的 NPC 提权一次即时思考(与访客消息同权)。

## 8. 分阶段

- **TS0 — 数据模型 + 反应性对齐**:Thought/流存储/哈希链落地;`talk()`
  内部改写为 observation→reply-action,**外部行为逐字节不变**(smoke:
  现有 talk 冒烟在 flag 开关两种状态下同绿)。无自导思考。
- **TS1 — 自导节奏**:调度器 + 代谢档节奏 + 预算 + 无人观看纪律;
  reflection 落流;0gtown 街市 feed 展示"路过的心声"。
- **TS2 — 可验证流**:逐条 attestation 采集、锚定循环、`inject_thought`、
  证明抽屉扩展。
- **TS3 — 单时间线多人**:宿主启用异步回复语义(NPC 决定回应谁/何时),
  旁听与 gossip 改为流内 observation;onchainpal 市井场景首发。

各阶段验证门:TS0 = 现有冒烟双态全绿 + 流 roundtrip/哈希链单测;
TS1 = 节奏/预算/档位切换的确定性单测(注入 FakeClock 与 FakeKernel);
TS2 = 篡改流任一条 → 链校验失败,注入思想与自产思想可区分;
TS3 = 多访客并发 smoke(回应选择的确定性由 seed 保证)。

## 9. 非目标

- harness 自修改(思想改自身调度/预算/工具面)——明确禁止,可验证性
  与安全边界优先。
- 每条思想上链——链上只有周期性 head 锚;逐条永远在 DSN/warm 层。
- 取代 fusion——fusion 是 infra(一次思考的内部结构),本文是引擎
  (思考的时序与流);advisor profile 是 §4 成本引擎的实现细节。
- 全局单流(全镇一条流)——每 NPC 一条;镇级叙事仍走 gossip/chronicle。

## 10. 开放问题

1. 思想的规范序列化(哈希链输入)是否复用 fusion 回执的 canonical-JSON
   决策(JCS)——建议同一决定,一次定死。
2. 流尾窗口大小与 select 的配比(上下文预算内,流尾 vs 记忆检索的份额)。
3. TS3 的回应选择是否需要确定性(demo 可复现 vs 心智自然性)——倾向
   seed 化确定性,与引擎 STF 哲学一致。
4. 多 NPC 互相观察(A 的 action 成为 B 的 observation)的扇出控制——
   防止思想风暴互相点燃烧穿预算;候选:同房间才可观察 + 每 tick 扇出上限。
