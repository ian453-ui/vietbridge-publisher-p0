const reasons={
 OWNER_EVIDENCE_MISSING:'补充原负责人和当前负责人标识；不要推断或自动换人。',
 OWNER_CHANGE_NOT_ALLOWED:'当前负责人不一致；交回原负责人确认，不自动转移。',
 SOURCE_IDENTITY_MISMATCH:'确认原仓库的 publisher-unified 分支及标准 GitHub origin。',
 EXACT_COMMIT_REQUIRED:'核对交接的完整40位提交与本地 HEAD；不要自动采用更新版本。',
 WORKTREE_NOT_CLEAN:'工作树有修改或状态不明；先保留并评审，不覆盖。',
 MAC_EVIDENCE_MISSING_OR_EXPIRED:'补充有效的 Mac 观察证据；不影响独立云端检查。',
 MAC_OFFLINE_OR_UNKNOWN:'Mac 离线或状态不明；本地步骤等待，不自动转到云端执行。',
 MAC_LOCAL_CHANGES_OR_UNKNOWN:'确认 Mac 工作树干净；有修改时先保留。',
 DATA_PRESERVATION_UNCONFIRMED:'明确保留本地数据库、浏览器及访问配置，不上传它们。',
 MAC_EXACT_COMMIT_REQUIRED:'Mac 尚未确认在目标提交；同步后再做本地验收。',
 LOCAL_DEPENDENCIES_UNVERIFIED:'本地运行依赖尚未核实；只补必要证据。',
 EXISTING_PUBLICATION_CONFIRMATION_REQUIRED:'本工具永不授予发布许可；继续遵循原执行确认流程。',
 HISTORY_INCOMPLETE_OR_EXPIRED:'历史证据缺失、不完整或过期；不能据此判断可重发。',
 ACCOUNT_BINDING_MISSING:'补充准确的工作区与账号绑定。',
 HISTORY_SCOPE_MISMATCH:'历史记录不属于所选账号／工作区；停止混用证据。',
 EXISTING_OR_UNCERTAIN_RESULT_NO_REPLAY:'存在已执行或不确定结果；禁止重放，沿原流程核对。',
 UNRECOGNIZED_HISTORY_STATE:'历史状态不受识别；先核实，不按未执行处理。',
};
const evidence={MISSING:'缺失',INVALID_TIME_RANGE:'时间字段无效或期限倒置',FUTURE_OBSERVATION:'观察时间在未来',EXPIRED:'已过期',FRESH:'在声明有效期内（未经独立认证）'};
const names={cloudReviewBuildTest:'云端代码评审／构建／测试',macManualSync:'Mac 手工同步',macLocalVerification:'Mac 本地验收',publication:'发布'};
export function continuationReport(report){
 const lines=['续接检查：只读建议，不是执行许可。',...Object.entries(report.evidence).map(([key,value])=>`${key==='mac'?'Mac':'历史'}证据：${evidence[value]||'未知'}`)];
 for(const [key,step] of Object.entries(report.steps)){
  lines.push(`${names[key]||'步骤'}：${step.status==='CHECKABLE'?'可人工检查（不代表已执行）':'受阻'}`);
  for(const reason of step.reasons)lines.push(`  - ${reasons[reason]||'未知诊断原因；停止并核查。'}`);
 }
 lines.push('不改 owner、不拉取代码、不读写业务数据库、不联系 Mac 或发布平台。');
 return lines.join('\n');
}
