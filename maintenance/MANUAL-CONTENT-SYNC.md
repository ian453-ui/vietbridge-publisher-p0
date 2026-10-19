# 一次手动 Drive 来源同步

维护入口默认关闭平台执行；正常管理员可选用现有本地资料、预览、保存本地内容、建立草稿并仅确认版本，仍使用原 CSRF 和业务归属/版本校验，不授予发布权限。空配置仍不允许 Drive 同步。新入口只在 READ_ONLY 模式读取管理员审批的私有策略；不启用 execution、scan scheduler 或自动 content sync，也不添加平台诊断、reconcile、execute、导入审批或发布权限。

配置入口为 `PUBLISHER_MANUAL_CONTENT_SYNC_AUTHORIZATION_FILE`，指向当前用户拥有、普通文件且 0600 的绝对路径；禁止 symlink。不得同时配置 `PUBLISHER_SCOPED_AUTHORIZATION_FILE`。未配置时原只读入口继续运行。此文件仅包含审批引用和来源标识，不包含凭据。

策略结构如下；占位内容故意不能通过校验。仅在独立复核 GO、父线程确认当次手动同步审批及已有正常 Drive 授权恢复后才可生成真实配置，不得改用新 OAuth client、扩大 scope 或编造审批引用。

```json
{
  "version": 1,
  "operation": "SYNC_EXISTING_DRIVE_SOURCE_ONCE",
  "id": "<unique-authorization-id>",
  "issued_at": 0,
  "expires_at": 0,
  "approval_thread_id": "<actual-human-approval-thread>",
  "approval_message_id": "<actual-human-approval-message>",
  "scope": {
    "workspace": "<exact-current-workspace>",
    "account_id": "<exact-current-account>",
    "project_id": "<existing-project-id>",
    "manifest_drive_file_id": "<existing-manifest-file-id>",
    "relative_root": "clients/<existing-client-root>",
    "source_root": "<absolute-existing-client-root>"
  }
}
```

有效期最多 24 小时。现有 `PUBLISHER_MANIFEST_SOURCES_FILE` 和 `PUBLISHER_DRIVE_CONNECTOR_ENTRY` 仍由原 contentSyncOptions 读取。新门禁要求 workspace/account、project、manifest、relativeRoot 全部与现有来源精确一致，且策略目录、来源目录、客户目录的 device/inode 相同、只有该 workspace 一个物理目录所有者。只读取目录元数据；不会读取 Chrome profile 或平台凭据。多个客户来源不合并、不改写旧 V1 登记。

正常管理员登录后，GET `/api/content-sync?workspace=...&accountId=...` 返回来源状态及 `manualPermission.canRun`。来源卡片在许可可用时启用按钮。POST `/api/content-sync/run` 的 JSON 只能是 `{"workspace":"...","account_id":"..."}`，继续要求原 Origin、JSON Content-Type 和 CSRF；App token、额外 body 字段、query override 均阻断。

任何下载前，先原子创建 DATA_DIR/manual-content-sync 下 0700 目录中的 0600 RUNNING 标记并 fsync。标记以 operation + 原审批 thread/message 为索引；改 authorization ID、scope、到期时间或重启不会复用同一审批。运行结束变为 DONE，异常变为 BLOCKED；两者均代表当次尝试已消耗。并发、既有来源同步、过期、来源变更、未知目录或身份不匹配在下载前阻断。每次读取和文件提交重新检查审批及来源；运行中授权错误立即中止，旧 manifest 保持原样。

同步只通过已有注册来源和已有 makeClient/downloadRaw 接口读取清单、正文和图片，更新本机客户内容库。单项坏图/坏正文按现有机制 BLOCKED，不覆盖旧完整正文，健康新项仍可读取；既有任务快照与图片保持冻结。`lastCompletedAt` 是检查运行结束时间，须同时检查 lastResult/errors，不能当成全部内容成功。

本版本不含主动 OAuth 流程、生产来源登记或有效策略文件。独立复核与授权恢复完成前禁止部署或实际同步。模板中的占位引用不是授权。
