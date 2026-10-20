import { useState } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';

type Command = { label: string; command: string };

export function CopyCommand({ commands }: { commands: Command[] }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const current = commands[active] ?? commands[0];

  async function copy() {
    try {
      await navigator.clipboard.writeText(current.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-code-border bg-code-surface px-2 py-0.5 sm:px-3">
        <div className="flex items-center gap-0.5">
          <Terminal className="mr-1.5 size-3.5 text-muted-foreground" aria-hidden />
          {commands.map((item, index) => (
            <button
              key={item.label}
              type="button"
              onClick={() => setActive(index)}
              className={cn(
                'min-h-11 rounded-md px-3 font-mono text-[11px] uppercase tracking-wider transition-colors',
                index === active
                  ? 'bg-card text-foreground shadow-none ring-1 ring-border'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy install command"
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="flex items-center gap-2.5 px-4 py-3">
        <span className="select-none font-mono text-sm text-primary">$</span>
        <code className="overflow-x-auto whitespace-nowrap font-mono text-[0.8125rem] text-foreground">
          {current.command}
        </code>
      </div>
    </div>
  );
}
