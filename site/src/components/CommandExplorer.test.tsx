import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fixture from '../data/commands.json';
import {
  CommandExplorer,
  commandFromHash,
  filterCommands,
  type ExplorerCommand,
} from './CommandExplorer';

const commands = fixture as ExplorerCommand[];

let dom: JSDOM;
let roots: Root[] = [];

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/bundant/#commands/deploy',
  });
  const globals = globalThis as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.Event = dom.window.Event;
  globals.KeyboardEvent = dom.window.KeyboardEvent;
  globals.MouseEvent = dom.window.MouseEvent;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  roots = [];
  document.body.innerHTML = '';
});

afterAll(() => {
  dom.window.close();
});

async function renderAt(hash: string) {
  window.history.replaceState(null, '', hash);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<CommandExplorer commands={commands} />);
  });
  return container;
}

function pane(container: HTMLElement) {
  return container.querySelector('[role="region"]') as HTMLElement;
}

function option(container: HTMLElement, name: string) {
  return container.querySelector(`#command-option-${name}`) as HTMLElement;
}

function search(container: HTMLElement) {
  return container.querySelector('input[type="search"]') as HTMLInputElement;
}

async function type(container: HTMLElement, value: string) {
  const input = search(container);
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

async function press(target: HTMLElement, key: string) {
  await act(async () => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('command explorer data', () => {
  test('substring filter matches names and summaries, and can find nothing', () => {
    expect(filterCommands(commands, 'roll').map((command) => command.name)).toContain('rollback');
    expect(filterCommands(commands, 'proxy route').map((command) => command.name)).toContain('delete');
    expect(filterCommands(commands, 'no-such-command')).toEqual([]);
    expect(commandFromHash('#commands/logs')).toBe('logs');
    expect(commandFromHash('#commands')).toBeNull();
    expect(commandFromHash('#why')).toBeNull();
  });
});

describe('command explorer selection', () => {
  test('rendering and selecting never scroll the page', async () => {
    // Regression: a scrollIntoView() on the active option scrolled every ancestor, so
    // opening the page jumped the window down to this section.
    const calls: string[] = [];
    const proto = window.Element.prototype as unknown as { scrollIntoView: () => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      calls.push(this.id || String(this.className) || this.tagName);
    };
    try {
      const container = await renderAt('#commands/deploy');
      await act(async () => {
        option(container, 'rollback').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      });
      await press(container.querySelector('[role="listbox"]') as HTMLElement, 'ArrowDown');
    } finally {
      proto.scrollIntoView = original;
    }
    expect(calls).toEqual([]);
  });

  test('clicking an option selects it', async () => {
    const container = await renderAt('#commands/deploy');
    expect(pane(container).textContent).toContain('deploy');

    await act(async () => {
      option(container, 'rollback').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    expect(pane(container).querySelector('h3')?.textContent).toBe('rollback');
    expect(option(container, 'rollback').getAttribute('aria-selected')).toBe('true');
    expect(window.location.hash).toBe('#commands/rollback');
  });

  test('typing then Enter selects the first match', async () => {
    const container = await renderAt('#commands/deploy');
    await type(container, 'scale');
    expect(container.querySelector('.command-explorer-count')?.textContent).toContain('1 of 23');
    await press(container.querySelector('[role="listbox"]') as HTMLElement, 'Enter');

    expect(pane(container).querySelector('h3')?.textContent).toBe('scale');
    expect(option(container, 'scale').getAttribute('aria-selected')).toBe('true');
  });

  test('arrow keys move the list cursor and the URL hash follows a selection', async () => {
    const container = await renderAt('#commands/validate');
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;

    await press(listbox, 'ArrowDown');
    await press(listbox, 'Enter');

    expect(pane(container).querySelector('h3')?.textContent).toBe('scale');
    expect(window.location.hash).toBe('#commands/scale');
  });
});

describe('command explorer hash routing', () => {
  test('a deep link lands on its command and hashchange follows', async () => {
    const container = await renderAt('#commands/rollback');
    expect(pane(container).querySelector('h3')?.textContent).toBe('rollback');

    await act(async () => {
      window.location.hash = '#commands/events';
      window.dispatchEvent(new window.Event('hashchange'));
    });

    expect(pane(container).querySelector('h3')?.textContent).toBe('events');
  });
});

describe('command explorer detail pane', () => {
  test('renders every captured flag of the selected command', async () => {
    const container = await renderAt('#commands/deploy');
    const detail = pane(container).textContent ?? '';
    const deploy = commands.find((command) => command.name === 'deploy')!;

    expect(detail).toContain(deploy.usage);
    expect(deploy.flags.length).toBeGreaterThan(0);
    for (const flag of deploy.flags) {
      expect(detail).toContain(flag.flag);
      expect(detail).toContain(flag.description);
    }
    expect(detail).toContain(deploy.example);
  });

  test('the list is a listbox with one selected option', async () => {
    const container = await renderAt('#commands/status');
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(container.querySelectorAll('[role="option"][aria-selected="true"]').length).toBe(1);
  });
});
