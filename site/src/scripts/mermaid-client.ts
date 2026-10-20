/**
 * Client-side renderer for fenced mermaid blocks.
 *
 * rehype-mermaid (strategy: 'pre-mermaid') leaves the source as
 * <pre class="mermaid"> at build time, so the page is readable with JavaScript
 * off. This module is loaded only on docs pages; it imports Mermaid lazily,
 * renders each block with the Bigface palette, and keeps the source available
 * behind a details element.
 */
import type { MermaidConfig } from 'mermaid';

const PALETTE: MermaidConfig['themeVariables'] = {
  background: '#252925',
  primaryColor: '#2e332e',
  primaryTextColor: '#d9d9d4',
  primaryBorderColor: '#494848',
  secondaryColor: '#252925',
  tertiaryColor: '#1f231f',
  mainBkg: '#2e332e',
  nodeBorder: '#494848',
  nodeTextColor: '#d9d9d4',
  textColor: '#d9d9d4',
  lineColor: '#40c4ff',
  defaultLinkColor: '#40c4ff',
  edgeLabelBackground: '#252925',
  clusterBkg: '#252925',
  clusterBorder: '#494848',
  titleColor: '#d9d9d4',
  actorBkg: '#2e332e',
  actorBorder: '#494848',
  actorTextColor: '#d9d9d4',
  actorLineColor: '#494848',
  signalColor: '#d9d9d4',
  signalTextColor: '#d9d9d4',
  labelBoxBkgColor: '#2e332e',
  labelBoxBorderColor: '#494848',
  labelTextColor: '#d9d9d4',
  loopTextColor: '#d9d9d4',
  noteBkgColor: '#252925',
  noteBorderColor: '#494848',
  noteTextColor: '#d9d9d4',
  activationBkgColor: '#2e332e',
  activationBorderColor: '#40c4ff',
  sequenceNumberColor: '#1f231f',
  cScale0: '#2e332e',
  cScale1: '#252925',
  cScale2: '#1f231f',
  cScale3: '#333333',
  // Only palette values below: borderMuted, cursorLine, braceMatch, selection, lightBlue, paleBlue.
  cScale4: '#333333',
  cScale5: '#3b3c32',
  cScale6: '#3b514d',
  cScale7: '#646464',
  cScale8: '#40c4ff',
  cScale9: '#b3e5fc',
  cScale10: '#66d9ef',
  cScale11: '#e5e500',
  fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
  fontSize: '15px',
};

function sourceOf(node: HTMLElement): string {
  return (node.textContent ?? '').trim();
}

async function renderAll(): Promise<void> {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('pre.mermaid'));
  if (nodes.length === 0) return;

  try {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: PALETTE,
      flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: true },
      mindmap: { useMaxWidth: true },
      timeline: { useMaxWidth: true },
      sequence: { useMaxWidth: true },
    });

    for (const [index, node] of nodes.entries()) {
      const source = sourceOf(node);
      if (!source) continue;
      try {
        const { svg } = await mermaid.render('bundant-mermaid-' + index, source);
        const figure = document.createElement('figure');
        figure.className = 'mermaid-figure';
        figure.setAttribute('role', 'group');
        figure.setAttribute('aria-label', 'Diagram');

        const canvas = document.createElement('div');
        canvas.className = 'mermaid-diagram';
        canvas.innerHTML = svg;

        const details = document.createElement('details');
        details.className = 'mermaid-source';
        const summary = document.createElement('summary');
        summary.textContent = 'Diagram source';
        const pre = document.createElement('pre');
        pre.textContent = source;
        details.append(summary, pre);

        figure.append(canvas, details);
        node.replaceWith(figure);
      } catch (error) {
        node.classList.add('mermaid-error');
        node.hidden = false;
        console.error('mermaid: could not render diagram', error);
      }
    }
    document.documentElement.classList.add('mermaid-done');
  } catch (error) {
    document.documentElement.classList.add('mermaid-failed');
    console.error('mermaid: renderer failed to load', error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderAll, { once: true });
} else {
  void renderAll();
}
