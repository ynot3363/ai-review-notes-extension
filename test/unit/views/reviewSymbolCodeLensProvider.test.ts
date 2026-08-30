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
      startLine: number,
      startCharacter: number,
      endLine: number,
      endCharacter: number,
    ) {
      this.start = new Position(startLine, startCharacter);
      this.end = new Position(endLine, endCharacter);
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

  class CodeLens {
    public constructor(
      public readonly range: Range,
      public readonly command?: unknown,
    ) {}
  }

  class EventEmitter<T> {
    public readonly event = vi.fn();
    public readonly fire = vi.fn((_value?: T) => undefined);
    public readonly dispose = vi.fn();
  }

  const compare = (left: Position, right: Position): number =>
    left.line - right.line || left.character - right.character;

  return {
    CodeLens,
    EventEmitter,
    Position,
    Range,
    Uri,
    SymbolKind: { 11: 'Function', Function: 11 },
    commands: { executeCommand: vscodeState.executeCommand },
  };
});

import * as vscode from 'vscode';

import { ReviewSymbolCodeLensProvider } from '../../../src/views/reviewSymbolCodeLensProvider';
import { CREATE_SYMBOL_NOTE_COMMAND } from '../../../src/views/reviewSymbolHoverProvider';
import { ReviewSymbolNoteCodeLensProvider } from '../../../src/views/reviewSymbolNoteCodeLensProvider';

describe('review symbol CodeLens provider', () => {
  it('shows an Add Note action for every reported symbol when enabled', async () => {
    const uri = vscode.Uri.parse('file:///workspace/example.ts');
    const functionName = new vscode.Range(2, 9, 2, 16);
    vscodeState.executeCommand.mockResolvedValueOnce([
      {
        name: 'doThing',
        detail: '',
        kind: vscode.SymbolKind.Function,
        range: new vscode.Range(2, 0, 5, 1),
        selectionRange: functionName,
        children: [],
      },
    ]);
    const provider = new ReviewSymbolCodeLensProvider(() => true);

    const lenses = await provider.provideCodeLenses(
      { uri } as vscode.TextDocument,
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(lenses).toHaveLength(1);
    expect(lenses[0]?.range).toBe(functionName);
    expect(lenses[0]?.command).toMatchObject({
      command: CREATE_SYMBOL_NOTE_COMMAND,
      title: '$(comment-add) Add Note',
    });
  });

  it('shows View Note for a saved symbol note independently of add-note eligibility', () => {
    const uri = vscode.Uri.parse('file:///workspace/example.ts');
    const range = new vscode.Range(2, 9, 2, 16);
    const provider = new ReviewSymbolNoteCodeLensProvider();
    const note = {
      id: '64f8d415-c742-4a4d-9140-73fda994f3e8',
      uri,
      range,
      anchorKind: 'symbol',
      anchorState: 'attached',
      category: 'Testing',
      status: 'open',
      comment: 'Cover the failure path.',
    } as never;
    provider.setNotes([note]);

    const lenses = provider.provideCodeLenses(
      { uri } as vscode.TextDocument,
      { isCancellationRequested: false } as vscode.CancellationToken,
    );

    expect(lenses).toHaveLength(1);
    expect(lenses[0]?.range).toBe(range);
    expect(lenses[0]?.command).toMatchObject({
      command: 'codingNotesForAi.revealComment',
      title: '$(comment) View Note: Testing',
      arguments: [note],
    });
  });
});
