# 知识库快照

- 来源：`/Users/lumin/work-projects/northflank-mix-repo/g02-ritup-repo02-mix`（OKX 跟单研究台）
- 源提交：`f5db7e4015d8bd4ce60a8eaed95b904a8d601b95`
- 同步日期：2026-09-22
- 内容：`README.md`、`package.json`、`docs/`、`src/`、`scripts/`
- 排除：`node_modules/`、`data/`、`public/`、`test/`、`__pycache__/`、`.env`

## 重新同步（本机执行）

```bash
rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' --exclude '.env' \
  /Users/lumin/work-projects/northflank-mix-repo/g02-ritup-repo02-mix/{README.md,package.json,docs,src,scripts} \
  knowledge/g02/
```

这是构建时烤进镜像的静态快照；容器内的 agent 对它只读。
