# 安全策略

## 支持范围

当前维护 `main` 分支及 GitHub Pages 上的最新版本。Solar Flow 尚未提供正式安全 SLA。

## 报告漏洞

不要在公开 Issue、讨论区或社交媒体贴出可利用细节、个人账单、邮箱、认证链接、Firebase 文档或令牌。

请优先通过 GitHub 仓库的 **Security → Advisories → Report a vulnerability** 私下报告（如果该仓库界面提供此入口）。若入口不可用，请通过仓库维护者的 GitHub 账号私下联系，并只提供必要的复现信息。请勿将秘密放入标题或公开评论。

报告中可包含：受影响版本/提交、影响范围、最小化的合成复现步骤、可能的修复建议。不要附真实交易或用户身份。

## 凭证处理

- 绝不提交 `.env.local`、Firebase Admin SDK 服务账号 JSON、私钥、GitHub token 或认证邮件链接。
- `VITE_FIREBASE_*` 是会进入浏览器的客户端配置，不是秘密；数据库安全必须由 Authentication 和 Firestore Rules 保证。
- 如果误提交凭证，立即在对应服务撤销/轮换，并联系维护者评估 Git 历史清理；仅从当前文件删除并不能从旧提交中移除。
