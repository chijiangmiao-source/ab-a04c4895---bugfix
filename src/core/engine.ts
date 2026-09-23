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

interface HeapNode {
  /** 队列键：当前并集基数 = 最终基数的容许下界（合取只会增位） */
  key: number;
  /** 已合并的子门数 */
  depth: number;
  mask: Mask;
}

/** 以 (基数升序, 深度降序, 掩码升序) 排序的二叉堆；同基数优先深化以尽早拿到极小割集剪枝。 */
class SearchHeap {
  private nodes: HeapNode[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: HeapNode): void {
    const h = this.nodes;
    h.push(node);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(h[i], h[parent])) break;
      [h[i], h[parent]] = [h[parent], h[i]];
      i = parent;
    }
  }

  pop(): HeapNode {
    const h = this.nodes;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < h.length && this.less(h[l], h[smallest])) smallest = l;
        if (r < h.length && this.less(h[r], h[smallest])) smallest = r;
        if (smallest === i) break;
        [h[i], h[smallest]] = [h[smallest], h[i]];
        i = smallest;
      }
    }
    return top;
  }

  private less(a: HeapNode, b: HeapNode): boolean {
    if (a.key !== b.key) return a.key < b.key;
    if (a.depth !== b.depth) return a.depth > b.depth;
    return a.mask < b.mask;
  }
}

/**
 * AND 归并：候选割集 = 从每个子门各取一个割集后的并集，再取极小族。
 *
 * 不能按输入逐个折叠并在中间结果上判上限——后续合取支可能使族大幅坍缩
 * （五个 6 选 1 组先折叠出 6^5=7776 个组合，再与仅 7 个割集的“许可
 * 组合”门相与，最终族只有 7 个；旧实现按族大小排序使许可门最后参与，
 * 于是在中间折叠处误报超限）。这里改用最佳优先的分支限界枚举最终乘积：
 * 状态按当前并集基数（最终基数的容许下界）出队，完整割集按基数非降序
 * 落定；已确认的极小割集用于吸收/剪枝；上限只在最终极小族上判定。
 */
function minimizeAnd(children: Mask[][], limit: number): Mask[] {
  if (children.length === 1) return children[0];

  // 大割集（强约束）子门排在最前，使极小割集尽早落定、最大化剪枝；
  // 排序只依据族内容的确定性指标，与门定义/输入书写顺序无关。
  const stats = children.map((fam) => {
    let max = 0;
    let total = 0;
    let min = Infinity;
    for (const m of fam) {
      const b = bitCount(m);
      if (b > max) max = b;
      total += b;
      if (m < min) min = m;
    }
    return { fam, max, total, min, length: fam.length };
  });
  stats.sort(
    (a, b) =>
      b.max - a.max || b.total - a.total || a.length - b.length || a.min - b.min
  );
  const fams = stats.map((s) => s.fam);
  const depthCount = fams.length;

  const heap = new SearchHeap();
  heap.push({ key: 0, depth: 0, mask: 0 });

  // (depth, mask) 去重：不同选择路径可能给出同一部分并集。
  const visited = new Set<number>([0]);
  const KEY_BASE = 2 ** 30;

  const kept: Mask[] = [];
  const keptSet = new Set<Mask>();

  // 最佳优先分支限界：按当前并集基数出队（最终基数的容许下界），
  // 因此完整割集按基数非降序产出；后产出者不可能吸收先产出者，
  // 保留集只增不减，越过上限即为门最终族的真实超限。
  while (heap.size > 0) {
    const { depth, mask } = heap.pop();
    if (keptHasSubset(mask, kept, keptSet)) continue;

    if (depth === depthCount) {
      kept.push(mask);
      keptSet.add(mask);
      if (kept.length > limit) throw new LimitHit('', 0);
      continue;
    }

    for (const part of fams[depth]) {
      const union = mask | part;
      // 已含更小的极小割集：后续并集只会更大，整条分支被吸收。
      if (keptHasSubset(union, kept, keptSet)) continue;
      const key = (depth + 1) * KEY_BASE + union;
      if (visited.has(key)) continue;
      visited.add(key);
      heap.push({ key: bitCount(union), depth: depth + 1, mask: union });
    }
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
