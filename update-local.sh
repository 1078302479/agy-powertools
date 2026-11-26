#!/bin/sh
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$repo_root"

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "custom" ]; then
  printf '当前分支为 %s，请先切换到 custom 分支后再执行更新。\n' "$branch" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  printf '工作区存在未提交改动，请先提交或暂存后再拉取更新。\n' >&2
  exit 1
fi

printf '==> 拉取 origin/custom 最新代码...\n'
git pull --ff-only origin custom

printf '==> 运行定制核心测试...\n'
node --test tests/settings.test.mjs tests/native-ui.test.mjs

printf '==> 重新部署到本机插件目录...\n'
sh ./install.sh
