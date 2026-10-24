## 栖 Roost v0.6.0

这一版主要解决两件事：**「我配好了为什么没反应」**，和**「写插件太麻烦」**。
顺手把面板导航重排了，插件装多了不会再挤爆顶栏。

---

### 一、体检：不用再猜哪一步没通

面板概览页最上面多了一个「体检」，打开就自动跑一遍：

| 查什么 | 查不出来时的提示 |
|---|---|
| 凭证 | 换不到 access_token 时告诉你检查 AppSecret 有没有复制全 |
| 连接 | 没连上时提示去看 4014（没开通群聊能力）/ 4902（重复启动） |
| intents | **群聊事件没订阅**——网关连得上、日志也正常，但群消息一条进不来 |
| 插件目录 | 不可写时直接给路径 |
| 下载源 | 只有直连、没有兜底时提醒改成「自动」 |
| 面板暴露面 | 监听 0.0.0.0 又没设 accessKey 时报错 |
| 统计 | Node 版本不够、没有内置 SQLite 时说明「只是统计页空，其它不受影响」 |

每一项都带一句人话解释和**该去哪儿改**。全绿时只留一行「一切正常」，不占地方；
有 error 才自动展开。

---

### 二、写插件：三个命令，不连 QQ 也能跑

```bash
npm run create -- my-plugin "我的插件"      # 生成骨架（命令 + 菜单 + 配置示例）
npm run test:plugin -- my-plugin --list     # 看它注册了哪些命令和菜单
npm run test:plugin -- my-plugin hello 小明 # 跑一条，直接看回复
```

`test:plugin` 用的是新增的 `src/plugin/testkit.js`：造一个假 `ctx` 和假 `msg`，
把命令跑一遍。不需要凭证、不开面板、不连网关。想写断言就在自己的测试里
`import { runCommand } from './src/plugin/testkit.js'`。

夹具只实现插件真会用到的那部分能力，`ctx.api` 里没实现的方法**调用时直接报错**，
而不是静默返回 `undefined` 让你查半天。

### 外部插件也有 SDK 了

以前写 Python 插件得自己对着协议手写收发。现在仓库里有两个单文件 SDK，
拷到插件目录就能 import，不装包、不建虚拟环境：

| 语言 | 文件 | 用法 |
|---|---|---|
| Python | `sdk/python/roost_sdk.py` | `from roost_sdk import Plugin` |
| Node | `sdk/node/roost.mjs` | `import { Plugin } from './roost.mjs'` |

```python
from roost_sdk import Plugin

p = Plugin(id='my-plugin', name='我的插件', version='1.0.0')

@p.command('hello [名字]', desc='打个招呼')
def hello(m):
    m.reply(f'你好，{m.args[0] if m.args else m.name}')

if __name__ == '__main__':
    p.run()
```

协议本身没变，SDK 只是把它包成顺手的样子——`插件协议.md` 仍然是权威定义。

### 编辑器里终于有补全了

`types/roost.d.ts` + `jsconfig.json`：插件里写 `/** @param {RoostCtx} ctx */`，
`ctx.` 和 `msg.` 就都有补全和说明了。**`checkJs` 是关的**——只给补全，
不会因为类型问题满屏红波浪线。不想要直接删掉这两个文件，不影响运行。

---

### 三、插件配置能声明校验规则

默认值不再只能写死一个值：

```js
config: {
  greeting: '你好',                                                  // 简写，类型自动推断
  count: { default: 3, type: 'number', min: 1, max: 10, desc: '几次' },
  name:  { default: '', type: 'string', required: true },
  token: { default: '', type: 'string', pattern: '^[a-z0-9]+$' },
}
```

面板照 schema 生成控件并当场拦一道，后端 `setConfig` 落盘前再验一次
（聊天里的命令也能改配置，面板不是唯一入口）。

`type: 'string'` 当 `text` 的别名处理——作者十有八九会写 `string`，不让他因此踩空。
正则写错了只跳过那一条校验，不会让整个保存失败。

---

### 四、`ctx.state`：热重载不再吃掉内存数据

热重载会重建模块，模块顶层变量全丢。这是 ESM 的行为，但第一次遇到的人
基本都会以为是框架把数据吃了。现在想留的东西挂 `ctx.state`：

```js
setup(ctx) {
  ctx.state.cache ??= new Map();   // 重载后还是同一个对象
}
```

| | `ctx.state` | `ctx.storage` |
|---|---|---|
| 跨热重载 | 保留 | 保留 |
| 跨重启 | **丢** | 保留 |
| 适合 | 缓存、计数器、连接句柄 | 玩家数据 |

插件被卸载（不是重载）时才清掉。

---

### 五、导航重排：4 个一级入口

```
概览   数据 ▾        设置 ▾        插件 ▾
       统计          配置          插件管理
       事件          群组          ─────────
       日志          权限          插件页面（各插件注册的）
```

插件注册的页面从「每个占一个顶部页签」改成挂进「插件」菜单——**插件装多了
不会把顶栏挤爆**。子项选中时父级也高亮，否则用户看着「概览」亮着、
内容却是日志，会以为自己点错了。点击外部或 Esc 收起，`#stats`、`#page:dice:rank`
这些地址仍然可以直接打开。

---

### 六、其它

- **插件市场能搜了**：搜索框（名字 / 描述 / 标签）+ 分类下拉，纯前端过滤，输入即生效
- **统计能导出**：`/api/stats/export` 给 CSV，带 BOM，Excel 打开中文不乱码。
  导的是**汇总**（按天 / 按会话 / 按命令），不是逐条明细——明细带 openid，
  做表格分析用不上，还会把隐私带出去
- **权限页能点人了**：列出「最近说过话的人」，点一下自动填好 openid 和作用域，
  不用去日志里翻长串
- **群组页能手动登记**：官方没有「列出机器人所在的群」的接口，一直没被 @ 过的群
  根本不会出现。知道 openid 的话可以手动登记
- **插件加载失败能看堆栈**：卡片上一行摘要，点「查看堆栈」展开完整调用栈；
  修好重新加载后旧堆栈会自动清掉
- **内建插件也会自动装依赖**：以前只有外部插件会装，内建插件要手动
  `npm i --prefix`，踩坑的人不少
- **插件页面跟着主题走**：iframe 带上 `theme` 参数，页面里直接用
  `var(--panel)` `var(--text)`，作者不用自己适配深浅色

### 修的 bug

- `.gitignore` 里的 `node/` 会忽略**任何层级**下名为 node 的目录，
  `sdk/node/roost.mjs` 被静默排除、没进版本库。改成 `/node/` 锚定根目录
- 新代码里用了 `var(--accent)`，但面板根本没定义这个变量；
  体检的状态色也写死了十六进制，夜间模式下对比度不够。统一改成
  `--ok` / `--warn` / `--err` / `--primary`
- 插件加载成功后没清 `errorStacks`，修好之后面板还挂着上次的旧红字

---

### 测试

```bash
npm test          # 267 项（+27）
npm run test:e2e  # 145 项（+23）
```

新增覆盖：体检各项判定、testkit 的假 ctx / 假 msg / runCommand、
配置校验（必填 / 范围 / 正则 / 写错正则）、`ctx.state` 跨重载、
市场搜索与分类、CSV 导出、权限候选人、导航结构（分组下拉 / 插件页面容器 / aria）。

---

### 升级

```bash
git pull
```

不需要改配置，也不需要改插件。导航结构变了但地址没变，收藏的
`#config`、`#page:xxx` 照样能打开。

---

### 许可

**永久免费，禁止任何收费，禁止商业使用。** 不提供商业授权。
