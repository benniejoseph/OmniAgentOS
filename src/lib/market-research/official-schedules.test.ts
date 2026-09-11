import { describe, expect, it } from "vitest";

import { highImpactEventCatalog } from "@/lib/market-research/event-catalog";
import {
  parseBeaSchedule,
  parseCensusSchedule,
  parseFederalReserveSchedule,
} from "@/lib/market-research/official-schedules";

describe("first-party market schedule adapters", () => {
  it("maps only the reviewed Census retail release", () => {
    const retail = highImpactEventCatalog.find(({ eventKey }) =>
      eventKey === "us.retail_sales"
    )!;
    const html = `
      <table><tr>
        <td><a href="/retail">Advance Monthly Sales for Retail and Food Services</a></td>
        <td sorttable_customkey="202604010830">April 1, 2026</td>
        <td>8:30 AM</td>
      </tr><tr>
        <td>Unreviewed Census Release</td>
        <td sorttable_customkey="202604021000">April 2, 2026</td>
      </tr></table>`;

    expect(parseCensusSchedule(html, retail)).toEqual([
      expect.objectContaining({
        source: "census",
        eventKey: "us.retail_sales",
        releaseDate: "2026-04-01",
        occurredAt: "2026-04-01T12:30:00.000Z",
      }),
    ]);
  });

  it("maps national BEA releases and excludes state GDP", () => {
    const events = highImpactEventCatalog.filter(({ eventKey }) =>
      eventKey === "us.gdp" || eventKey === "us.personal_income_outlays"
    );
    const html = `
      <table><thead><tr><th>Year 2026</th></tr></thead><tbody>
        <tr class="scheduled-releases-type-press">
          <td><div class="release-date">January 22</div><small>8:30 AM</small></td>
          <td class="release-title views-field">Gross Domestic Product, 3rd Quarter 2025 (Updated Estimate)</td>
          <td><a href="/news/2026/gdp">View</a></td>
        </tr>
        <tr><td><div class="release-date">January 23</div><small>8:30 AM</small></td>
          <td class="release-title">Gross Domestic Product by State and Personal Income by State, 3rd Quarter 2025</td></tr>
        <tr><td><div class="release-date">February 20</div><small>8:30 AM</small></td>
          <td class="release-title">Personal Income and Outlays, December 2025</td></tr>
      </tbody></table>`;

    expect(parseBeaSchedule(html, events)).toEqual([
      expect.objectContaining({
        source: "bea",
        eventKey: "us.gdp",
        releaseDate: "2026-01-22",
        occurredAt: "2026-01-22T13:30:00.000Z",
        sourceUrl: "https://www.bea.gov/news/2026/gdp",
      }),
      expect.objectContaining({
        source: "bea",
        eventKey: "us.personal_income_outlays",
        releaseDate: "2026-02-20",
      }),
    ]);
  });

  it("uses the final meeting day and the official 2 PM Eastern statement time", () => {
    const fomc = highImpactEventCatalog.find(({ eventKey }) =>
      eventKey === "us.fomc"
    )!;
    const html = `
      <div class="panel panel-default"><div class="panel-heading"><h4><a>2026 FOMC Meetings</a></h4></div>
        <div class="row fomc-meeting" ">
          <div class="fomc-meeting__month"><strong>January</strong></div>
          <div class="fomc-meeting__date">27-28</div>
          <a href="/newsevents/pressreleases/monetary20260128a.htm">HTML</a>
        </div>
        <div class="fomc-meeting--shaded row fomc-meeting" ">
          <div class="fomc-meeting--shaded fomc-meeting__month"><strong>March</strong></div>
          <div class="fomc-meeting__date">17-18*</div>
        </div>
      </div>`;

    expect(parseFederalReserveSchedule(html, fomc)).toEqual([
      expect.objectContaining({
        source: "federal_reserve",
        eventKey: "us.fomc",
        releaseDate: "2026-01-28",
        occurredAt: "2026-01-28T19:00:00.000Z",
        sourceUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260128a.htm",
      }),
      expect.objectContaining({
        releaseDate: "2026-03-18",
        occurredAt: "2026-03-18T18:00:00.000Z",
      }),
    ]);
  });
});
