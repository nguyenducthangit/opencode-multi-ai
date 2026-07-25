import { describe, expect, it } from "vitest";

import { classifyKiroSdkError } from "../lib/providers/kiro/request/classify-error.js";

describe("classifyKiroSdkError", () => {
  it("maps SDK metadata statuses to the shared taxonomy", () => {
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 400 }, message: "bad model" }),
    ).toEqual({ kind: "unknown-client-error", status: 400 });
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 401 } }),
    ).toEqual({ kind: "auth-dead" });
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 402 } }),
    ).toEqual({ kind: "quota-exhausted" });
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 403 } }),
    ).toEqual({ kind: "entitlement-blocked" });
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 429 } }),
    ).toMatchObject({ kind: "transient" });
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 503 } }),
    ).toEqual({ kind: "server" });
    expect(classifyKiroSdkError(new Error("fetch failed"))).toEqual({
      kind: "network",
    });
  });

  it("keeps a throttling 429 transient even when its message says 'rate limit'", () => {
    // AWS CodeWhisperer throttles surface as ThrottlingException / HTTP 429 and
    // the message routinely contains 'limit'. Status precedence must keep this
    // transient so the (often single) account is not benched for 15 minutes.
    expect(
      classifyKiroSdkError({
        name: "ThrottlingException",
        message: "Rate limit exceeded, please try again later",
        $metadata: { httpStatusCode: 429 },
      }),
    ).toMatchObject({ kind: "transient" });
    expect(
      classifyKiroSdkError({
        name: "ThrottlingException",
        message: "Too many requests",
      }),
    ).toMatchObject({ kind: "transient" });
    expect(
      classifyKiroSdkError({ message: "Request rate exceeded" }),
    ).toMatchObject({ kind: "transient" });
  });

  it("classifies a genuine subscription/usage cap as quota-exhausted", () => {
    expect(
      classifyKiroSdkError({
        message: "You have reached your monthly request limit",
        $metadata: { httpStatusCode: 429 },
      }),
    ).toEqual({ kind: "quota-exhausted" });
    expect(
      classifyKiroSdkError({ $metadata: { httpStatusCode: 402 } }),
    ).toEqual({ kind: "quota-exhausted" });
    expect(
      classifyKiroSdkError({ message: "monthly limit reached" }),
    ).toEqual({ kind: "quota-exhausted" });
    expect(
      classifyKiroSdkError({ message: "out of free credits" }),
    ).toEqual({ kind: "quota-exhausted" });
  });
});
