#!/usr/bin/env bash
# 敏感信息扫描：防止真实凭据、内网地址、组织/公司标识进入公开仓库。
#
# 两层设计：
#   1. 通用模式（本文件内置，随仓库公开）：明显不应出现在公开仓库的内容。
#      注意：本文件自身不能包含任何组织专属词，否则扫描脚本就成了标识泄漏源。
#   2. 本地词表（scripts/sensitive_words.local.txt，已 gitignore，不入库）：
#      存放个人/组织专属标识词，仅本机扫描时使用。
#
# 用法：bash scripts/check_sensitive.sh

set -euo pipefail

# 通用模式：每条附自己的排除列表（文档中的占位示例不视为敏感）
run_pattern() {
    local pat="$1"; shift
    git grep -inE "$pat" -- . ':(exclude)scripts/check_sensitive.sh' "$@" || true
}

hits=""

# 本机绝对用户路径
h=$(run_pattern '/Users/[a-z]+'); [ -n "$h" ] && hits+="$h"$'\n'
# 环境变量被赋了具体值（文档允许 =... / $VAR 占位）
h=$(git grep -inE 'GRAFANA_[A-Z_]*(URL|USER|PASSWORD)=[^. $]' -- . ':(exclude)scripts/check_sensitive.sh' || true); [ -n "$h" ] && hits+="$h"$'\n'
# 硬编码密码字面量（排除常见占位值：文档示例与测试假值）
h=$(run_pattern 'password\s*[:=]\s*["'"'"'][^"'"'"']{6,}' | grep -viE '你的|your|placeholder|example|xxx|changeme|dummy|secret' || true); [ -n "$h" ] && hits+="$h"$'\n'
# 疑似内网 IP
h=$(run_pattern 'https?://(10|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.'); [ -n "$h" ] && hits+="$h"$'\n'

# 本地词表扫描（存在才扫）
WORD_FILE="scripts/sensitive_words.local.txt"
if [ -f "$WORD_FILE" ]; then
    local_pat=$(grep -vE '^\s*(#|$)' "$WORD_FILE" | tr '\n' '|' | sed 's/|$//')
    if [ -n "$local_pat" ]; then
        h=$(git grep -inE "$local_pat" -- . ':(exclude)scripts/check_sensitive.sh' ':(exclude)scripts/sensitive_words.local.txt' || true)
        [ -n "$h" ] && hits+="$h"$'\n'
    fi
else
    echo "提示：未找到 $WORD_FILE（本地词表，已 gitignore），跳过组织专属词扫描。"
fi

if [ -n "${hits//[[:space:]]/}" ]; then
    echo "检测到疑似敏感信息，禁止提交："
    echo "$hits"
    echo
    echo "如确认为误报，请调整 scripts/check_sensitive.sh 中的模式。"
    exit 1
fi

echo "敏感信息扫描通过 ✅"
