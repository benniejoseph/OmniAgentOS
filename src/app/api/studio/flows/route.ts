import { studioHandler } from "@/lib/studio/http";

export const runtime = "nodejs";
export const maxDuration = 60;
export const GET = studioHandler("flows");
export const POST = studioHandler("flows");
