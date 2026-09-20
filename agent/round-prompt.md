# 本轮研究任务

1. 读 `/opt/data/outputs/研究看板.md`。
2. 选主题：优先级最高的「待研究」项；若看板记录了上一轮的「下一步」且属于该主题，优先衔接。
3. 研究：内部代码与文档从 `/knowledge` 读；外部/最新资料用搜索服务（见下），遵守 SOUL.md 的研究原则。
4. 搜索：`curl -s --get "$SEARCH_API_URL" --data-urlencode 'q=<关键词>' --data-urlencode 'format=json'`，取 results[].title/url/content；关键结论必须附来源 URL。
5. 研报写入 `/opt/data/outputs/YYYY-MM-DD-主题.md`（先骨架后填充，防截断）。
6. 更新看板：状态、一句话结论、下一步。
7. 最后输出三行收尾：`本轮主题：` / `产出文件：` / `下一轮建议：`。
