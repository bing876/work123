# @ai-workbench/server（占位）

后端服务，**当前为空目录占位，尚未实现**。

## 规划（待定）

- 提供 HTTP / WebSocket 接口，供 `apps/desktop` 调用
- 对接大模型 Provider（OpenAI 兼容 / 自建网关）
- 会话持久化（SQLite / Postgres）
- 流式返回（SSE 或 WebSocket）

## 起步时要做的事

1. 在本目录补一个 `package.json`（`"name": "@ai-workbench/server"`），它才会被 pnpm workspace 识别。
2. 复用 `@ai-workbench/shared` 里的类型作为接口契约：

   ```json
   { "dependencies": { "@ai-workbench/shared": "workspace:*" } }
   ```

3. 技术选型建议保持与 desktop 一致（TypeScript + ESM），方便共享类型。
