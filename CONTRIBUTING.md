# 贡献指南

> 本项目处于活跃迭代期。欢迎 issue / PR，但请先看完本文以减少返工。

---

## 1. 报 issue 之前

- 在 `%APPDATA%\com.aireader.app\` 删个干净试一下（消除"是不是我本地的脏数据"）。
- 看 [`docs/FEATURES.md`](./docs/FEATURES.md) 「已知限制」一节。
- 复现步骤 + 操作系统 + AIreader 版本 + 报错截图（前端 DevTools console + 跑 `npm run tauri dev` 的终端输出）。

---

## 2. 提 PR 之前

### 2.1 确认 issue 已被 acknowledge

新功能 / 大改动**先开 issue 讨论**。直接 PR 实现一个未讨论过的功能很可能被拒，不是因为坏，而是因为可能跟 roadmap 冲突。

bugfix / 小改进可以直接 PR。

### 2.2 在本地通过

```powershell
# Rust
cd src-tauri
cargo check
cargo clippy -- -D warnings

# TypeScript
cd ..
npx tsc --noEmit

# E2E 烟测（手动）
npm run tauri dev
# 然后按 docs/DEVELOPMENT.md §7 的清单跑一遍
```

PR 描述里说一下你跑了哪些验证。

### 2.3 跟 [`CLAUDE.md`](./.claude/CLAUDE.md) 工程准则对照

这是项目的指导意见（钱学森《工程控制论》改编），评审会按这些条款审：

- **原则 3 抓主要矛盾**：一个 PR 解决一件事。不要顺手做 4 个不相关的"优化"。
- **原则 5 先定义系统**：改之前讲清楚边界 / 组成 / 关系 / 目标。
- **原则 8 能控 + 能观**：新的指标 / 行为要有办法测、有办法干预。
- **原则 12 稳定性优先**：异常输入 / 极端情况怎么表现，比理想情况多快重要。
- **原则 13 摄动检查**：依赖延迟翻倍 / 用户量 +30% / 某参数估错一个数量级，会怎样。
- **原则 14 冗余容错**：单点失败的兜底要明确。
- **原则 18 局部最优 ≠ 全局最优**：跨模块接口比模块内优化更重要。

不要求记号背诵，但 PR 评审会引用具体条款。

---

## 3. 代码风格

### 3.1 Rust

- `rustfmt` 默认配置，PR 前 `cargo fmt --all`。
- `cargo clippy -- -D warnings` 不留警告。
- 错误处理：业务函数 `Result<T, E>` where E 是有意义的类型；Tauri command 层 map_err 转 `String`。
- 不写 `unwrap()`，除非显然不可能 panic（且写注释说明）。
- 不写 `unsafe`。

### 3.2 TypeScript

- `noUnusedLocals` / `noUnusedParameters` 开启（已在 tsconfig），不留死代码。
- 不用 `any`，必要时 `unknown` + narrowing。
- 组件按 feature 切，**不要**按"组件类型"切（不要建 `components/` 下放一切）。
- IPC 调用只通过 `lib/ipc.ts` 的 `ipc.xxx()`，不直接 `invoke()`。
- React 19 + `react-jsx` 自动注入，不要 `import React from "react"`（除非用 React.X 类型）。

### 3.3 样式

- Tailwind v4 utility 优先。
- 颜色用 CSS 变量（`var(--color-ink)` 之类），不写硬色，否则主题切换失效。
- 字体：正文用 `font-serif`（Noto Serif SC），UI 用默认（Inter）。

### 3.4 注释

- 写在「为什么这么写」上，不要 paraphrase 代码。
- 公共 API 加 doc comment 说明前置条件 + 错误情况。
- 复杂业务逻辑加块状注释解释取舍（见 `ChatPanel.tsx` 的 `UiMessage` 类型注释作为范本）。

---

## 4. 提交规范

### 4.1 Commit message

无强制 conventional commits，但请：

- 第一行 ≤ 72 字符
- 第一行描述「做了什么」，不要描述「为什么」（详细原因写在 body）
- 中英文均可，但同一个 PR 内保持一致
- 不要写 "fix bug" / "更新" 这种没信息量的标题

例：
- ✅ `Add RAG citation click-to-jump in ChatPanel`
- ✅ `修 EPUB 章节切换时 highlight 重复注入`
- ❌ `update`
- ❌ `fix several issues`

### 4.2 PR 标题

跟 commit 第一行同样要求。

### 4.3 PR body

至少包含：

```md
## 做了什么
- 一句话总结

## 为什么
- 解决什么问题 / 完成什么需求
- 如果是 issue，挂上 #N

## 怎么验证
- [ ] cargo check
- [ ] tsc --noEmit
- [ ] 手动测试 X / Y / Z 场景
```

---

## 5. 改动范围约定

### 不要在一个 PR 里同时做的事

| ❌ 不要混合 | ✅ 拆开 |
|---|---|
| 业务功能 + 大规模 rename | 先 rename PR，后功能 PR |
| 业务功能 + 依赖升级 | 单独 deps PR |
| 业务功能 + 大批格式化 | 用 `cargo fmt` / prettier 单独跑 |
| 修一个 bug + 顺手重构 | 先 fix，后 refactor |

### 大改动（> 500 行）

先开 RFC issue，附 ARCHITECTURE.md 风格的设计说明 → 讨论 → 再写代码。

---

## 6. 添加依赖

### Rust

新增 crate 要在 PR 描述里说明：
- 为什么不能用现有依赖实现
- 这个 crate 的 maintenance 状态（最近一次 release / open issue 数 / 是否 ≥ 1.0）
- 体积影响（`cargo bloat` 估算）

倾向：MIT / Apache-2 双许可、活跃维护、`no_std` 兼容的 crate 优先。

### npm

同样原则。倾向 zero-deps / 体积小 / TypeScript 原生支持的包。

---

## 7. 文档

任何用户可见的功能改动**必须**同步更新：

- [`docs/FEATURES.md`](./docs/FEATURES.md) — 功能列表
- [`docs/USAGE.md`](./docs/USAGE.md) — 用户指南
- [`README.md`](./README.md) — 一句话提及

任何 IPC 命令 / 事件改动**必须**同步：

- [`docs/IPC.md`](./docs/IPC.md)

任何 DB schema 改动**必须**同步：

- [`docs/DATA_MODEL.md`](./docs/DATA_MODEL.md)

架构层面改动**必须**同步：

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

PR 中**没有**更新对应文档 = 自动 request changes，不管代码多漂亮。

---

## 8. 安全

- **不要**在 issue / PR 里贴 API key。
- **不要**在测试时把真书 / 隐私文档 commit 进仓库。
- 发现安全问题（私密路径泄漏 / 凭证写文件 / 任意命令执行 等）：私下邮件给维护者，不要开 public issue。

---

## 9. 行为准则

- 对人不对事 → 反过来：**对事不对人**。
- 反对 idea 时附上反例 / 反对论证，不只是 "I don't like it"。
- 不喜欢某个决定可以表达，但实施时尊重决定。
- 不打嘴仗。讨论持续超过 3 轮没共识 → 维护者决断 → 接受。

---

## 10. 维护者保留权利

- 拒绝任何不符合 roadmap 的 PR（即便代码本身没问题）。
- 改写 commit message 让历史一致。
- 把多个相关 PR squash 进一个 merge commit。
- 在你的 PR 上小改 + force push 你的 branch（合并前征得同意）。
- 关掉超过 90 天无活动的 issue / PR（先 ping 一次）。

---

感谢贡献。慢慢来，不急。
