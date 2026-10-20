import { useEffect, useRef, useState } from 'react';
import './TerminalDemo.css';
import {
  findCommandIndex,
  hintBlock,
  nextCommandIndex,
  streamFrames,
  trimTranscript,
  type DemoFixture,
  type TranscriptBlock,
} from './terminal-machine';

const TYPING_MS = 28;
const LINE_MS = 70;
const CHIP_BLURBS: Record<string, string> = {
  validate: 'parse the contract, touch nothing',
  deploy: 'start, gate, swap, stop the old revision',
  status: 'what is live per revision',
  rollback: 'restore the previous revision',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Props = { demo: DemoFixture; layout?: 'side' | 'compact' };

export default function TerminalDemo({ demo, layout = 'side' }: Props) {
  const { commands, prompt } = demo;
  const [blocks, setBlocks] = useState<TranscriptBlock[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [lastIndex, setLastIndex] = useState(-1);
  const runId = useRef(0);
  const blockId = useRef(0);
  const reducedRef = useRef(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const nextIndex = nextCommandIndex(lastIndex, commands.length);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      reducedRef.current = query.matches;
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(
    () => () => {
      runId.current += 1;
    },
    [],
  );

  useEffect(() => {
    const screen = screenRef.current;
    if (screen !== null) screen.scrollTop = screen.scrollHeight;
  }, [blocks, input]);

  async function run(index: number) {
    const command = commands[index];
    if (command === undefined) return;
    const id = ++runId.current;
    const reduced = reducedRef.current;
    setRunning(true);
    setLastIndex(index);
    setInput('');
    setBlocks((current) =>
      current.map((block) => (block.streaming ? { ...block, streaming: false } : block)),
    );

    if (!reduced) {
      for (let length = 1; length <= command.cmd.length; length += 1) {
        if (runId.current !== id) return;
        setInput(command.cmd.slice(0, length));
        await sleep(TYPING_MS);
      }
      await sleep(120);
    }
    if (runId.current !== id) return;

    setInput('');
    const transcriptId = ++blockId.current;
    setBlocks((current) =>
      trimTranscript([
        ...current,
        { id: transcriptId, command: command.cmd, lines: [], streaming: true, kind: 'command' },
      ]),
    );

    const frames = streamFrames(command.lines, reduced);
    for (const frame of frames) {
      if (!reduced) await sleep(LINE_MS);
      if (runId.current !== id) return;
      setBlocks((current) =>
        trimTranscript(
          current.map((block) =>
            block.id === transcriptId ? { ...block, lines: frame, streaming: frame.length < command.lines.length } : block,
          ),
        ),
      );
    }

    if (runId.current !== id) return;
    setBlocks((current) =>
      current.map((block) => (block.id === transcriptId ? { ...block, streaming: false } : block)),
    );
    setRunning(false);
  }

  function runTyped(value: string) {
    const index = findCommandIndex(commands, value);
    if (index >= 0) {
      void run(index);
      return;
    }
    setInput('');
    setBlocks((current) => trimTranscript([...current, hintBlock(++blockId.current)]));
  }

  function onSubmit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (running) return;
    const typed = input.trim();
    if (typed === '') {
      void run(nextIndex);
      return;
    }
    runTyped(typed);
  }

  return (
    <div
      className={
        layout === 'compact'
          ? 'grid min-w-0 gap-4'
          : 'grid min-w-0 gap-6 md:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] md:items-start'
      }
    >
      <div
        className="min-w-0 overflow-hidden rounded-xl border border-border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        tabIndex={0}
        role="region"
        aria-label="terminal demo"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-muted bg-code-surface px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="size-2.5 rounded-full bg-destructive" aria-hidden="true" />
            <span className="size-2.5 rounded-full bg-warning" aria-hidden="true" />
            <span className="size-2.5 rounded-full bg-success" aria-hidden="true" />
            <span className="ml-2 font-mono text-[11px] text-muted-foreground">bundant · demo</span>
          </div>
          <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            recorded run
          </span>
        </div>

        <div
          ref={screenRef}
          className={
            'terminal-demo-screen bg-code-surface px-4 py-4 font-mono text-[11.5px] leading-6' +
            (layout === 'compact' ? ' terminal-demo-screen--compact' : '')
          }
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={running}
        >
          {blocks.length === 0 ? (
            <p className="text-muted-foreground">
              type a command, or press Enter to run <span className="text-foreground">{commands[0]?.cmd}</span>
            </p>
          ) : null}

          {blocks.map((block) => (
            <div key={block.id} className={block.kind === 'hint' ? 'text-warning' : 'mt-3 first:mt-0'}>
              {block.kind === 'command' ? (
                <div className="break-words text-foreground">
                  <span className="text-primary">{prompt}</span>{' '}
                  <span>{block.command}</span>
                  {block.streaming && block.lines.length === 0 ? (
                    <span className="terminal-demo-cursor ml-1 align-middle" aria-hidden="true" />
                  ) : null}
                </div>
              ) : null}
              {block.lines.map((line, index) => (
                <div key={block.id + ':' + index} className="whitespace-pre-wrap break-words text-muted-foreground">
                  {line}
                </div>
              ))}
            </div>
          ))}
        </div>

        <form
          onSubmit={onSubmit}
          className="flex flex-wrap items-center gap-2 border-t border-border-muted bg-card px-4 py-3"
        >
          <label htmlFor="terminal-demo-input" className="sr-only">
            Terminal command
          </label>
          <span className="font-mono text-[11.5px] text-primary" aria-hidden="true">
            {prompt}
          </span>
          <input
            id="terminal-demo-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            readOnly={running}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby="terminal-demo-help"
            placeholder={
              running
                ? 'running…'
                : 'next: ' + (commands[nextIndex]?.cmd.replace(/^bundant\s+/, '') ?? 'a command')
            }
            className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="terminal-demo-cursor" aria-hidden="true" />
          <button
            type="button"
            onClick={() => void run(nextIndex)}
            disabled={running}
            aria-label={'Run next command: ' + (commands[nextIndex]?.cmd ?? '')}
            className="rounded-md border border-border bg-muted px-2.5 py-1 font-mono text-[10.5px] text-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Run next
          </button>
        </form>
        <p id="terminal-demo-help" className="sr-only">
          Type validate, deploy, status or rollback. Press Enter with an empty prompt to run the next
          command.
        </p>
      </div>

      <div className="min-w-0">
        <p className="mono-label">Commands in this transcript</p>
        <div className={layout === 'compact' ? 'mt-2 grid grid-cols-2 gap-2' : 'mt-3 grid gap-2'}>
          {commands.map((command, index) => {
            const name = command.cmd.replace(/^bundant\s+/, '');
            const active = index === lastIndex && running;
            return (
              <button
                key={command.cmd}
                type="button"
                onClick={() => void run(index)}
                data-command={name}
                aria-current={active ? 'true' : undefined}
                className={
                  'group flex min-w-0 items-start justify-between gap-3 rounded-lg border px-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
                  (layout === 'compact' ? 'py-2 ' : 'py-3 ') +
                  (active
                    ? 'border-primary bg-muted'
                    : 'border-border bg-card hover:border-primary hover:bg-muted')
                }
              >
                <span className="min-w-0">
                  <span className="block font-mono text-[11.5px] text-primary">{command.cmd}</span>
                  {layout === 'side' ? (
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                      {CHIP_BLURBS[name] ?? 'replay this command'}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {typeof command.durationMs === 'number' ? (command.durationMs / 1000).toFixed(1) + 's' : ''}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Recorded on a real docker host, then redacted; nothing runs in your browser.
        </p>
      </div>
    </div>
  );
}
