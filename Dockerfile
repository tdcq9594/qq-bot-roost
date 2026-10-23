# 栖 Roost —— 零依赖 QQ 官方机器人框架
#
# 这个镜像**不装任何 npm 包**，因为项目本身零依赖。
# 所以镜像很小，构建也快（只有复制文件）。
#
#   docker build -t roost .
#   docker run -d --name roost \
#     -p 15207:15207 \
#     -v $(pwd)/config:/app/config \
#     -v $(pwd)/data:/app/data \
#     -v $(pwd)/logs:/app/logs \
#     -v $(pwd)/plugins:/app/plugins \
#     roost
#
# 三个目录必须挂出来，否则容器重建后配置、存档、插件全丢。

FROM node:22-alpine

# 插件可能用 Python / Go 写，需要的话把对应运行时打开：
#   apk add --no-cache python3 py3-pip go
# 默认镜像只带 Node，保持最小。外部插件运行时会提示缺哪个解释器。

WORKDIR /app

# 只复制运行必需的东西。docs / .github / test 不进镜像。
COPY package.json ./
COPY src ./src
COPY web ./web

# 配置目录先建好，挂载卷时不会因为目录不存在变成 root 所有
RUN mkdir -p config/bots data logs plugins

# 容器里没有浏览器，默认不开
ENV ROOST_NO_BROWSER=1
# 面板要监听 0.0.0.0 才能从宿主机访问；可用 -e ROOST_WEBUI_HOST=... 覆盖
ENV ROOST_WEBUI_HOST=0.0.0.0
ENV ROOST_WEBUI_PORT=15207
# 日志直接进 stdout，方便 docker logs
ENV NODE_ENV=production

EXPOSE 15207
# Webhook 模式才需要，默认不监听
EXPOSE 15208

# 用非 root 跑，降低被插件代码搞坏容器的风险
RUN chown -R node:node /app
USER node

# --no-open 不尝试开浏览器（容器里没有）
CMD ["node", "src/main.js", "--no-open"]
