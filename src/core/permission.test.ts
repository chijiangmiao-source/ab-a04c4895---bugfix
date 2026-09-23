import { describe, expect, it } from 'vitest';
import { audit } from './pipeline';
import { analyze, MAX_CUTSETS_PER_GATE } from './engine';
import type { ParsedModel } from './types';

function model(events: string[], lines: string[], top: string): ParsedModel {
  const gates = lines.map((line, i) => {
    const [name, type, ...inputs] = line.trim().split(/\s+/);
    return { name, type: type as 'AND' | 'OR', inputs, line: i + 1 };
  });
  return { events, gates, top };
}

const GROUPS = ['A', 'B', 'C', 'D', 'E'] as const;
const SUFFIXES = [0, 1, 2, 3, 4, 5] as const;

/** 五组基本事件 A0–A5…E0–E5，共 30 个。 */
function permissionEvents(): string[] {
  const events: string[] = [];
  for (const g of GROUPS) for (const i of SUFFIXES) events.push(`${g}${i}`);
  return events;
}

/**
 * 共享许可模型：
 *   GA..GE 各 OR 汇总一组（6 个割集）；
 *   P0..P5 为同后缀 AND 组合；PX 为 A0,B1,C2,D3,E4 交错组合；
 *   PERM 用 OR 汇总这 7 条组合；TOP = GA..GE 与 PERM 相与。
 */
function permissionGateLines(topInputs: string[] = ['GA', 'GB', 'GC', 'GD', 'GE', 'PERM']): string[] {
  const lines: string[] = [];
  for (const g of GROUPS) {
    lines.push(`G${g} OR ${SUFFIXES.map((i) => `${g}${i}`).join(' ')}`);
  }
  for (const i of SUFFIXES) {
    lines.push(`P${i} AND A${i} B${i} C${i} D${i} E${i}`);
  }
  lines.push('PX AND A0 B1 C2 D3 E4');
  lines.push('PERM OR P0 P1 P2 P3 P4 P5 PX');
  lines.push(`TOP AND ${topInputs.join(' ')}`);
  return lines;
}

const EXPECTED_CUTSETS: string[][] = [
  ['A0', 'B0', 'C0', 'D0', 'E0'],
  ['A0', 'B1', 'C2', 'D3', 'E4'],
  ['A1', 'B1', 'C1', 'D1', 'E1'],
  ['A2', 'B2', 'C2', 'D2', 'E2'],
  ['A3', 'B3', 'C3', 'D3', 'E3'],
  ['A4', 'B4', 'C4', 'D4', 'E4'],
  ['A5', 'B5', 'C5', 'D5', 'E5']
];

describe('共享许可组合（中间爆炸被许可门收缩）', () => {
  it('顶事件恰为 7 个极小割集：6 个同后缀 + 1 个交错，不截断不扩展', () => {
    const r = analyze(model(permissionEvents(), permissionGateLines(), 'TOP'));
    expect(r.status).toBe('complete');
    if (r.status !== 'complete') return;
    // 与期望族逐元素相等：既不能多出（扩展），也不能少了（截断）。
    expect(r.cutsets).toEqual(EXPECTED_CUTSETS);
  });

  it('30 个基本事件全部归为可选（无必现、无无关）', () => {
    const events = permissionEvents();
    const r = analyze(model(events, permissionGateLines(), 'TOP'));
    expect(r.status).toBe('complete');
    if (r.status !== 'complete') return;
    expect(Object.keys(r.classification).sort()).toEqual([...events].sort());
    for (const e of events) expect(r.classification[e]).toBe('optional');
    // 每个事件至少出现在某割集中，且没有事件出现在全部割集中。
    for (const e of events) {
      const appears = r.cutsets.filter((cs) => cs.includes(e));
      expect(appears.length).toBeGreaterThan(0);
      expect(appears.length).toBeLessThan(r.cutsets.length);
    }
  });

  it('许可门 PERM 与顶门 TOP 的规范化割集数都为 7，分组门各为 6', () => {
    const r = analyze(model(permissionEvents(), permissionGateLines(), 'TOP'));
    expect(r.status).toBe('complete');
    if (r.status !== 'complete') return;
    expect(r.gateCounts.PERM).toBe(7);
    expect(r.gateCounts.TOP).toBe(7);
    for (const g of GROUPS) expect(r.gateCounts[`G${g}`]).toBe(6);
    for (const i of SUFFIXES) expect(r.gateCounts[`P${i}`]).toBe(1);
    expect(r.gateCounts.PX).toBe(1);
  });

  it('走完整解析/校验管线同样不误报 complexity_limit', () => {
    const eventsText = permissionEvents().join('\n') + '\n';
    const gatesText = permissionGateLines().join('\n') + '\n';
    const r = audit(eventsText, gatesText, 'TOP');
    expect(r.status).toBe('complete');
    if (r.status === 'complete') {
      expect(r.cutsets).toEqual(EXPECTED_CUTSETS);
      expect(r.gateCounts.PERM).toBe(7);
      expect(r.gateCounts.TOP).toBe(7);
    }
  });
});

describe('门定义顺序与顶门输入顺序不影响结论', () => {
  const baseline = analyze(model(permissionEvents(), permissionGateLines(), 'TOP'));

  it('门定义整体逆序、顶门输入逆序后割集/归属/门计数完全一致', () => {
    const reversedLines = [...permissionGateLines()].reverse();
    // 逆序后 TOP 行落在最前，其输入也已逆序；仍以 TOP 为顶事件。
    const r = analyze(model(permissionEvents(), reversedLines, 'TOP'));
    expect(r.status).toBe('complete');
    if (r.status !== 'complete' || baseline.status !== 'complete') {
      expect(r.status).toBe('complete');
      return;
    }
    expect(r.cutsets).toEqual(baseline.cutsets);
    expect(r.classification).toEqual(baseline.classification);
    expect(r.gateCounts).toEqual(baseline.gateCounts);
  });

  it('顶门输入任意排列（许可门居首/居中/居末）结论一致', () => {
    const orders = [
      ['PERM', 'GA', 'GB', 'GC', 'GD', 'GE'],
      ['GA', 'PERM', 'GB', 'GC', 'GD', 'GE'],
      ['GA', 'GB', 'PERM', 'GC', 'GD', 'GE'],
      ['GE', 'GD', 'GC', 'GB', 'GA', 'PERM']
    ];
    for (const topInputs of orders) {
      const r = analyze(model(permissionEvents(), permissionGateLines(topInputs), 'TOP'));
      expect(r.status, `inputs=${topInputs.join(',')}`).toBe('complete');
      if (r.status === 'complete' && baseline.status === 'complete') {
        expect(r.cutsets).toEqual(baseline.cutsets);
        expect(r.gateCounts.TOP).toBe(7);
        expect(r.gateCounts.PERM).toBe(7);
      }
    }
  });

  it('交错组合门定义提前、许可门输入乱序后七个割集不变', () => {
    const lines = permissionGateLines();
    // 将 PX 行移到分组门之后、P0 之前，并打乱 PERM 输入顺序。
    const px = lines.find((l) => l.startsWith('PX '))!;
    const withoutPx = lines.filter((l) => !l.startsWith('PX ') && !l.startsWith('PERM ') && !l.startsWith('TOP '));
    const reordered = [...withoutPx.slice(0, 5), px, ...withoutPx.slice(5), 'PERM OR PX P5 P3 P1 P0 P2 P4', 'TOP AND PERM GA GB GC GD GE'];
    const r = analyze(model(permissionEvents(), reordered, 'TOP'));
    expect(r.status).toBe('complete');
    if (r.status === 'complete') expect(r.cutsets).toEqual(EXPECTED_CUTSETS);
  });
});

describe('真实超限边界仍如实返回 complexity_limit', () => {
  function exploding(groups: number): ParsedModel {
    const events: string[] = [];
    const lines: string[] = [];
    for (let g = 0; g < groups; g += 1) {
      const members = [`e${g}_0`, `e${g}_1`, `e${g}_2`];
      events.push(...members);
      lines.push(`GRP${g} OR ${members.join(' ')}`);
    }
    lines.push(`BIG AND ${Array.from({ length: groups }, (_, g) => `GRP${g}`).join(' ')}`);
    return model(events, lines, 'BIG');
  }

  it('最终极小割集确为 3^7=2187 时返回 complexity_limit', () => {
    const r = analyze(exploding(7));
    expect(r.status).toBe('complexity_limit');
    if (r.status === 'complexity_limit') {
      expect(r.gate).toBe('BIG');
      expect(r.limit).toBe(MAX_CUTSETS_PER_GATE);
      expect('cutsets' in r).toBe(false);
    }
  });

  it('恰好等于上限 2000 时仍完整输出（边界不含糊）', () => {
    // 4×5×10×10 = 2000
    const sizes = [4, 5, 10, 10];
    const events: string[] = [];
    const lines: string[] = [];
    sizes.forEach((s, gi) => {
      const members = Array.from({ length: s }, (_, k) => `h${gi}_${k}`);
      events.push(...members);
      lines.push(`GRP${gi} OR ${members.join(' ')}`);
    });
    lines.push('BIG AND GRP0 GRP1 GRP2 GRP3');
    const r = analyze(model(events, lines, 'BIG'));
    expect(r.status).toBe('complete');
    if (r.status === 'complete') expect(r.cutsets).toHaveLength(2000);
  });
});
