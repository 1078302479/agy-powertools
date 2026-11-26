# Agy Powertools 二次开发项目记忆

## 仓库与分支约定

- **官方上游 (`upstream`)**：`https://github.com/WhiteBr1ck/agy-powertools.git`（仅拉取，不推送）
- **个人仓库 (`origin`)**：`https://github.com/1078302479/agy-powertools.git`
- **`main` 分支**：保持与 `upstream/main` 一致的原版干净基线
- **`custom` 分支**：所有二次开发改动均提交在此分支，并追踪 `origin/custom`

## 拉取并同步原版更新流程

当用户要求「拉取上游更新 / 同步原版更新」时，按以下步骤执行：

1. **拉取上游并展示变更摘要**
   ```sh
   git fetch upstream
   git log custom..upstream/main --oneline
   git diff custom..upstream/main --stat
   ```
2. **快进更新本地 `main` 基线**
   ```sh
   git fetch upstream main:main
   ```
3. **将 `custom` 变基到最新原版**
   ```sh
   git checkout custom
   git rebase upstream/main
   ```
   - 如发生合并冲突，优先完整保留上游的新功能与 Bug 修复，同时无损保留本地定制功能。
4. **运行测试验证**
   - 至少验证定制相关测试：`node --test tests/settings.test.mjs tests/native-ui.test.mjs`，并在可用时跑全量 `npm test`。
5. **重新部署到本机并推送个人仓库**
   ```sh
   sh ./install.sh
   git push origin main
   git push --force-with-lease origin custom
   ```

## 当前二次开发定制清单

1. **输入框额度光环数值显示 (`composerQuotaHaloValue`)**
   - 默认值：`notch`（骑缝光环微标，骑跨输入框顶部边框，占底栏宽度 0px）
   - 支持设置面板切换 5 种模式：`notch`（骑缝光环微标）、`tip`（光环末端游标）、`watermark`（右上角微水印）、`inline`（底栏纯数字呼应）、`off`（仅光环）
   - 主要涉及文件：`lib/settings.mjs`、`lib/native-ui.js`、`lib/native-panels.js`、`tests/settings.test.mjs`、`tests/native-ui.test.mjs`
2. **代码与文案约束**
   - 所有遥测与统计展示保持简洁，禁止使用中点字符作为分隔符。
   - 二次开发期间建议在插件「设置 -> 关于」中关闭空闲自动热更新，避免覆盖本地安装版本。
