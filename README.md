# VietBridge 多平台发布器 P0

这是一个独立本地 Web 应用。日常运行不调用 AI，也不消耗模型 token。SQLite 是执行事实权威；Google Drive 台账是跨工具共享镜像；平台回读是外部副作用权威。

## 当前已经可用

- 极简单页 UI：新建任务、立即执行、每个平台独立进度、暂停/继续/终止、完成结果。
- 任务名自动生成，无“保存草稿”步骤。
- 内容源支持：默认台账、内容编号、关键词、本地路径、本地文件选择器、`file://`、Google Drive 文件链接。
- 选择单个本地文件时按文件哈希反查资源库，并补齐同一内容包的标题、正文、封面与完整媒体。
- 关键词只返回候选，不自动猜测。
- 共享台账中已发布的平台自动取消选择并置灰。
- 内容在入队前复制成 SHA-256 寻址的不可变快照。
- 每个平台单独建作业、单独记录事件、提交尝试、回执、异常和人工问询。
- 发布审批、单次提交防护、`UNKNOWN → RECONCILE_PENDING`、公众号草稿非正式发布、视频号无 ID 成功等状态规则已实现并通过测试。

## 平台执行状态

- Facebook 图文：已接入真实后台 worker，支持单图/多图、dry run、一次提交、帖子 ID 回读和永久结果记录。
- 小红书图文/视频：已升级到官方 v2.5.0，接入登录身份检查、一次提交和不确定结果阻断；超时仍会进入 `RECONCILE_PENDING`，不会自动重发。
- 微信公众号：已接入 Wenyan `publish_article`，只记录为公众号草稿箱，不宣称正式群发。
- 视频号：已接入专用、持久化的受控 Chrome 页面驱动。首次扫码后复用登录；自动核对账号、上传视频、填写标题/描述/合集、单次发表，并以独立视频列表的标题＋数量/状态回读作为成功证据。登录或回读不明确时只暂停当前平台。

后台 worker 随 Web 服务一起启动。任务不再停留在虚假的“排队中”：它会执行、明确阻断，或要求用户处理登录/平台不确定状态。

Google Drive 链接会先识别文件 ID；只有文件已经同步进允许的本地资源库时才自动匹配。P0 不自动下载任意公网 URL。

## 启动

双击 `启动发布器.command`，或在本目录运行：

```sh
npm run web
```

然后打开 `http://127.0.0.1:17880/`。

验证命令：

```sh
npm run typecheck
npm test
python3 /Users/a1-6/.codex/skills/vietbridge-multiplatform-publisher/scripts/validate_p0_cases.py test/fixtures/p0-acceptance-cases.json
```

设计依据见 `docs/gpt-design-review-decision.md` 和 `docs/independent-app-architecture.md`。
