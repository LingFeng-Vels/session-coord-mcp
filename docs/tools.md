# Tools

## 👤 会话与团队

### `coord_register_session`

注册当前编码会话。

### `coord_heartbeat`

刷新会话心跳，并延长该会话尚未过期的路径认领。

### `coord_list_sessions`

列出当前工作区内所有会话。

### `coord_list_teams`

列出当前工作区中的开发团队。

### `coord_create_team`

创建开发团队。

### `coord_join_team`

让当前 session 加入一个开发团队。

### `coord_onboarding_status`

检查当前 session 是否需要先创建团队或加入团队。

这个工具是实现“一键消息自动接管”的关键。

## 📋 任务

### `coord_create_task`

创建任务。

### `coord_list_tasks`

查询任务。

### `coord_claim_task`

认领任务。

### `coord_update_task`

更新任务。

### `coord_complete_task`

完成任务，默认释放相关路径认领，并写入一条完成更新。

## 📁 路径

### `coord_claim_paths`

认领路径范围。

### `coord_release_paths`

释放路径范围。

### `coord_check_conflicts`

检查路径冲突，并返回相关任务与同一范围内的近期决策。

## 💬 协作上下文

### `coord_post_update`

发送进度、阻塞、交接或告警。

### `coord_get_updates`

获取近期更新。

### `coord_record_decision`

记录架构或接口决策。

### `coord_search_context`

搜索任务、更新、决策和路径认领上下文。

## ✅ 校验

### `coord_validate_scope`

校验当前 session 的 Git 变更是否超出已认领范围。
