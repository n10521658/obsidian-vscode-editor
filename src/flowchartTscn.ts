/**
 * Godot scene (`.tscn`) wiring detection for the flowchart model. Scenes are
 * data, not code — they have no extractable symbols — so every ref found here
 * is owned by the file itself (see `FlowchartFile.fileEdges`), not by a
 * symbol. Three kinds of wiring are detected:
 *
 * - **script** — a `[ext_resource type="Script" path="res://….cs" id="…"]`
 *   whose id is referenced by a `script = ExtResource("<id>")` node property
 *   (a C# script attached to a node). The `uid` attribute is optional and
 *   attribute order varies, so attributes are parsed independently.
 * - **scene** — a `type="PackedScene"` ext_resource referenced by
 *   `instance=ExtResource("<id>")` on a `[node …]` line (an instanced scene).
 * - **table** — a `TableName = "PascalName"` property line (the declarative
 *   table-binding mechanism: a binder component script hooks row events for
 *   the named SpacetimeDB table/view).
 *
 * Only *used* ext_resources become refs — a declared-but-never-attached
 * resource produces nothing. `res://` paths are returned unresolved; mapping
 * them to vault paths (via the enclosing Godot project, the folder holding
 * `project.godot`) and resolving table names against the accessor index both
 * happen in `buildFlowchartModel`'s post-pass.
 */

export interface TscnRef {
	kind: "script" | "scene" | "table";
	/** `res://…` target for script/scene refs. */
	resPath?: string;
	/** PascalCase table/view name for table refs. */
	tableName?: string;
}

export function detectTscnRefs(content: string): TscnRef[] {
	// `[ext_resource …]` blocks, keyed by id. Attributes (`type`, `path`, `id`,
	// optional `uid`) are extracted independently so order doesn't matter.
	const resources = new Map<string, { kind: "script" | "scene"; path: string }>();
	const reBlock = /\[ext_resource[^\]]*\]/g;
	let m: RegExpExecArray | null;
	while ((m = reBlock.exec(content)) !== null) {
		const attrs = new Map<string, string>();
		const reAttr = /(\w+)="([^"]*)"/g;
		let a: RegExpExecArray | null;
		while ((a = reAttr.exec(m[0])) !== null) attrs.set(a[1], a[2]);
		const id = attrs.get("id");
		const type = attrs.get("type");
		const path = attrs.get("path");
		if (!id || !type || !path || !path.startsWith("res://")) continue;
		if (type === "Script" && path.endsWith(".cs")) resources.set(id, { kind: "script", path });
		else if (type === "PackedScene" && path.endsWith(".tscn")) resources.set(id, { kind: "scene", path });
	}

	const out: TscnRef[] = [];
	const seen = new Set<string>();
	const push = (ref: TscnRef) => {
		const key = `${ref.kind}:${ref.resPath ?? ref.tableName ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(ref);
	};

	const reScript = /\bscript\s*=\s*ExtResource\("([^"]+)"\)/g;
	while ((m = reScript.exec(content)) !== null) {
		const r = resources.get(m[1]);
		if (r?.kind === "script") push({ kind: "script", resPath: r.path });
	}

	const reInstance = /\binstance\s*=\s*ExtResource\("([^"]+)"\)/g;
	while ((m = reInstance.exec(content)) !== null) {
		const r = resources.get(m[1]);
		if (r?.kind === "scene") push({ kind: "scene", resPath: r.path });
	}

	const reTable = /^[ \t]*TableName[ \t]*=[ \t]*"([A-Za-z]\w*)"[ \t]*$/gm;
	while ((m = reTable.exec(content)) !== null) {
		push({ kind: "table", tableName: m[1] });
	}

	return out;
}
