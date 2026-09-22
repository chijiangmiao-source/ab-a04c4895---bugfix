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
 * 不能按输入逐个折叠并在中间结果上判上限——后续合取支可能使族大幅坍缩
 * （例如 2187 个组合再与“全部事件”单割集相与，最终只剩 1 个）。
 * 这里对全部子门做组合枚举，并按最终并集的基数 s 从小到大处理：
 * 基数更大的候选不可能吸收更小的候选，所以处理完 s 后，
 * 大小 ≤s 的极小割集已经全部确定，保留集此后只增不减，
 * 此时越过上限即为门最终族的真实超限。
 */
function minimizeAnd(children: Mask[][], limit: number): Mask[] {
  if (children.length === 1) return children[0];

  // 分支数少的子门先展开，尽早用极小割集剪枝后续分支。
  const fams = [...children].sort((a, b) => a.length - b.length);
  let frontier = fams[0];

  for (let i = 1; i < fams.length; i += 1) {
    const candidates = new Set<Mask>();
    // (子门序号, 当前并集) 去重，避免等价路径指数重复。
    const visited = new Set<number>();
    const KEY_BASE = 2 ** 30;
    for (const left of frontier) {
      for (const right of fams[i]) {
        const union = left | right;
        const key = i * KEY_BASE + union;
        if (visited.has(key)) continue;
        visited.add(key);
        candidates.add(union);
      }
    }

    const buckets: Mask[][] = Array.from({ length: 31 }, () => []);
    for (const candidate of candidates) {
      buckets[bitCount(candidate)].push(candidate);
    }

    const next: Mask[] = [];
    const nextSet = new Set<Mask>();
    // 最终并集基数的下界：每个子门至少贡献其最小割集的位数。
    const minSize = Math.min(...[...candidates].map(bitCount));
    // 上界：所有候选位的并集（实际枚举不会超过它）。
    const maxSize = Math.max(...[...candidates].map(bitCount));
    for (let size = minSize; size <= maxSize; size += 1) {
      for (const candidate of buckets[size]) {
        // 已含更小的极小割集：后续并集只会更大，整条分支被吸收。
        if (keptHasSubset(candidate, next, nextSet)) continue;
        next.push(candidate);
        nextSet.add(candidate);
        if (next.length > limit) throw new LimitHit('', 0);
      }
    }
    frontier = next;
  }

  return frontier;
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
