/**
 * verify 一次性服务的“共享许可组合”场景断言（由 esbuild 打包为 Node ESM 后执行）。
 *
 * 五组基本事件 A0–A5…E0–E5：GA..GE 各由 OR 汇总（6 个割集）；
 * 六条同后缀许可 P0..P5 与一条交错许可 PX=(A0,B1,C2,D3,E4) 由 PERM(OR) 汇总；
 * TOP = GA..GE ∧ PERM。
 *
 * 逐输入折叠会在中途得到 6^5=7776 个组合，但许可门把最终族收缩为 7 个极小割集。
 * 本断言确保这种模型不会被误报为 complexity_limit，并核对：
 *   - 顶事件恰为 7 个极小割集（6 同后缀 + 1 交错），不截断、不扩展；
 *   - 30 个基本事件全部归为可选；
 *   - 许可门 PERM 与顶门 TOP 规范化割集数都为 7。
 * 任一断言失败即以非零退出码结束进程（由 compose 以退出码报告）。
 */
import { analyze } from '../src/core/engine';
import type { ParsedModel } from '../src/core/types';

let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}`, detail ?? '');
  }
}

function buildModel(events: string[], lines: string[], top: string): ParsedModel {
  const gates = lines.map((line, i) => {
    const [name, type, ...inputs] = line.trim().split(/\s+/);
    return { name, type: type as 'AND' | 'OR', inputs, line: i + 1 };
  });
  return { events, gates, top };
}

const GROUPS = ['A', 'B', 'C', 'D', 'E'];
const SUFFIXES = [0, 1, 2, 3, 4, 5];

const events: string[] = [];
for (const g of GROUPS) for (const i of SUFFIXES) events.push(`${g}${i}`);

const lines: string[] = [];
for (const g of GROUPS) lines.push(`G${g} OR ${SUFFIXES.map((i) => `${g}${i}`).join(' ')}`);
for (const i of SUFFIXES) lines.push(`P${i} AND A${i} B${i} C${i} D${i} E${i}`);
lines.push('PX AND A0 B1 C2 D3 E4');
lines.push('PERM OR P0 P1 P2 P3 P4 P5 PX');
lines.push('TOP AND GA GB GC GD GE PERM');

const expected = [
  'A0*B0*C0*D0*E0',
  'A0*B1*C2*D3*E4',
  'A1*B1*C1*D1*E1',
  'A2*B2*C2*D2*E2',
  'A3*B3*C3*D3*E3',
  'A4*B4*C4*D4*E4',
  'A5*B5*C5*D5*E5'
];

console.log('[permission] shared permission combinations: 6^5 intermediate => 7 final cutsets');
const r = analyze(buildModel(events, lines, 'TOP'));
check('状态为 complete（未误报 complexity_limit）', r.status === 'complete', r.status);
if (r.status === 'complete') {
  const got = r.cutsets.map((c) => [...c].sort().join('*'));
  check('恰为 7 个极小割集（6 同后缀 + 1 交错，不截断不扩展）', JSON.stringify(got) === JSON.stringify(expected), got);
  check('30 个基本事件全部归为可选', events.every((e) => r.classification[e] === 'optional'), r.classification);
  check('许可门 PERM 规范化割集数为 7', r.gateCounts.PERM === 7, r.gateCounts);
  check('顶门 TOP 规范化割集数为 7', r.gateCounts.TOP === 7, r.gateCounts);
}

if (failures > 0) {
  console.error(`\nPERMISSION SCENARIO FAILED: ${failures}`);
  process.exit(1);
}
console.log('PERMISSION SCENARIO PASSED');
