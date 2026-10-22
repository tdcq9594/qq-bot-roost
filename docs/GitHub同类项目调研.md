# GitHub 同类项目调研

> 调研时间：2026-10-22
> 目的：为「斗罗机器人平台」寻找可参考的架构设计，明确差异化定位
> 数据来源：GitHub API 实时查询 + 各项目官方文档

---

## 一、结论先行

三个判断：

1. **通用框架赛道已经饱和**。AstrBot（42.7k）、NoneBot2（7.8k）、Koishi（6.3k）、ZeroBot（2.6k）各自占据一块地盘，现在从零做一个"通用机器人框架"正面竞争没有胜算。

2. **但"文字游戏"这个细分赛道出现了真空**。QQ 群文字游戏的事实标准是 `nonebot_plugin_xiuxian_2`（修仙 2.0），而它 **最后一次提交是 2024-10-09，已停更两年**，只有 98 star 却衍生出几十个魔改 fork。这说明：需求真实存在、用户在流失、没有现代替代品。

3. **本项目的差异化不在"框架"，在"多语言插件 + 细粒度权限 + 游戏垂直整合"**。这三件事现有项目一个都没做全，是我们唯一能立住的点。

---

## 二、项目全景

按与我们的相关度分四层：

### 第一层：通用机器人框架（架构参考）

| 项目 | Star | 语言 | 许可 | 状态 | 核心特征 |
|---|---|---|---|---|---|
| [AstrBotDevs/AstrBot](https://github.com/AstrBotDevs/AstrBot) | 42,761 | Python | AGPL-3.0 | 活跃（日更） | 多平台 + LLM 集成 + 插件市场 + WebUI |
| [nonebot/nonebot2](https://github.com/nonebot/nonebot2) | 7,759 | Python | MIT | 活跃 | 异步、依赖注入、插件生态最大 |
| [koishijs/koishi](https://github.com/koishijs/koishi) | 6,276 | TypeScript | MIT | 活跃 | cordis 内核、嵌套插件、服务容器 |
| [FloatTech/ZeroBot-Plugin](https://github.com/FloatTech/ZeroBot-Plugin) | 2,649 | Go | AGPL-3.0 | 活跃 | 包即插件、三级开关、编译期裁剪 |

### 第二层：协议标准（反面教材）

| 项目 | Star | 状态 | 教训 |
|---|---|---|---|
| [botuniverse/onebot](https://github.com/botuniverse/onebot) | 2,068 | **已冻结**（2023-07 最后更新） | 标准依赖非官方协议实现，go-cqhttp 一停，整个生态被迫迁移 |

### 第三层：文字游戏内容（玩法参考 + 机会点）

| 项目 | Star | 语言 | 状态 | 说明 |
|---|---|---|---|---|
| [QingMuCat/nonebot_plugin_xiuxian_2](https://github.com/QingMuCat/nonebot_plugin_xiuxian_2) | 98 | Python | **已停更**（2024-10） | QQ 群修仙文字游戏事实标准，衍生 fork 数十个 |
| [MyXiaoNan/Marisa](https://github.com/MyXiaoNan/Marisa) | 少 | Python | 开发中 | 修仙 3.0 重构尝试，用 uv + pyright + pre-commit |
| [liyw0205/nonebot_plugin_xiuxian_2_pmv](https://github.com/liyw0205/nonebot_plugin_xiuxian_2_pmv) | 少 | Python | 活跃 | 魔改版，已改用 SQLite + 双适配器（OneBot V11 / QQ 官方） |

### 第四层：小众直连框架（架构高度相似，但没做起来）

| 项目 | Star | 说明 |
|---|---|---|
| [cocotais/cocotais-bot](https://github.com/cocotais/cocotais-bot) | 4 | TypeScript，`npx` 启动 + `plugins` 目录自动加载 + `plugin apply` 命令。架构与我们几乎一致，但 4 star 说明光有架构不够 |

---

## 三、值得借鉴的六个设计

### 1. 配置 Schema 驱动 WebUI 自动渲染 ★★★★★

**来源**：AstrBot 的 `_conf_schema.json`

AstrBot 插件目录下放一个 `_conf_schema.json`，WebUI 自动把它渲染成表单，插件作者**一行前端代码都不用写**：

```json
{
  "api_key": { "description": "API Key", "type": "string", "secret": true, "default": "" },
  "max_retry": { "description": "最大重试", "type": "int", "default": 3 },
  "mode": { "description": "运行模式", "type": "string", "options": ["fast", "safe"], "default": "safe" },
  "nested": {
    "description": "嵌套配置",
    "type": "object",
    "items": { "id": { "type": "int" }, "time": { "type": "int", "default": 123 } }
  }
}
```

支持字段：`type`（string/text/int/float/bool/object/list）、`description`、`hint`、`default`、`options`、`secret`（密码框遮罩）、`invisible`、`editor_mode`（代码编辑器）。

**为什么重要**：这是"吸引开发者"的最低成本杠杆。插件作者最烦的就是"写个功能还要写配置界面"。

**对我们的启示**：目前我们的插件配置是自由 JSON，WebUI 只能显示原始文本。加上 schema 后，配置页可以自动生成表单。工作量不大（前端加一个 schema→表单的渲染器，约 200 行），收益极高。

---

### 2. 插件元数据要能表达"兼容性" ★★★★★

**来源**：AstrBot 的 `metadata.yaml`

```yaml
display_name: 我的插件
short_desc: 一句话介绍你的插件。
support_platforms:
  - telegram
  - discord
astrbot_version: ">=4.16,<5"
```

三个字段值得直接抄：

| 字段 | 作用 |
|---|---|
| `support_platforms` | 声明支持哪些平台，WebUI 按平台过滤显示 |
| `astrbot_version` | 版本约束，不满足则**阻止加载**并提示，可手动跳过 |
| `short_desc` / `logo.png` | 市场卡片展示用 |

**对我们的启示**：我们的 `plugin.json` 目前有 id/name/version/description/author，缺 `shortDesc`、`icon`、`repo`、`frameworkVersion`、`supportPlatforms`。补上这五个，插件市场才有基础。

版本约束建议用 semver 而非 PEP 440（我们是 Node 生态）：`"^0.5.0"` 或 `">=0.5.0 <1.0.0"`。

---

### 3. 嵌套插件与独立热重载 ★★★★☆

**来源**：Koishi

Koishi 的插件可以嵌套 —— 入口插件里 `ctx.plugin(Foo)`、`ctx.plugin(Bar)` 加载子模块：

```ts
export function apply(ctx: Context) {
  ctx.plugin(Foo)
  ctx.plugin(Bar)
}
```

关键收益不是"能拆"，而是**子模块享受独立热重载** —— 改 Foo 的代码不会影响 Bar 的运行状态。

Koishi 插件还有三种等价形态（函数 / 类 / 带 `apply` 的对象），加载时相当于调用一次。这让"插件"这个概念的边界很薄 —— 任何能接收 `(ctx, config)` 的东西都是插件。

**对我们的启示**：斗罗这种大型游戏插件，按玩法拆成 `back`/`boss`/`sect`/`pk` 等子模块后，如果每个子模块能独立热重载，调试体验会好很多。目前我们是整包热重载，改一行要重载整个斗罗。

**优先级**：中。可以做，但不急于第一版。

---

### 4. 插件卸载必须自动回收副作用 ★★★★★

**来源**：cordis（Koishi 内核）

`ctx.plugin()` 返回一个 fork 对象，调用 `.dispose()` 会**自动清理该插件注册的所有中间件、指令、定时器、事件监听**。插件作者不需要写任何清理代码。

这是正确性问题，不是体验问题。如果卸载插件时指令还挂在注册表里，就会出现"插件已卸载但指令还能触发 → 报错"。

**我们的现状（已核查，比预想的好）**：`loader.unload()` 对两种插件都做了完整清理 ——

| 注册入口 | 存放位置 | 清理方式 |
|---|---|---|
| `ctx.command()` | `registry.commands` + `menus` | `registry.clearPlugin(id)` |
| `ctx.on()` | `registry.listeners` | 同上 |
| `ctx.menu()` / `defineLevels()` | `registry.menus` | 同上 |
| `ctx.schedule()` | `ctx` 内部 `disposers` | `ctx.dispose()` |
| `ctx.onTeardown()` | 同上 | 同上 |
| `ctx.storage` | 待写盘缓冲 | `dispose()` 里 `flush()` |
| 外部插件子进程 | `SubprocessPlugin` | `host.stop()` |

**结论：这一项不需要改。** 唯一遗留的边界是插件作者绕过 `ctx` 直接调 `setInterval` / `process.on` —— 那是作者的责任，规范里写清楚即可。

**核查中发现的真实小问题**：`loader.js` 的 `errors` 映射键不一致 ——

- 第 127 行 `this.errors.set(id, ...)` 用**目录名**
- 第 177 行 `this.errors.delete(meta.id)` 用**插件自报 id**

当 `plugin.json` 里的 `id` 与文件夹名不同时（当前代码没有强制两者一致），一个插件「先加载失败、后修复成功」会留下**残留错误记录**，WebUI 上仍显示为失败。修法二选一：统一用 `meta.id` 作为 `errors` 的键，或在加载时校验 `id === 目录名` 并报错。建议后者，同时消除 `loaded`、`allocations`、`errors` 三处键不一致的隐患。

---

### 5. 三级开关与明确的优先级规则 ★★★★☆

**来源**：ZeroBot-Plugin

三层开关：

| 层级 | 命令 | 说明 |
|---|---|---|
| 编译期 | 注释 `main.go` 的 `import` | 物理裁剪，减小体积 |
| 运行期全局 | `/全局启用 xxx` | 所有群默认 |
| 运行期单群 | `/启用 xxx` | 单群覆盖 |

并且**把优先级规则写进文档**：

> 当全局未配置或与默认相同时，状态取决于单独配置，后备为默认配置；当全局与默认不同时，状态取决于全局配置，单独配置失效。

**对我们的启示**：我们目前只有 `groups.enabled` 群级开关，缺全局开关。加了全局开关后，必须同时明确"全局禁用 vs 群级启用"谁优先 —— 建议采用 ZeroBot 的规则（全局显式禁用优先，防止误开），并写进文档。

---

### 6. 文字游戏的模块划分（直接可用的玩法清单）★★★★★

**来源**：修仙 2.0 的 `xiuxian/` 目录

```
xiuxian_back/        背包
xiuxian_bank/        银行（存钱）
xiuxian_base/        基础（等级、属性、境界）
xiuxian_boss/        BOSS 战
xiuxian_buff/        状态增益
xiuxian_impart/      传承（先天属性）
xiuxian_impart_pk/   传承对战
xiuxian_info/        信息查看
xiuxian_mixelixir/   炼丹（合成）
xiuxian_rift/        秘境（副本）
xiuxian_sect/        宗门（公会）
xiuxian_work/        打工（产出货币）
```

外加若干横切模块：`data_source.py`（数据读写）、`item_json.py`（物品定义）、`lay_out.py`（消息渲染）、`player_fight.py`（战斗计算）、`read_buff.py`（buff 解析）、`xiuxian_config.py`（配置）、`xiuxian_opertion.py`（通用操作）。

**映射到斗罗**：

| 修仙模块 | 斗罗对应 |
|---|---|
| base | 魂力等级 / 魂环年限 / 属性面板 |
| back | 储物魂导器 |
| bank | 金魂币 |
| boss | 魂兽猎杀 / 魂环获取 |
| buff | 状态（武魂附体、增幅魂技） |
| impart | 魂骨 / 传承 |
| pk | 魂师对决 |
| mixelixir | 锻造 / 丹药 / 合成 |
| rift | 星斗大森林 / 魂兽秘境 |
| sect | 唐门 / 七宝琉璃宗 / 史莱克 |
| work | 猎魂任务 / 委托 |

这个划分验证了一件事：**我们的插件规范应该允许一个游戏插件内部再分层**，而不是把所有玩法塞进一个 `index.js`。斗罗应该是一个「插件包」，内部按玩法分子模块。

---

## 四、横向对比

| 维度 | 我们 | AstrBot | NoneBot2 | Koishi | ZeroBot |
|---|---|---|---|---|---|
| 语言 | Node.js 内核 + **多语言插件** | Python | Python | TypeScript | Go |
| 插件语言 | **JS / Python / Go / 任意** | Python | Python | JS/TS | Go |
| 运行时依赖 | **零依赖** | 大量 | 大量 | 大量 | 零（编译后） |
| 官方 QQ API 直连 | ✅ | ✅（适配器） | ✅（适配器） | ✅（适配器） | ❌（走 OneBot） |
| 权限模型 | **5 作用域 × 数字等级** | ADMIN 布尔 | SUPERUSER 列表 | 有限 | superusers + 服务粒度 |
| WebUI | ✅ 6 页签 | ✅ 完整 | ❌（需插件） | ✅ Console | ❌（可选编译） |
| 插件市场 | ❌ | ✅ | ✅ | ✅ | ❌ |
| 配置 Schema | ❌ | ✅ | ✅（Pydantic） | ✅（schemastery） | ❌ |
| 多平台 | ❌（仅 QQ） | ✅ 14 平台 | ✅ 多 | ✅ 多 | ❌ |

**读法**：我们在「多语言」「零依赖」「权限粒度」三项领先，在「市场」「配置 Schema」「多平台」三项落后。后三项里，配置 Schema 成本最低收益最高，应该先补。

---

## 五、本项目已经做得更好的地方

这部分要写进 README，是差异化卖点的依据：

1. **唯一真正多语言的插件平台**。AstrBot / NoneBot2 只有 Python，ZeroBot 只有 Go，Koishi 只有 JS/TS。我们内建 ESM + 外部子进程 NDJSON，Python / Go / Rust / C# 都能写插件，且实测外部插件开销 0.089 ms/条（串行）、0.020 ms/条（10 会话并行）。

2. **零运行时依赖**。原生 `fetch` + 全局 `WebSocket` + `http`，装完 Node 22 直接跑。对比 AstrBot 的依赖树（FastAPI + Quart 兼容层 + faiss + 一堆 LLM SDK），我们的部署成本低一个数量级。

3. **权限粒度最细**。AstrBot 只有 ADMIN 布尔值；ZeroBot 有 superusers 列表 + 服务粒度封禁。我们是「作用域（global/group/channel/user/feature）× 数字等级（0 主人 / 1 管理员 / 2 群管 / 3 助手 / 10-998 插件区 / 9999 无权限）」，且等级号段启动时按插件 id 字典序动态分配，插件可自定义自己的等级。这个模型没有对标。

4. **内建 + 外部双轨**。轻量功能写内建（0.134 ms/条），重功能或非 JS 语言走子进程（崩溃不影响主进程，kill 后 4 秒自动重启）。别人都是单一形态。

5. **直连官方 API**。OneBot 标准 2023-07 已冻结，go-cqhttp 停维护，整个生态被迫迁移。我们从第一天就走官方 API，没有这个包袱。

---

## 六、行动建议（按优先级）

| 优先级 | 事项 | 理由 | 预估工作量 |
|---|---|---|---|
| P0 | 插件配置 Schema + WebUI 自动表单 | 吸引开发者的最低成本杠杆 | 前端渲染器 ~200 行 + 规范补一节 |
| P0 | 插件元数据补 `shortDesc` / `icon` / `repo` / `frameworkVersion` / `supportPlatforms` | 插件市场的前提 | 规范 + loader 校验，~50 行 |
| P1 | 修 `loader.js` 的 `errors` 键不一致（见第三节第 4 条） | 已确认的真实缺陷，会导致 WebUI 显示残留失败 | ~10 行 |
| P1 | 全局插件开关 + 明确优先级规则写进文档 | 多群运维刚需 | ~80 行 + 文档 |
| P1 | 斗罗按玩法拆子模块（参考修仙的 11 个模块划分） | 直接影响游戏插件可维护性 | 设计阶段就要定 |
| P2 | 嵌套插件 + 子模块独立热重载 | 调试体验 | 中等 |
| P3 | 多平台适配层抽象 | 只有真要做多平台时才需要，现在做是过度设计 | 大 |

> 注：原计划的「核查插件卸载副作用回收」已核查完毕，结论是**当前实现完整，无需改动**。

---

## 七、附：完整仓库清单

```
通用框架
  AstrBotDevs/AstrBot              42,761  Python    AGPL-3.0   ★ 最值得读
  nonebot/nonebot2                  7,759  Python    MIT
  koishijs/koishi                   6,276  TS        MIT        ★ 插件模型最优雅
  FloatTech/ZeroBot-Plugin          2,649  Go        AGPL-3.0   ★ 开关设计
  cocotais/cocotais-bot                 4  TS        -          架构相似但没做起来

协议标准
  botuniverse/onebot                2,068  -         MIT        已冻结（2023-07）

文字游戏
  QingMuCat/nonebot_plugin_xiuxian_2   98  Python    -          已停更（2024-10）★ 机会点
  MyXiaoNan/Marisa                     ?  Python    MIT        修仙 3.0 重构尝试
  liyw0205/nonebot_plugin_xiuxian_2_pmv ? Python    -          魔改版，已用 SQLite
```

---

## 八、一句话总结

**别做第二个 AstrBot，做第一个"多语言文字游戏机器人平台"。**

现有项目的空白是：修仙 2.0 停更两年、没人接手、玩法代码和框架代码耦合在一个 NoneBot 插件里。如果我们把「框架」和「斗罗」彻底分开 —— 框架提供多语言插件 + 细粒度权限 + 配置 Schema，斗罗作为一个参考实现展示这套框架能做什么 —— 这个定位没有竞争对手。
