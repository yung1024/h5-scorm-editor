创建时间：2026-09-26 09:44:18（Asia/Shanghai）
本次修改时间：2026-09-26 10:17:35（Asia/Shanghai）

# H5 SCORM Editor

面向已有 H5 课件的本地轻量维护工具。导入 ZIP 课件后，可以修改文字、替换图片、调整基础页面样式，再导出 SCORM 1.2 课程包。项目包含浏览器开发模式和 Windows 桌面版。

> 当前为早期版本。请先在课件副本上试用，并在目标 LMS 中检查导出的 SCORM 包。

## 能做什么

- 导入 H5 ZIP，识别入口页面；支持已有的 SCORM 启动壳和部分嵌套正文结构。
- 在“内容维护”视图修改跨页面文字、替换图片，并撤销最近一次维护操作。
- 在 GrapesJS 画布中编辑文字和基础布局、预览桌面与手机效果。
- 保存修改，保留原有 `imsmanifest.xml`；没有 manifest 时生成 SCORM 1.2 manifest。
- 导出 SCORM 1.2 ZIP。原课件的脚本会随导出包保留。

## 快速开始

需要 Node.js 20 或更高版本。建议使用 Windows 桌面版开发流程：

```powershell
npm ci
npm run desktop:dev
```

仅在本机浏览器中开发：

```powershell
npm ci
npm run dev
```

打开 `http://localhost:5173`。开发服务将 `/api` 转发至本机后端 `127.0.0.1:3001`。也可以运行 `npm run build`，再运行 `npm run start -w backend`，打开 `http://127.0.0.1:3001`。

## 测试与打包

```powershell
npm test
npm run build
npm run desktop:package
```

桌面免安装包位于 `desktop/out/`。可用 `npm run verify:portable -w desktop -- "课件.zip"` 在隔离目录验证。生成 Windows 安装包使用 `npm run desktop:make`；安装包会写入 `desktop/releases/v版本号/`，需要先确保该版本号尚未使用。

可运行 `npm run test:fixture` 生成无个人数据的演示 ZIP：`backend/test-fixtures/course.zip`。该 ZIP 是本地产物，不纳入源码仓库。

## 使用范围

项目重点是**维护已有课件**，没有承诺完整还原所有 H5 交互、SCORM 功能或 LMS 行为。画布编辑时不会执行导入课件的 JavaScript；预览和导出后的脚本行为仍需自行验证。导入不受信任的课件前请考虑其中可能包含的脚本与外部资源。

浏览器版设计为单机使用，不提供公开服务器所需的用户登录和权限隔离。桌面版使用仅绑定本机的随机端口和会话令牌。不要将浏览器版直接部署到公网。

## 项目结构

- `frontend/`：React 界面及 GrapesJS 编辑器。
- `backend/`：课程导入、维护、预览和 SCORM 导出。
- `desktop/`：Electron 桌面外壳及 Windows 打包。

桌面构建细节见 [桌面版说明](desktop/README.md)。项目源代码采用 [MIT 许可证](LICENSE)，第三方依赖及课件素材遵循各自的授权条款。

