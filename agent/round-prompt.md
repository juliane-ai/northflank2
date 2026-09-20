# 本轮研究任务

1. 读 `/opt/data/outputs/研究看板.md`；若存在 `/opt/data/outputs/研究经验.md` 也通读（沿用其中有效方法，避开已记录的坑）。
2. 选主题：优先级最高的「待研究」项；若看板记录了上一轮的「下一步」且属于该主题，优先衔接。
3. 研究：内部代码与文档从 `/knowledge` 读；外部/最新资料用搜索服务（见下），遵守 SOUL.md 的研究原则。
4. 搜索：`curl -s --get "$SEARCH_API_URL" --data-urlencode 'q=<关键词>' --data-urlencode 'format=json'`，取 results[].title/url/content；关键结论必须附来源 URL。
5. 研报写入 `/opt/data/outputs/YYYY-MM-DD-主题.md`（先骨架后填充，防截断）。
6. **写完研报立即更新看板（必做）**：状态改「已产出」、一句话结论、下一步；不看板的轮次视为未完成。
7. **追加工作方法收获到 `/opt/data/outputs/研究经验.md`**（没有则创建）：只记方法不记结论，格式 `- MM-DD [检索|代码阅读|报告结构|运行] 一句话`，本轮最多 3 条，确实没有就跳过。
8. 最后输出三行收尾：`本轮主题：` / `产出文件：` / `下一轮建议：`。
