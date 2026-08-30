import * as vscode from 'vscode';

import type { ReviewNoteView } from '../services/reviewNoteView';

/** Shows navigation lenses for saved symbol notes independently of creation UI settings. */
export class ReviewSymbolNoteCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private notes: readonly ReviewNoteView[] = [];

  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  public setNotes(notes: readonly ReviewNoteView[]): void {
    this.notes = notes.filter(
      ({ anchorKind, anchorState }) => anchorKind === 'symbol' && anchorState === 'attached',
    );
    this.changeEmitter.fire();
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    if (token.isCancellationRequested) {
      return [];
    }
    const uri = document.uri.toString();
    return this.notes
      .filter((note) => note.uri.toString() === uri)
      .map(
        (note) =>
          new vscode.CodeLens(note.range, {
            command: 'codingNotesForAi.revealComment',
            title: `$(comment) View Note: ${note.category}`,
            tooltip: `${note.status} • ${firstLine(note.comment)}`,
            arguments: [note],
          }),
      );
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}

function firstLine(comment: string): string {
  return (
    comment
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? '(empty note)'
  );
}
