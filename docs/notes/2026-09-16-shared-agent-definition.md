# Shared Agent Definition 首个实现切片

## 目标

Shared Agent 是团队共同使用的长期 AI 身份。首个切片共享 Agent Definition，不共享 Session：多个独立 Session 可以引用同一个定义，但各自保留 transcript、附件、临时上下文和执行状态。

## 所有权与磁盘布局

定义由 Agent instance 持有，写入：

```text
<yeaftDir>/shared-agents/<definitionId>/definition.json
```

Session 只在自己的 `session.json` 中保存：

- `sharedAgentDefinitionId`
- `sharedAgentDefinitionRevision`

Definition 更新使用递增 revision 和 optimistic revision check。Session copy 保留定义引用；没有这些字段的历史 Session 按未绑定 Shared Agent 读取。

## Skills

Definition 的 `skillSources` 保存仓库 URL、Agent 本机只读 checkout 路径、固定 revision 和 include 规则。首版支持递归发现该 checkout 下所有 `SKILL.md`，适用于 GraphConnectors 中分散在 `.github/skills`、`.claude/skills`、`.agents/skills` 与 `Tools/**` 下的技能。

运行时 precedence 从低到高为：

1. bundled
2. shared-agent
3. Agent user
4. project Claude / Codex / Yeaft

因此团队共享技能是只读基线，本机用户和 Session workspace 仍可覆盖同名技能。重复名称通过 source diagnostics 暴露，不把扫描顺序伪装成无冲突。

首个 GCS 定义应把 GraphConnectors checkout 固定到经过审核的 commit SHA；当前开发盘点基于 `0a96251d50f0cca48bb5e3cb0145fe8b8f84433c`。

## 身份和运行时

Definition instruction 作为 VP persona 的 runtime preamble 注入。Shared Agent id/revision 同时参与 skill runtime cache identity，避免相同 `workDir` 下不同 Shared Agent 互相泄漏技能。

## 权限边界

Definition 的 `toolPolicy` 是声明式能力上限，不是授权本身。建议 GCS On-call 默认配置：

- IcM、Kusto、监控：`read`
- Redis 和任何事故状态变更：`approval-required`
- 未配置能力：不自动视为允许

当前切片不增加工具执行绕过，不共享用户凭据，也不自动执行 IcM 更新、通知、缓解或 Redis 写入。

## 后续工作

- Server 增加团队/tenant 范围的 Definition ACL 与版本发布记录。
- Web 增加 Definition 列表、编辑、Session 绑定和冲突展示。
- 验证 skill source 声明的 revision 与 checkout 实际 Git HEAD 一致。
- 将 Shared Agent 长期记忆增加独立 ownership scope；在此之前不复用 Session transcript 充当共享记忆。
- 把 IcM、Kusto、监控、Redis 的 tool policy 接入统一授权 gate 和审计日志。
