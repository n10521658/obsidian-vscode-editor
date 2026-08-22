import { App, TFile, TFolder } from "obsidian";
import { SymbolInfo, SymbolKind } from "./symbolResolver";
import { FlowchartFile, toSnakeCase } from "./flowchartModel";

/**
 * Cross-file Rust edge detection for the flowchart model. The per-file
 * heuristic (`detectSameFileCalls` in flowchartModel.ts) only sees calls whose
 * callee lives in the same file, so idiomatic module layouts — glob imports
 * (`use crate::player::methods::*;`) followed by bare calls, struct literals
 * and signature types from a `tables.rs`, and SpacetimeDB `ctx.db.<accessor>()`
 * table handles — produced no edges at all. This module adds them, text-based
 * like the rest of the edge heuristics (no tree-sitter queries):
 *
 * - `use` statements are parsed per file (glob, `{a, b}` lists, single names,
 *   `as` aliases; `crate::`/`super::`/`self::` resolved against the file's
 *   crate base — see `crateBaseFor` — not the scan root, so generating from a
 *   vault root above the crate still resolves `crate::…` imports) and expanded
 *   into an imported-name → target-symbol map. Glob imports expand to every
 *   edgeable symbol of the target file.
 * - A mention scan flags every `\bname\b` occurrence of an imported symbol
 *   inside a symbol's line range (calls, struct literals, `Type::assoc`,
 *   signature types all mention the name). Ownership is the innermost symbol
 *   of any edgeable kind, so a struct owns the type mentions in its fields;
 *   attribute/doc lines directly above a symbol count as that symbol (this is
 *   what catches `scheduled(tick_active_consumable_effects)` in a `#[table]`
 *   attribute, which sits above the struct's own line range).
 * - A `ctx.db.<accessor>(` scan maps SpacetimeDB table handles to the struct
 *   whose `#[table(accessor = <name>, ...)]` matches, via a vault-wide
 *   accessor index built from the scanned files. The index also covers
 *   `#[…::view(accessor = …)]` functions (client-visible read views) and both
 *   bare (`#[table(…)`) and qualified (`#[spacetimedb::table(…)`) attributes.
 *   Each match is labeled `write` when its statement writes
 *   (`.insert/.update/.delete/.try_insert/.upsert(`) and `read` otherwise.
 *
 * Same-file targets are recorded only for the `ctx.db` scan (a table defined
 * in the using file is still a table access); same-file *mentions* stay with
 * the per-file detector. Variables are neither owners nor targets
 * (a `pub const` must not become an edge endpoint). Resolution limits:
 * qualified-path calls (`a::b::foo()`) and module-alias imports are not
 * tracked, a name exported by two glob imports resolves to the first import,
 * and two crates exporting the same module path collide first-wins. All of
 * these simply yield no edge when they fail to resolve.
 */

/** Symbol kinds that may own or receive a cross-file edge (variables excluded). */
export const CROSS_EDGE_KINDS: Set<SymbolKind> = new Set(["function", "struct", "enum", "class", "interface"]);

/** A resolved cross-file reference: `from` (in the FlowchartFile's own file) mentions `toSym`. */
export interface CrossSymbolEdge {
	from: string;
	/** 1-based occurrence pinning `from` among same-named symbols (impl methods sharing a name). */
	fromOccurrence?: number;
	toFile: TFile;
	toSym: SymbolInfo;
	/** `read` / `write` for `ctx.db` table accesses; unset for plain mentions. */
	label?: string;
}

export interface ImportTarget {
	ff: FlowchartFile;
	sym: SymbolInfo;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Net paren balance of a line (attribute continuation detection). */
function parenDelta(s: string): number {
	let d = 0;
	for (const ch of s) {
		if (ch === "(") d++;
		else if (ch === ")") d--;
	}
	return d;
}

/**
 * The contiguous attribute/doc block directly above a symbol (which
 * `listSymbols` does not fold into the symbol's range), as 1-based rows.
 * Multi-line attributes are supported by tracking paren balance while walking
 * upward. Returns the rows in top-down order.
 */
export function attributeRowsAbove(lines: string[], startLine: number): number[] {
	const rows: number[] = [];
	let balance = 0; // paren balance of the partially collected attribute (walking up)
	let i = startLine - 2; // 0-based index of the line above the symbol
	while (i >= 0) {
		const t = lines[i].trim();
		const d = parenDelta(t);
		if (t.startsWith("#[")) {
			rows.unshift(i + 1);
			balance = 0; // the `#[` line closes whatever was unclosed below
			i--;
			continue;
		}
		if (t.startsWith("///")) {
			rows.unshift(i + 1);
			i--;
			continue;
		}
		if (d < 0 || balance < 0) {
			rows.unshift(i + 1);
			balance += d;
			i--;
			continue;
		}
		break;
	}
	return rows;
}

/**
 * The crate base of a Rust file: the nearest ancestor folder holding a
 * `Cargo.toml`, plus its `src` child when present. Walks all the way to the
 * vault root so generating from a folder above the crate (e.g. the vault
 * root) still finds it. Null when no `Cargo.toml` is found.
 */
function crateBaseFor(file: TFile): string | null {
	let dir = file.parent;
	while (dir) {
		const hasCargo = dir.children.some((c) => c instanceof TFile && c.name === "Cargo.toml");
		if (hasCargo) {
			const src = dir.children.find((c) => c instanceof TFolder && c.name === "src");
			return src ? `${dir.path}/src` : dir.path;
		}
		dir = dir.parent;
	}
	return null;
}

/**
 * The Rust module path of `file`, `::`-joined, relative to its crate base
 * (falling back to the scan root when no crate is found):
 * `player/tables.rs` → `player::tables`; `mod.rs`/`lib.rs`/`main.rs`
 * basenames drop, so `combat/mod.rs` → `combat` and `lib.rs` → ``.
 * The vault root's path (`"/"`) is treated as the empty prefix — Obsidian
 * file paths never start with `/`.
 */
function modulePathFor(root: TFolder, file: TFile): string | null {
	const crate = crateBaseFor(file);
	const candidates = crate ? [crate, root.path] : [root.path];
	for (let base of candidates) {
		// The vault root's path ("/") is the empty prefix — Obsidian file
		// paths never start with `/`. A file outside its crate's base (e.g.
		// outside `src/`) falls back to scan-root-relative.
		if (base === "/") base = "";
		const prefix = base === "" ? "" : `${base}/`;
		if (!file.path.startsWith(prefix)) continue;
		const segs = file.path.slice(prefix.length, file.path.length - file.extension.length - 1).split("/");
		const last = segs[segs.length - 1];
		if (last === "mod" || last === "lib" || last === "main") segs.pop();
		return segs.join("::");
	}
	return null;
}

/** Resolves a `use` path's module part against the scan root (see file header for limits). */
function resolveModPath(raw: string, selfMod: string): string | null {
	const segs = raw.split("::").filter((s) => s.length > 0);
	const selfSegs = selfMod.length > 0 ? selfMod.split("::") : [];
	let base: string[];
	let i = 0;
	if (segs[0] === "crate") {
		base = [];
		i = 1;
	} else if (segs[0] === "self") {
		base = [...selfSegs];
		i = 1;
	} else if (segs[0] === "super") {
		base = [...selfSegs];
		while (segs[i] === "super") {
			if (base.length === 0) return null; // super past the crate root
			base.pop();
			i++;
		}
	} else {
		base = []; // 2018-edition `use` paths are crate-relative
	}
	return [...base, ...segs.slice(i)].join("::");
}

interface UseImport {
	mod: string;
	/** "*" for globs, otherwise the imported names with their local alias. */
	names: "*" | { name: string; alias: string }[];
}

/**
 * Parses every `use` statement (single-line or multi-line) into a module path
 * plus imported names. Nested brace trees (`a::{b::{c}}`) are skipped entry by
 * entry. Statements that resolve outside the scanned files are dropped later,
 * at lookup time.
 */
function parseUseImports(content: string, selfMod: string): UseImport[] {
	const out: UseImport[] = [];
	const re = /^[ \t]*(?:pub[ \t]+)?use[ \t]+([^;]+);/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		const body = m[1].replace(/\s*::\s*/g, "::").replace(/\s+/g, " ").trim();
		const brace = body.indexOf("{");
		let modPart: string;
		let names: UseImport["names"];
		if (body.endsWith("::*")) {
			modPart = body.slice(0, -3);
			names = "*";
		} else if (brace >= 0 && body.endsWith("}")) {
			modPart = body.slice(0, brace).replace(/::+$/, "");
			names = [];
			for (const entry of body.slice(brace + 1, -1).split(",")) {
				const e = entry.trim();
				if (!e || e.includes("{")) continue; // nested trees unsupported
				const as = e.split(/\s+as\s+/);
				names.push({ name: as[0].trim(), alias: (as[1] ?? as[0]).trim() });
			}
		} else {
			const cut = body.lastIndexOf("::");
			modPart = cut >= 0 ? body.slice(0, cut) : "";
			const tail = cut >= 0 ? body.slice(cut + 2) : body;
			const as = tail.split(/\s+as\s+/);
			names = [{ name: as[0].trim(), alias: (as[1] ?? as[0]).trim() }];
		}
		const mod = resolveModPath(modPart, selfMod);
		if (mod !== null) out.push({ mod, names });
	}
	return out;
}

/** The innermost edgeable symbol whose range contains `line` (1-based). */
function innermostSymbol(symbols: SymbolInfo[], line: number): SymbolInfo | null {
	let best: SymbolInfo | null = null;
	for (const s of symbols) {
		if (!CROSS_EDGE_KINDS.has(s.kind)) continue;
		if (s.startLine <= line && line <= s.endLine) {
			if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
		}
	}
	return best;
}

/**
 * Fills `crossDetectedEdges` of every Rust file in `files` (see the file
 * header for the heuristics) and returns the SpacetimeDB accessor index
 * (table/view accessor name → defining symbol) — the C# table detectors in
 * flowchartModel.ts resolve against it too. Runs after the per-file scan so
 * every file's symbols are known; re-reads file contents via the metadata
 * cache.
 */
export async function detectCrossFileEdges(
	app: App,
	root: TFolder,
	files: FlowchartFile[],
): Promise<Map<string, ImportTarget>> {
	const rsFiles = files.filter((ff) => ff.file.extension === "rs");

	// Module path → file, for `use` resolution.
	const modIndex = new Map<string, FlowchartFile>();
	for (const ff of rsFiles) {
		const mod = modulePathFor(root, ff.file);
		if (mod !== null && !modIndex.has(mod)) modIndex.set(mod, ff);
	}

	// Read every Rust file once; build the SpacetimeDB accessor index
	// (`#[table(accessor = X)]` above a struct, `#[…::view(accessor = X)]`
	// above a fn — both bare and `spacetimedb::`-qualified attributes) and
	// stash the lines for later.
	const linesByFile = new Map<FlowchartFile, string[]>();
	const accessorIndex = new Map<string, ImportTarget>();
	for (const ff of rsFiles) {
		const lines = (await app.vault.cachedRead(ff.file)).split("\n");
		linesByFile.set(ff, lines);
		for (const sym of ff.symbols) {
			if (sym.kind !== "struct" && sym.kind !== "function") continue;
			const attr = attributeRowsAbove(lines, sym.startLine)
				.map((row) => lines[row - 1])
				.join(" ");
			const isTable = sym.kind === "struct" && /\b(?:\w+::)*table\s*\(/.test(attr);
			const isView = sym.kind === "function" && /\b(?:\w+::)*view\s*\(/.test(attr);
			if (!isTable && !isView) continue;
			const m = /\baccessor\s*=\s*(\w+)/.exec(attr) ?? /\bname\s*=\s*(\w+)/.exec(attr);
			const accessor = m ? m[1] : toSnakeCase(sym.name);
			if (!accessorIndex.has(accessor)) accessorIndex.set(accessor, { ff, sym });
		}
	}

	for (const ff of rsFiles) {
		const lines = linesByFile.get(ff);
		const selfMod = modulePathFor(root, ff.file);
		if (!lines || selfMod === null) continue;

		// Imported-name → target symbol map. Locally defined names shadow
		// imports; between two imports the first one wins.
		const localNames = new Set(ff.symbols.map((s) => s.name));
		const imported = new Map<string, ImportTarget>();
		for (const imp of parseUseImports(lines.join("\n"), selfMod)) {
			const target = modIndex.get(imp.mod);
			if (!target) continue;
			if (imp.names === "*") {
				for (const sym of target.symbols) {
					if (!CROSS_EDGE_KINDS.has(sym.kind)) continue;
					if (localNames.has(sym.name) || imported.has(sym.name)) continue;
					imported.set(sym.name, { ff: target, sym });
				}
			} else {
				for (const { name, alias } of imp.names) {
					if (localNames.has(alias) || imported.has(alias)) continue;
					const sym = target.symbols.find((s) => s.name === name && CROSS_EDGE_KINDS.has(s.kind));
					if (sym) imported.set(alias, { ff: target, sym });
				}
			}
		}

		// Attribute/doc lines directly above a symbol are owned by that symbol
		// (catches `scheduled(fn_name)` in `#[table(...)]` and doc mentions).
		const attrOwner = new Map<number, SymbolInfo>();
		for (const sym of ff.symbols) {
			if (!CROSS_EDGE_KINDS.has(sym.kind)) continue;
			for (const row of attributeRowsAbove(lines, sym.startLine)) {
				if (!attrOwner.has(row)) attrOwner.set(row, sym);
			}
		}

		const seen = new Set<string>();
		const pushEdge = (owner: SymbolInfo, target: ImportTarget, label?: string, allowSameFile = false) => {
			if (!allowSameFile && target.ff === ff) return; // same-file mentions stay with the per-file detector
			const key = `${owner.name}#${owner.occurrence}->${target.ff.file.path}#${target.sym.name}:${label ?? ""}`;
			if (seen.has(key)) return;
			seen.add(key);
			ff.crossDetectedEdges.push({
				from: owner.name,
				fromOccurrence: owner.occurrence,
				toFile: target.ff.file,
				toSym: target.sym,
				label,
			});
		};
		const ownerAt = (row: number): SymbolInfo | null =>
			innermostSymbol(ff.symbols, row) ?? attrOwner.get(row) ?? null;

		// Scans run on string-scrubbed lines so `format!("Enchantment ...")`
		// and friends can't produce phantom mentions.
		const scrubbed = lines.map((l) => l.replace(/"([^"\\]|\\.)*"/g, '""'));

		// Mention scan: any occurrence of an imported name (calls, struct
		// literals, `Type::assoc`, signature types) inside a symbol's range.
		const names = [...imported.keys()];
		if (names.length > 0) {
			const re = new RegExp(`\\b(${names.map(escapeRegExp).join("|")})\\b`, "g");
			for (let row = 0; row < scrubbed.length; row++) {
				const line = scrubbed[row];
				re.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = re.exec(line)) !== null) {
					// Skip look-alikes that only share the name: member accesses
					// (`.is_admin`) and struct-literal fields (`is_admin:`).
					if (m.index > 0 && line[m.index - 1] === ".") continue;
					if (line.startsWith(":", m.index + m[1].length) && !line.startsWith("::", m.index + m[1].length)) continue;
					const owner = ownerAt(row + 1);
					if (owner) pushEdge(owner, imported.get(m[1])!);
				}
			}
		}

		// SpacetimeDB table handles: `ctx.db.<accessor>(` → the accessor's
		// struct (or view fn). Labeled `write` when the statement (match →
		// next `;`, so multi-line rustfmt chains are covered) mutates, else
		// `read`. Same-file tables are recorded here — the per-file detector
		// only sees plain calls.
		const reDb = /\bctx\.db\.(\w+)\s*\(/g;
		const reWrite = /\.\s*(insert|update|delete|try_insert|upsert)\s*\(/;
		for (let row = 0; row < scrubbed.length; row++) {
			reDb.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = reDb.exec(scrubbed[row])) !== null) {
				const target = accessorIndex.get(m[1]);
				if (!target) continue;
				const owner = ownerAt(row + 1);
				if (!owner) continue;
				let stmt = scrubbed[row].slice(m.index);
				for (let r2 = row + 1; !stmt.includes(";") && r2 < scrubbed.length && r2 < row + 12; r2++) {
					stmt += "\n" + scrubbed[r2];
				}
				const semi = stmt.indexOf(";");
				if (semi >= 0) stmt = stmt.slice(0, semi);
				pushEdge(owner, target, reWrite.test(stmt) ? "write" : "read", true);
			}
		}
	}

	return accessorIndex;
}
