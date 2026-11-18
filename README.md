# AI DevOps

AI DevOps 是一个可自托管的、多云的智能研发运维控制台。它把代码仓库、发布流水线、云资源、审批、审计和 AI 辅助分析放到一个浏览器界面中。

如果你是第一次使用，不需要先学习 Git 或云控制台，请从这里开始：

- 登录平台后打开左侧“使用指南”
- 阅读 [零代码使用指南](docs/beginner-guide.md)

当前版本是第一阶段 MVP：

- Git 仓库登记、HTTPS 仓库同步和版本记录
- 应用类型字段模板（网站、小程序、后端 API、移动端、通用服务）
- 按类型创建和管理应用实例，复用同一套字段定义与校验
- 发布流水线编排、模拟执行、生产审批
- 腾讯云、阿里云、华为云账号入口及演示资源视图
- 安全模式 AI Copilot：没有模型密钥时也能分析常见发布故障
- 统一审计事件
- Docker Compose 部署入口和后续 Kubernetes Runner 扩展点

真实代码执行必须放在隔离 Runner 中。当前 MVP 默认使用模拟执行，不会在控制面宿主机上运行仓库脚本。

## 本地启动

不需要你手动安装 Node.js 或 pnpm。项目自带的 D 盘运行时位于
`runtime\node`，双击启动脚本时会自动使用它；只有运行时缺失时才会
尝试系统环境中的 Node.js。

Windows 用户可以直接双击根目录的 `start-ai-devops.cmd`。脚本会自动安装依赖、
构建控制面、启动服务并打开浏览器；局域网地址也会显示在启动窗口中。

```powershell
Copy-Item .env.example .env
pnpm install
pnpm dev
```

浏览器打开 <http://127.0.0.1:5173>。

首次双击启动时，脚本会随机生成管理员密码和 JWT 密钥，并将密码显示在启动窗口。
相同凭据只保存在本机 `.env` 中的 `ADMIN_PASSWORD`，不会写入源码或 README。

```text
管理员邮箱：admin@aidevops.local
```

如果通过 `pnpm dev` 手动启动，请在复制 `.env.example` 后主动设置强密码。

## 生产构建

```powershell
pnpm build
pnpm start
```

构建后控制面在 <http://127.0.0.1:8787>，同时提供 API 和前端静态资源。

## Docker

```powershell
docker compose up --build
```

## 设计文档

完整的产品逻辑、技术架构、安全边界和迭代路线见 [docs/architecture.md](docs/architecture.md)。

