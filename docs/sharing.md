# 公开仓库边界

允许发布的内容只有：自动提交脚本、离线合成测试、Agent 指引、必要说明、虚构 JSON 示例和无账号的参数模板。

禁止发布素材、真实提示词／清单、状态与提交回执、任务或画布 ID、生成视频、日志、下载链接、Cookie、Token、通知收件人、个人机器路径及原项目 Git 历史。

本仓库 `.gitignore` 默认忽略顶层新增目录，并排除常见素材、运行状态和本机配置。它不能阻止 `git add -f`，也不能替代检查。

每次发布前：

```bash
git add README.md AGENTS.md CLAUDE.md config.example.json .gitignore docs examples scripts
python3 scripts/check-public.py
git diff --cached --stat
git diff --cached
```

检查脚本审计 **Git 暂存区快照**，使用精确文件白名单，拒绝额外文件、二进制内容、私钥／常见凭据模式、个人目录、生产 URL 标识与异常大文件。新增合法源文件时，应明确审查后更新白名单。

自动模式匹配无法识别所有敏感业务内容，发布者仍应逐个审阅 diff；不要将未知文件作为“示例”直接上传。

运行时应把素材与批次放仓库外。`config.local.json` 仅本机使用，模板只保留生成参数；登录信息不写入任何配置。
