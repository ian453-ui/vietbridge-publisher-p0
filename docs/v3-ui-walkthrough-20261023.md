# Publisher V3 隔离界面验收，2026-10-23

本轮在 `publisher-v3/cloud-slice-01` 的 `86d8e1381f4c868b4704da2d831b638fe5ec863d` 基线上执行。开始时工作区干净、Git 索引无锁，未发现活动的 Git/Node 写入者。使用云端 `/usr/bin/chromium` 和 Playwright 打开实际 Worker 入口提供的 V3 HTML/CSS/JS，分别以 1440×1000 和 390×844 视口操作。服务仅监听本机随机端口，采用临时 SQLite、文件素材桶、`synthetic-owner` 服务器端模拟身份、两个标注为“合成验收”的客户和四个标注为“假账号”的账号。页面顶部另加隔离测试标识。浏览器拦截非本机来源请求；本轮没有生产数据、真实凭据或平台外发。

这是真实浏览器操作与**合成后端绑定**的验收，不是正式 ChatGPT Sites 登录、真实 D1/R2 或真实平台账号验收。下表中的失败回包和 `UNKNOWN` 是隔离实例内的模拟，不能推断线上故障已经复现。

| 步骤与预期 | 浏览器实际结果 | 证据 |
| --- | --- | --- |
| 切换到空客户 B，内容和任务应为空；返回客户 A 后可见共享内容 | B 显示明确空态；A 显示不同完整 ID、日期与版本的内容，不按三位尾号合并 | [桌面初始](evidence/v3-ui-walkthrough-20261023/01-desktop-overview.png)、[空客户](evidence/v3-ui-walkthrough-20261023/02-empty-workspace.png)、[手机空态](evidence/v3-ui-walkthrough-20261023/13-mobile-empty-and-switch.png) |
| 查看 Facebook 和小红书独立稿；展开原完整正文 | Facebook 与小红书显示各自的标题/正文；原文第二段末尾可展开，缺 Facebook 稿的内容不提供 Facebook 完整预览 | [Facebook 预览](evidence/v3-ui-walkthrough-20261023/03-content-preview.png)、[小红书预览](evidence/v3-ui-walkthrough-20261023/04-xhs-preview.png) |
| 编辑 Facebook 平台稿、预览并保存 | 保存回读为独立平台版本 2；原文及其他平台稿没有被该操作替换 | [编辑预览](evidence/v3-ui-walkthrough-20261023/05-edit-preview.png)、[原始状态记录](evidence/v3-ui-walkthrough-20261023/actions.jsonl) |
| 查看制作图片、完整文本；人工内容批准后查看准备结果 | 合成 PNG 解码为 1122×1402，正文与平台稿读到末段；批准后仅生成 `UPLOAD_PREVIEW_ONLY · DRAFT`，没有发布许可 | [图片和全文](evidence/v3-ui-walkthrough-20261023/07-review-full-media.png)、[批准回执](evidence/v3-ui-walkthrough-20261023/08-content-approved.png)、[准备预览](evidence/v3-ui-walkthrough-20261023/09-plan-preview.png) |
| 明确目标账号 A2 后逐项预检 | 显示“须独立审核”“缺少所选平台稿”“旧版本须重选”等逐项原因；没有把 A1 的批准转移给 A2 | [预检](evidence/v3-ui-walkthrough-20261023/10-batch-preflight.png) |
| 模拟保存已提交但浏览器收到 503；先回读，避免自动重试 | 界面将该项标记“未确认；重新预检、回读原任务”；数据库只有一个 A2 草稿。重新预检显示同一任务已冻结；任务页可读回编辑后的完整文案 | [失败回包](evidence/v3-ui-walkthrough-20261023/11-lost-ack-result.png)、[任务回读](evidence/v3-ui-walkthrough-20261023/12-task-readback.png) |
| 模拟原任务为 `UNKNOWN` 后再次预检 | 任务页显示原尝试；预检提示“原任务只可对账，不重建或重发”，冻结按钮禁用 | [UNKNOWN 任务](evidence/v3-ui-walkthrough-20261023/15-mobile-unknown-reconcile.png)、[对账限制](evidence/v3-ui-walkthrough-20261023/16-unknown-preflight.png) |
| 在 A1、A2、空客户 B 之间切换，关闭弹窗并返回导航；检查手机宽度 | 各账号任务分别回读，空客户不显示 A 客户内容；弹窗关闭后可回内容/任务/审核页；页面与弹窗在 390px 均无横向溢出，未捕获页面脚本异常或外域请求 | [手机审核](evidence/v3-ui-walkthrough-20261023/14-mobile-review.png)、[手机账号标识](evidence/v3-ui-walkthrough-20261023/19-mobile-account-clarity.png)、[逐步记录](evidence/v3-ui-walkthrough-20261023/actions.jsonl) |

本轮修复两个已在浏览器复现的普通界面问题：

1. **P2，列表无法查找。** 原操作：客户 A 的内容列表中寻找 `qa-other-date` 或完整内容 ID，页面没有搜索入口，必须逐张卡片阅读。预期：在当前结果中按标题、完整 ID 或 slug 定位，且“选择前 20 项”只作用于可见结果。现在提供本次最多 200 项的本地筛选、结果计数、无匹配空态；搜索词变化会清空选择和在途预检结果，切换账号时清空搜索。已在手机实际输入、选择、清空和切换账号复验：[匹配结果](evidence/v3-ui-walkthrough-20261023/18-mobile-search-found.png)、[无匹配结果](evidence/v3-ui-walkthrough-20261023/17-mobile-search-empty.png)。
2. **P2，手机当前账号辨认困难。** 原操作：在 390px 顶栏切换名称尾部才有区别的 Facebook A1/A2；下拉框闭合时两个名称均被截断。预期：在任何页能看清当前完整客户和账号。现在导航下方显示完整客户、账号和平台，切换后立即更新；没有放宽账号隔离：[修复后手机图](evidence/v3-ui-walkthrough-20261023/19-mobile-account-clarity.png)。

旧版对比仅依据仓库代码检查，未运行 V1/V2 真实服务。V1 的 `legacy-p0/src/web-ui.ts:99,103,108` 确有标题/编号搜索和图片点击放大；V3 现恢复当前已加载内容的搜索，审核图仍只在弹窗内预览，未实现 V1 的点击放大。V2 快照 `85e987a00876a94385c5b4e99be67a7347523457` 的 `src/unified-client.js:47-58,165-174` 有账号映射及标题、正文、标签、作者、媒体输入，`34-45` 有带冻结内容和目标身份的单次执行确认。V3 当前只验收内容/草稿/内容审核；文件替换、跨平台媒体编辑和真实执行不在本包，不能声称完整继承或已上线。

截图是合成数据和模拟身份的浏览器证据。真实用户登录、官方 Sites 部署与绑定、实际 D1/R2、真实平台身份和发布结果均未验证。没有新 Site、权限或凭据变动。

验证：`node --check src/sites/cloud-console.js` 通过；相关浏览器回归 `node --test test/sites-worker-ui.test.js test/sites-cloud-console-ui.test.js` 为 **48/48**。首次直接 `npm test` 有 23 项因旧测试默认寻找 Mac Chrome/ffmpeg 而无法启动，不是断言失败，原日志见 [首次全量日志](evidence/v3-ui-walkthrough-20261023/full-test.log)。设置仓库已有的 `PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium`、`PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg` 后在此云端实例重新运行完整 `npm test`，结果 **1339/1339 通过，0 失败、0 取消、0 跳过**，见 [最终全量日志](evidence/v3-ui-walkthrough-20261023/full-test-cloud.log)。
