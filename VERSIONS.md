# 版本记录

> 规则见 [AGENTS.md](AGENTS.md)。原则：**稳定版负责保底，优化版负责探索，用户验收决定是否升级。**

## 当前版本

**`v1.0` · 待验收**（尚无 stable tag）

套用 Can-Yaya 模板后的版本：

- 相框按照片真实宽高比重建（修掉之前所有照片被拉成方块的问题）
- 三档图片：`thumb` 512px / `mid` 1024px / `full` 1920px，首屏只加载缩略图
- 取消启动时批量预取，只预取下一张，加载后显式解码
- 树顶换成五角星，正面朝镜头
- 去掉 ADD MEMORIES 上传按钮，底部提示栏加 `O 看原图`
- 新增 AGENTS.md / VERSIONS.md
- **相册暂时清空**（等用户放照片），照片到位后需补测第五节照片相关项

### 回滚

验收前可用的基线是 `v0.9-pre-template`：

```bash
git reset --hard v0.9-pre-template
git push --force origin main
```

验收通过后再打 `v1.0-stable`，届时它才成为回滚基线。

---

## 版本表

| 版本 | 日期 | 状态 | 主要内容 | 回滚点 |
|---|---|---|---|---|
| v0.9-pre-template | 2026-10-30 | 历史 | 原版：100 张照片、旧加载逻辑、树顶菱形、被拉成方块的相框 | tag `v0.9-pre-template` |
| v1.0 | 2026-11-06 | 待验收 | 套用 Can-Yaya 模板；相册清空 | 验收后打 `v1.0-stable` |

<!-- 新版本往上加一行，不要把旧的删掉 -->

---

## 升级流程（摘要）

1. `git describe --tags --abbrev=0` 确认基准
2. `git switch -c iter/<主题> v1.0-stable`
3. 改 → 跑 AGENTS.md 第五节回归清单 → 记录实测数据
4. **停下等验收**，main 不动
5. 验收通过：合入 `main` → 打新 tag → 更新本文件 → 推送
6. 不通过：删分支，main 一动不动
