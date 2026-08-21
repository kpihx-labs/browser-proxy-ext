import type { SnapshotScope } from "./protocol";

/** A bookmark node reduced to serializable, non-sensitive extension fields. */
export interface BookmarkNode {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly children?: readonly BookmarkNode[];
}

/** A tab representation scoped to the installed Edge profile. */
export interface TabSnapshot {
  readonly id: number;
  readonly windowId: number;
  readonly groupId: number;
  readonly index: number;
  readonly title: string;
  readonly url?: string;
  readonly active: boolean;
}

/** A grouping hint, explicitly not official Edge Workspace data. */
export interface WorkspaceHint {
  readonly windowId: number;
  readonly groupId?: number;
  readonly label: string;
  readonly source: "window" | "tabGroup";
  readonly authoritative: false;
}

/** The approved, read-only response payload. */
export interface BrowserSnapshot {
  readonly capturedAt: string;
  readonly bookmarks?: readonly BookmarkNode[];
  readonly tabs?: readonly TabSnapshot[];
  readonly workspaceHints?: readonly WorkspaceHint[];
}

/**
 * Purpose: collect precisely the categories a user approved, and no others.
 * Args: `scopes` is the validated daemon request scope list.
 * Returns: a serializable profile-scoped snapshot.
 * Examples: `collectSnapshot(["bookmarks"])`; `collectSnapshot(["tabs", "workspaceHints"])`.
 */
export async function collectSnapshot(scopes: readonly SnapshotScope[]): Promise<BrowserSnapshot> {
  const snapshot: { capturedAt: string; bookmarks?: readonly BookmarkNode[]; tabs?: readonly TabSnapshot[]; workspaceHints?: readonly WorkspaceHint[] } = {
    capturedAt: new Date().toISOString(),
  };
  if (scopes.includes("bookmarks")) snapshot.bookmarks = await collectBookmarks();
  if (scopes.includes("tabs") || scopes.includes("workspaceHints")) {
    const tabs = await collectTabs();
    if (scopes.includes("tabs")) snapshot.tabs = tabs;
    if (scopes.includes("workspaceHints")) snapshot.workspaceHints = await deriveWorkspaceHints(tabs);
  }
  return snapshot;
}

/**
 * Purpose: read the complete bookmark tree of the installed Edge profile.
 * Args: none.
 * Returns: sanitized roots preserving folders, titles, URLs, and child order.
 * Examples: `collectBookmarks()` after creating a folder; `collectBookmarks()` in a fresh profile.
 */
async function collectBookmarks(): Promise<readonly BookmarkNode[]> {
  const tree = await chrome.bookmarks.getTree();
  return tree.map(toBookmarkNode);
}

/**
 * Purpose: transform a browser bookmark object into the contract-safe recursive shape.
 * Args: `node` is a bookmark API node.
 * Returns: a node without timestamps or browser-internal metadata.
 * Examples: `toBookmarkNode({ id: "1", title: "Docs" } as chrome.bookmarks.BookmarkTreeNode)`; `toBookmarkNode({ id: "2", title: "Site", url: "https://example.test" } as chrome.bookmarks.BookmarkTreeNode)`.
 */
function toBookmarkNode(node: chrome.bookmarks.BookmarkTreeNode): BookmarkNode {
  const children = node.children?.map(toBookmarkNode);
  return { id: node.id, title: node.title, ...(node.url ? { url: node.url } : {}), ...(children ? { children } : {}) };
}

/**
 * Purpose: collect tab metadata available through Edge extension APIs, excluding page content.
 * Args: none.
 * Returns: serializable tab records for every accessible profile tab.
 * Examples: `collectTabs()` with one Edge window; `collectTabs()` with grouped tabs.
 */
async function collectTabs(): Promise<readonly TabSnapshot[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(hasTabIdAndWindow).map((tab) => ({ id: tab.id, windowId: tab.windowId, groupId: tab.groupId, index: tab.index, title: tab.title ?? "", ...(tab.url ? { url: tab.url } : {}), active: tab.active }));
}

/**
 * Purpose: remove malformed browser tab records before they enter the external snapshot.
 * Args: `tab` is a result returned by the tabs API.
 * Returns: `true` when numeric tab and window IDs are present.
 * Examples: `hasTabIdAndWindow({ id: 3, windowId: 1 } as chrome.tabs.Tab)` is `true`; `hasTabIdAndWindow({} as chrome.tabs.Tab)` is `false`.
 */
function hasTabIdAndWindow(tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number; windowId: number } {
  return typeof tab.id === "number" && typeof tab.windowId === "number";
}

/**
 * Purpose: derive clearly non-authoritative workspace-like labels from windows and tab groups.
 * Args: `tabs` is the sanitized tab list for the current profile.
 * Returns: heuristic hints labeled with `authoritative: false`; never official Workspace data.
 * Examples: `deriveWorkspaceHints([])` returns `[]`; `deriveWorkspaceHints([{ windowId: 1, groupId: 2 } as TabSnapshot])` includes a group hint.
 */
async function deriveWorkspaceHints(tabs: readonly TabSnapshot[]): Promise<readonly WorkspaceHint[]> {
  const windowIds = [...new Set(tabs.map((tab) => tab.windowId))];
  const hints: WorkspaceHint[] = windowIds.map((windowId) => ({ windowId, label: `Window ${windowId}`, source: "window", authoritative: false }));
  const groupIds = [...new Set(tabs.map((tab) => tab.groupId).filter((groupId) => groupId >= 0))];
  for (const groupId of groupIds) {
    const group = await chrome.tabGroups.get(groupId);
    hints.push({ windowId: group.windowId, groupId, label: group.title || `Tab group ${groupId}`, source: "tabGroup", authoritative: false });
  }
  return hints;
}
