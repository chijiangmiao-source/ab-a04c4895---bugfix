/**
 * verify 一次性服务的规定场景断言（由 esbuild 打包为 Node ESM 后执行）。
 * 覆盖：
 *   1. 吸收律场景的最小割集；
 *   2. 共享子门的事件归属；
 *   3. 任一门规范化后超过 2000 个割集的超限场景与 2000 边界；
 *   4. （permission）五组事件 + 七条许可组合：最终仅 7 个极小割集，
 *      不得误报 complexity_limit；门定义/顶门输入重排结论不变；
 *      无许可约束的同结构模型（6^5=7776）仍须报超限。
 *
 * 用法：node scenarios.mjs [core|permission]（默认 core）。
 * verify.sh 在 HTTP 冒烟成功后再执行 permission 组。
 * 任一断言失败即以非零退出码结束进程。
 */
import { analyze } from '../src/core/engine';
import { audit } from '../src/core/pipeline';
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

const names = (cuts: string[][]): string[] => cuts.map((c) => [...c].sort().join('*'));

function runCoreScenarios(): void {
  // ---- 场景 1：吸收律 ----
  // TOP = G1 OR G2，G1=A OR B，G2=A AND B；{A,B} 是 {A}、{B} 的真超集，必须被吸收。
  console.log('[scenario 1] absorption: A∨B∨(A∧B) => {A},{B}');
  {
    const r = audit('A\nB\n', 'G1 OR A B\nG2 AND A B\nTOP OR G1 G2\n', 'TOP');
    check('状态为 complete', r.status === 'complete', r);
    if (r.status === 'complete') {
      check('最小割集恰为 {A},{B}', JSON.stringify(names(r.cutsets)) === JSON.stringify(['A', 'B']), names(r.cutsets));
    }
  }

  // ---- 场景 2：共享子门的事件归属 ----
  // S 被 L、R 共享；T=(S∧A)∨(S∧B)。割集 {A},{B}，X 未接入任何门。
  console.log('[scenario 2] shared sub-gate classification');
  {
    const r = analyze(
      buildModel(
        ['A', 'B', 'X'],
        ['S OR A B', 'L AND S A', 'R AND S B', 'T OR L R'],
        'T'
      )
    );
    check('状态为 complete', r.status === 'complete', r);
    if (r.status === 'complete') {
      check('A=可选', r.classification.A === 'optional', r.classification);
      check('B=可选', r.classification.B === 'optional', r.classification);
      check('X=无关', r.classification.X === 'irrelevant', r.classification);
      check('割集为 {A},{B}', JSON.stringify(names(r.cutsets)) === JSON.stringify(['A', 'B']), names(r.cutsets));
      check('共享门 S 仅规范化一次（计数=2）', r.gateCounts.S === 2, r.gateCounts);
    }
  }

  // ---- 场景 3：complexity_limit ----
  // 7 个三选一组相与 => 3^7 = 2187 > 2000；必须报告 complexity_limit 且不得产出完整结论。
  console.log('[scenario 3] complexity_limit at 3^7=2187 > 2000');
  {
    const events: string[] = [];
    const lines: string[] = [];
    for (let g = 0; g < 7; g += 1) {
      const members = [`e${g}_0`, `e${g}_1`, `e${g}_2`];
      events.push(...members);
      lines.push(`GRP${g} OR ${members.join(' ')}`);
    }
    lines.push('BIG AND GRP0 GRP1 GRP2 GRP3 GRP4 GRP5 GRP6');
    const r = analyze(buildModel(events, lines, 'BIG'));
    check('状态为 complexity_limit', r.status === 'complexity_limit', r);
    if (r.status === 'complexity_limit') {
      check('定位到超限门 BIG', r.gate === 'BIG', r);
      check('上限为 2000', r.limit === 2000, r);
      check('未输出任何割集（不冒充完整结论）', !('cutsets' in r), r);
    }
    // 边界：恰好 2000（4*5*10*10）必须完整
    const sizes = [4, 5, 10, 10];
    const ev2: string[] = [];
    const ln2: string[] = [];
    sizes.forEach((s, gi) => {
      const members = Array.from({ length: s }, (_, k) => `h${gi}_${k}`);
      ev2.push(...members);
      ln2.push(`GRP${gi} OR ${members.join(' ')}`);
    });
    ln2.push('BIG AND GRP0 GRP1 GRP2 GRP3');
    const r2 = analyze(buildModel(ev2, ln2, 'BIG'));
    check('恰好 2000 时完整输出 2000 个割集', r2.status === 'complete' && r2.cutsets.length === 2000, r2.status);
  }
}

function runPermissionScenario(): void {
  // ---- 场景 4：五组基本事件 + 七条许可组合（共享许可约束） ----
  // A0..A5、B0..B5、C0..C5、D0..D5、E0..E5 共 30 个事件；
  // 五组各由一个 OR 门汇总；P0..P5 连接同后缀事件（AND），PX 连接 A0 B1 C2 D3 E4；
  // PERM 用 OR 汇总七条组合；TOP = G_A∧G_B∧G_C∧G_D∧G_E∧PERM。
  // 许可约束把 6^5=7776 种组合收缩为恰好 7 个极小割集，不得误报超限。
  console.log('[scenario 4] shared permission combinations: 6^5 constrained => 7 cutsets');
  const letters = ['A', 'B', 'C', 'D', 'E'];
  const events: string[] = [];
  for (const L of letters) for (let i = 0; i < 6; i += 1) events.push(`${L}${i}`);
  const lines: string[] = [];
  for (const L of letters) {
    lines.push(`G_${L} OR ${Array.from({ length: 6 }, (_, i) => `${L}${i}`).join(' ')}`);
  }
  for (let i = 0; i < 6; i += 1) {
    lines.push(`P${i} AND A${i} B${i} C${i} D${i} E${i}`);
  }
  lines.push('PX AND A0 B1 C2 D3 E4');
  lines.push('PERM OR P0 P1 P2 P3 P4 P5 PX');
  lines.push('TOP AND G_A G_B G_C G_D G_E PERM');

  const expected = [
    'A0*B0*C0*D0*E0',
    'A0*B1*C2*D3*E4',
    'A1*B1*C1*D1*E1',
    'A2*B2*C2*D2*E2',
    'A3*B3*C3*D3*E3',
    'A4*B4*C4*D4*E4',
    'A5*B5*C5*D5*E5'
  ];

  const r = analyze(buildModel(events, lines, 'TOP'));
  check('状态为 complete（不误报 complexity_limit）', r.status === 'complete', r.status);
  if (r.status === 'complete') {
    check('恰为 7 个极小割集', r.cutsets.length === 7, r.cutsets.length);
    check(
      '七个极小割集完整：六条同后缀 + 交错 A0·B1·C2·D3·E4',
      JSON.stringify(names(r.cutsets)) === JSON.stringify(expected),
      names(r.cutsets)
    );
    check('七条组合均未被截断或扩展（每条恰 5 个事件）', r.cutsets.every((c) => c.length === 5));
    const roles = Object.values(r.classification);
    check('30 个基本事件全部归为可选', roles.length === 30 && roles.every((x) => x === 'optional'), r.classification);
    check('许可组合门 PERM 规范化割集数为 7', r.gateCounts.PERM === 7, r.gateCounts);
    check('顶门 TOP 规范化割集数为 7', r.gateCounts.TOP === 7, r.gateCounts);
  }

  // 门定义顺序与顶门输入顺序重排：结论不变。
  {
    const parsed = buildModel(events, lines, 'TOP');
    const byName = new Map(parsed.gates.map((g) => [g.name, g]));
    const reordered = ['PERM', 'G_E', 'P5', 'PX', 'P0', 'TOP', 'G_A', 'P1', 'G_C', 'P3', 'G_B', 'P2', 'G_D', 'P4']
      .map((name, i) => ({ ...byName.get(name)!, line: i + 1 }));
    const top = reordered.find((g) => g.name === 'TOP')!;
    top.inputs = ['PERM', 'G_E', 'G_A', 'G_C', 'G_D', 'G_B'];
    const r2 = analyze({ events, gates: reordered, top: 'TOP' });
    check('重排后仍为 complete 且 7 个割集不变',
      r2.status === 'complete' && JSON.stringify(names(r2.cutsets)) === JSON.stringify(expected),
      r2.status);
    if (r2.status === 'complete') {
      check('重排后 PERM/TOP 门计数仍为 7', r2.gateCounts.PERM === 7 && r2.gateCounts.TOP === 7, r2.gateCounts);
    }
  }

  // 真实超限对照：去掉许可约束，五组 6 选 1 直接相与 => 6^5 = 7776 > 2000。
  {
    const unconstrained = letters.map(
      (L) => `G_${L} OR ${Array.from({ length: 6 }, (_, i) => `${L}${i}`).join(' ')}`
    );
    unconstrained.push('TOP AND G_A G_B G_C G_D G_E');
    const r3 = analyze(buildModel(events, unconstrained, 'TOP'));
    check('无许可约束时 6^5=7776 仍报 complexity_limit', r3.status === 'complexity_limit' && r3.gate === 'TOP', r3.status);
  }
}

const group = process.argv[2] ?? 'core';
if (group === 'permission') runPermissionScenario();
else runCoreScenarios();

if (failures > 0) {
  console.error(`\nVERIFY SCENARIOS FAILED: ${failures}`);
  process.exit(1);
}
console.log('\nALL VERIFY SCENARIOS PASSED');
