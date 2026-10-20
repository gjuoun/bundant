export type DemoCommand = {
  cmd: string;
  lines: string[];
  durationMs?: number;
};

export type DemoFixture = {
  prompt: string;
  commands: DemoCommand[];
};

export type TranscriptBlock = {
  id: number;
  command: string;
  lines: string[];
  streaming: boolean;
  kind: "command" | "hint";
};

/** Exact answer for a command the fixture does not contain. */
export const HINT = "demo only - try: validate, deploy, status, rollback";

/** The transcript is a window, not an unbounded log. */
export const MAX_TRANSCRIPT_LINES = 220;

/** First meaningful word of a typed line, with an optional leading "bundant". */
export function commandToken(input: string): string | undefined {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts[0]?.toLowerCase() === "bundant") parts.shift();
  return parts[0]?.toLowerCase();
}

/** Index of the command a visitor typed, or -1 when it is not in the fixture. */
export function findCommandIndex(commands: DemoCommand[], input: string): number {
  const token = commandToken(input);
  if (token === undefined) return -1;
  return commands.findIndex((command) => commandToken(command.cmd) === token);
}

/** Enter with an empty prompt runs the next command, wrapping at the end. */
export function nextCommandIndex(lastIndex: number, count: number): number {
  if (count <= 0) return -1;
  return lastIndex < 0 || lastIndex >= count - 1 ? 0 : lastIndex + 1;
}

/** Frames of visible lines: one per tick, or a single frame for reduced motion. */
export function streamFrames(lines: string[], reducedMotion: boolean): string[][] {
  if (reducedMotion) return [lines.slice()];
  return lines.map((_, index) => lines.slice(0, index + 1));
}

export function hintBlock(id: number): TranscriptBlock {
  return { id, command: "", lines: [HINT], streaming: false, kind: "hint" };
}

/** Keep the newest maxLines lines, dropping blocks that fall entirely out. */
export function trimTranscript(
  blocks: TranscriptBlock[],
  maxLines: number = MAX_TRANSCRIPT_LINES,
): TranscriptBlock[] {
  if (maxLines <= 0) return [];
  let budget = maxLines;
  const kept: TranscriptBlock[] = [];
  for (let index = blocks.length - 1; index >= 0 && budget > 0; index -= 1) {
    const block = blocks[index]!;
    if (block.lines.length <= budget) {
      kept.unshift(block);
      budget -= block.lines.length;
    } else {
      kept.unshift({ ...block, lines: block.lines.slice(-budget) });
      budget = 0;
    }
  }
  return kept;
}
