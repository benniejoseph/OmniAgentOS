import {
  CustomerAccountConflictError,
  CustomerAccountNotFoundError,
} from "@/lib/customer-success/store";
import { CustomerAccountWriteDeniedError } from "@/lib/app-services/customer-accounts";
import { SharedContextAuthorityError } from "@/lib/memory/shared-context";

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

export function customerAccountFailureResponse(
  error: unknown,
  operation: string,
) {
  if (error instanceof CustomerAccountNotFoundError) {
    return Response.json(
      { error: error.message },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  if (error instanceof CustomerAccountConflictError) {
    return Response.json(
      { error: error.message },
      { status: 409, headers: privateNoStoreHeaders },
    );
  }
  if (error instanceof CustomerAccountWriteDeniedError) {
    return Response.json(
      { error: error.message },
      { status: 403, headers: privateNoStoreHeaders },
    );
  }
  if (error instanceof SharedContextAuthorityError) {
    return Response.json(
      { error: error.message },
      { status: error.code === "postgres_required" ? 503 : 404, headers: privateNoStoreHeaders },
    );
  }
  console.error(`Customer account ${operation} failed`, error);
  return Response.json(
    { error: `Customer account ${operation} failed.` },
    { status: 500, headers: privateNoStoreHeaders },
  );
}
