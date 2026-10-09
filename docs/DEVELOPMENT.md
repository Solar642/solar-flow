# 开发与部署

## 本机开发

环境：Node.js 22+、npm。仓库没有后端服务；静态界面由 Vite 提供。

```sh
npm ci
npm test
npm run dev
```

在 `http://127.0.0.1:5173/solar-flow/` 打开。没有 Firebase 配置时仍可使用本机账本。

生产构建与预览：

```sh
npm run build
npm run preview
```

自动化测试使用 Node.js 内置 `node:test`。测试账单位于 `tests/fixtures/`，必须保持合成数据；不得用用户真实账单替换。

## 自建 Firebase 同步

公开演示站连接的是 Solar Flow 维护者配置的 Firebase 项目。若要托管自己的版本并自行控制云数据：

1. 在 Firebase Console 创建自己的项目；创建 Firestore 时选定适合自己的区域。数据库建立后区域通常不能直接迁移，先确认数据驻留需求。
2. 在 Authentication 中启用邮箱/密码登录，并按需设置邮箱验证策略。
3. 创建 Cloud Firestore 数据库并发布仓库中的 [`firestore.rules`](../firestore.rules)。不要在测试期间改成宽松的“所有人读写”规则。
4. 将你实际访问网站的域名加入 Authentication 的 Authorized domains。
5. 复制 `.env.example` 为 `.env.local`，填入 Firebase **Web app 客户端配置**。该配置是公开前端标识，访问保护来自 Firestore Rules，不是 API key 保密。
6. 启动 `npm run dev`，创建一个测试账号并验证邮箱，检查只能访问自身 UID 下的记录；不要导入真实财务流水做首次验证。

认证配置会由 `src/firebase.js` 读取。云端安全依赖 Auth 设置和 `firestore.rules` 一致工作；改规则前应增加/运行 `tests/sync.test.js` 的相关测试，并在 Firebase Emulator 或隔离测试项目验证。

## GitHub Pages

仓库的 `.github/workflows/pages.yml` 会在 `main` 更新时运行测试、构建并部署 Pages。工作流需要在仓库 Settings → Secrets and variables → Actions → Variables 中提供：

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`

这些是浏览器客户端配置，不是私钥；可以作为 Actions Variables，但绝不能把 Admin SDK 服务账号 JSON、私钥、访问令牌或 Firebase Admin 凭证放进仓库或网页构建变量。上线前确认 Pages 域名已加入 Firebase Authentication 的授权域名。

部署者应自行阅读当前 Firebase 价格与配额、设置合理的用量告警，并告知使用者云端区域、数据访问者和删除/保留方式。不要在 README 中公开个人付款/账户状态。

## 发布前检查

```sh
npm ci
npm test
npm run build
git diff --check
```

还应检查：

- `git status --short` 中没有 `.env.local`、用户数据或无意生成的截图。
- 登录后规则拒绝访问其他 UID；未验证邮箱不能同步。
- 手机窄屏和桌面至少各走查一次；空数据与导入预览都可理解。
- 文档中所有样例都是合成数据，并准确描述当前规则。
