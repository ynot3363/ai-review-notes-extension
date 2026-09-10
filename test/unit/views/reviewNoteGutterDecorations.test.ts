import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  createDecoration: vi.fn(),
  onVisibleEditors: vi.fn(),
  disposeDecoration: vi.fn(),
  disposeSubscription: vi.fn(),
  onConfiguration: vi.fn(),
  getConfiguration: vi.fn(),
  disposeConfiguration: vi.fn(),
}));

vi.mock('vscode', () => ({
  Uri: {
    parse: (value: string) => ({ toString: () => value }),
    joinPath: (base: { toString(): string }, ...parts: string[]) =>
      `${base.toString()}/${parts.join('/')}`,
  },
  Range: class {
    public readonly start: { line: number; character: number };
    public constructor(line: number, character: number) {
      this.start = { line, character };
    }
  },
  DecorationRangeBehavior: { ClosedClosed: 1 },
  window: {
    visibleTextEditors: [],
    createTextEditorDecorationType: state.createDecoration,
    onDidChangeVisibleTextEditors: state.onVisibleEditors,
  },
  workspace: {
    getConfiguration: state.getConfiguration,
    onDidChangeConfiguration: state.onConfiguration,
  },
}));

import * as vscode from 'vscode';

import type { ReviewNoteView } from '../../../src/services/reviewNoteView';
import { ReviewNoteGutterDecorations } from '../../../src/views/reviewNoteGutterDecorations';

function editor(path: string): vscode.TextEditor {
  return {
    document: { uri: vscode.Uri.parse(path), lineCount: 20 },
    setDecorations: vi.fn(),
  } as unknown as vscode.TextEditor;
}

function note(path: string, line: number, anchorState = 'attached'): ReviewNoteView {
  return {
    uri: vscode.Uri.parse(path),
    range: new vscode.Range(line, 0, line + 2, 0),
    anchorState,
  } as ReviewNoteView;
}

describe('saved note gutter decorations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.createDecoration.mockReturnValue({ dispose: state.disposeDecoration });
    state.onVisibleEditors.mockReturnValue({ dispose: state.disposeSubscription });
    state.onConfiguration.mockReturnValue({ dispose: state.disposeConfiguration });
    state.getConfiguration.mockImplementation(() => ({
      get: (_key: string, fallback: boolean) => fallback,
    }));
    Object.assign(vscode.window, { visibleTextEditors: [] });
  });

  it('updates split editors and removes stale markers after moving or deleting notes', () => {
    const left = editor('file:///workspace/example.ts');
    const right = editor('file:///workspace/example.ts');
    const other = editor('file:///workspace/other.ts');
    Object.assign(vscode.window, { visibleTextEditors: [left, right, other] });
    const decorations = new ReviewNoteGutterDecorations(vscode.Uri.parse('file:///extension'));

    decorations.setNotes([
      note(left.document.uri.toString(), 2),
      note(left.document.uri.toString(), 2),
      note(left.document.uri.toString(), 4, 'orphaned'),
      note(left.document.uri.toString(), 6, 'ambiguous'),
      note(left.document.uri.toString(), 30),
    ]);

    for (const target of [left, right]) {
      expect(target.setDecorations).toHaveBeenLastCalledWith(expect.anything(), [
        expect.objectContaining({ start: { line: 2, character: 0 } }),
      ]);
    }
    expect(other.setDecorations).toHaveBeenLastCalledWith(expect.anything(), []);

    decorations.setNotes([note(other.document.uri.toString(), 8)]);
    expect(left.setDecorations).toHaveBeenLastCalledWith(expect.anything(), []);
    expect(right.setDecorations).toHaveBeenLastCalledWith(expect.anything(), []);
    expect(other.setDecorations).toHaveBeenLastCalledWith(expect.anything(), [
      expect.objectContaining({ start: { line: 8, character: 0 } }),
    ]);

    decorations.setNotes([]);
    expect(other.setDecorations).toHaveBeenLastCalledWith(expect.anything(), []);
    decorations.dispose();
  });

  it('decorates newly visible files, supplies theme variants, and disposes its resources', () => {
    const decorations = new ReviewNoteGutterDecorations(vscode.Uri.parse('file:///extension'));
    const target = editor('file:///workspace/README.md');
    decorations.setNotes([note(target.document.uri.toString(), 0)]);
    const onVisibleEditors = state.onVisibleEditors.mock.calls[0]![0] as (
      editors: readonly vscode.TextEditor[],
    ) => void;
    onVisibleEditors([target]);

    expect(target.setDecorations).toHaveBeenLastCalledWith(expect.anything(), [
      expect.objectContaining({ start: { line: 0, character: 0 } }),
    ]);
    expect(state.createDecoration).toHaveBeenCalledWith(
      expect.objectContaining({
        gutterIconPath: 'file:///extension/assets/notes-dark.svg',
        gutterIconSize: 'contain; transform: translate(5px, -2px)',
        light: {
          gutterIconPath: 'file:///extension/assets/notes-dark.svg',
          gutterIconSize: 'contain; transform: translate(5px, -2px)',
        },
        dark: {
          gutterIconPath: 'file:///extension/assets/notes-light.svg',
          gutterIconSize: 'contain; transform: translate(5px, -2px)',
        },
      }),
    );
    decorations.dispose();
    expect(state.disposeDecoration).toHaveBeenCalledOnce();
    expect(state.disposeSubscription).toHaveBeenCalledOnce();
    expect(state.disposeConfiguration).toHaveBeenCalledOnce();
  });

  it('hides icons immediately and restores the latest notes when re-enabled', () => {
    const target = editor('file:///workspace/example.ts');
    Object.assign(vscode.window, { visibleTextEditors: [target] });
    let enabled = true;
    state.getConfiguration.mockImplementation(() => ({ get: () => enabled }));
    const decorations = new ReviewNoteGutterDecorations(vscode.Uri.parse('file:///extension'));
    const changed = state.onConfiguration.mock.calls[0]![0] as (
      event: Pick<vscode.ConfigurationChangeEvent, 'affectsConfiguration'>,
    ) => void;
    const event = {
      affectsConfiguration: (key: string) => key === 'codingNotesForAi.showGutterIcons',
    };
    decorations.setNotes([note(target.document.uri.toString(), 2)]);

    enabled = false;
    changed(event);
    expect(target.setDecorations).toHaveBeenLastCalledWith(expect.anything(), []);
    decorations.setNotes([note(target.document.uri.toString(), 8)]);
    expect(target.setDecorations).toHaveBeenLastCalledWith(expect.anything(), []);

    enabled = true;
    changed(event);
    expect(target.setDecorations).toHaveBeenLastCalledWith(expect.anything(), [
      expect.objectContaining({ start: { line: 8, character: 0 } }),
    ]);
    decorations.dispose();
  });

  it('honors folder-specific settings and hides icons in newly visible editors', () => {
    const visible = editor('file:///enabled/example.ts');
    const hidden = editor('file:///disabled/example.ts');
    Object.assign(vscode.window, { visibleTextEditors: [visible] });
    state.getConfiguration.mockImplementation((_section: string, uri: vscode.Uri) => ({
      get: () => !uri.toString().includes('/disabled/'),
    }));
    const decorations = new ReviewNoteGutterDecorations(vscode.Uri.parse('file:///extension'));
    decorations.setNotes([
      note(visible.document.uri.toString(), 1),
      note(hidden.document.uri.toString(), 1),
    ]);
    const onVisibleEditors = state.onVisibleEditors.mock.calls[0]![0] as (
      editors: readonly vscode.TextEditor[],
    ) => void;
    onVisibleEditors([visible, hidden]);
    expect(visible.setDecorations).toHaveBeenLastCalledWith(expect.anything(), [
      expect.objectContaining({ start: { line: 1, character: 0 } }),
    ]);
    expect(hidden.setDecorations).toHaveBeenLastCalledWith(expect.anything(), []);
    decorations.dispose();
  });
});
