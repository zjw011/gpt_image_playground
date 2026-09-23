# Agent Instructions for gpt-image-playground

本文件定义 AI 编码助手在此仓库中应遵循的工作方式。

## 项目概况

- React 19 + Vite + TypeScript 前端应用，使用 Zustand 状态管理、Tailwind CSS 样式。
- 源码在 `src/`，构建产物由 Vite 生成，不要手动编辑 `dist/`。
- 包管理器为 npm（有 `package-lock.json`），不要使用 yarn 或 pnpm。
- 前台页面在 `src/pages/`：公开页（`LandingPage`/`PricingPage`/`HelpPage`）与认证页（`auth/`）不进应用引导流程；
  应用页（`app/`）统一由 `src/App.tsx` 做 bootstrap 与登录门禁，再由 `app/AppShell.tsx` 提供侧栏外壳。
- 管理后台在 `src/pages/admin/`，**已并入主前端 SPA**，不再是 `server/admin/` 那套独立原生页面。
  入口是 `/admin`，由 `AdminGuard` 按会话里的 `role` 放行；站长就是一条 `role: 'admin'` 的用户记录，
  和普通用户走**同一个登录入口**（`POST /api/session`），前端拿到 role 后自己分流。
- 路由表在 `src/router.tsx`。`vite.config` 的 `base` 是 `'./'`，**不能**直接当 react-router 的 basename——
  相对 basename 会让整张路由表一条都匹配不上（页面能看但点哪儿都不跳），必须走 `resolveRouterBasename()`。
- **路由最多只能有一层**（`/admin`、`/me?tab=xxx` 这种）。产物按 `base:'./'` 构建，两层以上的路径
  （`/admin/channels`、`/studio/result`）在浏览器里会把 `./assets/xxx.js` 解析成 `/admin/assets/xxx.js`，
  直接白屏；只有单层路径才在根路径部署和子路径部署下都成立。分区分片一律用 `?tab=`。
- 视觉基座在 `src/pages/theme.tsx`（配色、按钮、输入框、Logo、页脚、加载占位），图标在 `src/pages/icons.tsx`。
  后台的配色不走 theme，是另一套浅白浅蓝（区别于前台的紫罗兰插画风）。
- 插画素材在 `public/art/`，已按实际渲染尺寸压过，替换时别塞回原始大图。

## 常用命令

| 操作 | 命令 |
|------|------|
| 安装依赖 | `npm install` |
| 开发服务器 | `npm run dev` |
| 构建 | `npm run build` |
| 运行测试 | `npm test` |
| 监听测试 | `npm run test:watch` |
| 菜单跳转审计 | `npm run audit:menu`（自带 dev server） |
| 渲染体检 | `npm run audit:render`（自带 dev server） |
| 托管模式审计 | `npm run audit:server`（会先构建，自己起后端） |

- 测试使用 Vitest，已有多个 `*.test.ts` 文件。
- 不要新增 lint/formatter 配置文件，除非明确要求。
- 三个审计脚本用本机 Chrome 的 DevTools 协议真机点击，验证跳转、文案、开关联动。
  改动导航、路由、页面文案或后台管控相关的逻辑后跑一遍，比肉眼看代码可靠。
  需要本机装有 Chrome，路径可用 `CHROME_PATH` 覆盖。
- **审计脚本必须自带被测服务**（`scripts/lib/devServer.mjs` / 自己 spawn 后端）。
  以前写成"先手动 `npm run dev` 再跑脚本"，结果 dev server 早就退出了，脚本仍对着端口一通点击，
  把连接失败报成一堆业务断言失败；更糟的是路由失配时每页都被弹回首页，断言照样全绿。
  因此：每页都要断言**落在哪个路径**，不能只断言"页面上有字"。

## 代码风格（强制）

### 简单优先

写出能工作的**最简代码**。少抽象、少包装。有疑问就内联。

- 不要为单次使用的 1-5 行逻辑创建独立函数，直接内联。
- 函数只有在**多处调用**且**逻辑非平凡**时才值得提取。
- 不要引入项目中不存在的设计模式或架构层。

### 完整实现

- 不要留 `// TODO: implement later`、`// ...` 或 stub 函数。
- 如果不确定某个细节，给出完整的最佳猜测实现。错误但完整的代码优于正确但残缺的骨架。

### 跟随现有风格

这是最高优先级规则。修改文件时，遵循该文件及周围代码的已有风格。

### 格式

- **2 空格缩进**。
- **单引号**（`'hello'`）。
- **无分号**。
- 箭头函数始终加括号：`(x) => x`。
- 行宽不做硬性限制，但尽量保持可读。

### TypeScript

- 使用 ESM import，`const` 优先，永远不用 `var`。
- Target `ES2020`（见 `tsconfig.json`）。
- 优先早返回，避免深层嵌套和 `else` 链。
- 尽量避免 `any`；需要时保持局部化。
- 利用类型推断，不写多余的类型注解。
- 共享类型放 `src/types.ts`，局部类型放文件顶部。

### 命名

- **PascalCase**：组件、类型、接口。
- **camelCase**：函数、变量、参数。
- **UPPER_SNAKE_CASE**：模块级常量。
- 文件名小写驼峰：`apiProfiles.ts`、`maskPreprocess.ts`。
- 局部变量优先短名：`ctx`、`el`、`msg`、`idx`、`opts`、`err`。多词名仅在单词不够清晰时使用。

### 解构

避免无必要的解构。优先点号访问以保留上下文。

```ts
// 好
profile.baseUrl
opts.settings

// 避免
const { baseUrl } = profile
const { settings } = opts
```

例外：React 组件 props、hooks 返回值、函数参数解构是可以的。

### 控制流

```ts
// 好：早返回
function getPreset(name: string) {
  if (!name) return defaultPreset
  return presets.find((p) => p.name === name)
}

// 避免：多余的 else
function getPreset(name: string) {
  if (!name) return defaultPreset
  else return presets.find((p) => p.name === name)
}
```

### 变量

优先 `const`，用三元或早返回代替 `let` 重赋值。

```ts
// 好
const params = hasInputImages
  ? { ...baseParams, image: inputImages }
  : baseParams

// 避免
let params
if (hasInputImages) params = { ...baseParams, image: inputImages }
else params = baseParams
```

### 常量提取

不要为一次性使用的字面量定义命名常量。只有满足以下条件之一才提取：
1. 多处使用，或
2. 含义不一目了然，或
3. 是需要调优的关键参数。

### 防御性代码

本项目涉及外部 API 响应、URL 参数、IndexedDB 持久化数据——对这些**外部输入**保留必要的校验和兼容处理（`normalize*`、`ensure*` 等函数在本项目中是合理的）。

但不要对已声明为非可选的内部类型加投机性空检查。

## Import 顺序

大致分组：
1. React / React DOM
2. 第三方包（zustand、fflate、react-markdown 等）
3. 本地类型（`../types`、`./types`）
4. 本地模块（`./lib/*`、`./hooks/*`、`./components/*`）

## React 组件

- 函数组件 + hooks，不使用 class 组件。
- 组件文件放 `src/components/`，hooks 放 `src/hooks/`，工具函数放 `src/lib/`。
- 复杂 UI 逻辑可以拆成独立组件或 hook，不必强行内联。
- Tailwind 类名不强制排序，但同类属性（布局、间距、颜色、交互）尽量分组书写，保持可读。

## 错误处理

- 对网络请求和文件 I/O 使用 `try/catch`，用 `console.warn` 或 `console.error` 记录。
- 不要对没有证据会失败的路径加投机性错误处理。

## 注释与语言

- 代码注释使用**中文**，与项目现有风格保持一致。
- UI 文案默认中文。
- 注释应简洁，说明"为什么"而非"做了什么"——除非逻辑复杂不易一眼看出。

## 架构约束

- 新增纯函数或工具逻辑时，放 `src/lib/` 而非 `src/store.ts`。store 文件已过大，应只包含 state 定义和 action 入口。
- 避免在多处重复定义相同工具函数（如 `blobToDataUrl`），优先复用 `src/lib/` 中已有导出。
- 新增较大功能时，优先拆成独立模块（lib 函数 + hook + 组件），而非全部塞进现有大文件。
- 组件超过 800 行时，考虑按逻辑边界拆成子组件或自定义 hook。
- **用户侧 / 管理员侧的边界**：渠道、模型、密钥一律由管理员在后台维护。托管模式下（`isBackendManagedMode()`）
  用户侧不能出现任何新增/编辑/删除渠道的入口，设置弹窗里的「API 配置」要换成只读的「我的渠道」，
  校验提示也不能让用户去补一个他根本填不了的 API Key。只有纯前端（自备密钥）模式才允许用户自己填。
- **后台并入主前端后的一条铁律**：管理员和普通用户共用 `gip_guest` 这一个 cookie。
  任何"口令/密码被改动 → 销毁同角色会话"的逻辑都必须**保留操作者本人那一个会话**
  （用 `destroySessionsByRoleExcept`），否则管理员改完密码会把自己当场登出。
- **访问方式不等于登录方式**：`accessMode` 决定"要不要身份"（open/passcode/accounts/wechat），
  但不能限制"能不能用账号登录"——否则默认的 open 模式下站长永远拿不到带 role 的会话，
  后台就成了一个谁也进不去的页面。`handleFrontLogin` 里带用户名的请求永远走账号校验。

## 注意事项

- `src/store.ts` 是核心状态文件（5000+ 行），修改时注意：
  - 持久化逻辑和数据迁移（`persist` middleware + IndexedDB）。
  - 模块顶部的 `normalize*` 函数用于从 IndexedDB/localStorage 恢复时清洗旧格式数据，修改需保持向后兼容。
  - 新增 state 字段时，考虑是否需要持久化以及升级路径。
- `src/lib/apiProfiles.ts` 包含多供应商配置，修改时注意向后兼容。
- `src/lib/db.ts` 是 IndexedDB 封装层，修改 schema 时需升级 `DB_VERSION` 并处理 `onupgradeneeded`。
- 修改完成后优先运行 `npm run build` 验证编译，再运行 `npm test` 验证测试。

## 交付约定

改动推送后，回复末尾附上服务器更新命令，不要给多个方案让用户自己挑：

```bash
git pull && docker compose up -d --build
```

即使本次只改了 `server/`（理论上 `docker compose restart` 就够），也照样给这一条——统一一条命令，用户不必判断该用哪个。
