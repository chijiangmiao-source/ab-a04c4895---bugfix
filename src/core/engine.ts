import type {
  Analysis,
  CompleteAnalysis,
  EventRole,
  Gate,
  LimitedAnalysis,
  ParsedModel
} from './types';

export const MAX_CUTSETS_PER_GATE = 2000;

/** 基本事件最多 30 个，用 30 位掩码（位 0..29），子集判断退化为位运算。 */
type Mask = number;

class LimitHit {
  constructor(readonly gate: string, readonly line: number) {}
}

export function bitCount(m: Mask): number {
  let x = m;
  let n = 0;
  while (x) {
    n += 1;
    x &= x - 1;
  }
  return n;
}

function containsAny(kept: Mask[], m: Mask): boolean {
  for (const k of kept) {
    if ((m & k) === k) return true;
  }
  return false;
}

/** kept 中是否存在 m 的子集；枚举 m 的子掩码与线性扫描择优。 */
function keptHasSubset(m: Mask, kept: Mask[], keptSet: Set<Mask>): boolean {
  if (kept.length === 0) return false;
  if (2 ** (bitCount(m) - 1) < kept.length) {
    for (let s = (m - 1) & m; s; s = (s - 1) & m) {
      if (keptSet.has(s)) return true;
    }
    return false;
  }
  return containsAny(kept, m);
}

/**
 * OR 归并：各子门割集本身就是候选，求极小族。
 * 按基数升序保留——更晚的集合不可能吸收更早的集合，
 * 因此保留数量只增不减，越过上限即可可靠地判定截断。
 */
function minimizeOr(children: Mask[][], limit: number): Mask[] {
  const buckets: Mask[][] = Array.from({ length: 31 }, () => []);
  const seen = new Set<Mask>();
  for (const fam of children) {
    for (const m of fam) {
      if (!seen.has(m)) {
        seen.add(m);
        buckets[bitCount(m)].push(m);
      }
    }
  }

  const kept: Mask[] = [];
  const keptSet = new Set<Mask>();
  for (let size = 0; size <= 30; size += 1) {
    for (const m of buckets[size]) {
      if (keptHasSubset(m, kept, keptSet)) continue;
      kept.push(m);
      keptSet.add(m);
      if (kept.length > limit) throw new LimitHit('', 0);
    }
  }
  return kept;
}

/**
 * AND 归并：候选割集 = 从每个子门各取一个割集后的并集，再取极小族。
 *
 * 绝不能在“逐输入折叠的中间产物”上判上限——尚未并入的合取支可能使族大幅坍缩：
 * 五组 6 选 1 的中间积有 6^5=7776 个候选，但再与仅含 7 个合法组合的许可门相与，
 * 最终族坍缩为 7 个割集；在折叠中途判限会把这种模型误报为 complexity_limit。
 *
 * 这里按“最终并集基数 s”从小到大逐桶 DFS 枚举：
 *   - 同基数的不同集合互不为真超集，因此同桶内去重后全部是极小割集；
 *   - 跨桶吸收只可能由更小的已保留割集造成，前缀一旦含之即整支剪枝；
 *   - 前缀基数一旦超过 s，后续并集只会更大，立即剪枝；
 *   - (深度, 并集) 记忆化消除等价前缀（共享结构导致的路径合并）。
 * 上限只对“最终极小族”计数：确认到第 limit+1 个极小割集时才判超限，
 * 因此中间爆炸、最终收缩不会误报；门定义顺序与顶门输入顺序也不影响结论。
 *
 * 另有一道二级保护：极端模型（例如 30 个互不相交二元组相与 => 2^30 个候选）
 * 的可行前缀本身就超过枚举预算时按 complexity_limit 中止，避免页面失去响应；
 * 常规“先爆炸后收缩”的模型在到达叶子后会被吸收剪枝大规模裁掉，远低于预算。
 */
const MAX_AND_ENUMERATION_STEPS = 4_000_000;

function minimizeAnd(children: Mask[][], limit: number): Mask[] {
  if (children.length === 1) return children[0];

  // 大割集的子门排在前（其位约束最强，能尽早用“前缀基数>s”剪枝）；
  // 仅为性能优化，与最终结果无关。
  const fams = [...children].sort((a, b) => {
    const am = Math.min(...a.map(bitCount));
    const bm = Math.min(...b.map(bitCount));
    return bm - am || a.length - b.length;
  });
  const n = fams.length;
  const KEY_BASE = 2 ** 30;

  let allBits: Mask = 0;
  let lowerBound = 0;
  for (const fam of fams) {
    for (const cut of fam) allBits |= cut;
    lowerBound = Math.max(lowerBound, Math.min(...fam.map(bitCount)));
  }

  const kept: Mask[] = [];
  const keptSet = new Set<Mask>();
  let steps = 0;

  for (let s = lowerBound; s <= bitCount(allBits); s += 1) {
    // 本桶内确认的极小割集（基数恰为 s 且不含任何更小的已保留割集）。
    const found = new Set<Mask>();
    // (深度, 并集) 去重：同一状态的全部扩展完全一致。
    const seen = new Set<number>();
    let aborted = false;

    const dfs = (depth: number, union: Mask): void => {
      if (aborted) return;
      steps += 1;
      if (steps > MAX_AND_ENUMERATION_STEPS) {
        aborted = true;
        return;
      }
      // 上限只统计最终极小族：连同更小桶已确认的，达到第 limit+1 个即真实超限。
      if (kept.length + found.size > limit) {
        aborted = true;
        return;
      }
      if (bitCount(union) > s) return;
      if (keptHasSubset(union, kept, keptSet)) return;

      if (depth === n) {
        if (bitCount(union) === s) found.add(union);
        return;
      }

      const key = depth * KEY_BASE + union;
      if (seen.has(key)) return;
      seen.add(key);

      for (const cut of fams[depth]) {
        dfs(depth + 1, union | cut);
        if (aborted) return;
      }
    };

    dfs(0, 0);

    // 二级保护触发：枚举预算耗尽，按超限中止该门（与真实超限同一出口）。
    if (steps > MAX_AND_ENUMERATION_STEPS) throw new LimitHit('', 0);

    for (const m of found) {
      // 叶子兜底复检（吸收它的更小割集可能直到最后一步才被凑齐）。
      if (!keptHasSubset(m, kept, keptSet)) {
        kept.push(m);
        keptSet.add(m);
      }
    }
    if (kept.length > limit) throw new LimitHit('', 0);
  }

  return kept;
}

export function analyze(model: ParsedModel): Analysis {
  const eventBit = new Map<string, number>();
  model.events.forEach((e, i) => eventBit.set(e, i));
  const gateByName = new Map<string, Gate>();
  for (const g of model.gates) gateByName.set(g.name, g);

  const memo = new Map<string, Mask[]>();
  const gateCounts: Record<string, number> = {};
  const partialGateCounts: Record<string, number> = {};
  const stack = new Set<string>();

  const normalize = (name: string): Mask[] => {
    const cached = memo.get(name);
    if (cached) return cached;
    if (stack.has(name)) {
      // 调用方负责先做 DAG 校验，此处理论不可达。
      throw new Error(`unexpected cycle at ${name}`);
    }
    const gate = gateByName.get(name);
    if (!gate) throw new Error(`unknown gate ${name}`);
    stack.add(name);

    try {
      // 同一输入（含重复书写的共享门）只参与一次。
      const uniqueInputs = [...new Set(gate.inputs)];
      const children: Mask[][] = uniqueInputs.map((input) => {
        const bit = eventBit.get(input);
        return bit !== undefined ? [1 << bit] : normalize(input);
      });

      const family =
        gate.type === 'AND'
          ? minimizeAnd(children, MAX_CUTSETS_PER_GATE)
          : minimizeOr(children, MAX_CUTSETS_PER_GATE);

      memo.set(name, family);
      gateCounts[name] = family.length;
      partialGateCounts[name] = family.length;
      return family;
    } catch (err) {
      // 基数枚举抛出的 LimitHit 不带门信息；在直接触发的那一帧补上，
      // 嵌套调用已带名时原样上抛，避免被父门名覆盖。
      if (err instanceof LimitHit && err.gate === '') {
        throw new LimitHit(gate.name, gate.line);
      }
      throw err;
    } finally {
      stack.delete(name);
    }
  };

  // 按门定义顺序逐一枚举；共享门经 memo 仅规范化一次，杜绝重复计算。
  for (const g of model.gates) {
    try {
      normalize(g.name);
    } catch (err) {
      if (err instanceof LimitHit) {
        const limited: LimitedAnalysis = {
          status: 'complexity_limit',
          gate: err.gate,
          line: err.line,
          limit: MAX_CUTSETS_PER_GATE,
          partialGateCounts
        };
        return limited;
      }
      throw err;
    }
  }

  const topFamily = memo.get(model.top)!;
  const masksToIds = (m: Mask): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < model.events.length; i += 1) {
      if (m & (1 << i)) ids.push(model.events[i]);
    }
    // 集合内按事件标识排序
    ids.sort();
    return ids;
  };

  let orUnion: Mask = 0;
  let andIntersection: Mask | null = null;
  for (const m of topFamily) {
    orUnion |= m;
    andIntersection = andIntersection === null ? m : andIntersection & m;
  }
  const intersection = andIntersection ?? 0;

  const classification: Record<string, EventRole> = {};
  for (const e of model.events) {
    const bit = 1 << eventBit.get(e)!;
    let role: EventRole;
    if (intersection & bit) role = 'mandatory';
    else if (orUnion & bit) role = 'optional';
    else role = 'irrelevant';
    classification[e] = role;
  }

  // 集合间按事件标识元组字典序排序
  const cutsets = topFamily
    .map(masksToIds)
    .sort((a, b) => {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i += 1) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return a.length - b.length;
    });

  const complete: CompleteAnalysis = {
    status: 'complete',
    top: model.top,
    cutsets,
    classification,
    gateCounts
  };
  return complete;
}
