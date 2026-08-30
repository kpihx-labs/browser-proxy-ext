import { expect, test } from "bun:test";
import {
  buildApprovalResponseMessage,
  buildAskResponseMessage,
  buildDismissOverlaysResponseMessage,
  buildDropFileResponseMessage,
  buildSetComboboxResponseMessage,
  buildSetDateResponseMessage,
  buildShowApprovalMessage,
  buildShowAskMessage,
  buildSolveCaptchaResponseMessage,
  isApprovalResponseMessage,
  isAskResponseMessage,
  isDismissOverlaysResponseMessage,
  isDropFileResponseMessage,
  isSetComboboxResponseMessage,
  isSetDateResponseMessage,
  isShowApprovalMessage,
  isShowAskMessage,
  isSolveCaptchaResponseMessage,
} from "../src/messages";

// This is the confirmed fix for the pre-existing approval-overlay message-shape mismatch:
// background.ts now builds the exact same shape content.ts validates (requestId/scopes), instead
// of the old id/kind shape that isApprovalPrompt() always rejected.
test("showApproval round trip: background's builder output is accepted by content's validator", () => {
  const messageBackgroundWouldSend = buildShowApprovalMessage("r-1", ["bookmark.create"]);
  expect(messageBackgroundWouldSend).toEqual({ type: "showApproval", requestId: "r-1", scopes: ["bookmark.create"] });
  expect(isShowApprovalMessage(messageBackgroundWouldSend)).toBe(true);
});

test("showApproval validator rejects the old, mismatched id/kind shape", () => {
  expect(isShowApprovalMessage({ type: "showApproval", id: "r-1", kind: "bookmark.create" })).toBe(false);
});

test("approvalResponse round trip: content's builder output is accepted by background's validator", () => {
  const messageContentWouldSend = buildApprovalResponseMessage("r-1", true);
  expect(messageContentWouldSend).toEqual({ type: "approvalResponse", requestId: "r-1", approved: true });
  expect(isApprovalResponseMessage(messageContentWouldSend)).toBe(true);
});

test("approvalResponse validator rejects the old, mismatched id-keyed shape", () => {
  expect(isApprovalResponseMessage({ type: "approvalResponse", id: "r-1", approved: true })).toBe(false);
});

test("showAsk / askResponse round trip", () => {
  const ask = buildShowAskMessage("r-2", "2FA code?", "text");
  expect(isShowAskMessage(ask)).toBe(true);
  const answer = buildAskResponseMessage("r-2", "123456");
  expect(isAskResponseMessage(answer)).toBe(true);
});

test("dismissOverlaysResponse round trip", () => {
  const reply = buildDismissOverlaysResponseMessage("r-3", 2);
  expect(isDismissOverlaysResponseMessage(reply)).toBe(true);
});

test("solveCaptchaResponse round trip, with and without a reason", () => {
  expect(isSolveCaptchaResponseMessage(buildSolveCaptchaResponseMessage("r-4", true, false, "grid solving not implemented"))).toBe(true);
  expect(isSolveCaptchaResponseMessage(buildSolveCaptchaResponseMessage("r-4", false, false))).toBe(true);
});

test("setDateResponse / setComboboxResponse / dropFileResponse round trips", () => {
  expect(isSetDateResponseMessage(buildSetDateResponseMessage("r-5", true))).toBe(true);
  expect(isSetComboboxResponseMessage(buildSetComboboxResponseMessage("r-6", false))).toBe(true);
  expect(isDropFileResponseMessage(buildDropFileResponseMessage("r-7", true))).toBe(true);
});

test("validators fail closed on malformed input", () => {
  expect(isShowApprovalMessage(null)).toBe(false);
  expect(isShowApprovalMessage([])).toBe(false);
  expect(isShowApprovalMessage({ type: "showApproval", requestId: "", scopes: ["x"] })).toBe(false);
  expect(isShowApprovalMessage({ type: "showApproval", requestId: "r-1", scopes: [] })).toBe(false);
  expect(isApprovalResponseMessage({ type: "approvalResponse", requestId: "r-1", approved: true, extra: 1 })).toBe(false);
});
