/**
 * Internal `chrome.runtime` messaging contract between `background.ts` (the sole holder of the
 * daemon WebSocket) and `content.ts` (the only place with page/DOM access). This is distinct from
 * `protocol.ts`, which defines the *public*, daemon-facing bridge protocol described in
 * `CONTRACT.md`. Nothing here is sent over the WebSocket; it only travels through
 * `chrome.tabs.sendMessage` / `chrome.runtime.sendMessage` inside the browser process.
 */

/** Redacted category labels shown to the user for a daemon-issued approval request. */
export type ApprovalScope = string;

/** Background -> content: show a redacted approve/deny prompt before a daemon action executes. */
export interface ShowApprovalMessage {
  readonly type: "showApproval";
  readonly requestId: string;
  readonly scopes: readonly ApprovalScope[];
}

/** Content -> background: the user's approve/deny decision for one `ShowApprovalMessage`. */
export interface ApprovalResponseMessage {
  readonly type: "approvalResponse";
  readonly requestId: string;
  readonly approved: boolean;
}

/** Background -> content: ask the user a free-text or password-masked question. */
export interface ShowAskMessage {
  readonly type: "showAsk";
  readonly requestId: string;
  readonly question: string;
  readonly inputType: "text" | "password";
}

/** Content -> background: the user's typed answer to one `ShowAskMessage`. */
export interface AskResponseMessage {
  readonly type: "askResponse";
  readonly requestId: string;
  readonly answer: string;
}

/** Background -> content: heuristically dismiss cookie/consent overlays on the active page. */
export interface DismissOverlaysMessage {
  readonly type: "dismissOverlays";
  readonly requestId: string;
}

/** Content -> background: how many overlay elements were dismissed. */
export interface DismissOverlaysResponseMessage {
  readonly type: "dismissOverlaysResponse";
  readonly requestId: string;
  readonly dismissed: number;
}

/** The only supported best-effort captcha operations. */
export type CaptchaAction = "detect" | "click_checkbox" | "click_grid";

/** Background -> content: best-effort, same-origin-only captcha detection/interaction. */
export interface SolveCaptchaMessage {
  readonly type: "solveCaptcha";
  readonly requestId: string;
  readonly action: CaptchaAction;
  readonly cells?: readonly number[];
}

/** Content -> background: captcha detection/interaction outcome, always honest about scope. */
export interface SolveCaptchaResponseMessage {
  readonly type: "solveCaptchaResponse";
  readonly requestId: string;
  readonly detected: boolean;
  readonly clicked: boolean;
  readonly reason?: string;
}

/** Background -> content: set a native `<input type="date">` field and fire change events. */
export interface SetDateMessage {
  readonly type: "setDate";
  readonly requestId: string;
  readonly selector: string;
  readonly value: string;
}

/** Content -> background: whether the native date field was found and set. */
export interface SetDateResponseMessage {
  readonly type: "setDateResponse";
  readonly requestId: string;
  readonly applied: boolean;
}

/** Background -> content: heuristically type into and select from a combobox/autocomplete widget. */
export interface SetComboboxMessage {
  readonly type: "setCombobox";
  readonly requestId: string;
  readonly selector: string;
  readonly value: string;
}

/** Content -> background: whether a matching option was found and clicked. */
export interface SetComboboxResponseMessage {
  readonly type: "setComboboxResponse";
  readonly requestId: string;
  readonly matched: boolean;
}

/** Background -> content: synthesize a drag-and-drop file upload onto a drop target. */
export interface DropFileMessage {
  readonly type: "dropFile";
  readonly requestId: string;
  readonly selector: string;
  readonly filename: string;
  readonly contentBase64: string;
  readonly mimeType: string;
}

/** Content -> background: whether the synthetic drop event sequence was dispatched. */
export interface DropFileResponseMessage {
  readonly type: "dropFileResponse";
  readonly requestId: string;
  readonly dropped: boolean;
}

/** Union of every background -> content command. */
export type BackgroundToContentMessage =
  | ShowApprovalMessage
  | ShowAskMessage
  | DismissOverlaysMessage
  | SolveCaptchaMessage
  | SetDateMessage
  | SetComboboxMessage
  | DropFileMessage;

/** Union of every content -> background reply. */
export type ContentToBackgroundMessage =
  | ApprovalResponseMessage
  | AskResponseMessage
  | DismissOverlaysResponseMessage
  | SolveCaptchaResponseMessage
  | SetDateResponseMessage
  | SetComboboxResponseMessage
  | DropFileResponseMessage;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const CAPTCHA_ACTIONS: readonly CaptchaAction[] = ["detect", "click_checkbox", "click_grid"];

/**
 * Purpose: verify that a value is a non-null, non-array plain object safe to index by string keys.
 * Args: `value` is an untrusted value of any shape.
 * Returns: `true` when `value` can be treated as `Record<string, unknown>`.
 * Examples: `isPlainRecord({ a: 1 })` is `true`; `isPlainRecord([1, 2])` is `false`.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Purpose: validate the bounded, redaction-safe request identifier shared by every message here.
 * Args: `value` is an untrusted field pulled from a runtime message.
 * Returns: `true` when `value` is a 1-128 character id built from the allowed character set.
 * Examples: `isRequestId("r-1")` is `true`; `isRequestId("")` is `false`.
 */
function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

/**
 * Purpose: share the `type` + `requestId` validation common to every content-script reply message.
 * Args: `value` is an untrusted runtime message; `type` is the exact literal expected; `extra` checks the remaining type-specific fields.
 * Returns: `true` when `value` has the exact `type`, a valid `requestId`, and `extra` accepts it.
 * Examples: `isReplyShape({type:"askResponse",requestId:"r-1",answer:"x"}, "askResponse", (r) => typeof r.answer === "string")` is `true`; `isReplyShape({type:"askResponse"}, "askResponse", () => true)` is `false`.
 */
function isReplyShape<T extends string>(value: unknown, type: T, extra: (record: Record<string, unknown>) => boolean): value is { type: T; requestId: string } {
  if (!isPlainRecord(value)) return false;
  return value.type === type && isRequestId(value.requestId) && extra(value);
}

/**
 * Purpose: build the redacted prompt sent to a tab's content script before a gated daemon action executes.
 * Args: `requestId` is the daemon-issued protocol id; `scopes` names the action category, never a raw payload.
 * Returns: a `ShowApprovalMessage` ready for `chrome.tabs.sendMessage`.
 * Examples: `buildShowApprovalMessage("r-1", ["bookmark.create"])`; `buildShowApprovalMessage("r-2", ["group.move"])`.
 */
export function buildShowApprovalMessage(requestId: string, scopes: readonly string[]): ShowApprovalMessage {
  return { type: "showApproval", requestId, scopes };
}

/**
 * Purpose: validate a `showApproval` prompt before rendering it in the page overlay.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid, non-empty-scopes `ShowApprovalMessage`.
 * Examples: `isShowApprovalMessage({type:"showApproval",requestId:"r-1",scopes:["tabs"]})` is `true`; `isShowApprovalMessage({type:"showApproval",requestId:"r-1",scopes:[]})` is `false`.
 */
export function isShowApprovalMessage(value: unknown): value is ShowApprovalMessage {
  if (!isPlainRecord(value)) return false;
  return value.type === "showApproval" && isRequestId(value.requestId) && Array.isArray(value.scopes) && value.scopes.length > 0 && value.scopes.every((scope) => typeof scope === "string");
}

/**
 * Purpose: build the user's approve/deny decision sent back from the page overlay.
 * Args: `requestId` identifies the prompt; `approved` is the click decision.
 * Returns: an `ApprovalResponseMessage`.
 * Examples: `buildApprovalResponseMessage("r-1", true)`; `buildApprovalResponseMessage("r-1", false)`.
 */
export function buildApprovalResponseMessage(requestId: string, approved: boolean): ApprovalResponseMessage {
  return { type: "approvalResponse", requestId, approved };
}

/**
 * Purpose: validate an approval decision reported by the content script.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for an exact 3-key `ApprovalResponseMessage`.
 * Examples: `isApprovalResponseMessage({type:"approvalResponse",requestId:"r-1",approved:true})` is `true`; `isApprovalResponseMessage({type:"approvalResponse",requestId:"r-1",approved:true,extra:1})` is `false`.
 */
export function isApprovalResponseMessage(value: unknown): value is ApprovalResponseMessage {
  return isReplyShape(value, "approvalResponse", (record) => Object.keys(record).length === 3 && typeof record.approved === "boolean");
}

/**
 * Purpose: build a free-text/password question prompt for the active tab.
 * Args: `requestId` is the correlation id; `question` is the prompt text; `inputType` selects masking.
 * Returns: a `ShowAskMessage`.
 * Examples: `buildShowAskMessage("r-1", "What is the 2FA code?", "text")`; `buildShowAskMessage("r-2", "Confirm password", "password")`.
 */
export function buildShowAskMessage(requestId: string, question: string, inputType: "text" | "password"): ShowAskMessage {
  return { type: "showAsk", requestId, question, inputType };
}

/**
 * Purpose: validate a `showAsk` prompt before rendering its input overlay.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `ShowAskMessage`.
 * Examples: `isShowAskMessage({type:"showAsk",requestId:"r-1",question:"Code?",inputType:"text"})` is `true`; `isShowAskMessage({type:"showAsk",requestId:"r-1",question:"Code?",inputType:"hidden"})` is `false`.
 */
export function isShowAskMessage(value: unknown): value is ShowAskMessage {
  if (!isPlainRecord(value)) return false;
  return value.type === "showAsk" && isRequestId(value.requestId) && typeof value.question === "string" && (value.inputType === "text" || value.inputType === "password");
}

/**
 * Purpose: build the user's typed answer to a `showAsk` prompt.
 * Args: `requestId` identifies the prompt; `answer` is the submitted text.
 * Returns: an `AskResponseMessage`.
 * Examples: `buildAskResponseMessage("r-1", "123456")`; `buildAskResponseMessage("r-2", "")`.
 */
export function buildAskResponseMessage(requestId: string, answer: string): AskResponseMessage {
  return { type: "askResponse", requestId, answer };
}

/**
 * Purpose: validate the content script's answer to a `showAsk` prompt.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `AskResponseMessage`.
 * Examples: `isAskResponseMessage({type:"askResponse",requestId:"r-1",answer:"hi"})` is `true`; `isAskResponseMessage({type:"askResponse",requestId:"r-1"})` is `false`.
 */
export function isAskResponseMessage(value: unknown): value is AskResponseMessage {
  return isReplyShape(value, "askResponse", (record) => typeof record.answer === "string");
}

/**
 * Purpose: build the request to heuristically dismiss cookie/consent overlays on the active page.
 * Args: `requestId` is the correlation id.
 * Returns: a `DismissOverlaysMessage`.
 * Examples: `buildDismissOverlaysMessage("r-1")`; `buildDismissOverlaysMessage("r-2")`.
 */
export function buildDismissOverlaysMessage(requestId: string): DismissOverlaysMessage {
  return { type: "dismissOverlays", requestId };
}

/**
 * Purpose: validate a `dismissOverlays` command before running the DOM heuristic scan.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `DismissOverlaysMessage`.
 * Examples: `isDismissOverlaysMessage({type:"dismissOverlays",requestId:"r-1"})` is `true`; `isDismissOverlaysMessage({type:"dismissOverlays"})` is `false`.
 */
export function isDismissOverlaysMessage(value: unknown): value is DismissOverlaysMessage {
  if (!isPlainRecord(value)) return false;
  return value.type === "dismissOverlays" && isRequestId(value.requestId);
}

/**
 * Purpose: build the count of overlay elements dismissed by the content script.
 * Args: `requestId` identifies the command; `dismissed` is the element count removed or accepted.
 * Returns: a `DismissOverlaysResponseMessage`.
 * Examples: `buildDismissOverlaysResponseMessage("r-1", 2)`; `buildDismissOverlaysResponseMessage("r-2", 0)`.
 */
export function buildDismissOverlaysResponseMessage(requestId: string, dismissed: number): DismissOverlaysResponseMessage {
  return { type: "dismissOverlaysResponse", requestId, dismissed };
}

/**
 * Purpose: validate the content script's overlay-dismissal outcome.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `DismissOverlaysResponseMessage`.
 * Examples: `isDismissOverlaysResponseMessage({type:"dismissOverlaysResponse",requestId:"r-1",dismissed:1})` is `true`; `isDismissOverlaysResponseMessage({type:"dismissOverlaysResponse",requestId:"r-1",dismissed:"1"})` is `false`.
 */
export function isDismissOverlaysResponseMessage(value: unknown): value is DismissOverlaysResponseMessage {
  return isReplyShape(value, "dismissOverlaysResponse", (record) => typeof record.dismissed === "number");
}

/**
 * Purpose: build a best-effort, same-origin-only captcha detection/interaction command.
 * Args: `requestId` is the correlation id; `action` selects the operation; `cells` names grid cells for a future, currently unimplemented, grid solver.
 * Returns: a `SolveCaptchaMessage`.
 * Examples: `buildSolveCaptchaMessage("r-1", "detect")`; `buildSolveCaptchaMessage("r-2", "click_checkbox")`.
 */
export function buildSolveCaptchaMessage(requestId: string, action: CaptchaAction, cells?: readonly number[]): SolveCaptchaMessage {
  return cells === undefined ? { type: "solveCaptcha", requestId, action } : { type: "solveCaptcha", requestId, action, cells };
}

/**
 * Purpose: validate a `solveCaptcha` command before running the DOM heuristic.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `SolveCaptchaMessage`.
 * Examples: `isSolveCaptchaMessage({type:"solveCaptcha",requestId:"r-1",action:"detect"})` is `true`; `isSolveCaptchaMessage({type:"solveCaptcha",requestId:"r-1",action:"solve_all"})` is `false`.
 */
export function isSolveCaptchaMessage(value: unknown): value is SolveCaptchaMessage {
  if (!isPlainRecord(value)) return false;
  if (value.type !== "solveCaptcha" || !isRequestId(value.requestId) || typeof value.action !== "string") return false;
  if (!CAPTCHA_ACTIONS.includes(value.action as CaptchaAction)) return false;
  return value.cells === undefined || (Array.isArray(value.cells) && value.cells.every((cell) => typeof cell === "number"));
}

/**
 * Purpose: build the honest outcome of a captcha detection/interaction attempt.
 * Args: `requestId` identifies the command; `detected` reports iframe presence; `clicked` reports a dispatched click; `reason` explains partial/no support.
 * Returns: a `SolveCaptchaResponseMessage`.
 * Examples: `buildSolveCaptchaResponseMessage("r-1", true, false, "grid solving not implemented")`; `buildSolveCaptchaResponseMessage("r-2", false, false)`.
 */
export function buildSolveCaptchaResponseMessage(requestId: string, detected: boolean, clicked: boolean, reason?: string): SolveCaptchaResponseMessage {
  return reason === undefined ? { type: "solveCaptchaResponse", requestId, detected, clicked } : { type: "solveCaptchaResponse", requestId, detected, clicked, reason };
}

/**
 * Purpose: validate the content script's captcha detection/interaction outcome.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `SolveCaptchaResponseMessage`.
 * Examples: `isSolveCaptchaResponseMessage({type:"solveCaptchaResponse",requestId:"r-1",detected:true,clicked:false})` is `true`; `isSolveCaptchaResponseMessage({type:"solveCaptchaResponse",requestId:"r-1",detected:"yes",clicked:false})` is `false`.
 */
export function isSolveCaptchaResponseMessage(value: unknown): value is SolveCaptchaResponseMessage {
  return isReplyShape(
    value,
    "solveCaptchaResponse",
    (record) => typeof record.detected === "boolean" && typeof record.clicked === "boolean" && (record.reason === undefined || typeof record.reason === "string")
  );
}

/**
 * Purpose: build a command to set a native `<input type="date">` field and fire change events.
 * Args: `requestId` is the correlation id; `selector` targets the field; `value` is the ISO date string to apply.
 * Returns: a `SetDateMessage`.
 * Examples: `buildSetDateMessage("r-1", "#birthdate", "1990-01-01")`; `buildSetDateMessage("r-2", "input[name=start]", "2026-08-29")`.
 */
export function buildSetDateMessage(requestId: string, selector: string, value: string): SetDateMessage {
  return { type: "setDate", requestId, selector, value };
}

/**
 * Purpose: validate a `setDate` command before touching the DOM.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `SetDateMessage`.
 * Examples: `isSetDateMessage({type:"setDate",requestId:"r-1",selector:"#d",value:"2026-01-01"})` is `true`; `isSetDateMessage({type:"setDate",requestId:"r-1"})` is `false`.
 */
export function isSetDateMessage(value: unknown): value is SetDateMessage {
  if (!isPlainRecord(value)) return false;
  return value.type === "setDate" && isRequestId(value.requestId) && typeof value.selector === "string" && typeof value.value === "string";
}

/**
 * Purpose: build the outcome of a native date-field assignment.
 * Args: `requestId` identifies the command; `applied` reports whether the field was found and set.
 * Returns: a `SetDateResponseMessage`.
 * Examples: `buildSetDateResponseMessage("r-1", true)`; `buildSetDateResponseMessage("r-2", false)`.
 */
export function buildSetDateResponseMessage(requestId: string, applied: boolean): SetDateResponseMessage {
  return { type: "setDateResponse", requestId, applied };
}

/**
 * Purpose: validate the content script's date-field assignment outcome.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `SetDateResponseMessage`.
 * Examples: `isSetDateResponseMessage({type:"setDateResponse",requestId:"r-1",applied:true})` is `true`; `isSetDateResponseMessage({type:"setDateResponse",requestId:"r-1",applied:"true"})` is `false`.
 */
export function isSetDateResponseMessage(value: unknown): value is SetDateResponseMessage {
  return isReplyShape(value, "setDateResponse", (record) => typeof record.applied === "boolean");
}

/**
 * Purpose: build a command to heuristically type into and select from a combobox/autocomplete widget.
 * Args: `requestId` is the correlation id; `selector` targets the widget; `value` is the text to type and match.
 * Returns: a `SetComboboxMessage`.
 * Examples: `buildSetComboboxMessage("r-1", "#country", "France")`; `buildSetComboboxMessage("r-2", "[role=combobox]", "Cameroon")`.
 */
export function buildSetComboboxMessage(requestId: string, selector: string, value: string): SetComboboxMessage {
  return { type: "setCombobox", requestId, selector, value };
}

/**
 * Purpose: validate a `setCombobox` command before touching the DOM.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `SetComboboxMessage`.
 * Examples: `isSetComboboxMessage({type:"setCombobox",requestId:"r-1",selector:"#c",value:"x"})` is `true`; `isSetComboboxMessage({type:"setCombobox",requestId:"r-1"})` is `false`.
 */
export function isSetComboboxMessage(value: unknown): value is SetComboboxMessage {
  if (!isPlainRecord(value)) return false;
  return value.type === "setCombobox" && isRequestId(value.requestId) && typeof value.selector === "string" && typeof value.value === "string";
}

/**
 * Purpose: build the outcome of a combobox type-and-select attempt.
 * Args: `requestId` identifies the command; `matched` reports whether a matching option was clicked.
 * Returns: a `SetComboboxResponseMessage`.
 * Examples: `buildSetComboboxResponseMessage("r-1", true)`; `buildSetComboboxResponseMessage("r-2", false)`.
 */
export function buildSetComboboxResponseMessage(requestId: string, matched: boolean): SetComboboxResponseMessage {
  return { type: "setComboboxResponse", requestId, matched };
}

/**
 * Purpose: validate the content script's combobox type-and-select outcome.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `SetComboboxResponseMessage`.
 * Examples: `isSetComboboxResponseMessage({type:"setComboboxResponse",requestId:"r-1",matched:true})` is `true`; `isSetComboboxResponseMessage({type:"setComboboxResponse",requestId:"r-1",matched:1})` is `false`.
 */
export function isSetComboboxResponseMessage(value: unknown): value is SetComboboxResponseMessage {
  return isReplyShape(value, "setComboboxResponse", (record) => typeof record.matched === "boolean");
}

/**
 * Purpose: build a command to synthesize a drag-and-drop file upload onto a drop target.
 * Args: `requestId` is the correlation id; `selector` targets the drop zone; `filename`/`mimeType` describe the file; `contentBase64` is its encoded bytes.
 * Returns: a `DropFileMessage`.
 * Examples: `buildDropFileMessage("r-1", "#dropzone", "a.png", "iVBORw0KGgo=", "image/png")`; `buildDropFileMessage("r-2", "[data-drop]", "doc.pdf", "JVBERi0=", "application/pdf")`.
 */
export function buildDropFileMessage(requestId: string, selector: string, filename: string, contentBase64: string, mimeType: string): DropFileMessage {
  return { type: "dropFile", requestId, selector, filename, contentBase64, mimeType };
}

/**
 * Purpose: validate a `dropFile` command before decoding and dispatching synthetic drop events.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `DropFileMessage`.
 * Examples: `isDropFileMessage({type:"dropFile",requestId:"r-1",selector:"#d",filename:"a.png",contentBase64:"AA==",mimeType:"image/png"})` is `true`; `isDropFileMessage({type:"dropFile",requestId:"r-1"})` is `false`.
 */
export function isDropFileMessage(value: unknown): value is DropFileMessage {
  if (!isPlainRecord(value)) return false;
  return (
    value.type === "dropFile" &&
    isRequestId(value.requestId) &&
    typeof value.selector === "string" &&
    typeof value.filename === "string" &&
    typeof value.contentBase64 === "string" &&
    typeof value.mimeType === "string"
  );
}

/**
 * Purpose: build the outcome of a synthetic file-drop attempt.
 * Args: `requestId` identifies the command; `dropped` reports whether the target was found and the drop sequence dispatched.
 * Returns: a `DropFileResponseMessage`.
 * Examples: `buildDropFileResponseMessage("r-1", true)`; `buildDropFileResponseMessage("r-2", false)`.
 */
export function buildDropFileResponseMessage(requestId: string, dropped: boolean): DropFileResponseMessage {
  return { type: "dropFileResponse", requestId, dropped };
}

/**
 * Purpose: validate the content script's synthetic file-drop outcome.
 * Args: `value` is an untrusted runtime message.
 * Returns: `true` for a syntactically valid `DropFileResponseMessage`.
 * Examples: `isDropFileResponseMessage({type:"dropFileResponse",requestId:"r-1",dropped:true})` is `true`; `isDropFileResponseMessage({type:"dropFileResponse",requestId:"r-1",dropped:"true"})` is `false`.
 */
export function isDropFileResponseMessage(value: unknown): value is DropFileResponseMessage {
  return isReplyShape(value, "dropFileResponse", (record) => typeof record.dropped === "boolean");
}
