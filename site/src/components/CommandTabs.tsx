import { Fragment } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { CommandGroup } from '@/lib/commands';

export function CommandTabs({ groups }: { groups: CommandGroup[] }) {
  return (
    <Tabs defaultValue={groups[0]?.id} className="mt-10">
      <div className="overflow-x-auto">
        <TabsList className="w-full sm:w-fit">
          {groups.map((group) => (
            <TabsTrigger key={group.id} value={group.id} className="min-w-0 px-3 sm:px-5">
              {group.label}
              <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">{group.commands.length}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {groups.map((group) => (
        <TabsContent key={group.id} value={group.id} forceMount className="mt-5 data-[state=inactive]:hidden">
          <div className="rounded-xl border border-border bg-card">
            <div className="flex flex-col gap-1 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">{group.blurb}</p>
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{group.commands.length} commands</span>
            </div>
            <div className="px-5">
              {group.commands.map((command) => (
                <Fragment key={command.name}>
                  <div
                    data-command
                    className="grid gap-1 border-b border-border py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] sm:items-baseline sm:gap-6"
                  >
                    <code className="font-mono text-[11px] leading-relaxed text-foreground sm:text-[0.78rem]">{command.usage}</code>
                    <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{command.description}</p>
                  </div>
                  {'\n'}
                </Fragment>
              ))}
              {'\n'}
            </div>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}
