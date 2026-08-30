import { describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({ executeCommand: vi.fn() }));

vi.mock('vscode', () => {
  class Position {
    public constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  }

  class Range {
    public readonly start: Position;
    public readonly end: Position;

    public constructor(
      startOrLine: Position | number,
      startCharacterOrEnd: Position | number,
      endLine?: number,
      endCharacter?: number,
    ) {
      if (startOrLine instanceof Position && startCharacterOrEnd instanceof Position) {
        this.start = startOrLine;
        this.end = startCharacterOrEnd;
      } else {
        this.start = new Position(startOrLine as number, startCharacterOrEnd as number);
        this.end = new Position(endLine!, endCharacter!);
      }
    }

    public contains(other: Range): boolean {
      return compare(this.start, other.start) <= 0 && compare(this.end, other.end) >= 0;
    }
  }

  class Uri {
    private constructor(private readonly value: string) {}

    public static parse(value: string): Uri {
      return new Uri(value);
    }

    public toString(): string {
      return this.value;
    }
  }

  class MarkdownString {
    public isTrusted?: boolean | { readonly enabledCommands: readonly string[] };
    public constructor(public readonly value: string) {}
  }

  class Hover {
    public readonly contents: MarkdownString[];
    public constructor(
      contents: MarkdownString,
      public readonly range?: Range,
    ) {
      this.contents = [contents];
    }
  }

  const compare = (left: Position, right: Position): number =>
    left.line - right.line || left.character - right.character;

  return {
    Hover,
    MarkdownString,
    Position,
    Range,
    Uri,
    SymbolKind: { 11: 'Function', Function: 11 },
    commands: { executeCommand: vscodeState.executeCommand },
  };
});

import * as vscode from 'vscode';

import {
  CREATE_SYMBOL_NOTE_COMMAND,
  ReviewSymbolHoverProvider,
} from '../../../src/views/reviewSymbolHoverProvider';

describe('review symbol hover provider', () => {
  it('shows Add Note only while hovering a reported symbol declaration', async () => {
    const uri = vscode.Uri.parse('file:///workspace/example.ts');
    const functionRange = new vscode.Range(2, 0, 5, 1);
    const functionName = new vscode.Range(2, 9, 2, 16);
    vscodeState.executeCommand.mockResolvedValueOnce([
      {
        name: 'doThing',
        detail: '',
        kind: vscode.SymbolKind.Function,
        range: functionRange,
        selectionRange: functionName,
        children: [],
      },
    ]);
    const provider = new ReviewSymbolHoverProvider(() => true);

    const hover = await provider.provideHover(
      { uri } as vscode.TextDocument,
      new vscode.Position(2, 12),
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(hover?.range).toBe(functionName);
    const content = hover?.contents[0] as vscode.MarkdownString | undefined;
    expect(content?.value).toContain(`[Add Note](command:${CREATE_SYMBOL_NOTE_COMMAND}?`);
    expect(content?.isTrusted).toEqual({ enabledCommands: [CREATE_SYMBOL_NOTE_COMMAND] });
  });

  it('returns no action when the hover is outside every symbol declaration', async () => {
    vscodeState.executeCommand.mockResolvedValueOnce([
      {
        name: 'doThing',
        detail: '',
        kind: vscode.SymbolKind.Function,
        range: new vscode.Range(2, 0, 5, 1),
        selectionRange: new vscode.Range(2, 9, 2, 16),
        children: [],
      },
    ]);
    const provider = new ReviewSymbolHoverProvider(() => true);

    const hover = await provider.provideHover(
      { uri: vscode.Uri.parse('file:///workspace/example.ts') } as vscode.TextDocument,
      new vscode.Position(4, 2),
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(hover).toBeUndefined();
  });
});
