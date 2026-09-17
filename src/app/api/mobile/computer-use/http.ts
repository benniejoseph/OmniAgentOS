import { mobileError } from "@/lib/auth/mobile-http";
import {
  LocalComputerCommandError,
  LocalComputerUnavailableError,
} from "@/lib/local-computer/store";
import { SecurityPolicyError } from "@/lib/security/context";

export function localComputerInvalidRequest(message: string) {
  return mobileError(400, "invalid_request", message);
}

export function localComputerErrorResponse(error: unknown) {
  if (error instanceof SecurityPolicyError) {
    return mobileError(
      error.status,
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
    );
  }
  if (error instanceof LocalComputerUnavailableError) {
    return mobileError(409, "computer_unavailable", error.message);
  }
  if (error instanceof LocalComputerCommandError) {
    return mobileError(409, error.code, error.message);
  }
  return mobileError(
    503,
    "computer_use_unavailable",
    "Local Computer Use cannot be safely processed right now.",
  );
}
