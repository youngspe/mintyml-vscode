import * as vscode from 'vscode';
import { MintymlConverter } from 'mintyml';
import { StringByteOffsetIndex } from './textUtil.js';

interface DisposableLike {
  dispose(): unknown;
}

class Subs {
  #refCounts: Map<DisposableLike, number> | undefined = new Map();

  add<T extends DisposableLike | null | undefined>(value: T): T {
    if (!value) return value;

    if (!this.#refCounts) {
      value.dispose();
      return value;
    }

    const count = this.#refCounts.get(value) ?? 0;
    this.#refCounts.set(value, count + 1);
    return value;
  }

  subtract(value: DisposableLike | null | undefined) {
    if (!value || !this.#refCounts) return this;

    const count = this.#refCounts.get(value);
    if (count === undefined) return this;

    if (count === 1) {
      this.#refCounts.delete(value);
    } else {
      this.#refCounts.set(value, count - 1);
    }

    return this;
  }

  delete(value: DisposableLike | null | undefined) {
    if (value) this.#refCounts?.delete(value);
  }

  disposeOf(value: DisposableLike | null | undefined) {
    if (!value || !this.#refCounts) return this;

    if (this.#refCounts.delete(value)) {
      value.dispose();
    }

    return this;
  }

  dispose() {
    const refCounts = this.#refCounts;
    if (!refCounts) return;

    this.#refCounts = undefined;

    for (const item of refCounts.keys()) {
      item.dispose();
    }
  }
}

class Throttler<T = void> {
  delayMs: number;

  #currentPromise?: Promise<void> | undefined;
  #nextPromise?: PromiseWithResolvers<T | undefined> | undefined;
  #queued = false;
  #running = true;
  #looping = false;
  #cancel: ((_?: undefined) => void) | undefined;
  #action;

  constructor(action: () => T | PromiseLike<T>, options: { delayMs?: number } = {}) {
    this.#action = action;
    this.delayMs = options.delayMs ?? 0;
  }

  async #loop() {
    if (this.#looping) return;
    this.#looping = true;
    this.#currentPromise = undefined;
    if (this.#currentPromise) {
      await this.#currentPromise;
    }

    if (this.delayMs > 0) {
      await new Promise(ok => setTimeout(ok, this.delayMs));
    }

    while (this.#nextPromise) {
      const { promise, resolve, reject } = this.#nextPromise;
      this.#nextPromise = undefined;
      this.#currentPromise = promise.then(
        () => undefined,
        () => undefined,
      );

      this.#cancel = resolve;
      await Promise.try(this.#action).then(resolve, reject);
      this.#cancel = undefined;

      if (this.delayMs > 0) {
        await new Promise(ok => setTimeout(ok, this.delayMs));
      }
    }

    this.#looping = false;
  }

  pause() {
    if (!this.#running) return;

    this.#running = false;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  resume() {
    if (this.#running) return;

    this.#running = true;
    void this.#loop();
  }

  update(): Promise<T | undefined> {
    if (!this.#running) return Promise.resolve(undefined);

    if (!this.#currentPromise) {
      const promise = Promise.try(this.#action);

      this.#currentPromise = promise
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          this.#currentPromise = undefined;
        });

      void this.#loop();

      return promise;
    }

    const { promise } = (this.#nextPromise ??= Promise.withResolvers<T | undefined>());

    return promise;
  }
}

const STANDARD_DEBOUNCE_MS = 2000;
const PREVIEW_DEBOUNCE_MS = 500;

export function activate(context: vscode.ExtensionContext) {
  const subs = new Subs();
  context.subscriptions.push(subs);
  const mintymlConverter = new MintymlConverter({ completePage: true });
  const dx = vscode.languages.createDiagnosticCollection('MinTyML');

  let previewPanel: vscode.WebviewPanel | undefined;
  let _doc: vscode.TextDocument | undefined;

  const docUpdaters = new Map<string, Throttler>();

  let webViewSubs: Subs | undefined;

  // const updateHtml = new Throttler(
  //   async () => {
  //     if (!previewPanel || !_doc) return;

  //     const previewHtml = await mintymlConverter.convertForgiving(_doc.getText());
  //     previewPanel.webview.html = previewHtml.output ?? '';
  //   },
  //   { delayMs: 500 },
  // );

  async function setWebView(doc: vscode.TextDocument) {
    webViewSubs ??= subs.add(new Subs());

    const oldThrottler = _doc && docUpdaters.get(_doc.uri.toString());
    if (oldThrottler) {
      oldThrottler.delayMs = STANDARD_DEBOUNCE_MS;
    }

    _doc = doc;

    const newThrottler = docUpdaters.get(doc.uri.toString());

    if (newThrottler) {
      newThrottler.delayMs = PREVIEW_DEBOUNCE_MS;
    }

    const title = `Preview ${doc.uri.path.replace(/^.+\/(?!$)/, '')}`;
    if (previewPanel) {
      previewPanel.title = title;
      previewPanel.reveal(undefined, true);
    } else {
      previewPanel = webViewSubs.add(
        vscode.window.createWebviewPanel(
          'mintyml.preview',
          title,
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
          { enableFindWidget: true },
        ),
      );

      webViewSubs.add(
        previewPanel.onDidChangeViewState(state => {
          if (state.webviewPanel.visible) {
            docUpdaters.get(doc.uri.toString())?.update();
          }
        }),
      );

      previewPanel.onDidDispose(() => {
        webViewSubs?.delete(previewPanel);
        subs.disposeOf(webViewSubs);
        webViewSubs = undefined;
        previewPanel = undefined;
        _doc = undefined;
      });
    }

    await newThrottler?.update();
  }

  subs.add(
    vscode.commands.registerCommand(
      'mintyml.openPreview',
      async ({ external: uri }: { external?: string } = {}) => {
        let doc;

        if (uri) {
          doc = vscode.workspace.textDocuments.find(x => x.uri.toString() === uri);
        } else {
          doc = vscode.window.activeTextEditor?.document;
        }

        if (!doc) {
          vscode.window.showErrorMessage('No MinTyML document to preview', {
            detail: uri ? `no open document with URI ${uri}.` : '',
          });
          return;
        }

        await setWebView(doc);
      },
    ),
  );

  let onDocChange: DisposableLike | undefined;

  const addDoc = async (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'mintyml') return;

    const uri = doc.uri.toString();
    if (docUpdaters.has(uri)) return;

    const byteOffsetIndex = new StringByteOffsetIndex(doc);

    const throttler = new Throttler(
      async () => {
        const result = await mintymlConverter.convertForgiving(doc.getText());

        if (result.output && previewPanel?.visible && _doc?.uri.toString() === uri) {
          previewPanel.webview.html = result.output;
        }

        const errors = result.error?.syntaxErrors ?? [];

        dx.set(
          doc.uri,
          errors.map(
            e =>
              new vscode.Diagnostic(
                new vscode.Range(
                  byteOffsetIndex.getPositionAtByteOffset(e.start),
                  byteOffsetIndex.getPositionAtByteOffset(e.end),
                ),
                e.message,
                vscode.DiagnosticSeverity.Error,
              ),
          ),
        );
      },
      { delayMs: STANDARD_DEBOUNCE_MS },
    );
    docUpdaters.set(uri, throttler);

    if (docUpdaters.size === 1 && !onDocChange) {
      onDocChange = subs.add(
        vscode.workspace.onDidChangeTextDocument(async e => {
          const uri = e.document.uri.toString();

          const updater = docUpdaters.get(uri);

          if (updater && doc.languageId !== 'mintyml') {
            removeDoc(doc);
          } else if (updater) {
            await updater.update();
          } else {
            await addDoc(doc);
          }
        }),
      );
    }

    await throttler.update();
  };

  const removeDoc = (doc: vscode.TextDocument) => {
    const uri = doc.uri.toString();

    if (docUpdaters.delete(uri) && docUpdaters.size === 0 && onDocChange) {
      subs.disposeOf(onDocChange);
      onDocChange = undefined;
    }
  };

  subs.add(vscode.workspace.onDidOpenTextDocument(addDoc));
  subs.add(
    vscode.window.onDidChangeVisibleTextEditors(e => {
      for (const editor of e) {
        if (editor.document) {
          addDoc(editor.document);
        }
      }
    }),
  );

  subs.add(vscode.workspace.onDidCloseTextDocument(removeDoc));

  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document) {
      addDoc(editor.document);
    }
  }
}
