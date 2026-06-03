# 人生之书 · 书柜

一个可静态部署的古风人生模拟器。每一段人生都会成为一册书，保存在本地书柜中，可继续续写、回看前文、打开终章。

## 本地运行

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

构建产物输出到 `dist/`。项目使用相对路径资源，适合部署到 GitHub Pages。

## 存储与安全

- 书柜数据保存在浏览器 IndexedDB。
- 接口配置保存在浏览器 localStorage。
- 项目不内置 API Key；公开部署后需要用户在设置中填写自己的兼容 OpenAI 接口配置。
