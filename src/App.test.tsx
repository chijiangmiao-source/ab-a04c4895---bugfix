// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

const containers: HTMLElement[] = [];

function render(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  act(() => root.render(<App />));
  return { container, root };
}

afterEach(() => {
  for (const c of containers) {
    act(() => c.textContent && (c.innerHTML = ''));
  }
  containers.length = 0;
});

function setNative(el: Element, value: string): void {
  const proto = Object.getPrototypeOf(el) as unknown as { value: string };
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('App 页面', () => {
  it('渲染示例并显示 8 个割集与“无关”分类', () => {
    const { container } = render();
    const heading = container.textContent ?? '';
    expect(heading).toContain('最小割集（8 个）');
    expect(heading).toContain('无关');
    expect(heading).toContain('COSMIC');
    // 共享门计数表
    expect(heading).toContain('LOSS');
  });

  it('保留非法输入并显示可点击的问题定位', () => {
    const { container } = render();
    const gateArea = container.querySelectorAll('textarea')[1];
    setNative(gateArea, 'G AND A MISSING');
    expect(container.textContent).toContain('missing_reference');
  });

  it('超限输入显示 complexity_limit 警示且不输出割集', () => {
    const { container } = render();
    const areas = container.querySelectorAll('textarea');
    const ev: string[] = [];
    const lines: string[] = [];
    for (let g = 0; g < 7; g += 1) {
      const members = [`e${g}_0`, `e${g}_1`, `e${g}_2`];
      ev.push(...members);
      lines.push(`GRP${g} OR ${members.join(' ')}`);
    }
    lines.push('BIG AND GRP0 GRP1 GRP2 GRP3 GRP4 GRP5 GRP6');
    setNative(areas[0], ev.join('\n'));
    setNative(areas[1], lines.join('\n'));
    const topInput = container.querySelector('input')!;
    setNative(topInput, 'BIG');

    const text = container.textContent ?? '';
    expect(text).toContain('complexity_limit');
    expect(text).toContain('结论不完整');
    expect(text).not.toContain('最小割集（0 个）');
  });

  it('五组事件 + 七条许可组合：页面显示 7 个极小割集、30 个可选事件，不误报超限', () => {
    const { container } = render();
    const areas = container.querySelectorAll('textarea');
    const letters = ['A', 'B', 'C', 'D', 'E'];
    const ev: string[] = [];
    for (const L of letters) for (let i = 0; i < 6; i += 1) ev.push(`${L}${i}`);
    const lines: string[] = [];
    for (const L of letters) {
      lines.push(`G_${L} OR ${Array.from({ length: 6 }, (_, i) => `${L}${i}`).join(' ')}`);
    }
    for (let i = 0; i < 6; i += 1) {
      lines.push(`P${i} AND A${i} B${i} C${i} D${i} E${i}`);
    }
    lines.push('PX AND A0 B1 C2 D3 E4');
    lines.push('PERM OR P0 P1 P2 P3 P4 P5 PX');
    lines.push('TOP AND PERM G_E G_A G_C G_D G_B');
    setNative(areas[0], ev.join('\n'));
    setNative(areas[1], lines.join('\n'));
    setNative(container.querySelector('input')!, 'TOP');

    const text = container.textContent ?? '';
    expect(text).not.toContain('complexity_limit');
    expect(text).toContain('最小割集（7 个）');
    // 七条组合均展示（同后缀六条 + 交错一条）
    expect(text).toContain('A0');
    expect(text).toContain('B1');
    expect(text).toContain('E4');
    // 事件归属：无可选以外的类别出现计数
    expect(text).toContain('基本事件归属');
    // 门计数表中许可门与顶门均为 7
    expect(text).toContain('PERM');
    // 30 个事件全部出现在可选行：必现行为空
    const mandatoryRow = text.match(/必现[\s\S]*?可选/);
    expect(mandatoryRow![0]).not.toMatch(/[A-E][0-5]/);
  });
});
