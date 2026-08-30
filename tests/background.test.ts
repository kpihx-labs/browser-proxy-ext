import { beforeAll, describe, expect, mock, test } from "bun:test";

/**
 * Minimal `chrome.*` mock covering only the APIs `background.ts`'s KIND_HANDLERS touch:
 * bookmarks, tabGroups, tabs (group/query/sendMessage/onCreated), runtime, and storage.
 * Installed on `globalThis.chrome` BEFORE dynamically importing `background.ts`, because that
 * module registers `chrome.runtime.onMessage.addListener(...)` as a top-level side effect.
 */
function installChromeMock() {
  const bookmarksCreate = mock(async (bookmark: { title: string; url: string; parentId?: string }) => ({
    id: "99",
    title: bookmark.title,
    url: bookmark.url,
    parentId: bookmark.parentId,
  }));
  const bookmarksRemove = mock(async (_id: string) => undefined);
  const bookmarksGetTree = mock(async () => [{ id: "0", title: "root", children: [{ id: "1", title: "Bookmarks Bar", url: undefined, parentId: "0", children: [] }] }]);

  const tabsGroup = mock(async (_options: { tabIds: number | number[] }) => 7);
  const tabGroupsUpdate = mock(async (id: number, props: { title?: string; color?: string; collapsed?: boolean }) => ({
    id,
    title: props.title,
    color: props.color ?? "grey",
    collapsed: props.collapsed ?? false,
  }));
  const tabGroupsQuery = mock(async () => [{ id: 7, title: "Research", color: "blue", collapsed: false, windowId: 1 }]);
  const tabGroupsMove = mock(async (id: number, props: { windowId: number; index: number }) => ({ id, windowId: props.windowId }));
  const tabsQueryByGroup = mock(async (_query: { groupId?: number; active?: boolean }) => [{ id: 12, url: "https://example.com", title: "Example" }]);
  const tabsSendMessage = mock(async (_tabId: number, _message: unknown) => undefined);

  const onMessageListeners: Array<(message: unknown, sender: unknown) => unknown> = [];
  const onCreatedListeners: Array<(tab: unknown) => void> = [];
  const onAlarmListeners: Array<(alarm: { name: string }) => void> = [];
  const alarmsCreate = mock((_name: string, _info: { periodInMinutes?: number }) => undefined);
  const storageLocalGet = mock(async (_key: string) => ({}) as Record<string, unknown>);

  (globalThis as Record<string, unknown>).chrome = {
    bookmarks: { create: bookmarksCreate, remove: bookmarksRemove, getTree: bookmarksGetTree },
    tabGroups: { update: tabGroupsUpdate, query: tabGroupsQuery, move: tabGroupsMove },
    tabs: {
      group: tabsGroup,
      query: tabsQueryByGroup,
      sendMessage: tabsSendMessage,
      onCreated: {
        addListener: (fn: (tab: unknown) => void) => onCreatedListeners.push(fn),
        removeListener: (fn: (tab: unknown) => void) => {
          const index = onCreatedListeners.indexOf(fn);
          if (index >= 0) onCreatedListeners.splice(index, 1);
        },
      },
    },
    runtime: {
      onMessage: { addListener: (fn: (message: unknown, sender: unknown) => unknown) => onMessageListeners.push(fn) },
      sendMessage: mock(async () => undefined),
    },
    storage: { local: { get: storageLocalGet } },
    alarms: {
      create: alarmsCreate,
      onAlarm: { addListener: (fn: (alarm: { name: string }) => void) => onAlarmListeners.push(fn) },
    },
  };

  return {
    bookmarksCreate,
    bookmarksRemove,
    bookmarksGetTree,
    tabsGroup,
    tabGroupsUpdate,
    tabGroupsQuery,
    tabGroupsMove,
    tabsQueryByGroup,
    tabsSendMessage,
    alarmsCreate,
    onAlarmListeners,
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
  // Dynamic import so the chrome mock exists before background.ts's top-level
  // `chrome.runtime.onMessage.addListener(...)` side effect runs. `connectBridge()` also runs at
  // import time and attempts a real loopback WebSocket connection, which simply fails to connect in
  // this sandboxed test environment without affecting the handlers under test below.
  background = await import("../src/background");
});

describe("KIND_HANDLERS dispatch table", () => {
  test("bookmark.create calls chrome.bookmarks.create with the real payload and returns real data", async () => {
    const handler = getHandler("bookmark.create");
    const result = await handler({ title: "KpihX Labs", url: "https://kpihx-labs.com" });
    expect(mocks.bookmarksCreate).toHaveBeenCalledWith({ title: "KpihX Labs", url: "https://kpihx-labs.com", parentId: undefined });
    expect(result).toEqual({ id: "99", title: "KpihX Labs", url: "https://kpihx-labs.com", parentId: null });
  });

  test("bookmark.create rejects a malformed payload instead of silently stubbing a response", async () => {
    const handler = getHandler("bookmark.create");
    await expect(handler({ title: "missing url" })).rejects.toThrow();
  });

  test("bookmark.remove calls chrome.bookmarks.remove and returns real data", async () => {
    const handler = getHandler("bookmark.remove");
    const result = await handler({ id: "42" });
    expect(mocks.bookmarksRemove).toHaveBeenCalledWith("42");
    expect(result).toEqual({ id: "42", removed: true });
  });

  test("bookmark.list flattens the real chrome.bookmarks.getTree() result (not a hardcoded stub)", async () => {
    const handler = getHandler("bookmark.list");
    const result = (await handler(undefined)) as { bookmarks: unknown[] };
    expect(mocks.bookmarksGetTree).toHaveBeenCalled();
    expect(result.bookmarks.length).toBeGreaterThan(0);
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

  test("group.list queries real tab groups and their tabs", async () => {
    const handler = getHandler("group.list");
    const result = (await handler(undefined)) as { groups: unknown[] };
    expect(mocks.tabGroupsQuery).toHaveBeenCalled();
    expect(result.groups.length).toBe(1);
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
    const [, message] = mocks.tabsSendMessage.mock.calls[0] as [number, { type: string; requestId: string; scopes: string[] }];
    expect(message).toEqual({ type: "showApproval", requestId: "req-approval-1", scopes: ["bookmark.create"] });
  });

  test("handleRequest resolves without throwing for an unrecognized kind (fails closed via the daemon response path, not an exception)", async () => {
    await expect(background.handleRequest({ type: "request", id: "req-unknown-1", kind: "nonexistent.kind", payload: {} })).resolves.toBeUndefined();
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
