import { App } from "obsidian";
import { Parser, Language, Node as SyntaxNode } from "web-tree-sitter";

export interface CodeSubpath {
	linkpath: string;
	symbol: string | null;
	occurrence: number; // 1-based
}

export interface SymbolRange {
	startLine: number; // 1-based
	endLine: number;   // 1-based, inclusive
	text: string;
}

const LANGUAGE_BY_EXTENSION: Record<string, { wasm: string; functionTypes: string[] }> = {
	cs: { wasm: "tree-sitter-c_sharp.wasm", functionTypes: ["method_declaration", "constructor_declaration", "local_function_statement"] },
	rs: { wasm: "tree-sitter-rust.wasm", functionTypes: ["function_item"] },
};

const ATTRIBUTE_TYPES = new Set(["attribute_list", "attribute_item"]);

export function isSymbolCapableExtension(extension: string): boolean {
	return extension in LANGUAGE_BY_EXTENSION;
}

/**
 * Splits "LocalPlayer.cs#RegisterComponent#2" into its parts.
 * The occurrence suffix is 1-based and defaults to 1.
 */
export function parseCodeSubpath(linktext: string): CodeSubpath {
	const parts = linktext.split("#");
	const linkpath = parts[0];
	let symbol: string | null = null;
	let occurrence = 1;
	if (parts.length > 1 && parts[1].length > 0) {
		symbol = parts[1];
	}
	if (parts.length > 2) {
		const n = parseInt(parts[2], 10);
		if (!isNaN(n) && n > 0) occurrence = n;
	}
	return { linkpath, symbol, occurrence };
}

export class SymbolResolver {
	private app: App;
	private pluginDir: string;
	private parserReady: Promise<boolean> | null = null;
	private languages = new Map<string, Promise<Language | null>>();

	constructor(app: App, pluginDir: string) {
		this.app = app;
		this.pluginDir = pluginDir;
	}

	private async readWasm(filename: string): Promise<ArrayBuffer> {
		return await this.app.vault.adapter.readBinary(`${this.pluginDir}/${filename}`);
	}

	private initParser(): Promise<boolean> {
		if (!this.parserReady) {
			this.parserReady = (async () => {
				try {
					// Pass the wasm bytes directly: in Obsidian's Electron renderer the
					// Emscripten glue detects a browser env and would otherwise try to
					// fetch() the file path, which fails. locateFile is still required —
					// without it the glue eagerly builds a URL from import.meta.url,
					// which doesn't exist in the CJS bundle.
					await Parser.init({
						locateFile: () => "web-tree-sitter.wasm",
						wasmBinary: await this.readWasm("web-tree-sitter.wasm"),
					} as any);
					return true;
				} catch (e: any) {
					console.error("vscode-editor: tree-sitter init failed", e);
					return false;
				}
			})();
		}
		return this.parserReady;
	}

	private loadLanguage(extension: string): Promise<Language | null> {
		let cached = this.languages.get(extension);
		if (!cached) {
			cached = (async () => {
				if (!(await this.initParser())) return null;
				try {
					const bytes = new Uint8Array(await this.readWasm(LANGUAGE_BY_EXTENSION[extension].wasm));
					return await Language.load(bytes);
				} catch (e) {
					console.error(`vscode-editor: failed to load tree-sitter grammar for .${extension}`, e);
					return null;
				}
			})();
			this.languages.set(extension, cached);
		}
		return cached;
	}

	/**
	 * Finds the `occurrence`-th (1-based) function named `name` in the file content,
	 * in document order. Overloads / same-name functions in different impl blocks
	 * are distinguished by the occurrence index.
	 */
	async findSymbol(content: string, extension: string, name: string, occurrence: number): Promise<SymbolRange | null> {
		const langSpec = LANGUAGE_BY_EXTENSION[extension];
		if (!langSpec) return null;
		const language = await this.loadLanguage(extension);
		if (!language) return null;

		const parser = new Parser();
		try {
			parser.setLanguage(language);
			const tree = parser.parse(content);
			if (!tree) return null;
			const matches: SyntaxNode[] = [];
			this.collectFunctionNodes(tree.rootNode, langSpec.functionTypes, name, matches);
			const node = matches[occurrence - 1];
			if (!node) return null;

			// Extend the range upwards over contiguous attribute lines ([HttpGet], #[test], ...)
			let startRow = node.startPosition.row;
			let sibling = node.previousNamedSibling;
			while (sibling && ATTRIBUTE_TYPES.has(sibling.type) && sibling.endPosition.row <= startRow) {
				startRow = sibling.startPosition.row;
				sibling = sibling.previousNamedSibling;
			}
			const endRow = node.endPosition.row;

			const lines = content.split("\n");
			return {
				startLine: startRow + 1,
				endLine: endRow + 1,
				text: lines.slice(startRow, endRow + 1).join("\n"),
			};
		} catch (e) {
			console.error("vscode-editor: tree-sitter parse failed", e);
			return null;
		} finally {
			parser.delete();
		}
	}

	private collectFunctionNodes(node: SyntaxNode, functionTypes: string[], name: string, out: SyntaxNode[]): void {
		if (functionTypes.includes(node.type)) {
			const nameNode = node.childForFieldName("name") ?? this.lastIdentifierChild(node);
			if (nameNode && nameNode.text === name) {
				out.push(node);
			}
		}
		for (const child of node.namedChildren) {
			this.collectFunctionNodes(child, functionTypes, name, out);
		}
	}

	private lastIdentifierChild(node: SyntaxNode): SyntaxNode | null {
		let result: SyntaxNode | null = null;
		for (const child of node.namedChildren) {
			if (child.type === "identifier") result = child;
		}
		return result;
	}
}
