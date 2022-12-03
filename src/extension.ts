import * as vscode from 'vscode';
import path = require('path');
import * as fs from 'fs';
import * as os from 'os';
import { ElasticCompletionItemProvider } from './ElasticCompletionItemProvider';
import { ElasticCodeLensProvider } from './ElasticCodeLensProvider';
import { ElasticContentProvider } from './ElasticContentProvider';
import { ElasticDecoration } from './ElasticDecoration';
import { ElasticMatch } from './ElasticMatch';
import { ElasticMatches } from './ElasticMatches';
import { AxiosError, AxiosResponse } from 'axios';
import axiosInstance from './axiosInstance';
import stripJsonComments, { toBodyObj } from './helpers';

let panel: vscode.WebviewPanel | undefined;

export async function activate(context: vscode.ExtensionContext) {
    getHost(context);
    const languages = ['es', 'elasticsearch'];
    context.subscriptions.push(vscode.languages.registerCodeLensProvider(languages, new ElasticCodeLensProvider(context)));

    let resultsProvider = new ElasticContentProvider();
    vscode.workspace.registerTextDocumentContentProvider('elasticsearch', resultsProvider);

    let esMatches: ElasticMatches;
    let decoration: ElasticDecoration;

    function checkEditor(document: vscode.TextDocument): Boolean {
        if (document === vscode.window.activeTextEditor!.document && document.languageId == 'es') {
            if (esMatches == null || decoration == null) {
                esMatches = new ElasticMatches(vscode.window.activeTextEditor!);
                decoration = new ElasticDecoration(context);
            }
            return true;
        }
        return false;
    }

    if (checkEditor(vscode.window.activeTextEditor!.document)) {
        esMatches = new ElasticMatches(vscode.window.activeTextEditor!);
        decoration!.UpdateDecoration(esMatches);
    }

    vscode.workspace.onDidChangeTextDocument(e => {
        if (checkEditor(e.document)) {
            esMatches = new ElasticMatches(vscode.window.activeTextEditor!);
            decoration.UpdateDecoration(esMatches);
        }
    });

    vscode.window.onDidChangeTextEditorSelection(e => {
        if (checkEditor(e.textEditor.document)) {
            esMatches.UpdateSelection(e.textEditor);
            decoration.UpdateDecoration(esMatches);
        }
    });
    let esCompletionHover = new ElasticCompletionItemProvider(context);

    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(languages, esCompletionHover, '/', '?', '&', '"'));
    context.subscriptions.push(vscode.languages.registerHoverProvider(languages, esCompletionHover));

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.execute', (em: ElasticMatch) => {
            if (!em) {
                em = esMatches.Selection;
            }
            executeQuery(context, resultsProvider, em);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.setHost', () => {
            setHost(context);
        }),
    );

    vscode.commands.registerCommand('extension.setClip', (uri, query) => {
        // var ncp = require('copy-paste');
        // ncp.copy(query, function () {
        // vscode.window.showInformationMessage('Copied to clipboard');
        // });
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.open', (em: ElasticMatch) => {
            var column = 0;
            let uri = vscode.Uri.file(em.File.Text);
            return vscode.workspace
                .openTextDocument(uri)
                .then(textDocument =>
                    vscode.window.showTextDocument(
                        textDocument,
                        column ? (column > vscode.ViewColumn.Three ? vscode.ViewColumn.One : column) : undefined,
                        true,
                    ),
                );
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lint', (em: ElasticMatch) => {
            try {
                let l = em.Method.Range.start.line + 1;
                const editor = vscode.window.activeTextEditor;
                editor!.edit(editBuilder => {
                    if (em.HasBody) {
                        const bodyObj = toBodyObj(em.Body.Text);
                        editBuilder.replace(em.Body.Range, JSON.stringify(bodyObj, undefined, 4));
                    }
                });
            } catch (error: any) {
                console.log(error.message);
            }
        }),
    );
}

async function setHost(context: vscode.ExtensionContext): Promise<string> {
    const host = await vscode.window.showInputBox(<vscode.InputBoxOptions>{
        prompt: 'Please enter the elastic host',
        ignoreFocusOut: true,
        value: getHost(context),
    });

    context.workspaceState.update('elasticsearch.host', host);
    vscode.workspace.getConfiguration().update('elasticsearch.host', host);
    return host || 'localhost:9200';
}

export function getHost(context: vscode.ExtensionContext): string {
    return context.workspaceState.get('elasticsearch.host') || vscode.workspace.getConfiguration().get('elasticsearch.host', 'localhost:9200');
}

export async function executeQuery(context: vscode.ExtensionContext, resultsProvider: ElasticContentProvider, em: ElasticMatch) {
    const host = getHost(context);
    const startTime = new Date().getTime();

    const sbi = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    sbi.text = '$(search) Executing query ...';
    sbi.show();

    const bodyStr = stripJsonComments(em.Body.Text);
    const bodyObj = toBodyObj(bodyStr);

    const response = await axiosInstance
        .request({
            method: em.Method.Text as any,
            baseURL: host,
            url: em.Path.Text.startsWith('/') ? `${host}${em.Path.Text}` : em.Path.Text,
            data: bodyObj ? JSON.stringify(bodyObj, undefined, 4) : undefined,
        })
        .catch(error => error as AxiosError<any, any>);

    sbi.dispose();
    const goodResponse = response as AxiosResponse<any, any>;
    const badResponse = response as AxiosError<any, any>;
    let results: any = '';
    if (badResponse?.isAxiosError || goodResponse.status >= 300) {
        results = goodResponse.data ? goodResponse.data : badResponse;
    } else {
        results = goodResponse.data;
    }
    if (typeof results == 'object') {
        results = JSON.stringify(results, undefined, 4);
    }
    const endTime = new Date().getTime();
    results = `// ${new Date().toISOString()} - took ${(endTime - startTime) / 1000} secs\n` + results;
    showResult(results);
}

async function showResult(results: string) {
    const column = vscode.window.activeTextEditor!.viewColumn! + 1;
    const config = vscode.workspace.getConfiguration();
    var asDocument = config.get('elasticsearch.showResultAsDocument', true);
    if (asDocument) {
        const resultFilePath = vscode.workspace.rootPath || path.join(os.homedir(), '.vscode-elastic');
        let uri = vscode.Uri.file(path.join(resultFilePath, 'ElasticSearchResult.json'));
        if (!fs.existsSync(uri.fsPath)) {
            uri = uri.with({ scheme: 'untitled' });
        }
        const textDocument = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(
            textDocument,
            column ? (column > vscode.ViewColumn.Three ? vscode.ViewColumn.One : column) : undefined,
            true,
        );
        editor.edit(editorBuilder => {
            if (editor.document.lineCount > 0) {
                const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
                editorBuilder.delete(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine.range.start.line, lastLine.range.end.character)));
            }
            editorBuilder.insert(new vscode.Position(0, 0), results);
        });
        return;
    }

    if (!panel) {
        panel = vscode.window.createWebviewPanel('annotator-annotation', 'ElasticSearchResult', column, { enableScripts: true });
        panel.onDidDispose(() => {
            panel = undefined;
        });
    }
    panel.webview.html = `
<html>
    <body>
        <pre>
            <code>
${results}
            </code>
        </pre>
    </body>
</html>`;
    panel.iconPath = vscode.Uri.parse('https://github.com/barnuri/vscode-elasticsearch/blob/master/media/elastic.png?raw=true');
}

// this method is called when your extension is deactivated
export function deactivate() {}
