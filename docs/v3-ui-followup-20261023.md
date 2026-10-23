# Publisher V3 界面小包复验，2026-10-23

起点为原分支 `publisher-v3/cloud-slice-01` 的 `60dbe57849153baf7f03e79cffa846be05ea0914`，工作区干净且没有活动的 Git/Node 写入者。以云端 Chromium 打开实际 Worker 入口提供的 V3，服务只监听 `127.0.0.1`；后端使用临时 SQLite、合成媒体文件、模拟服务器身份，以及标记为“合成验收”的客户和“假账号”。没有使用真实登录、生产数据、社媒权限或外发。

| 问题与严重级别 | 复现、预期和实际结果 | 证据 |
| --- | --- | --- |
| P2：审核信息图无法放大 | 在 390px 审核弹窗中打开 1122×1402 的合成封面，原图仅以最多 300px 高显示，图片没有可点或可聚焦的放大入口。现在图像按钮可打开同一账号、同一审核素材的放大层；先适应屏幕，再可切到原始像素并横纵滚动。Escape 和明确的关闭按钮返回原审核弹窗及原图按钮焦点；连续 Escape→Enter 重开也稳定。 | [修改前手机审核图](evidence/v3-ui-followup-20261023/02-before-review-image.png)、[手机放大预览](evidence/v3-ui-followup-20261023/04-after-mobile-image-fit.png)、[原始像素模式](evidence/v3-ui-followup-20261023/05-after-mobile-image-original.png)、[桌面放大预览](evidence/v3-ui-followup-20261023/08-after-desktop-image-fit.png) |
| P2：手机首张内容卡出现过晚 | 在 390×844 视口，原首卡顶端位于页面 y=1190。将完整识别/批量说明移至卡片后的可展开区，压缩重复文案与控件间距后，首卡顶端 y=826，页面无横向溢出。顶端仍直接显示完整客户/账号、真实发布未启用、手动稿待核验、目标账号必须明确、须逐项预检、仅冻结草稿及改稿重新审核。详情展开后仍可查看完整 ID、版本、三位尾号规则和 MANUAL_UNVERIFIED 等说明。 | [修改前手机列表](evidence/v3-ui-followup-20261023/01-before-mobile-list.png)、[修改后手机列表](evidence/v3-ui-followup-20261023/09-after-mobile-compact.png)、[桌面列表](evidence/v3-ui-followup-20261023/07-after-desktop-list.png) |

图片查看只复制当前已入账审核图片的同源、同工作区、同账号素材地址；其他地址在界面层拒绝，服务端原有访问校验保持不变。切到另一假账号后看不到原账号的审核卡。实际浏览器操作中没有外域请求或页面脚本错误。合成封面仅验证尺寸、放大、关闭和范围，不代表真实文字信息图的可读性已验收。

本轮只改 V3 的 HTML、CSS、浏览器行为和相关回归；没有触及部署、授权、凭据或发布流程。真实用户身份、正式 Sites 运行环境和真实媒体仍未验收。

验证：`node --check src/sites/cloud-console.js` 通过。相关浏览器回归[首跑](evidence/v3-ui-followup-20261023/focused-first.log) **46/48**，两项旧断言仍等待被压缩前的成功提示文字；更新断言后，原失败场景、图片查看与 Worker 入口的[定向复跑](evidence/v3-ui-followup-20261023/focused-regression.log) **6/6**。随后以本实例已有的 Chromium 和 ffmpeg 路径运行完整 `npm test`，结果 **1339/1339 通过，0 失败、0 取消、0 跳过**，见 [最终全量日志](evidence/v3-ui-followup-20261023/full-test-cloud.log)。
