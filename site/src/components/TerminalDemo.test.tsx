import { describe, expect, test } from 'bun:test';
import fixture from '../data/demo.json';
import {
  HINT,
  findCommandIndex,
  hintBlock,
  nextCommandIndex,
  streamFrames,
  trimTranscript,
  type DemoCommand,
  type TranscriptBlock,
} from './terminal-machine';

const commands = fixture.commands as DemoCommand[];

describe('terminal demo state machine', () => {
  test('known command streams its captured lines', () => {
    expect(findCommandIndex(commands, 'deploy')).toBe(1);
    expect(findCommandIndex(commands, 'bundant validate')).toBe(0);
    const lines = commands[1]!.lines;
    const frames = streamFrames(lines, false);
    expect(frames.length).toBe(lines.length);
    expect(frames[0]).toEqual(lines.slice(0, 1));
    expect(frames.at(-1)).toEqual(lines);
  });

  test('unknown command prints the demo-only hint', () => {
    expect(findCommandIndex(commands, 'kubectl get pods')).toBe(-1);
    expect(findCommandIndex(commands, '')).toBe(-1);
    expect(hintBlock(7).lines).toEqual([HINT]);
    expect(HINT).toBe('demo only - try: validate, deploy, status, rollback');
  });

  test('Enter advances to the next command', () => {
    expect(nextCommandIndex(-1, commands.length)).toBe(0);
    expect(nextCommandIndex(0, commands.length)).toBe(1);
    expect(nextCommandIndex(2, commands.length)).toBe(3);
    expect(nextCommandIndex(3, commands.length)).toBe(0);
  });

  test('reduced motion prints every line in one frame', () => {
    const lines = commands[1]!.lines;
    const frames = streamFrames(lines, true);
    expect(frames.length).toBe(1);
    expect(frames[0]).toEqual(lines);
  });

  test('the transcript keeps the last N lines', () => {
    const blocks: TranscriptBlock[] = ['a', 'b', 'c'].map((name, index) => ({
      id: index,
      command: 'bundant ' + name,
      lines: [name + '1', name + '2', name + '3', name + '4'],
      streaming: false,
      kind: 'command',
    }));
    const kept = trimTranscript(blocks, 6);
    expect(kept.flatMap((block) => block.lines)).toEqual(['b3', 'b4', 'c1', 'c2', 'c3', 'c4']);
    expect(kept[0]!.command).toBe('bundant b');
  });
});
