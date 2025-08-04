#!/bin/bash

# Telegram修复脚本 - 自动重启ngrok和更新webhook
# Fix Telegram Script - Auto restart ngrok and update webhook

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

echo "🔧 Telegram Remote Control 修复脚本"
echo "📁 项目目录: $PROJECT_DIR"

# 检查.env文件
if [ ! -f "$ENV_FILE" ]; then
    echo "❌ .env文件不存在: $ENV_FILE"
    exit 1
fi

# 加载环境变量
source "$ENV_FILE"

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "❌ TELEGRAM_BOT_TOKEN未设置"
    exit 1
fi

# 停止旧的ngrok进程
echo "🔄 停止旧的ngrok进程..."
pkill -f "ngrok http" || true
sleep 2

# 启动新的ngrok隧道
echo "🚀 启动ngrok隧道..."
nohup ngrok http 3001 > /dev/null 2>&1 &
sleep 5

# 获取新的ngrok URL
echo "🔍 获取新的ngrok URL..."
NEW_URL=""
for i in {1..10}; do
    NEW_URL=$(curl -s http://localhost:4040/api/tunnels | jq -r '.tunnels[0].public_url' 2>/dev/null || echo "")
    if [ -n "$NEW_URL" ] && [ "$NEW_URL" != "null" ]; then
        break
    fi
    echo "等待ngrok启动... ($i/10)"
    sleep 2
done

if [ -z "$NEW_URL" ] || [ "$NEW_URL" = "null" ]; then
    echo "❌ 无法获取ngrok URL"
    exit 1
fi

echo "✅ 新的ngrok URL: $NEW_URL"

# 更新.env文件
echo "📝 更新.env文件..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s|TELEGRAM_WEBHOOK_URL=.*|TELEGRAM_WEBHOOK_URL=$NEW_URL|" "$ENV_FILE"
else
    # Linux
    sed -i "s|TELEGRAM_WEBHOOK_URL=.*|TELEGRAM_WEBHOOK_URL=$NEW_URL|" "$ENV_FILE"
fi

# 设置新的webhook
echo "🔗 设置Telegram webhook..."
WEBHOOK_URL="$NEW_URL/webhook/telegram"
RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"$WEBHOOK_URL\", \"allowed_updates\": [\"message\", \"callback_query\"]}")

if echo "$RESPONSE" | grep -q '"ok":true'; then
    echo "✅ Webhook设置成功: $WEBHOOK_URL"
else
    echo "❌ Webhook设置失败: $RESPONSE"
    exit 1
fi

# 验证webhook状态
echo "🔍 验证webhook状态..."
WEBHOOK_INFO=$(curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo")
echo "📊 Webhook信息: $WEBHOOK_INFO"

# 测试健康检查
echo "🏥 测试健康检查..."
HEALTH_RESPONSE=$(curl -s "$NEW_URL/health" || echo "failed")
if echo "$HEALTH_RESPONSE" | grep -q '"status":"ok"'; then
    echo "✅ 健康检查通过"
else
    echo "⚠️  健康检查失败，请确保webhook服务正在运行"
    echo "运行: node start-telegram-webhook.js"
fi

echo ""
echo "🎉 修复完成！"
echo "📱 新的webhook URL: $WEBHOOK_URL"
echo "🧪 发送测试消息..."

# 发送测试消息
# 优先发送到群组，如果没有群组则发送到个人聊天
CHAT_TARGET="$TELEGRAM_GROUP_ID"
if [ -z "$CHAT_TARGET" ]; then
    CHAT_TARGET="$TELEGRAM_CHAT_ID"
fi

if [ -n "$CHAT_TARGET" ]; then
    curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
        -H "Content-Type: application/json" \
        -d "{\"chat_id\": $CHAT_TARGET, \"text\": \"🎉 Telegram Remote Control已修复并重新配置！\\n\\n新的webhook URL: $WEBHOOK_URL\\n\\n现在你可以接收Claude通知了。\"}" > /dev/null
    echo "✅ 测试消息已发送到Telegram (Chat ID: $CHAT_TARGET)"
else
    echo "⚠️  未配置Telegram Chat ID或Group ID"
fi
echo ""
echo "🔥 下一步："
echo "1️⃣  确保webhook服务正在运行: node start-telegram-webhook.js"
echo "2️⃣  在tmux中设置Claude hooks: export CLAUDE_HOOKS_CONFIG=$PROJECT_DIR/claude-hooks.json"
echo "3️⃣  启动Claude: claude"