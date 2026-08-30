# Development

This guide covers local development, validation, and packaging for Coding Notes for AI. The marketplace-facing feature and usage documentation lives in the [README](README.md).

## Prerequisites

- VS Code 1.74 or newer
- Node.js 22 or newer
- npm

## Set up the project

Clone or download the project, open its root directory in VS Code, and install the development dependencies:

```sh
npm install
npm run build
```

## Run the Extension Development Host

Start the watch build in a terminal:

```sh
npm run watch
```

Then press `F5` or run **Debug: Start Debugging**. Choose **VS Code Extension Development** if VS Code asks for a debugger. In the new Extension Development Host window, open any folder and find **Coding Notes for AI** in the Explorer.

You can also launch a built checkout directly from a shell where the `code` command is installed:

```sh
code --extensionDevelopmentPath=/absolute/path/to/coding-notes-for-ai-extension
```

## Build, format, and test

```sh
npm run format          # apply Prettier formatting
npm run format:check    # check formatting without changing files
npm run lint            # run ESLint
npm run typecheck       # type-check extension, unit tests, and host tests
npm test                # run the focused unit tests
npm run test:extension  # build and run smoke tests in a VS Code Extension Host
npm run build           # bundle dist/extension.js with esbuild
npm run validate        # run formatting, lint, types, unit tests, and build
```

The Extension Host test runner may download a compatible VS Code test build the first time it runs.

## Package and install a VSIX

Create a local package with the bundled `@vscode/vsce` dependency:

```sh
npm run package
```

This creates `coding-notes-for-ai-<version>.vsix` in the project root. Install it from the command line:

```sh
code --install-extension ./coding-notes-for-ai-<version>.vsix
```

Alternatively, run **Extensions: Install from VSIX…** in VS Code and select the generated file. Reload VS Code if prompted.

The extension identity is `aepcodes.coding-notes-for-ai`.
