import { Component, TFile } from "obsidian";
import CodeFilesPlugin from "./main";
import { mountCodeEditor } from "./mountCodeEditor";
import { isSymbolCapableExtension, parseCodeSubpath, SymbolRange } from "./symbolResolver";

/**
 * Registers a code-file embed creator for every extension the plugin manages,
 * so ![[file.cs]] / ![[file.rs#someFn]] render as read-only Monaco editors
 * instead of Obsidian's generic file chip.
 *
 * Uses the internal app.embedRegistry (same registry core uses for png/pdf/md
 * embeds); extensions already claimed by core (md, png, ...) are skipped.
 */
export function registerCodeEmbedCreators(plugin: CodeFilesPlugin) {
	const registry = (plugin.app as any).embedRegistry;
	if (!registry) return;

	const registered: string[] = [];
	for (const extension of plugin.settings.extensions) {
		if (registry.isExtensionRegistered(extension)) continue;
		registry.registerExtension(
			extension,
			(ctx: any, file: TFile, subpath: string) => new CodeFileEmbed(plugin, ctx, file, subpath)
		);
		registered.push(extension);
	}
	plugin.register(() => {
		for (const extension of registered) {
			registry.unregisterExtension(extension);
		}
	});
}

class CodeFileEmbed extends Component {
	private plugin: CodeFilesPlugin;
	private ctx: any;
	private file: TFile;
	private subpath: string;
	private containerEl: HTMLElement;
	private mounted: mountCodeEditor | null = null;

	constructor(plugin: CodeFilesPlugin, ctx: any, file: TFile, subpath: string) {
		super();
		this.plugin = plugin;
		this.ctx = ctx;
		this.file = file;
		this.subpath = subpath ?? "";
		this.containerEl = ctx.containerEl;
		this.containerEl.addClass("file-embed", "vscode-editor-code-embed");
	}

	async loadFile() {
		const content = await this.plugin.app.vault.cachedRead(this.file);

		const { symbol, occurrence } = parseCodeSubpath(this.subpath);
		let symbolRange: SymbolRange | null = null;
		if (symbol && isSymbolCapableExtension(this.file.extension)) {
			symbolRange = await this.plugin.symbolResolver.findSymbol(
				content, this.file.extension, symbol, occurrence
			);
		}

		if (this.plugin.settings.showEmbedHeader) {
			const headerEl = this.containerEl.createDiv({ cls: "vscode-editor-code-embed-header" });
			const titleText = symbol
				? `${this.file.name}#${symbol}${occurrence > 1 ? `#${occurrence}` : ""}`
				: this.file.name;
			const titleEl = headerEl.createEl("a", {
				cls: "vscode-editor-code-embed-title",
				text: titleText,
			});
			titleEl.addEventListener("click", (evt) => {
				evt.preventDefault();
				this.plugin.app.workspace.openLinkText(this.ctx.linktext, this.ctx.sourcePath);
			});
			if (symbol && !symbolRange) {
				headerEl.createSpan({
					cls: "vscode-editor-code-embed-warning",
					text: isSymbolCapableExtension(this.file.extension)
						? ` — function "${symbol}" not found, showing whole file`
						: " — function links are only supported for .cs and .rs",
				});
			}
		}

		const lines = (symbolRange ? symbolRange.text : content).split("\n");
		const lineHeight = this.plugin.settings.fontSize * 1.5;
		const maxHeight = this.getMaxHeightOverride() ?? this.plugin.settings.embedMaxHeight;
		const height = Math.min(maxHeight, Math.max(this.plugin.settings.embedMinHeight, lines.length * lineHeight + 10));
		const startLine = symbolRange ? symbolRange.startLine : 1;

		const editorEl = this.containerEl.createDiv({ cls: "vscode-editor-code-embed-editor" });
		editorEl.style.height = `${height}px`;

		this.mounted = new mountCodeEditor(
			editorEl,
			this.plugin,
			symbolRange ? symbolRange.text : content,
			this.file.extension,
			false,
			false,
			{
				readOnly: true,
				scrollBeyondLastLine: false,
				// Only supply a custom renderer when line numbers are wanted — a function here
				// always renders numbers regardless of the "off" the settings-driven default
				// (genEditorSettings) would otherwise produce, so it must not be set unconditionally.
				lineNumbers: this.plugin.settings.lineNumbers
					? (n: number) => String(startLine + n - 1)
					: "off",
				renderLineHighlight: "none",
			}
		);
	}

	/**
	 * Reads a per-embed max-height override from `![[file.cs|500]]`. Obsidian parses the
	 * `|500` alias using the same convention as image sizing (`![[img.png|500]]`) and sets it
	 * as a `width` attribute on the embed container before the creator runs — there's no
	 * dedicated "height" alias syntax to hook into, so we repurpose that attribute here.
	 */
	private getMaxHeightOverride(): number | null {
		const raw = this.containerEl.getAttribute("width");
		if (!raw) return null;
		const value = Number(raw);
		return Number.isFinite(value) && value > 0 ? value : null;
	}

	onunload() {
		if (this.mounted) {
			this.mounted.monacoEditor.dispose();
			this.mounted = null;
		}
		this.containerEl.empty();
		super.onunload();
	}
}
