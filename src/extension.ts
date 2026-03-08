import * as vscode from 'vscode';
import { MintymlConverter } from 'mintyml';

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
    if (!value) return this;

    if (!this.#refCounts) return this;

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

  disposeOf(value: DisposableLike) {
    if (!this.#refCounts) return this;

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

  constructor(action: () => T | PromiseLike<T>, options: { debounceMs?: number } = {}) {
    this.#action = action;
    this.delayMs = options.debounceMs ?? 0;
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

export function activate(context: vscode.ExtensionContext) {
  const subs = new Subs();
  context.subscriptions.push(subs);
  const mintymlConverter = new MintymlConverter({ completePage: true });

  let previewPanel: vscode.WebviewPanel | undefined;
  let _doc: vscode.TextDocument | undefined;

  let webViewSubs: Subs | undefined;

  const updateHtml = new Throttler(
    async () => {
      if (!previewPanel || !_doc) return;

      const previewHtml = await mintymlConverter.convertForgiving(_doc.getText());
      previewPanel.webview.html = previewHtml.output ?? '';
    },
    { debounceMs: 500 },
  );

  async function setWebView(doc: vscode.TextDocument) {
    webViewSubs ??= subs.add(new Subs());

    _doc = doc;
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
            updateHtml.resume();
          } else {
            updateHtml.pause();
          }
        }),
      );

      previewPanel.onDidDispose(() => {
        webViewSubs?.delete(previewPanel);
        webViewSubs?.dispose();
        webViewSubs = undefined;
        previewPanel = undefined;
        _doc = undefined;
      });

      webViewSubs.add(
        vscode.workspace.onDidChangeTextDocument(({ document }) => {
          if (_doc?.uri === document.uri) {
            updateHtml.update();
          }
        }),
      );
    }

    await updateHtml.update();
  }

  context.subscriptions.push(
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
}
