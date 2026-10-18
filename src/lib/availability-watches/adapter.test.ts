import { describe, expect, it } from "vitest";
import { parseDistrictAvailability } from "./adapter";
import { AvailabilityInspectInputSchema } from "./contracts";

const config = AvailabilityInspectInputSchema.parse({
  source: { provider: "district", cinemaId: "1022272", cinemaName: "PVR VR Whitefield Road Bengaluru",
    sourceUrl: "https://www.district.in/movies/pvr-vr-whitefield-road-bengaluru-CD1022272" },
  target: { date: "2026-10-19", timezone: "Asia/Kolkata", movieTitle: "Jailer 2", language: "Tamil", seatClass: "gold", latestTime: "12:00" },
});
const checkedAt = "2026-10-18T07:23:00.000Z";
function inspect(times: string[], target = config.target, checked = checkedAt) {
  const root = { query: { fromdate: target.date }, props: { pageProps: { data: {
    cinemaId: "1022272", isCSR: false, serverState: { [`1022272${target.date}`]: {
      serverTime: Date.parse(checked) / 1000,
      meta: { cinema: { id: 1022272, name: "PVR VR, Whitefield Road, Bengaluru", sessionCount: times.length } },
      arrangedSessions: [{ cinemaId: 1022272, data: { label: "Jailer 2" }, sessions: times.map((showTime, i) => ({
        cid: 1022272, sid: String(43359 + i), showTime, lang: "Tamil", scrnFmt: "2D", disableClick: false,
        areas: [{ code: "G", label: "GOLD", sAvail: 32, disableClick: false, price: 900 }],
      })) }],
    } },
  } } } };
  return parseDistrictAvailability(`<script id="__NEXT_DATA__">${JSON.stringify(root)}</script>`, { ...config, target }, {
    checkedAt: checked, sourceUrl: `${config.source.sourceUrl}?fromdate=${target.date}`, sourceSha256: "a".repeat(64),
  });
}

describe("District UTC showtimes and India booking windows", () => {
  // Public listing captured on 2026-10-18. District rendered these three UTC
  // fields as 08:35 AM, 12:00 PM and 03:25 PM GOLD for the same session IDs.
  it("matches the captured 08:35 and noon shows, excluding 15:25", () => {
    const result = inspect(["2026-10-19T03:05", "2026-10-19T06:30", "2026-10-19T09:55"]);
    expect(result.matchingSessions).toBe(2);
    expect(result.matches.map(({ sessionId, localTime, startsAt }) => ({ sessionId, localTime, startsAt }))).toEqual([
      { sessionId: "43359", localTime: "08:35", startsAt: "2026-10-19T03:05:00.000Z" },
      { sessionId: "43360", localTime: "12:00", startsAt: "2026-10-19T06:30:00.000Z" },
    ]);
  });
  it("applies both inclusive bounds in India time", () => {
    expect(inspect(["2026-10-19T03:04", "2026-10-19T03:05", "2026-10-19T06:30", "2026-10-19T06:31"],
      { ...config.target, earliestTime: "08:35" }).matches.map(row => row.localTime)).toEqual(["08:35", "12:00"]);
  });
  it("matches an India date even when its UTC timestamp is the previous day", () => {
    expect(inspect(["2026-10-18T18:45"]).matches[0]).toMatchObject({ localTime: "00:15", startsAt: "2026-10-18T18:45:00.000Z" });
  });
  it("excludes sessions on another India calendar day", () => {
    expect(inspect(["2026-10-18T18:29", "2026-10-19T18:30"], { ...config.target, latestTime: null }).outcome).toBe("not_listed");
  });
  it("does not expire a future session by subtracting the India offset twice", () => {
    expect(inspect(["2026-10-19T03:05"], config.target, "2026-10-19T02:00:00.000Z").outcome).toBe("available");
    expect(inspect(["2026-10-19T03:05"], config.target, "2026-10-19T03:05:00.000Z").outcome).toBe("not_listed");
  });
  it.each(["2026-02-30T03:05", "2026-10-19T24:00", "2026-10-19T03:65"])("refuses invalid source calendar or clock fields: %s", time => {
    expect(() => inspect([time])).toThrow("The public booking data could not be matched");
  });
});
