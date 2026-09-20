FROM node:24-bookworm-slim

ENV TZ=Asia/Shanghai \
    DEBIAN_FRONTEND=noninteractive \
    NEW_API_BASE=https://ai--new-api--7jgxq8y8tx2h.code.run \
    RESEARCH_MODEL=nvidia/nemotron-3-super-120b-a12b \
    RESEARCH_MODELS=z-ai/glm-5.3,z-ai/glm-5.3-flash,deepseek-ai/deepseek-v4-flash-0731,nvidia/nemotron-3-super-120b-a12b,nvidia/nemotron-3-ultra-550b-a55b,openai/gpt-oss-20b \
    RESEARCH_INTERVAL_SECONDS=21600 \
    RESEARCH_FIRST_DELAY_SECONDS=120 \
    ROUND_TIMEOUT_SECONDS=3600 \
    SEARCH_API_URL=https://p01--g02-ritup-repo01-search--4ygvmqls7l8l.code.run/search \
    DATA_DIR=/opt/data \
    RESTORE_IF_DATA_EXISTS=false \
    SCHEDULED_BACKUP_ENABLED=false \
    SCHEDULED_BACKUP_TIME=03:30

# pi 固定版本保证可复现；python3 供研究计算用
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get install -y --no-install-recommends python3 openssl tar ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @earendil-works/pi-coding-agent@0.85.1 \
    && npm cache clean --force

# g02 只读知识库 + 研究人格 + 运维脚本
COPY knowledge/ /knowledge/
COPY agent/ /opt/agent/
COPY scripts/ /opt/scripts/
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh /opt/scripts/*.sh

ENTRYPOINT ["/entrypoint.sh"]
