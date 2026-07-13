# 韩语背词

一个静态韩语单词学习网页，内置 2400 个单词、30 个 Unit。

## 当前功能

- 复习优先：有到期复习时先复习，再学习新词。
- 分组学习：每 10 个单词为一组，全部记住后进入下一组。
- 任务入口：可手动选择学习新词、到期复习、复习今日新词。
- 组内重复：模糊会再出现 1 次，忘记会再出现 2 次。
- 间隔复习：按 1 / 2 / 4 / 7 / 15 / 30 天推进。
- 每日新词上限：可设置 10、20、30、50 或不限。
- 词库搜索：支持按韩语、中文、词性、单元搜索。
- 本机进度：使用 localStorage 保存，并兼容旧版进度 key。
- 云端同步：支持 Google 登录，每个账号按 Firebase UID 隔离，并将进度拆分为多个 Firestore 文档。
- 旧数据迁移：首次使用新版时自动读取旧的单文档云端进度并迁移为分片格式。
- 进度迁移：支持导出和导入 JSON，导入时按更新时间合并。
- 发音：使用浏览器 speechSynthesis 的 ko-KR 语音。

## 运行

直接用静态服务器打开即可：

```bash
python -m http.server 8765
```

然后访问 `http://127.0.0.1:8765/`。

## Firebase 设置

需要在 Firebase 控制台开启：

1. Authentication -> Sign-in method -> Google。
2. Firestore Database。
3. Firestore 安全规则：

```js
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/vocab/{docId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

云端数据保存在每位用户自己的 `users/{uid}/vocab/` 路径下。新版使用
`progress-manifest` 和多个 `progress-chunk-000`、`progress-chunk-001` 文档，
避免单个 Firestore 字段超过 1 MiB 限制。不同 UID 无法通过上述规则读取或修改彼此的数据。
