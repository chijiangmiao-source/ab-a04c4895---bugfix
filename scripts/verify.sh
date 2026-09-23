#!/bin/sh
# verify 一次性服务入口：代码测试 → 构建检查 → 规定场景断言 → HTTP 冒烟 → 许可场景。
# 其中“共享许可组合不误报超限”场景按要求放在 HTTP 冒烟成功之后执行。
# 任一步失败立即以非零退出码退出，由 compose 报告该服务失败。
set -eu

echo '== [1/5] 代码测试（vitest） =='
npm test -- --run

echo '== [2/5] 构建检查（tsc + vite build） =='
npm run build

echo '== [3/5] 规定场景断言：吸收律 / 共享子门归属 / complexity_limit =='
mkdir -p .verify
npx esbuild scripts/verify-scenarios.ts \
  --bundle --platform=node --format=esm --outfile=.verify/scenarios.mjs
node .verify/scenarios.mjs core

echo '== [4/5] HTTP 冒烟（web 服务 /healthz 与 /） =='
# compose 的 service_healthy 已保证就绪，这里仍做有限重试以保留独立运行能力。
ready=0
i=0
while [ "$i" -lt 30 ]; do
  if wget -q -O- "http://${WEB_HOST:-web}/healthz" >/dev/null; then ready=1; break; fi
  i=$((i + 1))
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo 'healthz 在重试窗口内不可用' >&2
  exit 1
fi
wget -q -O- "http://${WEB_HOST:-web}/healthz" | grep -q '^ok$'
wget -q -O- "http://${WEB_HOST:-web}/" | grep -q 'id="root"'
echo "healthz: $(wget -q -O- "http://${WEB_HOST:-web}/healthz")"

echo '== [5/5] 共享许可组合场景：7 个极小割集、重排不变、真实超限仍报 =='
# 按要求放在 HTTP 冒烟成功之后：此处失败同样以非零退出码报告。
node .verify/scenarios.mjs permission

echo ''
echo 'ALL VERIFY CHECKS PASSED'
