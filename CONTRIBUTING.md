# 贡献指南

先说一句：这个项目的取舍很明确——**宁可少一个功能，也不要一个"看起来很智能、实际点不准"的功能**。提 PR 之前，用下面这把尺子量一下自己要做的事。

## 报告问题

开 issue 时请带上这些，能省掉一半来回：

1. **系统与版本**：操作系统版本、Node 版本、`package.json` 里的版本号；
2. **设备情况**：`adb devices -l` 的输出（**序列号请自行打码**）；
3. **日志**：`%USERPROFILE%\.moka\desktop.log` 尾部 50 行，以及界面里"运行日志"那段；
4. **复现步骤**：你输入的那句话、模型是什么、卡在哪一步。

> 提交前请把日志里的 API Key、IP、设备序列号、聊天内容抹掉。贴出来的东西是公开的。

## 提交代码

```bash
git clone https://github.com/ismoshushi/moka moka
cd moka
npm install
npm run dev        # 改完能热更新
```

- 从 `main` 切一个语义化分支：`feat/xxx`、`fix/xxx`、`docs/xxx`；
- 一次 PR 只做一件事，顺手格式化会把 diff 淹掉；
- 提交信息用祈使句，例如 `fix(phone): 无线配对超时压到 18 秒`；
- **不要提交 `dist/`、`node_modules/`、`.cache/`**，也不要提交任何 `state.json`（里面有 Key）。

### 签署 DCO

本项目不使用 CLA，改用 [Developer Certificate of Origin](https://developercertificate.org/)。提交时加 `-s`：

```bash
git commit -s -m "feat(agent): 增加 phone_swipe"
```

这行 `Signed-off-by: 你的名字 <你的邮箱>` 表示你有权提交这段代码。

## 加一个工具

模型靠**描述**选工具，所以新增能力的成本几乎全在"怎么描述"上：

1. `electron/lib/agent.js` 的 `TOOLS` 里加函数定义；
2. 同文件 `dispatch()` 里加对应 `case`；
3. `SYSTEM` 提示词里写清**什么时候该用它、什么时候不该用**；
4. 在真机上跑通再提，别只跑通 `console.log`。

反面例子：`phone_tap` 的描述写"点击屏幕"——模型会瞎点。写"按截图上的像素坐标点击；坐标来自 phone_shot 截图，左上角为 (0,0)"，它才知道该干什么。

## 代码风格

- 主进程（`electron/`）是 **CommonJS**，别混 ES Module——Electron 33 在这个组合下会崩；
- 渲染层是 React + TypeScript，不留 `any` 兜底；
- 注释写"为什么"，不写"是什么"；踩过的坑要留在代码里（这个仓库有大量这类注释，别删）；
- 报错信息要对人能说人话：区分超时 / DNS / 连不上 / TLS / Key 错，不要只回一句"失败"。

## 不做什么

- 不加任何形式上传统计、埋点、崩溃上报；
- 不引入需要账号登录的云服务；
- 不做绕过平台风控、批量养号、自动加好友这类用途。这类 PR 直接关。

## 许可证

提交即表示你同意以 [Apache-2.0](../LICENSE) 授权你的贡献。
