import * as vscode from 'vscode';

import type { ReviewNoteView } from '../services/reviewNoteView';

// VS Code emits this value into the gutter's background-size CSS declaration.
// Its public API has no position offset, so append a transform to the same rule.
// This relies on VS Code's CSS generation and must be rechecked if it changes.
const GUTTER_ICON_SIZE = 'contain; transform: translate(5px, -2px)';

/** Marks saved, attached notes independently of the controls for creating notes. */
export class ReviewNoteGutterDecorations implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly visibleEditorsSubscription: vscode.Disposable;
  private readonly configurationSubscription: vscode.Disposable;
  private readonly rangesByUri = new Map<string, vscode.Range[]>();

  public constructor(extensionUri: vscode.Uri) {
    const lightIcon = vscode.Uri.joinPath(extensionUri, 'assets', 'notes-light.svg');
    const darkIcon = vscode.Uri.joinPath(extensionUri, 'assets', 'notes-dark.svg');
    this.decoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: darkIcon,
      gutterIconSize: GUTTER_ICON_SIZE,
      // Each theme's image generates a CSS background shorthand, which resets
      // background-size. Repeat the size to preserve scaling in both themes.
      light: { gutterIconPath: darkIcon, gutterIconSize: GUTTER_ICON_SIZE },
      dark: { gutterIconPath: lightIcon, gutterIconSize: GUTTER_ICON_SIZE },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.visibleEditorsSubscription = vscode.window.onDidChangeVisibleTextEditors((editors) => {
      this.updateEditors(editors);
    });
    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codingNotesForAi.showGutterIcons')) {
        this.updateEditors(vscode.window.visibleTextEditors);
      }
    });
  }

  public setNotes(notes: readonly ReviewNoteView[]): void {
    this.rangesByUri.clear();
    for (const note of notes) {
      if (note.anchorState !== 'attached') {
        continue;
      }
      const uri = note.uri.toString();
      const ranges = this.rangesByUri.get(uri) ?? [];
      const line = note.range.start.line;
      if (!ranges.some((range) => range.start.line === line)) {
        ranges.push(new vscode.Range(line, 0, line, 0));
      }
      this.rangesByUri.set(uri, ranges);
    }
    this.updateEditors(vscode.window.visibleTextEditors);
  }

  public dispose(): void {
    this.visibleEditorsSubscription.dispose();
    this.configurationSubscription.dispose();
    this.decoration.dispose();
    this.rangesByUri.clear();
  }

  private updateEditors(editors: readonly vscode.TextEditor[]): void {
    for (const editor of editors) {
      const enabled = vscode.workspace
        .getConfiguration('codingNotesForAi', editor.document.uri)
        .get<boolean>('showGutterIcons', true);
      const ranges = enabled ? (this.rangesByUri.get(editor.document.uri.toString()) ?? []) : [];
      editor.setDecorations(
        this.decoration,
        ranges.filter((range) => range.start.line < editor.document.lineCount),
      );
    }
  }
}
