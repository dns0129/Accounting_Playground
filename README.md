# Accounting Playground

## ACCT 2102 财报实验室

一个单文件网页，配合 HKU ACCT 2102（Intermediate Accounting I，IFRS）第 1–4 章学习。录入交易后，它会自动生成整个会计循环：日记账、T 字账、试算平衡工作底稿、损益及其他综合收益表、权益变动表、财务状况表、现金流量表和结账分录。

### 功能

- **35 种交易模板**：日常经营、投资、筹资、期末调整、OCI、终止经营。也可以自己写分录。
- **追溯数字来源**：点报表上的任何数字，可以看到计算公式和构成它的分录。点一笔交易，会高亮它影响到的每一行，一路到净利润、留存收益和现金。
- **切换列报方式**：费用按功能 / 按性质，单一报表 / 两张报表，现金流量表直接法 / 间接法。
- **勾稽检查**：借贷平衡、资产 = 负债 + 权益、净利润 → 留存收益、现金流量表与财务状况表的现金一致、直接法 = 间接法。
- **练习模式**：隐藏分录，报表数字留空自测。
- **36 道练习题**：覆盖第 1–4 章，有选择、配对、计算和分录题，提交后自动判分并给出详解。其中 6 道计算题可以一键载入工作台验证。

### 使用

用浏览器直接打开 `index.html`，不需要安装任何东西。

- 数据和作答记录保存在浏览器的 localStorage 里。换电脑或清除浏览数据前，用右上角「备份」导出 JSON。
- 「AI 描述」和「AI 出新题」现在会显示在普通浏览器中。连接云端 pi agent 后，可使用已授权的 ChatGPT 订阅生成分录、题目和详解；未连接时会显示连接状态。Claude Artifacts 中原有的 AI 调用仍可使用。

### 云端 GPT / pi agent

需要 Node.js 24.5 或更新版本。项目使用 pi 官方 SDK（`@earendil-works/pi-coding-agent`），默认模型为 `openai/gpt-6.1-sol`。

```bash
cd /workspace/Accounting_Playground
npm ci --ignore-scripts --cache /tmp/pi-npm-cache
npm run login
npm start
```

`npm run login` 会打开 ChatGPT 授权流程。在你自己的浏览器中完成登录；云端无法接收本机回调时，把浏览器最后的回调地址粘贴到登录终端。不要把授权码或令牌发到聊天里。登录保存到项目内 `.pi/auth.json`，权限为 600，目录和文件均被 Git 忽略。

云端建议运行 `npm run login:cloud`。这会自动选择 Codex 订阅的设备授权流程，显示官方验证页和设备码，并等待你在浏览器确认账户。确认后自动保存登录，无需复制回调地址；网页点击「刷新连接」即可读取新授权。设备授权需要放行 `auth.openai.com` 和 `chatgpt.com`。未显式设置 `PI_PROVIDER` 时，服务会自动使用新保存的 Codex 订阅授权；若已有普通 ChatGPT OAuth 登录，则优先使用该登录。

也可以直接在网页顶部点击「登录 ChatGPT」，或打开「AI 连接」点击「使用 ChatGPT 登录」。网页会生成登录码并显示「打开 ChatGPT 授权页」按钮；在官方页面输入登录码并确认账户后，本页自动检测结果、保存授权并更新 AI 连接，无需运行终端命令。可随时点击「取消登录」，登录码过期后可重新获取。关闭弹窗不会中断官方页面上的授权。

网页登录需要连接此项目的云端服务。GitHub Pages 仅承载静态网页，无法单独运行授权接口；如使用 GitHub Pages，应在「连接设置」中填写已部署的 HTTPS AI 服务地址和连接口令，并配置服务的 `APP_ORIGIN`。该登录入口不表示代码已发布到 GitHub Pages。

服务默认监听 `127.0.0.1:3000`，从这个服务打开网页后，在「AI 连接」中留空服务地址，并点击「刷新连接」。只使用 ChatGPT OAuth 授权，缺少订阅登录时会报错；即使环境设置了 `OPENAI_API_KEY`，也不会自动切到 API 付费。

这使用账户允许的 ChatGPT 订阅模型额度，实际模型权限、用量上限和计费由 OpenAI 的账户规则决定。订阅登录已配置不表示真实模型调用一定成功。[OpenAI 的第三方应用订阅说明](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)。

#### 网络与对外访问

云环境需要放行 `auth.openai.com`（登录及刷新）和 `api.openai.com`（GPT 请求）。代理和 CA 设置沿用环境配置，启动脚本启用 Node 的环境代理支持。当前任务的云环境只配置了软件包下载白名单，OpenAI 登录域名返回代理 403，因此还需要在云环境设置中补齐这两个域名。

需要 Codex 订阅通道时，分别用 `PI_PROVIDER=openai-codex npm run login` 登录、用 `PI_PROVIDER=openai-codex npm start` 启动，并额外放行 `chatgpt.com`。两条通道的授权分别保存，均禁止自动切到 API Key。

对外访问需使用 HTTPS 反向代理或已有的云服务入口，并设置秘密环境变量 `AI_GATEWAY_TOKEN`；`HOST=0.0.0.0` 时服务会要求设置口令。在网页「AI 连接」中填入 HTTPS 服务地址和口令。若网页与 AI 服务不同域，服务还需要设置 `APP_ORIGIN` 为网页的准确来源（例如 `https://your-accounting-site.example`）。口令只保存在该标签页的 sessionStorage 中；模型 OAuth 凭据始终在服务端。不要将口令放进 URL。

可用环境变量见 `.env.example`。如使用环境文件，可通过 `node --use-env-proxy --env-file=.env server.mjs` 启动；`npm start` 默认读取进程的环境变量，不自动加载 `.env`。

#### 接口与验证

- `GET /api/ai/status`：返回连接状态和模型名称，不返回凭据。
- `POST /api/ai/login`：开始或继续设备授权，返回登录码、官方验证地址和有效期；`GET /api/ai/login` 查询状态；`POST /api/ai/login/cancel` 用 `{ "id": "<登录请求 ID>" }` 取消。登录接口沿用服务口令、来源检查和请求头要求，只向网页返回设备码和状态，不返回 OAuth 令牌。
- `POST /api/ai/json`：请求体为 `{ "task": "transaction" | "quiz", "prompt": "..." }`，成功返回 `{ "result": {...} }`。需要 `Content-Type: application/json`、`X-Accounting-AI: 1`；设置了口令时还需要 `Authorization: Bearer <口令>`。
- 每次请求使用独立的内存会话，不启用文件、Shell、扩展或 MCP 工具，不保存学习内容到 pi 会话文件。页面保留原有账户代码、借贷平衡和题目结构校验，以及停止请求功能。
- `npm test` 验证实际网页的分录和出题流程、未授权状态、取消/超时、访问控制和 pi SDK 初始化。测试使用模拟模型回答，不消耗订阅额度；真实模型调用需要完成 OAuth 登录后另行验证。

示例公司和题目中的公司都是虚构的，仅供学习使用。
