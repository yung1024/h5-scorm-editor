创建时间：2026-09-26 09:44:18（Asia/Shanghai）

# 桌面版开发与发布

桌面应用复用 `frontend/` 和 `backend/`。Electron 启动时在 `127.0.0.1` 上选择随机端口，通过一次性会话令牌保护编辑接口。用户课程保存在 `%APPDATA%\H5 SCORM Editor\courses`。

需要 Node.js 20 或更高版本。在项目根目录执行：

```powershell
npm ci
npm test
npm run desktop:dev
```

生成免安装版：

```powershell
npm run desktop:package
```

打包结果在 `desktop/out/`。发布前建议在项目目录外检查免安装版：

```powershell
npm run verify:portable -w desktop -- "D:\path\to\test-course.zip"
```

生成安装包：

```powershell
npm run desktop:make
```

安装包写入 `desktop/releases/v版本号/`。如果目标版本目录已存在，脚本会停止；下次发布需先更新 `desktop/package.json` 版本号。构建产生的 `desktop/resources/`、`desktop/dist/`、图标、免安装版和安装包均不进入源码仓库。

Windows 安装包目前未包含代码签名。对外分发时应核对发布文件、来源和安装提示。课件数据目录与应用目录分离；升级应用时应保留用户数据。
