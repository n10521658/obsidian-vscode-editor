
import { ALL_SYMBOL_KINDS, SymbolKind } from "./symbolResolver";

export interface EditorSettings {
	extensions: string[];
	folding: boolean;
	lineNumbers: boolean;
	wordWrap: boolean;
	minimap: boolean;
	semanticValidation: boolean;
	syntaxValidation: boolean;
	themeColor: string;
	fontSize: number;
	fontFamily: string;
	fontLigatures: boolean;
	showEmbedHeader: boolean;
	canvasNodeWidth: number;
	canvasNodeHeight: number;
	flowchartNodeSpacingX: number;
	flowchartNodeSpacingY: number;
	linkableSymbolKinds: SymbolKind[];
	/** Whether flowchart generation includes generated binding files (e.g. `*.g.cs`). */
	includeGeneratedCodeFiles: boolean;
	/** Whether stale generated canvases (managed granularity tag, not rewritten by the run) are trashed on regeneration. */
	pruneStaleFlowcharts: boolean;
	/** Whether pruning uses the system trash instead of the vault trash. */
	pruneToSystemTrash: boolean;
}

export const DEFAULT_SETTINGS: EditorSettings = {
	extensions: ["ts", "js", "py", "css", "c", "cpp", "go", "rs", "java", "lua", "php", "cs", "tscn"],
	folding: true,
	lineNumbers: true,
	wordWrap: true,
	minimap: true,
	semanticValidation: true,
	syntaxValidation: true,
	themeColor: "AUTO",
	fontSize: 14,
	fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
	fontLigatures: true,
	showEmbedHeader: true,
	canvasNodeWidth: 560,
	canvasNodeHeight: 400,
	flowchartNodeSpacingX: 60,
	flowchartNodeSpacingY: 100,
	linkableSymbolKinds: [...ALL_SYMBOL_KINDS],
	includeGeneratedCodeFiles: false,
	pruneStaleFlowcharts: true,
	pruneToSystemTrash: false,
}


export const viewType = "vscode-editor";
