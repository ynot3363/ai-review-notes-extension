# Coding Notes for AI

Coding Notes for AI lets you attach structured, shareable notes to code without modifying source files. Use VS Code's native commenting UI, browse notes in the Explorer, and hand focused tasks or a complete resolution report to an AI coding agent.

Notes can target one line, an exact multi-line selection, or—when the active language service exposes it—a function, class, method, or variable declaration. The default shared store is `CODING_NOTES_FOR_AI.json` in each workspace root, so humans, scripts, source control, and AI coding agents can discover the same findings.

The extension does not call an AI API, require an API key, submit code automatically, or collect telemetry. Prompts and reports are copied only when you explicitly request them.

## Highlights

- **Annotate lines, ranges, and symbols** using native VS Code comments, the editor gutter, symbol hover actions, or optional CodeLens controls.
- **Keep source files clean** by storing notes in a workspace sidecar or private VS Code storage.
- **Share durable context** with stable IDs, categories, statuses, source anchors, and drift recovery.
- **Hand work to an AI agent** by copying one focused prompt or a complete resolution report.
- **Track work through completion** with edit, move, reattach, resolve, reopen, and delete actions.
- **Stay in control** with local processing, no telemetry, and no automatic AI submission.

## Getting started

After installing Coding Notes for AI:

1. Open a folder in VS Code.
2. Hover beside a line number and select the comment `+`, or select code and run **Coding Notes for AI: Add Note**.
3. Enter the note, choose a category if needed, and save it.
4. Open **Coding Notes for AI** in the Explorer to browse and manage workspace notes.
5. Run **Coding Notes for AI: Generate & Copy AI Resolution Report** when you are ready to paste the workspace task list into an AI coding agent.

Requires VS Code 1.74 or newer.

## Add and manage notes

Hover beside an eligible line number and click VS Code's native comment `+`, then enter the finding. VS Code controls this gutter affordance: the stable Comments API can choose eligible lines but cannot move the `+` into the numeric line-number column. Lines with saved findings show the native comment glyph and expandable thread.

To annotate a section, select its exact range and run **Coding Notes for AI: Add Note** from the Command Palette or editor context menu. With no selection, the command targets the active line. The same action is available with:

- macOS: `Cmd+Alt+R`
- Windows and Linux: `Ctrl+Alt+R`

Each thread contains one structured finding with a category, status, text, timestamps, and a stable ID. While adding a note, use the tag action beside the submit checkmark to choose its category; the selected category appears in the draft label. Use the saved thread actions to edit it in VS Code's multiline comment editor, copy its AI prompt, delete it, resolve it, or reopen it. The copy icon appears beside the resolution action. Resolved notes remain available in the outline and reports.

### Symbol anchors

For languages with an installed document-symbol provider, Add Note can target any function, class, method, constant, variable, or other declaration exposed for the file instead of the exact selection. Hover a reported symbol's declaration to reveal a compact **Add Note** action for direct attachment. The regular target picker puts the closest symbol first and keeps every other reported symbol searchable. Symbol support is best effort: language extensions expose different levels of detail, and local variables are not always reported. A symbol note also retains the declaration range as its universal text-anchor fallback.

Symbols with saved notes show a **View Note: _category_** CodeLens. These navigation lenses remain visible regardless of the `codingNotesForAi.creationUi` selection; disabling `symbolCodeLens` hides only the **Add Note** CodeLens.

### Edits, drift, and reattachment

Stored anchors include the workspace-relative file, range, a bounded selected-text quote, and content/context fingerprints. When edits move code, the extension tries to relocate a note using that evidence. It never silently attaches an ambiguous match to unrelated code.

If the target was deleted or relocation is ambiguous, the note becomes **orphaned**. Orphaned notes remain readable in the Explorer and reports. Open the intended file or select the replacement code and choose **Reattach Note Here** to establish a new anchor.

To change the association of an attached note, select a new line or range in an eligible workspace file, then choose **Move Note Here** from the note's native comment action or its Explorer context menu. You can keep the exact selection or choose any reported symbol in the file. Moving a note preserves its ID, text, category, and status, and it can also move the note to a different file or workspace root.

## Storage

The default `shared` mode writes one `CODING_NOTES_FOR_AI.json` sidecar in each workspace root. Source files stay untouched. The sidecar is ordinary JSON designed for review, versioning, scripts, and AI discovery; commit it when the notes should travel with the codebase.

Multi-root workspaces keep an independent sidecar in each root. File references in a sidecar are relative to that root. Updates use a temporary-file rename when the workspace provider supports it, with a serialized write fallback for providers that do not. Unrelated external edits are preserved; if the same note changed elsewhere, the action is rejected and the latest version is reloaded instead of overwriting it.

Set `codingNotesForAi.storage.mode` to `private` to keep notes in VS Code's local workspace storage instead. Private notes do not create or modify a workspace file, are not portable with the repository, and are not naturally discoverable by AI tools or other collaborators.

## Commands

Commands intended for direct use are available from the Command Palette under **Coding Notes for AI**. Context-only actions appear on native comment threads.

| Command                                                       | What it does                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Coding Notes for AI: Add Note**                             | Creates a finding on the selection, active line, or any available file symbol.            |
| **Coding Notes for AI: Edit Note**                            | Updates the selected finding.                                                             |
| **Coding Notes for AI: Delete Note**                          | Deletes the selected finding after confirmation.                                          |
| **Coding Notes for AI: Resolve Note**                         | Marks the selected finding resolved without deleting it.                                  |
| **Coding Notes for AI: Reopen Note**                          | Reopens a resolved finding by returning its status to `open`.                             |
| **Coding Notes for AI: Move Note Here**                       | Moves an attached finding to the current selection, line, or available symbol.            |
| **Coding Notes for AI: Reattach Note Here**                   | Anchors an orphaned finding to the current selection, line, or available symbol.          |
| **Coding Notes for AI: Show Notes**                           | Reveals the grouped Coding Notes for AI tree in the Explorer.                             |
| **Coding Notes for AI: Refresh Notes**                        | Reloads persisted notes and refreshes editor threads and the tree.                        |
| **Coding Notes for AI: Generate & Copy AI Resolution Report** | Opens and copies a task report instructing an AI agent to inspect and resolve the notes.  |
| **Coding Notes for AI: Copy AI Prompt**                       | Copies a focused prompt for the selected finding; also available on native saved threads. |

## Explorer, reports, and AI discovery

The Explorer tree groups findings by file, category, or status and includes resolved and orphaned notes. Selecting an attached finding opens its file and reveals its range. Resolved findings expose Reopen in the tree, including resolved orphaned notes; detached findings also expose explicit Reattach and Delete actions. AI resolution reports include the relevant `CODING_NOTES_FOR_AI.json` store path, are copied to the clipboard, and open as untitled Markdown documents ready to paste into an AI coding agent; they are never written automatically.

In shared mode, an AI coding agent with workspace access can read `CODING_NOTES_FOR_AI.json` like any other project file. Coding Notes for AI also builds a bounded prompt from the finding, anchor metadata, and surrounding source context. It asks the assistant to assess or implement the note without changing unrelated code.

## Settings

Configure these under **Settings** by searching for `Coding Notes for AI`, or place them in user/workspace JSON settings.

| Setting                                | Default                            | Purpose                                                                  |
| -------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `codingNotesForAi.categories`          | general-purpose category list      | Adds categories shown in note pickers.                                   |
| `codingNotesForAi.defaultCategory`     | `"General"`                        | Initially selected category.                                             |
| `codingNotesForAi.defaultStatus`       | `"open"`                           | Status for new findings: `open`, `question`, `follow-up`, or `resolved`. |
| `codingNotesForAi.creationUi`          | gutter and symbol hover            | Any combination of gutter, CodeLens, and symbol-hover controls.          |
| `codingNotesForAi.storage.mode`        | `"shared"`                         | Uses a shared JSON sidecar or private local VS Code storage.             |
| `codingNotesForAi.storage.sharedFile`  | `"CODING_NOTES_FOR_AI.json"`       | Workspace-root-relative shared sidecar filename.                         |
| `codingNotesForAi.files.exclude`       | common generated/cache directories | Disables note creation in matching workspace paths.                      |
| `codingNotesForAi.outline.groupBy`     | `"file"`                           | Explorer grouping: `file`, `category`, or `status`.                      |
| `codingNotesForAi.prompt.contextLines` | `20`                               | Maximum surrounding lines included before and after a finding.           |

Default categories are General, Bug, Improvement, Question, Documentation, Testing, Performance, Security, Accessibility, and Other. Values in `codingNotesForAi.categories` are added to that built-in list; `defaultCategory` and an existing note's current category are also included automatically. The picker accepts custom categories and saves them for future selection. It updates the existing folder or workspace setting when one is present, otherwise it saves the category to User settings. Duplicate or blank configured values are ignored. A category can be selected from the tag action while drafting and changed from the same action on a saved comment.

Use `codingNotesForAi.creationUi` to enable any combination of `lineGutter`, `symbolCodeLens`, and `symbolHover`. It defaults to `["lineGutter", "symbolHover"]`; the **Add Note** CodeLens is opt-in. An empty array hides every creation affordance without hiding existing notes or their **View Note** CodeLens.

The default file exclusions cover `.git`, `node_modules`, `dist`, `build`, `out`, `coverage`, `storybook-static`, `.cache`, `.next`, `.nuxt`, `.parcel-cache`, `.turbo`, `.yarn`, `.pnpm-store`, and `.vscode-test` directories. The configured shared sidecar is never offered as a note target.

## Copying prompts

Choose the copy icon on a saved native comment thread, the inline copy action in the Explorer tree, or **Coding Notes for AI: Copy AI Prompt** from the Command Palette. The extension builds a bounded prompt from the finding, anchor metadata, and surrounding source context, then places it on the clipboard. It does not open or submit to an assistant; paste the prompt into the AI tool of your choice when you are ready.

## Privacy, security, and Workspace Trust

- Source files and notes are processed locally. The extension makes no network requests and has no telemetry.
- Shared notes are normal workspace data. They may be committed, synchronized, or read by any tool with workspace access; avoid recording secrets.
- Private mode keeps notes in local VS Code workspace storage, outside the repository.
- Prompts are copied only after an explicit command and are never submitted automatically.
- Note creation, editing, navigation, reports, and clipboard copy can work in an untrusted workspace.

Review generated prompts and the shared sidecar before giving an external product access, and apply that product's privacy and data-handling policy.

## Development

Want to contribute or build the extension locally? See [Development](DEVELOPMENT.md) for setup, debugging, validation, and packaging instructions.

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE).
