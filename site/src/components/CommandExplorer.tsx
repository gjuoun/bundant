import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Check, Copy, Search, Terminal, X } from 'lucide-react';

export type ExplorerCommand = {
  name: string;
  group: string;
  summary: string;
  usage: string;
  flags: { flag: string; description: string }[];
  example: string;
};

type GroupId = 'deploy' | 'units' | 'groups' | 'ops';

const GROUP_META: Record<GroupId, { label: string; blurb: string }> = {
  deploy: { label: 'Deploy', blurb: 'Ship, move traffic, roll back' },
  units: { label: 'Units', blurb: 'One service, accessory or glob' },
  groups: { label: 'Groups', blurb: 'Namespaces and host prerequisites' },
  ops: { label: 'Ops', blurb: 'Read-only, over the same ssh' },
};

const GROUP_ORDER: GroupId[] = ['deploy', 'units', 'groups', 'ops'];

/** Substring match on the command name and its summary, case-insensitive. */
export function filterCommands(commands: ExplorerCommand[], query: string): ExplorerCommand[] {
  const q = query.trim().toLowerCase();
  if (q === '') return commands;
  return commands.filter((command) =>
    `${command.name} ${command.summary} ${command.group}`.toLowerCase().includes(q),
  );
}

/** `#commands/deploy` -> `deploy`; any other hash -> null. */
export function commandFromHash(hash: string): string | null {
  const match = /^#commands\/([a-z0-9-]+)$/i.exec(hash);
  return match ? match[1]!.toLowerCase() : null;
}

type Props = {
  commands: ExplorerCommand[];
};

export function CommandExplorer({ commands }: Props) {
  const searchId = useId();
  const listboxId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [selectedName, setSelectedName] = useState<string>(commands[0]?.name ?? '');
  const [activeIndex, setActiveIndex] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const selected = commands.find((command) => command.name === selectedName) ?? commands[0];
  const active = filtered[Math.min(activeIndex, Math.max(filtered.length - 1, 0))];

  const grouped = useMemo(() => {
    return GROUP_ORDER.map((group) => ({
      group,
      ...GROUP_META[group],
      commands: filtered.filter((command) => command.group === group),
    })).filter((entry) => entry.commands.length > 0);
  }, [filtered]);

  // The URL hash is the deep link: #commands/<name> selects that command, and
  // back/forward or a pasted link keeps working.
  useEffect(() => {
    const applyHash = () => {
      const name = commandFromHash(window.location.hash);
      if (name && commands.some((command) => command.name === name)) {
        setSelectedName(name);
        setMobileOpen(false);
      }
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [commands]);

  // A new query starts the cursor at the first match again.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keep the keyboard cursor inside the scrolled list.
  useEffect(() => {
    if (!active) return;
    const option = document.getElementById(`command-option-${active.name}`);
    if (typeof option?.scrollIntoView === 'function') {
      option.scrollIntoView({ block: 'nearest' });
    }
  }, [active]);

  useEffect(() => {
    setCopied(false);
  }, [selected?.name]);

  function select(name: string) {
    setSelectedName(name);
    setMobileOpen(false);
    const hash = `#commands/${name}`;
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', hash);
    }
  }

  function move(delta: number) {
    if (filtered.length === 0) return;
    const next = Math.min(Math.max(activeIndex + delta, 0), filtered.length - 1);
    setActiveIndex(next);
    setMobileOpen(true);
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      listRef.current?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
      listRef.current?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const pick = active ?? filtered[0];
      if (pick) select(pick.name);
    } else if (event.key === 'Escape') {
      setQuery('');
      setMobileOpen(false);
    }
  }

  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(filtered.length - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active) select(active.name);
    } else if (event.key === 'Escape') {
      setMobileOpen(false);
    }
  }

  async function copyExample() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.example);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard permission denied: the example stays selectable by hand.
    }
  }

  if (!selected) return null;

  return (
    <div className="command-explorer">
      <div className="command-explorer-list">
        <label htmlFor={searchId} className="command-explorer-label">
          Search commands
        </label>
        <div className="command-explorer-search">
          <Search className="command-explorer-search-icon" aria-hidden="true" />
          <input
            id={searchId}
            type="search"
            role="combobox"
            aria-expanded={mobileOpen}
            aria-controls={listboxId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder="deploy, rollback, logs…"
            value={query}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setMobileOpen(true);
            }}
            onFocus={() => setMobileOpen(true)}
            onKeyDown={onSearchKeyDown}
          />
          {query !== '' && (
            <button
              type="button"
              className="command-explorer-clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery('');
                setMobileOpen(false);
              }}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>

        <p className="command-explorer-count" aria-live="polite">
          {filtered.length} of {commands.length} commands
        </p>

        <div
          id={listboxId}
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Commands"
          aria-activedescendant={active ? `command-option-${active.name}` : undefined}
          className="command-explorer-scroll"
          data-open={mobileOpen ? 'true' : 'false'}
          onKeyDown={onListKeyDown}
        >
          {grouped.length === 0 && (
            <p className="command-explorer-empty">
              No command matches <span className="command-explorer-empty-query">“{query.trim()}”</span>.
            </p>
          )}
          {grouped.map((group) => (
            <div key={group.group} className="command-explorer-group" role="group" aria-label={group.label}>
              <p className="command-explorer-group-head">
                {group.label}
                <span>{group.commands.length}</span>
              </p>
              {group.commands.map((command) => {
                const isSelected = command.name === selected.name;
                return (
                  <div
                    key={command.name}
                    id={`command-option-${command.name}`}
                    role="option"
                    aria-selected={isSelected}
                    data-selected={isSelected ? 'true' : 'false'}
                    className="command-explorer-option"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => select(command.name)}
                  >
                    <span className="command-explorer-option-name">{command.name}</span>
                    <span className="command-explorer-option-summary">{command.summary}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div
        className="command-explorer-detail"
        role="region"
        aria-live="polite"
        aria-label={`${selected.name} command reference`}
      >
        <div className="command-explorer-detail-head">
          <div>
            <div className="command-explorer-badges">
              <span className="command-explorer-badge">{GROUP_META[selected.group as GroupId]?.label ?? selected.group}</span>
              <span className="command-explorer-badge command-explorer-badge-muted">bundant {selected.name}</span>
            </div>
            <h3 className="command-explorer-title">{selected.name}</h3>
          </div>
          <Terminal className="command-explorer-title-icon" aria-hidden="true" />
        </div>

        <p className="command-explorer-summary">{selected.summary}</p>

        <div className="command-explorer-block">
          <p className="command-explorer-block-title">Usage</p>
          <pre className="command-explorer-usage">
            <code>{selected.usage}</code>
          </pre>
        </div>

        <div className="command-explorer-block">
          <p className="command-explorer-block-title">
            Flags <span>{selected.flags.length}</span>
          </p>
          <dl className="command-explorer-flags">
            {selected.flags.map((flag) => (
              <div key={flag.flag} className="command-explorer-flag">
                <dt>{flag.flag}</dt>
                <dd>{flag.description}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="command-explorer-block">
          <div className="command-explorer-example-head">
            <p className="command-explorer-block-title">Example</p>
            <button type="button" className="command-explorer-copy" onClick={copyExample}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="command-explorer-example">
            <code>
              <span className="command-explorer-prompt">$</span> {selected.example}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
}
