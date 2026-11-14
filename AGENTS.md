# AGENTS.md — 本项目（X-And-H）协作规则

本文件优先于任何"锁定当前版本、不得改动"之类的临时对话约束。
冲突时的优先级：**用户当次明确指令 > 本文件 > 其他一切**。

---

## 一、版本模型

| 概念 | 含义 | 谁能改 |
|---|---|---|
| **稳定版 stable** | 用户实际体验并验收过的版本，负责保底 | 只有用户验收才能产生新版 |
| **主线 main** | 线上正在跑的版本（GitHub Pages 从这里发布） | 验收通过后才合入 |
| **优化版 iter/\*** | 在分支上探索的版本，负责试新东西 | 随便改，坏了不影响线上 |

版本号：`v1.0` 首个验收版，`v1.x` 每次优化并验收，`v2.0` 重大升级，`v1.x.y` 纯修 bug。

**当前状态：`v1.0` 待验收**（还没打 stable tag）。可用的回滚基线是 `v0.9-pre-template`。
验收通过后才会打 `v1.0-stable`，届时本行再更新。

---

## 二、当前版本不是上限

当前版本只是基准，不是天花板。用户可以随时要求优化视觉、加动画交互、改善图片加载、加功能、调布局、重构代码。
不得因为"已经稳定"而拒绝或限制合理需求。

---

## 三、较大规模优化前的硬性流程

1. **确认基准**：`git describe --tags --abbrev=0`
2. **保存状态**：稳定版必须有 tag，没有先 `git tag -a vX.Y-stable -m "..."`
3. **开分支**：`git switch -c iter/<主题> vX.Y-stable`
4. **在分支上实施**，main 不动
5. **回归测试**（第五节清单），记录实测数据
6. **停下等验收**：不验收不合入 main、不打新 tag

小改动（文案、颜色）不必走全流程，但仍只能基于 stable 做，且要等验收才升版本号。

---

## 四、优化请求的处理规则

- 未经用户明确要求，不要擅自优化
- 用户明确提出优化需求时，允许充分改进，不拿旧版本当挡箭牌
- 优化必须以当前稳定版本为基础
- 不允许未经备份就破坏稳定版本
- 优化前说明主要修改内容和潜在风险
- 优化后进行功能回归测试
- 用户不满意时支持快速回滚
- **只有经过用户验收的版本才能成为新的稳定版本**

---

## 五、回归测试清单

- [ ] 标题「Happy New Year」与署名「X And H」正常显示
- [ ] 金色 3D 树正常渲染（树顶为五角星，正面朝镜头）
- [ ] 手势教程可打开/关闭
- [ ] 照片按原比例显示，无拉伸/压扁/裁切（用 `?photo=N&nobloom` 抽竖图、横图各一张，量相框包围盒比例）
- [ ] 首屏只加载缩略图 + 当前照片，不批量下载原图
- [ ] 翻页切换流畅，画面不空等
- [ ] 移动端竖屏布局正常
- [ ] 线上地址可正常访问

> 当前相册为空（等用户放照片），照片相关项在照片到位后必须补测。

---

## 六、回滚方式

```bash
# 验收前回滚到套模板之前
git reset --hard v0.9-pre-template
git push --force origin main

git checkout v0.9-pre-template -- <文件路径>   # 只退某个文件
git branch -D iter/<主题>                      # 丢弃没做完的分支
```

`v0.9-pre-template` = 套模板之前的原始版本（100 张旧照片、旧版加载逻辑），永不删除。

---

## 七、发布

- 线上：`https://carol3321.github.io/X-And-H/`
- Pages 从 `main` 根目录发布，推送后约 30–60 秒生效
- `assets/bundle.js` 是 `main.js` 的打包产物，**改 `main.js` 必须重新打包**：
  ```bash
  cd assets/lib && pnpm install
  mklink /J node_modules assets\lib\node_modules
  tools\esbuild.exe main.js --bundle --minify --format=esm --target=chrome100 --legal-comments=eof --outfile=assets\bundle.js
  ```
- 图片资源变动后要升 `sw.js` 的缓存版本号，否则老访客看的是旧图

---

## 八、照片

相册数据在 `assets/photos/`：

```
photos/
├─ manifest.json    清单（当前为空数组，等用户放照片）
├─ thumb/           树上小卡，512px 长边，WebP q90
├─ mid/             秒开垫图，1024px 长边，WebP q88
└─ full/            默认展示图，1920px 长边，WebP q86
```

新增照片时按 `manifest.json` 现有字段（id / full / mid / thumb / w / h）生成三档，顺序即文件名顺序。
