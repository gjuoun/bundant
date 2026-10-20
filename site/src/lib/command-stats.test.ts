import { expect, test } from 'bun:test';
import fixture from '../data/commands.json';
import { commandStats } from './command-stats';

// One line: the copy counts distinct flags, not the per-command repetitions.
test('the explorer copy reports unique flags, not the sum of every command page', () => {
  const rows = fixture.reduce((total, command) => total + command.flags.length, 0);
  const unique = new Set(fixture.flatMap((command) => command.flags.map((flag) => flag.flag))).size;
  expect(commandStats(fixture)).toEqual({ commands: fixture.length, flags: unique });
  expect(commandStats(fixture).flags).toBeLessThan(rows);
});
