import { beforeAll, describe, expect, mock, test } from "bun:test";

/** This extension's own id, shared between the `chrome.management` mock factory and the tests
 * that assert self-target rejection (`extension-enable`/`disable` vs `extension-reload`). */
const OWN_ID = "own-extension-id";

/**
 * Purpose: a `WebSocket` that never actually touches the network, replacing the real one.
 * Args: constructor takes and ignores a URL, matching the real `WebSocket` constructor shape.
 * Returns: an object satisfying every `WebSocket` member `background.ts`'s `connectBridge()` uses
 * (`readyState`, the `CONNECTING`/`OPEN` statics, `addEventListener`, `send`).
 *
 * Root-caused a real, confirmed-live test flake with this fix: `connectBridge()` runs at module
 * import time and used to create a REAL `WebSocket`, which fails to connect in this sandboxed
 * environment — but that failure is asynchronous, and its `close` event fired at an unpredictable
 * LATER point during the test run (confirmed live via debug logging: it landed in the middle of
 * the unrelated `user.ask` test, and `onSocketClose()` unconditionally rejects every pending
 * `contentReplies` entry, breaking that test's in-flight round trip). Never resolving to `OPEN` or
 * `CLOSED` on its own eliminates this real-network race entirely, rather than papering over its
 * timing with an arbitrary drain delay.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  constructor(_url: string) {}
  addEventListener(_type: string, _handler: (event: unknown) => void): void {}
  send(_data: string): void {}
  close(): void {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;

/**
 * Minimal `chrome.*` mock covering only the APIs `background.ts`'s KIND_HANDLERS touch:
 * bookmarks, tabGroups, tabs (group/query/sendMessage/onCreated), runtime, and storage.
 * Installed on `globalThis.chrome` BEFORE dynamically importing `background.ts`, because that
 * module registers `chrome.runtime.onMessage.addListener(...)` as a top-level side effect.
 */
function installChromeMock() {
  const bookmarksCreate = mock(async (bookmark: { title: string; url?: string; parentId?: string; index?: number }) => ({
    id: "99",
    title: bookmark.title,
    url: bookmark.url,
    parentId: bookmark.parentId,
    index: bookmark.index ?? 0,
  }));
  const bookmarksRemove = mock(async (_id: string) => undefined);
  const bookmarksRemoveTree = mock(async (_id: string) => undefined);
  const bookmarksMove = mock(async (id: string, props: { parentId?: string; index?: number }) => ({
    id,
    parentId: props.parentId ?? "1",
    index: props.index ?? 0,
  }));
  const bookmarksUpdate = mock(async (id: string, props: { title?: string; url?: string }) => ({
    id,
    title: props.title ?? "KpihX Labs",
    url: props.url,
  }));
  const bookmarksGetTree = mock(async () => [
    {
      id: "0",
      title: "",
      children: [
        {
          id: "1",
          title: "Bookmarks bar",
          parentId: "0",
          index: 0,
          children: [
            { id: "42", title: "KpihX Labs", url: "https://kpihx-labs.com", parentId: "1", index: 0 },
          ],
        },
        { id: "2", title: "Other bookmarks", parentId: "0", index: 1, children: [] },
      ],
    },
  ]);
  const bookmarksGet = mock(
    async (
      _id: string,
    ): Promise<Array<{ id: string; title: string; url?: string; parentId?: string; index?: number }>> => [
      { id: "42", title: "KpihX Labs", url: "https://kpihx-labs.com", parentId: "1", index: 0 },
    ],
  );
  type MockBookmarkNode = {
    id: string;
    title: string;
    url?: string;
    parentId?: string;
    index?: number;
    children?: MockBookmarkNode[];
  };
  const bookmarksGetSubTree = mock(async (_id: string): Promise<MockBookmarkNode[]> => [
    {
      id: "1",
      title: "Bookmarks bar",
      parentId: "0",
      index: 0,
      children: [
        { id: "42", title: "KpihX Labs", url: "https://kpihx-labs.com", parentId: "1", index: 0 },
      ],
    },
  ]);

  type MockExtensionInfo = {
    id: string;
    name: string;
    shortName?: string;
    version?: string;
    description?: string;
    type?: string;
    enabled: boolean;
    mayDisable?: boolean;
    installType?: string;
    offlineEnabled?: boolean;
    homepageUrl?: string;
    updateUrl?: string;
    optionsUrl?: string;
    permissions?: string[];
    hostPermissions?: string[];
    icons?: Array<{ url: string; size: number }>;
  };
  const managementGetSelf = mock(
    async (): Promise<MockExtensionInfo> => ({
      id: OWN_ID,
      name: "Browser Proxy Bridge for Microsoft Edge",
      shortName: "Browser Proxy Bridge",
      version: "0.2.0",
      description: "A local, approval-gated bridge.",
      type: "extension",
      enabled: true,
      mayDisable: true,
      installType: "development",
      offlineEnabled: false,
      optionsUrl: "chrome-extension://own-extension-id/options.html",
      permissions: ["bookmarks", "tabs", "tabGroups", "storage", "alarms", "management"],
      hostPermissions: [],
      icons: [],
    }),
  );
  const managementGetAll = mock(async (): Promise<MockExtensionInfo[]> => [await managementGetSelf()]);
  const managementGet = mock(
    async (id: string): Promise<MockExtensionInfo> => ({
      id,
      name: "Some Extension",
      shortName: "Some Extension",
      version: "1.0.0",
      description: "A third-party extension.",
      type: "extension",
      enabled: true,
      mayDisable: true,
      installType: "normal",
      offlineEnabled: false,
      optionsUrl: "",
      permissions: ["storage"],
      hostPermissions: ["<all_urls>"],
      icons: [],
    }),
  );
  const managementSetEnabled = mock(async (_id: string, _enabled: boolean) => undefined);
  const managementUninstall = mock(async (_id: string, _options?: { showConfirmDialog?: boolean }) => undefined);
  const managementGetPermissionWarningsById = mock(async (_id: string): Promise<string[]> => [
    "Read and change your data on all websites",
  ]);

  const tabsGroup = mock(async (_options: { tabIds: number | number[] }) => 7);
  const tabGroupsUpdate = mock(async (id: number, props: { title?: string; color?: string; collapsed?: boolean }) => ({
    id,
    title: props.title,
    color: props.color ?? "grey",
    collapsed: props.collapsed ?? false,
  }));
  const tabGroupsQuery = mock(async () => [{ id: 7, title: "Research", color: "blue", collapsed: false, windowId: 1 }]);
  const tabGroupsMove = mock(async (id: number, props: { windowId: number; index: number }) => ({ id, windowId: props.windowId }));
  const tabGroupsGet = mock(async (id: number) => ({ id, title: "Research", color: "blue", collapsed: false }));
  const tabsQueryByGroup = mock(async (_query: { groupId?: number; active?: boolean }) => [
    { id: 12, url: "https://example.com", title: "Example", windowId: 1, index: 0, groupId: 7, active: true, pinned: false },
  ]);
  const tabsSendMessage = mock(async (_tabId: number, _message: unknown) => undefined);
  const tabsGet = mock(async (tabId: number) => ({ id: tabId, index: tabId === 34 ? 3 : 0, windowId: 1, status: "complete" }));
  const tabsMove = mock(async (tabIds: number | number[], props: { index: number; windowId?: number }) => ({
    id: Array.isArray(tabIds) ? tabIds[0] : tabIds,
    index: props.index,
    windowId: props.windowId ?? 1,
  }));
  const tabsUngroup = mock(async (_tabIds: number | number[]) => undefined);
  const tabsCreate = mock(async (_props: { url: string; active?: boolean }) => ({ id: 555, status: "complete", windowId: 1 }));
  const tabsRemove = mock(async (_tabId: number) => undefined);
  const tabsUpdate = mock(async (tabId: number, _props: { active?: boolean }) => ({ id: tabId, windowId: 1 }));
  const windowsUpdate = mock(
    async (
      windowId: number,
      props: { left?: number; top?: number; width?: number; height?: number; state?: string; focused?: boolean },
    ) => ({
      id: windowId,
      left: props.left ?? 0,
      top: props.top ?? 0,
      width: props.width ?? 800,
      height: props.height ?? 600,
      state: props.state ?? "normal",
      focused: props.focused ?? true,
    }),
  );

  const onMessageListeners: Array<(message: unknown, sender: unknown) => unknown> = [];
  const onCreatedListeners: Array<(tab: unknown) => void> = [];
  const onUpdatedListeners: Array<(tabId: number, changeInfo: { status?: string }) => void> = [];
  const onAlarmListeners: Array<(alarm: { name: string }) => void> = [];
  const alarmsCreate = mock((_name: string, _info: { periodInMinutes?: number; when?: number }) => undefined);
  const alarmsClear = mock(async (_name: string) => true);
  const storageLocalGet = mock(async (_key: string) => ({}) as Record<string, unknown>);

  (globalThis as Record<string, unknown>).chrome = {
    bookmarks: {
      create: bookmarksCreate,
      remove: bookmarksRemove,
      removeTree: bookmarksRemoveTree,
      move: bookmarksMove,
      update: bookmarksUpdate,
      getTree: bookmarksGetTree,
      getSubTree: bookmarksGetSubTree,
      get: bookmarksGet,
    },
    management: {
      getSelf: managementGetSelf,
      getAll: managementGetAll,
      get: managementGet,
      setEnabled: managementSetEnabled,
      uninstall: managementUninstall,
      getPermissionWarningsById: managementGetPermissionWarningsById,
    },
    tabGroups: { update: tabGroupsUpdate, query: tabGroupsQuery, move: tabGroupsMove, get: tabGroupsGet },
    tabs: {
      group: tabsGroup,
      query: tabsQueryByGroup,
      sendMessage: tabsSendMessage,
      get: tabsGet,
      move: tabsMove,
      ungroup: tabsUngroup,
      create: tabsCreate,
      remove: tabsRemove,
      update: tabsUpdate,
      onCreated: {
        addListener: (fn: (tab: unknown) => void) => onCreatedListeners.push(fn),
        removeListener: (fn: (tab: unknown) => void) => {
          const index = onCreatedListeners.indexOf(fn);
          if (index >= 0) onCreatedListeners.splice(index, 1);
        },
      },
      onUpdated: {
        addListener: (fn: (tabId: number, changeInfo: { status?: string }) => void) => onUpdatedListeners.push(fn),
        removeListener: (fn: (tabId: number, changeInfo: { status?: string }) => void) => {
          const index = onUpdatedListeners.indexOf(fn);
          if (index >= 0) onUpdatedListeners.splice(index, 1);
        },
      },
    },
    windows: { update: windowsUpdate },
    runtime: {
      onMessage: { addListener: (fn: (message: unknown, sender: unknown) => unknown) => onMessageListeners.push(fn) },
      sendMessage: mock(async () => undefined),
    },
    storage: { local: { get: storageLocalGet } },
    alarms: {
      create: alarmsCreate,
      clear: alarmsClear,
      onAlarm: { addListener: (fn: (alarm: { name: string }) => void) => onAlarmListeners.push(fn) },
    },
  };

  return {
    bookmarksCreate,
    bookmarksRemove,
    bookmarksRemoveTree,
    bookmarksMove,
    bookmarksUpdate,
    bookmarksGetTree,
    bookmarksGetSubTree,
    bookmarksGet,
    managementGetSelf,
    managementGetAll,
    managementGet,
    managementSetEnabled,
    managementUninstall,
    managementGetPermissionWarningsById,
    tabsGroup,
    tabGroupsUpdate,
    tabGroupsQuery,
    tabGroupsMove,
    tabGroupsGet,
    tabsQueryByGroup,
    tabsSendMessage,
    tabsGet,
    tabsMove,
    tabsUngroup,
    tabsCreate,
    tabsRemove,
    tabsUpdate,
    windowsUpdate,
    alarmsCreate,
    alarmsClear,
    onAlarmListeners,
    onMessageListeners,
    storageLocalGet,
  };
}

let background: typeof import("../src/background");
let mocks: ReturnType<typeof installChromeMock>;

/**
 * Purpose: look up a KIND_HANDLERS entry and assert it exists (tsconfig's `noUncheckedIndexedAccess`
 * would otherwise type every lookup as possibly `undefined`).
 * Args: `kind` is the daemon request kind under test.
 * Returns: the registered handler function.
 * Examples: `getHandler("bookmark.create")`; `getHandler("group.move")`.
 */
function getHandler(kind: string): (payload: unknown) => Promise<Record<string, unknown>> {
  const handler = background.KIND_HANDLERS[kind];
  if (!handler) throw new Error(`no handler registered for kind: ${kind}`);
  return handler;
}

beforeAll(async () => {
  mocks = installChromeMock();
  // Dynamic import so the chrome mock (and the FakeWebSocket global above) exist before
  // background.ts's top-level `chrome.runtime.onMessage.addListener(...)` + `connectBridge()`
  // side effects run.
  background = await import("../src/background");
});

describe("KIND_HANDLERS dispatch table", () => {
  test("bookmark.list reveals the REAL nested folder/subfolder tree, never a flat dump", async () => {
    const handler = getHandler("bookmark.list");
    const result = (await handler({})) as { depth: number | null; roots: Array<Record<string, unknown>> };
    expect(mocks.bookmarksGetTree).toHaveBeenCalled();
    expect(result.depth).toBeNull();
    // The invisible super-root ("0") is never itself returned — roots starts at its real children.
    expect(result.roots.map((root) => root.id)).toEqual(["1", "2"]);
    const bar = result.roots[0] as { type: string; children: Array<Record<string, unknown>> };
    expect(bar.type).toBe("folder");
    expect(bar.children).toEqual([
      { id: "42", title: "KpihX Labs", type: "bookmark", url: "https://kpihx-labs.com", parent_id: "1", index: 0 },
    ]);
  });

  test("bookmark.list depth:0 returns only the top-level roots, with empty children, never descending", async () => {
    const handler = getHandler("bookmark.list");
    const result = (await handler({ depth: 0 })) as { depth: number | null; roots: Array<{ children: unknown[] }> };
    expect(result.depth).toBe(0);
    expect(result.roots.every((root) => Array.isArray(root.children) && root.children.length === 0)).toBe(true);
  });

  test("bookmark.list rejects a negative or non-integer depth", async () => {
    const handler = getHandler("bookmark.list");
    await expect(handler({ depth: -1 })).rejects.toThrow();
    await expect(handler({ depth: 1.5 })).rejects.toThrow();
  });

  test("bookmark.list root_id scopes the whole call to ONE subfolder via getSubTree, never the top-level roots", async () => {
    const handler = getHandler("bookmark.list");
    mocks.bookmarksGetTree.mockClear();
    const result = (await handler({ root_id: "1" })) as { depth: number | null; roots: Array<Record<string, unknown>> };
    expect(mocks.bookmarksGetSubTree).toHaveBeenCalledWith("1");
    expect(mocks.bookmarksGetTree).not.toHaveBeenCalled();
    expect(result.roots).toEqual([
      {
        id: "1",
        title: "Bookmarks bar",
        type: "folder",
        url: null,
        parent_id: "0",
        index: 0,
        children: [
          { id: "42", title: "KpihX Labs", type: "bookmark", url: "https://kpihx-labs.com", parent_id: "1", index: 0 },
        ],
      },
    ]);
  });

  test("bookmark.list rejects a root_id naming a bookmark leaf, not a folder", async () => {
    const handler = getHandler("bookmark.list");
    mocks.bookmarksGetSubTree.mockImplementationOnce(async () => [
      { id: "42", title: "KpihX Labs", url: "https://kpihx-labs.com", parentId: "1", index: 0 },
    ]);
    await expect(handler({ root_id: "42" })).rejects.toThrow(/leaf/);
  });

  test("bookmark.list rejects an unknown root_id", async () => {
    const handler = getHandler("bookmark.list");
    mocks.bookmarksGetSubTree.mockImplementationOnce(async () => [] as never[]);
    await expect(handler({ root_id: "does-not-exist" })).rejects.toThrow();
  });

  test("bookmark.get reads ALL available info about ONE folder, including a children preview never the full subtree", async () => {
    const handler = getHandler("bookmark.get");
    mocks.bookmarksGet.mockImplementationOnce(async () => [
      { id: "29", title: "X", parentId: "2", index: 14, dateAdded: 1000, dateGroupModified: 2000 },
    ]);
    mocks.bookmarksGet.mockImplementationOnce(async () => [{ id: "2", title: "Other favorites" }]);
    mocks.bookmarksGetSubTree.mockImplementationOnce(async () => [
      {
        id: "29",
        title: "X",
        parentId: "2",
        index: 14,
        children: [
          { id: "30", title: "First link", url: "https://a", parentId: "29", index: 0 },
          { id: "31", title: "Last link", url: "https://b", parentId: "29", index: 1 },
        ],
      },
    ]);
    const result = await handler({ id: "29" });
    expect(result).toEqual({
      id: "29",
      title: "X",
      type: "folder",
      url: null,
      parent_id: "2",
      parent_title: "Other favorites",
      index: 14,
      date_added: 1000,
      date_group_modified: 2000,
      children_count: 2,
      children_preview: { first: "First link", last: "Last link" },
    });
  });

  test("bookmark.get reads ALL available info about ONE leaf bookmark — date_last_used, never children_*", async () => {
    const handler = getHandler("bookmark.get");
    mocks.bookmarksGet.mockImplementationOnce(async () => [
      {
        id: "42",
        title: "KpihX Labs",
        url: "https://kpihx-labs.com",
        parentId: "1",
        index: 0,
        dateAdded: 1000,
        dateLastUsed: 3000,
      },
    ]);
    mocks.bookmarksGet.mockImplementationOnce(async () => [{ id: "1", title: "Bookmarks bar" }]);
    const result = (await handler({ id: "42" })) as Record<string, unknown>;
    expect(result.type).toBe("bookmark");
    expect(result.date_last_used).toBe(3000);
    expect(result).not.toHaveProperty("children_count");
    expect(result).not.toHaveProperty("date_group_modified");
  });

  test("bookmark.get on an empty folder returns children_count:0 and a null preview", async () => {
    const handler = getHandler("bookmark.get");
    mocks.bookmarksGet.mockImplementationOnce(async () => [{ id: "7", title: "Empty", parentId: "5", index: 0 }]);
    mocks.bookmarksGet.mockImplementationOnce(async () => [{ id: "5", title: "Workspaces" }]);
    mocks.bookmarksGetSubTree.mockImplementationOnce(async () => [{ id: "7", title: "Empty", parentId: "5", index: 0, children: [] }]);
    const result = (await handler({ id: "7" })) as Record<string, unknown>;
    expect(result.children_count).toBe(0);
    expect(result.children_preview).toBeNull();
  });

  test("bookmark.get rejects a malformed payload and an unknown id", async () => {
    const handler = getHandler("bookmark.get");
    await expect(handler({})).rejects.toThrow();
    mocks.bookmarksGet.mockImplementationOnce(async () => [] as never[]);
    await expect(handler({ id: "does-not-exist" })).rejects.toThrow();
  });

  test("bookmark.create places a batch of items with absolute finesse — a folder created earlier in the SAME call resolved via parent_ref, no extra round trip", async () => {
    const handler = getHandler("bookmark.create");
    mocks.bookmarksCreate.mockClear();
    mocks.bookmarksCreate.mockImplementationOnce(async (bookmark) => ({
      id: "101",
      title: bookmark.title,
      url: bookmark.url,
      parentId: bookmark.parentId,
      index: 0,
    }));
    mocks.bookmarksCreate.mockImplementationOnce(async (bookmark) => ({
      id: "102",
      title: bookmark.title,
      url: bookmark.url,
      parentId: bookmark.parentId,
      index: 0,
    }));
    const result = await handler({
      items: [
        { type: "folder", title: "2026", ref: "y26", parent_id: "1" },
        { type: "bookmark", title: "SynapseS", url: "https://synapses.polytechnique.fr/", parent_ref: "y26" },
      ],
    });
    expect(mocks.bookmarksCreate).toHaveBeenNthCalledWith(1, { title: "2026", url: undefined, parentId: "1", index: undefined });
    expect(mocks.bookmarksCreate).toHaveBeenNthCalledWith(2, {
      title: "SynapseS",
      url: "https://synapses.polytechnique.fr/",
      parentId: "101",
      index: undefined,
    });
    expect(result).toEqual({
      created: [
        { ref: "y26", id: "101", type: "folder", title: "2026", url: null, parent_id: "1", index: 0 },
        { ref: null, id: "102", type: "bookmark", title: "SynapseS", url: "https://synapses.polytechnique.fr/", parent_id: "101", index: 0 },
      ],
    });
  });

  test("bookmark.create rejects a duplicate ref BEFORE creating anything", async () => {
    const handler = getHandler("bookmark.create");
    mocks.bookmarksCreate.mockClear();
    await expect(
      handler({
        items: [
          { type: "folder", title: "A", ref: "dup" },
          { type: "folder", title: "B", ref: "dup" },
        ],
      }),
    ).rejects.toThrow(/unique/);
    expect(mocks.bookmarksCreate).not.toHaveBeenCalled();
  });

  test("bookmark.create rejects a parent_ref that does not match an earlier item", async () => {
    const handler = getHandler("bookmark.create");
    await expect(
      handler({ items: [{ type: "bookmark", title: "X", url: "https://x", parent_ref: "nonexistent" }] }),
    ).rejects.toThrow(/parent_ref/);
  });

  test("bookmark.create rejects a malformed item instead of silently stubbing a response", async () => {
    const handler = getHandler("bookmark.create");
    await expect(handler({ items: [{ type: "bookmark", title: "missing url" }] })).rejects.toThrow();
    await expect(handler({ items: [{ type: "folder", title: "X", url: "https://x" }] })).rejects.toThrow();
  });

  test("bookmark.remove deletes a mix of a whole folder (removeTree) AND a standalone leaf (remove) in ONE batch call", async () => {
    const handler = getHandler("bookmark.remove");
    mocks.bookmarksGet.mockImplementationOnce(async () => [{ id: "7", title: "Old project", parentId: "1", index: 0 }]);
    mocks.bookmarksGet.mockImplementationOnce(async () => [
      { id: "42", title: "KpihX Labs", url: "https://kpihx-labs.com", parentId: "1", index: 1 },
    ]);
    const result = await handler({ ids: ["7", "42"] });
    expect(mocks.bookmarksRemoveTree).toHaveBeenCalledWith("7");
    expect(mocks.bookmarksRemove).toHaveBeenCalledWith("42");
    expect(result).toEqual({
      removed: [
        { id: "7", type: "folder", title: "Old project", url: null },
        { id: "42", type: "bookmark", title: "KpihX Labs", url: "https://kpihx-labs.com" },
      ],
    });
  });

  test("bookmark.remove is all-or-nothing — an unknown id anywhere in the batch removes NOTHING", async () => {
    const handler = getHandler("bookmark.remove");
    mocks.bookmarksRemove.mockClear();
    mocks.bookmarksRemoveTree.mockClear();
    mocks.bookmarksGet.mockImplementationOnce(async () => [
      { id: "42", title: "KpihX Labs", url: "https://kpihx-labs.com", parentId: "1", index: 0 },
    ]);
    mocks.bookmarksGet.mockImplementationOnce(async () => [] as never[]);
    await expect(handler({ ids: ["42", "does-not-exist"] })).rejects.toThrow();
    expect(mocks.bookmarksRemove).not.toHaveBeenCalled();
    expect(mocks.bookmarksRemoveTree).not.toHaveBeenCalled();
  });

  test("bookmark.remove rejects a malformed payload", async () => {
    const handler = getHandler("bookmark.remove");
    await expect(handler({ ids: [] })).rejects.toThrow();
    await expect(handler({ id: "42" })).rejects.toThrow();
  });

  test("bookmark.update applies any subset of rename/re-url/move/reposition, batch, in one call", async () => {
    const handler = getHandler("bookmark.update");
    mocks.bookmarksGet.mockImplementationOnce(async () => [
      { id: "42", title: "KpihX Labs", url: "https://kpihx-labs.com", parentId: "1", index: 0 },
    ]);
    mocks.bookmarksGet.mockImplementationOnce(async () => [
      { id: "42", title: "KpihX Labs (new)", url: "https://kpihx-labs.com", parentId: "7", index: 0 },
    ]);
    const result = await handler({ items: [{ id: "42", title: "KpihX Labs (new)", parent_id: "7" }] });
    expect(mocks.bookmarksUpdate).toHaveBeenCalledWith("42", { title: "KpihX Labs (new)", url: undefined });
    expect(mocks.bookmarksMove).toHaveBeenCalledWith("42", { parentId: "7", index: undefined });
    expect(result).toEqual({
      updated: [{ id: "42", title: "KpihX Labs (new)", url: "https://kpihx-labs.com", parent_id: "7", index: 0 }],
    });
  });

  test("bookmark.update rejects setting a url on an id that is actually a folder, before mutating anything", async () => {
    const handler = getHandler("bookmark.update");
    mocks.bookmarksUpdate.mockClear();
    mocks.bookmarksGet.mockImplementationOnce(async () => [{ id: "7", title: "Folder", parentId: "1", index: 0 }]);
    await expect(handler({ items: [{ id: "7", url: "https://x" }] })).rejects.toThrow(/folder/);
    expect(mocks.bookmarksUpdate).not.toHaveBeenCalled();
  });

  test("bookmark.update rejects a no-op item (nothing to change beyond id)", async () => {
    const handler = getHandler("bookmark.update");
    await expect(handler({ items: [{ id: "42" }] })).rejects.toThrow();
  });

  test("extension.list returns full detail for EVERY installed extension, with human-readable permission_warnings", async () => {
    const handler = getHandler("extension.list");
    const result = (await handler({})) as { extensions: Array<Record<string, unknown>> };
    expect(mocks.managementGetAll).toHaveBeenCalled();
    expect(result.extensions).toHaveLength(1);
    const own = result.extensions[0] as Record<string, unknown>;
    expect(own.id).toBe(OWN_ID);
    expect(own.name).toBe("Browser Proxy Bridge for Microsoft Edge");
    expect(own.permissions).toEqual(["bookmarks", "tabs", "tabGroups", "storage", "alarms", "management"]);
    expect(own.permission_warnings).toEqual(["Read and change your data on all websites"]);
  });

  test("extension.get reads ALL available detail about ONE extension by id", async () => {
    const handler = getHandler("extension.get");
    const result = (await handler({ id: "other-id" })) as Record<string, unknown>;
    expect(mocks.managementGet).toHaveBeenCalledWith("other-id");
    expect(result.id).toBe("other-id");
    expect(result.name).toBe("Some Extension");
    expect(result.permission_warnings).toEqual(["Read and change your data on all websites"]);
  });

  test("extension.get rejects a malformed payload", async () => {
    const handler = getHandler("extension.get");
    await expect(handler({})).rejects.toThrow();
  });

  test("extension.enable enables a batch of extensions in ONE call", async () => {
    const handler = getHandler("extension.enable");
    const result = await handler({ ids: ["a", "b"] });
    expect(mocks.managementSetEnabled).toHaveBeenNthCalledWith(1, "a", true);
    expect(mocks.managementSetEnabled).toHaveBeenNthCalledWith(2, "b", true);
    expect(result).toEqual({
      updated: [
        { id: "a", name: "Some Extension", enabled: true },
        { id: "b", name: "Some Extension", enabled: true },
      ],
    });
  });

  test("extension.disable disables a batch of extensions in ONE call", async () => {
    const handler = getHandler("extension.disable");
    mocks.managementSetEnabled.mockClear();
    await handler({ ids: ["a"] });
    expect(mocks.managementSetEnabled).toHaveBeenCalledWith("a", false);
  });

  test("extension.enable refuses to target this same extension — points at extension-reload instead", async () => {
    const handler = getHandler("extension.enable");
    mocks.managementSetEnabled.mockClear();
    await expect(handler({ ids: [OWN_ID] })).rejects.toThrow(/extension-reload/);
    expect(mocks.managementSetEnabled).not.toHaveBeenCalled();
  });

  test("extension.disable refuses to target this same extension", async () => {
    const handler = getHandler("extension.disable");
    mocks.managementSetEnabled.mockClear();
    await expect(handler({ ids: [OWN_ID] })).rejects.toThrow(/extension-reload/);
    expect(mocks.managementSetEnabled).not.toHaveBeenCalled();
  });

  test("extension.enable/disable rejects a malformed payload", async () => {
    const handler = getHandler("extension.enable");
    await expect(handler({ ids: [] })).rejects.toThrow();
    await expect(handler({})).rejects.toThrow();
  });

  test("extension.uninstall is deliberately not registered — chrome.management.uninstall() targeting another extension requires a genuine synchronous DOM user gesture, which a WebSocket-triggered call can never provide (live-verified, see CONTRACT.md)", () => {
    expect(() => getHandler("extension.uninstall")).toThrow();
  });

  test("extension.reload responds with this extension's own identity BEFORE chrome.runtime.reload() ever fires", async () => {
    const handler = getHandler("extension.reload");
    const runtimeReload = mock(() => undefined);
    (globalThis as { chrome: { runtime?: { reload?: () => void } } }).chrome.runtime = { reload: runtimeReload };
    const result = await handler({});
    expect(result).toEqual({
      reloading: true,
      id: OWN_ID,
      name: "Browser Proxy Bridge for Microsoft Edge",
      version: "0.2.0",
    });
    // The reload itself is scheduled, deliberately not fired synchronously within this same call.
    expect(runtimeReload).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(runtimeReload).toHaveBeenCalledTimes(1);
  });

  test("the approval overlay illustrates a batch extension-disable's real name/version/enabled state, never a bare extension id", async () => {
    mocks.tabsSendMessage.mockClear();
    await background.handleRequest({
      type: "request",
      id: "req-approval-transparency-6",
      kind: "approval",
      payload: { action: "extension-disable", payload: { profile: "default", ids: ["other-id"] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [, message] = mocks.tabsSendMessage.mock.calls[0] as [number, { details: string[] }];
    expect(message.details).toEqual([
      "ids:",
      "  other-id",
      "",
      'extension other-id: "Some Extension" v1.0.0 (enabled)',
    ]);
  });

  test("the approval overlay still illustrates bookmark-remove's ids as bookmarks, never as extensions (disambiguated by action name)", async () => {
    mocks.tabsSendMessage.mockClear();
    mocks.bookmarksGet.mockImplementationOnce(async () => [{ id: "42", title: "KpihX Labs", url: "https://kpihx-labs.com" }]);
    await background.handleRequest({
      type: "request",
      id: "req-approval-transparency-7",
      kind: "approval",
      payload: { action: "bookmark-remove", payload: { profile: "default", ids: ["42"] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [, message] = mocks.tabsSendMessage.mock.calls[0] as [number, { details: string[] }];
    expect(message.details).toEqual(["ids:", "  42", "", 'bookmark 42: "KpihX Labs" (https://kpihx-labs.com)']);
  });

  test("group.create calls chrome.tabs.group then chrome.tabGroups.update with the right args", async () => {
    const handler = getHandler("group.create");
    const result = await handler({ tab_ids: [12, 13], title: "Research", color: "blue" });
    expect(mocks.tabsGroup).toHaveBeenCalledWith({ tabIds: [12, 13] });
    expect(mocks.tabGroupsUpdate).toHaveBeenCalledWith(7, { title: "Research", color: "blue" });
    expect(result).toEqual({ group_id: 7, title: "Research", color: "blue" });
  });

  test("group.create rejects an empty tab_ids payload", async () => {
    const handler = getHandler("group.create");
    await expect(handler({ tab_ids: [] })).rejects.toThrow();
  });

  test("group.update calls chrome.tabGroups.update and returns the real updated group", async () => {
    const handler = getHandler("group.update");
    const result = await handler({ group_id: 7, collapsed: true });
    expect(mocks.tabGroupsUpdate).toHaveBeenCalledWith(7, { title: undefined, color: undefined, collapsed: true });
    expect(result).toEqual({ id: 7, title: null, color: "grey", collapsed: true });
  });

  test("group.move calls chrome.tabGroups.move (preserves the group across windows)", async () => {
    const handler = getHandler("group.move");
    const result = await handler({ group_id: 7, window_id: 99 });
    expect(mocks.tabGroupsMove).toHaveBeenCalledWith(7, { windowId: 99, index: -1 });
    expect(result).toEqual({ group_id: 7, window_id: 99 });
  });

  test("group.add_tabs calls chrome.tabs.group WITH groupId (adds to an existing group, never creates a new one)", async () => {
    const handler = getHandler("group.add_tabs");
    const result = await handler({ group_id: 7, tab_ids: [20, 21] });
    expect(mocks.tabsGroup).toHaveBeenCalledWith({ tabIds: [20, 21], groupId: 7 });
    expect(result).toEqual({ group_id: 7, tab_ids: [20, 21] });
  });

  test("group.add_tabs rejects an empty tab_ids payload", async () => {
    const handler = getHandler("group.add_tabs");
    await expect(handler({ group_id: 7, tab_ids: [] })).rejects.toThrow();
  });

  test("group.remove_tabs calls chrome.tabs.ungroup without closing the tabs", async () => {
    const handler = getHandler("group.remove_tabs");
    const result = await handler({ tab_ids: [12, 13] });
    expect(mocks.tabsUngroup).toHaveBeenCalledWith([12, 13]);
    expect(result).toEqual({ tab_ids: [12, 13], ungrouped: true });
  });

  test("group.sync reorganizes a whole window's tab/group layout in ONE call — ungroup, create, rename/recolor, and position, all at once (absolute flexibility, KπX directive)", async () => {
    mocks.tabsMove.mockClear();
    mocks.tabsUngroup.mockClear();
    mocks.tabsGroup.mockClear();
    mocks.tabGroupsUpdate.mockClear();
    mocks.tabGroupsMove.mockClear();
    const handler = getHandler("group.sync");
    const result = await handler({
      layout: [
        { type: "tab", tab_id: 1 },
        { type: "group", title: "Research", color: "blue", tab_ids: [2, 3] },
        { type: "tab", tab_id: 4 },
      ],
    });
    expect(mocks.tabsUngroup).toHaveBeenCalledWith([1]);
    expect(mocks.tabsMove).toHaveBeenCalledWith(1, { index: 0 });
    expect(mocks.tabsGroup).toHaveBeenCalledWith({ tabIds: [2, 3] });
    expect(mocks.tabGroupsUpdate).toHaveBeenCalledWith(7, { title: "Research", color: "blue" });
    expect(mocks.tabGroupsMove).toHaveBeenCalledWith(7, { index: 1 });
    expect(mocks.tabsMove).toHaveBeenCalledWith(4, { index: 3 });
    expect(result).toEqual({
      layout: [
        { type: "tab", tab_id: 1 },
        { type: "group", group_id: 7, tab_ids: [2, 3] },
        { type: "tab", tab_id: 4 },
      ],
    });
  });

  test("group.sync with an existing group_id ADDS to and renames that EXACT group, never creating a new one", async () => {
    mocks.tabsGroup.mockClear();
    const handler = getHandler("group.sync");
    await handler({ layout: [{ type: "group", group_id: 7, title: "Renamed", tab_ids: [9] }] });
    expect(mocks.tabsGroup).toHaveBeenCalledWith({ tabIds: [9], groupId: 7 });
  });

  test("group.sync rejects an empty layout and a group entry with no tabs", async () => {
    const handler = getHandler("group.sync");
    await expect(handler({ layout: [] })).rejects.toThrow();
    await expect(handler({ layout: [{ type: "group", tab_ids: [] }] })).rejects.toThrow();
  });

  test("tab.update with an explicit index moves the tab directly, no chrome.tabs.get lookup needed", async () => {
    const handler = getHandler("tab.update");
    const result = await handler({ tab_id: 12, index: 0 });
    expect(mocks.tabsGet).not.toHaveBeenCalled();
    expect(mocks.tabsMove).toHaveBeenCalledWith(12, { index: 0, windowId: undefined });
    expect(result).toEqual({ tab_id: 12, url: undefined, index: 0, window_id: 1, group_id: undefined });
  });

  test("tab.update with after_tab_id resolves the reference tab's real index + 1 first", async () => {
    const handler = getHandler("tab.update");
    const result = await handler({ tab_id: 12, after_tab_id: 34 });
    expect(mocks.tabsGet).toHaveBeenCalledWith(34);
    expect(mocks.tabsMove).toHaveBeenCalledWith(12, { index: 4, windowId: undefined });
    expect(result).toEqual({ tab_id: 12, url: undefined, index: 4, window_id: 1, group_id: undefined });
  });

  test("tab.update with before_tab_id resolves the reference tab's exact real index", async () => {
    const handler = getHandler("tab.update");
    await handler({ tab_id: 12, before_tab_id: 34, window_id: 99 });
    expect(mocks.tabsGet).toHaveBeenCalledWith(34);
    expect(mocks.tabsMove).toHaveBeenCalledWith(12, { index: 3, windowId: 99 });
  });

  test("tab.update rejects a no-op call (no field beyond tab_id) and more than one position field", async () => {
    const handler = getHandler("tab.update");
    await expect(handler({ tab_id: 12 })).rejects.toThrow();
    await expect(handler({ tab_id: 12, index: 0, before_tab_id: 34 })).rejects.toThrow();
  });

  test("tab.update navigates via url, in-place, before any position adjustment", async () => {
    const handler = getHandler("tab.update");
    mocks.tabsUpdate.mockClear();
    mocks.tabsMove.mockClear();
    const result = await handler({ tab_id: 12, url: "https://new.example" });
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(12, { url: "https://new.example" });
    expect(mocks.tabsMove).not.toHaveBeenCalled();
    expect(result).toEqual({ tab_id: 12, url: undefined, index: 0, window_id: 1, group_id: undefined });
  });

  test("tab.update with group_id:null ungroups the tab; a real group_id groups it", async () => {
    const handler = getHandler("tab.update");
    mocks.tabsUngroup.mockClear();
    mocks.tabsGroup.mockClear();
    await handler({ tab_id: 12, group_id: null });
    expect(mocks.tabsUngroup).toHaveBeenCalledWith(12);
    await handler({ tab_id: 12, group_id: 7 });
    expect(mocks.tabsGroup).toHaveBeenCalledWith({ tabIds: 12, groupId: 7 });
  });

  test("window.update adjusts an existing window's bounds/state/focus via chrome.windows.update", async () => {
    const handler = getHandler("window.update");
    mocks.windowsUpdate.mockClear();
    const result = await handler({ window_id: 1, state: "maximized" });
    expect(mocks.windowsUpdate).toHaveBeenCalledWith(1, { state: "maximized", focused: undefined });
    expect(result).toEqual({ window_id: 1, bounds: { left: 0, top: 0, width: 800, height: 600 }, state: "maximized", focused: true });
  });

  test("window.update rejects a no-op call (no field beyond window_id)", async () => {
    const handler = getHandler("window.update");
    await expect(handler({ window_id: 1 })).rejects.toThrow();
  });

  test("window.layout with no window_id returns every real window's canonical layout", async () => {
    const handler = getHandler("window.layout");
    const result = (await handler(undefined)) as { windows: Record<string, { tabs: unknown[]; order: unknown[] }> };
    expect(result.windows["1"]?.tabs.length).toBe(1);
    expect(result.windows["1"]?.order).toEqual([{ kind: "group", group_id: 7, title: "Research", color: "blue", collapsed: false, tabs: [12] }]);
  });

  test("window.layout with a window_id returns just that window's {tabs, groups, order}", async () => {
    const handler = getHandler("window.layout");
    const result = await handler({ window_id: 1 });
    expect(result).toEqual({
      window_id: 1,
      tabs: [{ chrome_tab_id: 12, index: 0, url: "https://example.com", title: "Example", group_id: 7, active: true, pinned: false }],
      groups: { "7": { title: "Research", color: "blue", collapsed: false } },
      order: [{ kind: "group", group_id: 7, title: "Research", color: "blue", collapsed: false, tabs: [12] }],
    });
  });

  test("window.layout for an unknown window_id returns an honest empty layout, never a stale one", async () => {
    const handler = getHandler("window.layout");
    const result = await handler({ window_id: 404 });
    expect(result).toEqual({ window_id: 404, tabs: [], groups: {}, order: [] });
  });

  test("group.list queries real tab groups and their tabs, enriched with window_id (derived from the same canonical layout as window.layout)", async () => {
    const handler = getHandler("group.list");
    const result = (await handler(undefined)) as { groups: Array<Record<string, unknown>> };
    expect(mocks.tabGroupsQuery).toHaveBeenCalled();
    expect(result.groups).toEqual([
      {
        id: 7,
        window_id: 1,
        title: "Research",
        color: "blue",
        collapsed: false,
        tabs: [{ id: 12, url: "https://example.com", title: "Example" }],
      },
    ]);
  });

  test("unknown kinds are absent from KIND_HANDLERS, matching the fail-closed 'unknown kind' response path", () => {
    expect(background.KIND_HANDLERS["nonexistent.kind"]).toBeUndefined();
  });

  test("'approval' is NOT a KIND_HANDLERS entry — it is handled separately by requestApproval", () => {
    expect(background.KIND_HANDLERS.approval).toBeUndefined();
  });

  test("handleRequest routes kind:'approval' to the approval overlay (chrome.tabs.sendMessage), not to KIND_HANDLERS", async () => {
    mocks.tabsSendMessage.mockClear();
    // `handleRequest` intentionally fire-and-forgets the "approval" branch (`return void requestApproval(request)`),
    // so flush pending microtasks/macrotasks before asserting on requestApproval's internal chrome.tabs.* calls.
    await background.handleRequest({ type: "request", id: "req-approval-1", kind: "approval", payload: { action: "bookmark.create", payload: {}, timeout_seconds: 30 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.tabsSendMessage).toHaveBeenCalledTimes(1);
    const [, message] = mocks.tabsSendMessage.mock.calls[0] as [number, { type: string; requestId: string; scopes: string[]; details: string[] }];
    expect(message).toEqual({ type: "showApproval", requestId: "req-approval-1", scopes: ["bookmark.create"], details: [] });
  });

  test("the approval overlay shows the REAL, non-secret proposal fields (100% transparency, KπX directive) — never just a bare action name", async () => {
    mocks.tabsSendMessage.mockClear();
    await background.handleRequest({
      type: "request",
      id: "req-approval-transparency-1",
      kind: "approval",
      payload: { action: "group-create", payload: { profile: "default", tab_ids: [1, 2], title: "Research" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [, message] = mocks.tabsSendMessage.mock.calls[0] as [number, { details: string[] }];
    // "profile" is a routing detail, not part of the proposed action — never shown. `tab_ids` also
    // gets a real, resolved illustration (KπX: "juste me montrer les ids ça ne m'aide pas" — every
    // native `tab_ids` reference is resolved to its real tab via `describeTabsContext`, appended
    // after a blank separator line, never just the bare id list on its own).
    expect(message.details).toEqual([
      "tab_ids: [1,2]",
      'title: "Research"',
      "",
      '  tab 1: "" ()',
      '  tab 2: "" ()',
    ]);
  });

  test("the approval overlay illustrates a group_id with its CURRENT real title, color, and tabs — never a bare id (KπX: 'son nom très important')", async () => {
    mocks.tabsSendMessage.mockClear();
    mocks.tabGroupsGet.mockImplementationOnce(async () => ({ id: 7, title: "Groupe 1", color: "blue", collapsed: false }));
    // First `chrome.tabs.query` call is `getActiveTabId()`'s own lookup (needs one approvable
    // http(s) tab so `tryShowApproval` succeeds on its first attempt); the SECOND is
    // `describeGroupContext`'s real `{groupId: 7}` query — same mocked function, two queued
    // `mockImplementationOnce` answers in real call order.
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => [
      { id: 12, url: "https://example.com", title: "Example", windowId: 1, index: 0, groupId: -1, active: true, pinned: false },
    ]);
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => [
      { id: 21, url: "edge://extensions/", title: "Extensions", windowId: 1, index: 0, groupId: 7, active: false, pinned: false },
      { id: 22, url: "edge://settings/profiles", title: "Settings", windowId: 1, index: 1, groupId: 7, active: true, pinned: false },
    ]);
    await background.handleRequest({
      type: "request",
      id: "req-approval-transparency-3",
      kind: "approval",
      payload: { action: "group-update", payload: { profile: "default", group_id: 7, title: "Setup" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [, message] = mocks.tabsSendMessage.mock.calls[0] as [number, { details: string[] }];
    expect(message.details).toEqual([
      "group_id: 7",
      'title: "Setup"',
      "",
      'group 7 — current title: "Groupe 1", color: blue, 2 tab(s):',
      '    - "Extensions" (edge://extensions/)',
      '    - "Settings" (edge://settings/profiles)',
    ]);
  });

  test("known-sensitive fields (e.g. a cookie's real value) are shown as <redacted>, never silently omitted or leaked", async () => {
    mocks.tabsSendMessage.mockClear();
    await background.handleRequest({
      type: "request",
      id: "req-approval-transparency-2",
      kind: "approval",
      payload: { action: "cookie-set", payload: { name: "session", value: "super-secret", domain: "example.com" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [, message] = mocks.tabsSendMessage.mock.calls[0] as [number, { details: string[] }];
    expect(message.details).toEqual(['name: "session"', "value: <redacted>", 'domain: "example.com"']);
  });

  test("the approval overlay illustrates a batch bookmark-remove's real title/url per id, never a bare bookmark id", async () => {
    mocks.tabsSendMessage.mockClear();
    mocks.bookmarksGet.mockImplementationOnce(async () => [{ id: "42", title: "KpihX Labs", url: "https://kpihx-labs.com" }]);
    await background.handleRequest({
      type: "request",
      id: "req-approval-transparency-4",
      kind: "approval",
      payload: { action: "bookmark-remove", payload: { profile: "default", ids: ["42"] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [, message] = mocks.tabsSendMessage.mock.calls[0] as [number, { details: string[] }];
    expect(message.details).toEqual(["ids:", "  42", "", 'bookmark 42: "KpihX Labs" (https://kpihx-labs.com)']);
  });

  test("the approval overlay illustrates a batch bookmark-create's referenced EXISTING parent folder, never a bare parent_id", async () => {
    mocks.tabsSendMessage.mockClear();
    mocks.bookmarksGet.mockImplementationOnce(async () => [{ id: "1", title: "Bookmarks bar" }]);
    await background.handleRequest({
      type: "request",
      id: "req-approval-transparency-5",
      kind: "approval",
      payload: {
        action: "bookmark-create",
        payload: { profile: "default", items: [{ type: "bookmark", title: "X", url: "https://x", parent_id: "1" }] },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [, message] = mocks.tabsSendMessage.mock.calls[0] as [number, { details: string[] }];
    expect(message.details).toEqual([
      `items: ${JSON.stringify([{ type: "bookmark", title: "X", url: "https://x", parent_id: "1" }])}`,
      "",
      'bookmark 1: "Bookmarks bar" ()',
    ]);
  });

  test("requestApproval redirects (focuses) the tab AND its window that will host the overlay — never a prompt KπX has to discover by accident", async () => {
    mocks.tabsUpdate.mockClear();
    mocks.windowsUpdate.mockClear();
    await background.handleRequest({
      type: "request",
      id: "req-approval-redirect-1",
      kind: "approval",
      payload: { action: "group-create" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(12, { active: true });
    expect(mocks.windowsUpdate).toHaveBeenCalledWith(1, { focused: true });
  });

  test("handleRequest resolves without throwing for an unrecognized kind (fails closed via the daemon response path, not an exception)", async () => {
    await expect(background.handleRequest({ type: "request", id: "req-unknown-1", kind: "nonexistent.kind", payload: {} })).resolves.toBeUndefined();
  });

  test("requestApproval falls back to a real http(s) tab when the active tab is this extension's OWN Options page (root-caused bug: silently rejected every approval whenever Options was the focused tab)", async () => {
    mocks.tabsSendMessage.mockClear();
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => [
      {
        id: 99,
        url: "chrome-extension://cihendapnnhccheeecinfjhfejmpebfb/options.html",
        title: "Options",
        windowId: 1,
        index: 0,
        groupId: -1,
        active: true,
        pinned: false,
      },
    ]);
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => [
      { id: 12, url: "https://example.com", title: "Example", windowId: 1, index: 1, groupId: -1, active: false, pinned: false },
    ]);
    await background.handleRequest({ type: "request", id: "req-approval-2", kind: "approval", payload: { action: "group-create" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.tabsSendMessage).toHaveBeenCalledTimes(1);
    const [tabId] = mocks.tabsSendMessage.mock.calls[0] as [number, unknown];
    expect(tabId).toBe(12);
  });

  test("requestApproval retries via a fresh temporary tab when a found candidate tab's content script is stale (root-caused live: right after THIS extension itself reloads, every previously-open tab's content script is orphaned)", async () => {
    mocks.tabsSendMessage.mockClear();
    mocks.tabsCreate.mockClear();
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => [
      { id: 99, url: "edge://extensions/", title: "Extensions", windowId: 1, index: 0, groupId: -1, active: true, pinned: false },
    ]);
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => [
      { id: 12, url: "https://example.com", title: "Example", windowId: 1, index: 1, groupId: -1, active: false, pinned: false },
    ]);
    mocks.tabsSendMessage.mockImplementationOnce(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    await background.handleRequest({ type: "request", id: "req-approval-6", kind: "approval", payload: { action: "group-create" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.tabsSendMessage).toHaveBeenCalledTimes(2);
    const [firstAttemptTabId] = mocks.tabsSendMessage.mock.calls[0] as [number, unknown];
    const [secondAttemptTabId] = mocks.tabsSendMessage.mock.calls[1] as [number, unknown];
    expect(firstAttemptTabId).toBe(12);
    expect(secondAttemptTabId).toBe(555);
    expect(mocks.tabsCreate).toHaveBeenCalledWith({ url: "https://example.com/", active: true });
  });

  test("requestApproval creates a temporary tab as a last resort when NO http(s) tab exists anywhere, and shows the overlay there", async () => {
    mocks.tabsSendMessage.mockClear();
    mocks.tabsCreate.mockClear();
    // Both the active-tab query and the http(s)-fallback query find nothing usable.
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => [
      { id: 99, url: "edge://settings/profiles", title: "Settings", windowId: 1, index: 0, groupId: -1, active: true, pinned: false },
    ]);
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => []);
    await background.handleRequest({ type: "request", id: "req-approval-3", kind: "approval", payload: { action: "group-create" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.tabsCreate).toHaveBeenCalledWith({ url: "https://example.com/", active: true });
    expect(mocks.tabsSendMessage).toHaveBeenCalledTimes(1);
    const [tabId] = mocks.tabsSendMessage.mock.calls[0] as [number, unknown];
    expect(tabId).toBe(555);
  });

  test("the temporary approval tab is closed once the approval is answered (approved), never left behind", async () => {
    mocks.tabsRemove.mockClear();
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => [
      { id: 99, url: "edge://settings/profiles", title: "Settings", windowId: 1, index: 0, groupId: -1, active: true, pinned: false },
    ]);
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => []);
    await background.handleRequest({ type: "request", id: "req-approval-4", kind: "approval", payload: { action: "group-create" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    background.handleApprovalResponse(
      { requestId: "req-approval-4", approved: true },
      { tab: { id: 555 } } as chrome.runtime.MessageSender,
    );
    expect(mocks.tabsRemove).toHaveBeenCalledWith(555);
  });

  test("the temporary approval tab is closed if the approval times out with no answer at all (via the chrome.alarms expiry sweep, never a plain setTimeout that an evicted service worker would lose)", async () => {
    mocks.tabsRemove.mockClear();
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => [
      { id: 99, url: "edge://settings/profiles", title: "Settings", windowId: 1, index: 0, groupId: -1, active: true, pinned: false },
    ]);
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => []);
    await background.handleRequest({
      type: "request",
      id: "req-approval-5",
      kind: "approval",
      payload: { action: "group-create", timeout_seconds: 30 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.alarmsCreate).toHaveBeenCalledWith("browser-proxy-approval-expiry:req-approval-5", { when: expect.any(Number) });
    // Simulate Chromium redelivering that exact alarm (works identically even after a full
    // service-worker eviction, unlike a lost setTimeout).
    for (const listener of mocks.onAlarmListeners) {
      listener({ name: "browser-proxy-approval-expiry:req-approval-5" });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.tabsRemove).toHaveBeenCalledWith(555);
  });
});

test("bounded reconnect delay starts at 500ms and never exceeds 30 seconds", () => {
  expect(background.reconnectDelayMs(0)).toBe(500);
  expect(background.reconnectDelayMs(1)).toBe(1000);
  expect(background.reconnectDelayMs(6)).toBe(30000);
  expect(background.reconnectDelayMs(100)).toBe(30000);
});

describe("profile identity (fixes 3 profiles returning the exact same bookmark tree)", () => {
  test("loadProfile falls back to 'default' when the operator never set one", async () => {
    mocks.storageLocalGet.mockImplementationOnce(async () => ({}));
    expect(await background.loadProfile()).toBe("default");
  });

  test("loadProfile returns the exact operator-declared profile from storage", async () => {
    mocks.storageLocalGet.mockImplementationOnce(async () => ({ browserProxyProfile: "research" }));
    expect(await background.loadProfile()).toBe("research");
  });
});

describe("chrome.alarms reconnect watchdog (survives service-worker eviction)", () => {
  test("a periodic reconnect alarm is armed synchronously at module load, not only via setTimeout", () => {
    // Registered once during the shared beforeAll() import — a `setTimeout`-only design would
    // register nothing chrome.alarms-visible at all, which is exactly the bug being guarded against.
    expect(mocks.alarmsCreate).toHaveBeenCalledWith(
      "browser-proxy-reconnect-watchdog",
      { periodInMinutes: 0.5 },
    );
  });

  test("the registered onAlarm listener calls connectBridge() again for a matching alarm name without throwing", () => {
    // A real reconnect attempt fails to open a socket in this sandboxed test environment (same
    // documented behavior as the module-load-time connectBridge() call above) — this test only
    // proves the alarm->reconnect wiring itself does not throw, which is what the eviction-recovery
    // guarantee actually depends on (Chromium redelivering the alarm and running this listener).
    expect(mocks.onAlarmListeners.length).toBeGreaterThan(0);
    for (const listener of mocks.onAlarmListeners) {
      expect(() => listener({ name: "browser-proxy-reconnect-watchdog" })).not.toThrow();
      expect(() => listener({ name: "some-other-extension-alarm" })).not.toThrow();
    }
  });
});

describe("sendToHostTab (centralized tab-resolution/focus/retry for every non-approval HITL kind)", () => {
  test("user.ask focuses the resolved tab and completes a real content-reply round trip", async () => {
    mocks.tabsUpdate.mockClear();
    mocks.windowsUpdate.mockClear();
    mocks.tabsSendMessage.mockClear();
    const handler = getHandler("user.ask");
    const resultPromise = handler({ question: "Continue?" });
    for (let attempt = 0; attempt < 50 && mocks.tabsSendMessage.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(12, { active: true });
    expect(mocks.windowsUpdate).toHaveBeenCalledWith(1, { focused: true });
    const [tabId, message] = mocks.tabsSendMessage.mock.calls[0] as [number, { requestId: string }];
    for (const listener of mocks.onMessageListeners) {
      await listener({ type: "askResponse", requestId: message.requestId, answer: "yes" }, { tab: { id: tabId } });
    }
    expect(await resultPromise).toEqual({ answer: "yes" });
  });

  test("captcha.solve retries via a fresh temporary tab when the found candidate's content script is stale, same centralized mechanism as approval", async () => {
    mocks.tabsSendMessage.mockClear();
    mocks.tabsCreate.mockClear();
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => [
      { id: 99, url: "edge://extensions/", title: "Extensions", windowId: 1, index: 0, groupId: -1, active: true, pinned: false },
    ]);
    mocks.tabsQueryByGroup.mockImplementationOnce(async () => [
      { id: 12, url: "https://example.com", title: "Example", windowId: 1, index: 1, groupId: -1, active: false, pinned: false },
    ]);
    mocks.tabsSendMessage.mockImplementationOnce(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    const handler = getHandler("captcha.solve");
    const resultPromise = handler({ action: "detect" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mocks.tabsCreate).toHaveBeenCalledWith({ url: "https://example.com/", active: true });
    const [tabId, message] = mocks.tabsSendMessage.mock.calls[1] as [number, { requestId: string }];
    expect(tabId).toBe(555);
    for (const listener of mocks.onMessageListeners) {
      void listener({ type: "solveCaptchaResponse", requestId: message.requestId, detected: true, clicked: false }, { tab: { id: tabId } });
    }
    expect(await resultPromise).toEqual({ detected: true, clicked: false });
    expect(mocks.tabsRemove).toHaveBeenCalledWith(555);
  });
});
