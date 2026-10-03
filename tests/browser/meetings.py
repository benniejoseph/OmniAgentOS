#!/usr/bin/env python3
"""Meetings lifecycle checks with exact, wholly intercepted synthetic effects.

Run serially against the shared isolated preview. No provider, Calendar, media,
WorkItem, draft or application mutation reaches the local application server.
"""

import argparse
import copy
import json
from pathlib import Path
import re
import time

from playwright.sync_api import expect, sync_playwright

from meetings_fixtures import (CREATED, EMAIL, GUEST, LONG, MAIN, MEDIA, OTHER, OUTSIDE, OWNER,
                               POLICY, RECORDING, WORKSPACE, MeetingFixtures, media, meeting_path)
from run import Checks, REPO, navigate, preview, select_theme


def workspace(page):
    return page.get_by_test_id("meetings-workspace")


def button(page, name):
    return workspace(page).get_by_role("button", name=name, exact=True)


def selected(page):
    return workspace(page).get_by_role("region", name="Selected meeting", exact=True)


def receipt(page):
    return workspace(page).locator('[role="status"][tabindex="-1"]')


def review(page, number):
    return workspace(page).locator('form[data-state="proposed"]').filter(has=page.get_by_text(re.compile(rf"^Review action {number}, source version \d+\.$")))


def until(page, predicate, label, timeout=20):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        page.wait_for_timeout(25)
    if not predicate():
        raise AssertionError(label)


def settle_layout(page):
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


def read_count(fixture, key):
    return sum(row["key"] == key for row in fixture.requests)


def ready(page, fixture, identity=MAIN, *, commitments=True):
    expect(workspace(page)).to_be_visible(timeout=30_000)
    expect(selected(page).get_by_role("heading", name=fixture.records[identity]["title"], exact=True)).to_be_visible()
    expect(selected(page)).to_have_attribute("aria-busy", "false")
    if commitments:
        expect(button(page, "Retry commitment review")).to_have_count(0)
    expect(button(page, "Refresh meetings")).to_be_enabled()


def refresh(page, fixture):
    count = read_count(fixture, "list")
    button(page, "Refresh meetings").click()
    until(page, lambda: read_count(fixture, "list") > count, "Meeting refresh did not start")
    expect(button(page, "Refresh meetings")).to_be_enabled()


def open_route(page, fixture, identity):
    before = fixture.calendar_count
    navigate(page, fixture.origin, meeting_path(identity))
    ready(page, fixture, identity)
    until(page, lambda: fixture.calendar_count > before, "Mounted Calendar check was not intercepted")
    expect(button(page, "Sync Calendar")).to_be_enabled()


def timeline_link(page, identity):
    return workspace(page).get_by_role("complementary", name="Meeting list", exact=True).locator(f'a[href="{meeting_path(identity)}"]')


def click_meeting(page, fixture, identity):
    before = fixture.calendar_count
    timeline_link(page, identity).click()
    expect(page).to_have_url(fixture.origin + meeting_path(identity), timeout=30_000)
    ready(page, fixture, identity)
    until(page, lambda: fixture.calendar_count > before, "Route remount did not run its intercepted Calendar check")
    expect(button(page, "Sync Calendar")).to_be_enabled()


def initial_reads(page, fixture, checks, label):
    fixture.read_plan("list", hold="initial-list", body={"error": "Synthetic first list read failed."}, status=503)
    fixture.fail("projects", "library")
    navigate(page, fixture.origin, "/app/meetings")
    until(page, lambda: "initial-list" in fixture.held, "Initial list read was not held")
    expect(workspace(page).get_by_role("region", name="Meeting overview").get_by_text("Unavailable", exact=True)).to_have_count(4)
    expect(workspace(page).get_by_text("Count unavailable", exact=True)).to_be_visible()
    checks.check(label + ": initial pending counts stay unavailable", "0 in window" not in workspace(page).inner_text())
    until(page, lambda: fixture.calendar_count >= 1, "Initial Calendar request was not intercepted")
    fixture.release("initial-list")
    expect(button(page, "Retry meeting list")).to_be_visible()
    expect(workspace(page).get_by_text("Meeting availability is unknown.", exact=True)).to_be_visible()
    expect(workspace(page).get_by_role("region", name="Meeting overview").get_by_text("Unavailable", exact=True)).to_have_count(4)
    button(page, "Retry meeting list").click()
    ready(page, fixture)
    expect(workspace(page).get_by_text("Google Calendar · unconfirmed", exact=True)).to_be_visible()
    expect(workspace(page).get_by_text("No successful calendar sync has been confirmed on this page.", exact=True)).to_be_visible()
    coverage = workspace(page).locator("details").filter(has=page.locator("summary").get_by_text("Source coverage", exact=True))
    coverage.locator("summary").click()
    expect(coverage.get_by_text("Synthetic projects unavailable.", exact=True)).to_be_visible()
    expect(coverage.get_by_text("Synthetic library unavailable.", exact=True)).to_be_visible()
    checks.check(label + ": independent ancillary failures preserve loaded meeting and review", review(page, 1).count() == 1)
    coverage.locator("summary").click()
    fixture.defaults.clear()
    refresh(page, fixture)
    ready(page, fixture)


def independent_reads(page, fixture, checks):
    fixture.fail("detail:" + MAIN)
    refresh(page, fixture)
    expect(button(page, "Retry meeting detail")).to_be_visible()
    expect(selected(page).get_by_role("heading", name=fixture.records[MAIN]["title"], exact=True)).to_be_visible()
    expect(workspace(page).get_by_text("Last loaded meeting detail.", exact=True)).to_be_visible()
    checks.check("Detail failure retains exact detail while list remains readable", timeline_link(page, OTHER).count() == 1)
    fixture.defaults.clear()
    button(page, "Retry meeting detail").click()
    ready(page, fixture)
    fixture.fail("commitments:" + MAIN)
    refresh(page, fixture)
    expect(button(page, "Retry commitment review")).to_be_visible()
    expect(review(page, 1).get_by_role("button", name="Confirm WorkItem", exact=True)).to_be_disabled()
    checks.check("Failed commitment review keeps retained proposals visibly inactive", review(page, 1).count() == 1)
    fixture.defaults.clear()
    button(page, "Retry commitment review").click()
    ready(page, fixture)
    malformed = fixture.detail()
    malformed["meeting"]["meetingId"] = OTHER
    fixture.read_plan("detail:" + MAIN, body=malformed)
    refresh(page, fixture)
    expect(button(page, "Retry meeting detail")).to_be_visible()
    checks.check("Malformed200 detail cannot replace selected identity", selected(page).get_by_role("heading", name=fixture.records[MAIN]["title"], exact=True).is_visible())
    button(page, "Retry meeting detail").click()
    ready(page, fixture)


def route_and_poll(page, fixture, checks):
    open_route(page, fixture, OUTSIDE)
    checks.check("Exact deep link loads outside the bounded list", OUTSIDE not in fixture.list_ids and timeline_link(page, OUTSIDE).count() == 0)
    click_meeting(page, fixture, OTHER)
    click_meeting(page, fixture, MAIN)
    fixture.head = media("queued")
    refresh(page, fixture)
    ready(page, fixture)
    expect(workspace(page).get_by_text("Audio is stored. Diarization, timestamping, chapters, and cited extraction are continuing in the background.", exact=True)).to_be_visible()
    before = read_count(fixture, "detail:" + MAIN)
    until(page, lambda: read_count(fixture, "detail:" + MAIN) >= before + 2, "Unchanged pending media did not continue polling twice", timeout=12)
    checks.check("Unchanged queued media continues bounded detail GETs", True)
    poisoned = fixture.detail()
    poisoned["meeting"]["title"] = "LATE_PENDING_DETAIL_MUST_NOT_APPEAR"
    fixture.read_plan("detail:" + MAIN, hold="late-media-read", body=poisoned)
    until(page, lambda: "late-media-read" in fixture.held, "Pending media read was not held", timeout=6)
    click_meeting(page, fixture, OTHER)
    fixture.head = media()
    click_meeting(page, fixture, MAIN)
    fixture.release("late-media-read")
    page.wait_for_timeout(150)
    ready(page, fixture)
    expect(workspace(page).get_by_text("LATE_PENDING_DETAIL_MUST_NOT_APPEAR", exact=True)).to_have_count(0)
    checks.check("A → B → A route remount fences a late same-ID pending-media read", True)


def synchronous_submit(page, control):
    control.evaluate("""el => {
      const form = el.form;
      el.click();
      document.querySelector('[data-testid="meetings-workspace"] button')?.focus();
      [...document.querySelectorAll('[data-testid="meetings-workspace"] button')]
        .find(button => button.textContent.trim() === 'Sync Calendar')?.click();
      form?.requestSubmit();
    }""")


def edit_lifecycle(page, fixture, checks):
    button(page, "Revise").click()
    expect(workspace(page).get_by_role("heading", name="Revise meeting", exact=True)).to_be_focused()
    title = workspace(page).get_by_label("Title", exact=True)
    title.fill("Unsaved immutable revision draft")
    submitted = fixture.draft(title="Unsaved immutable revision draft") | {"expectedRevision": 1}
    fixture.bump(MAIN, title="A newer source revision")
    refresh(page, fixture)
    expect(title).to_have_value("Unsaved immutable revision draft")
    fixture.expect_action("edit", submitted, mode="conflict", hold="frozen-edit")
    before = len(fixture.writes)
    synchronous_submit(page, button(page, "Publish revision"))
    until(page, lambda: "frozen-edit" in fixture.held, "Frozen edit was not intercepted")
    expect(title).to_be_disabled()
    expect(button(page, "Sync Calendar")).to_be_disabled()
    expect(button(page, "Cancel")).to_be_disabled()
    page.wait_for_timeout(100)
    checks.check("Frozen edit keeps original revision1 and one synchronous write slot", len(fixture.writes) == before + 1 and fixture.writes[-1]["body"] == submitted)
    fixture.release("frozen-edit")
    expect(workspace(page).get_by_role("alert")).to_contain_text("Synthetic immutable revision conflict.")
    expect(title).to_have_value("Unsaved immutable revision draft")
    expect(button(page, "Publish revision")).to_be_enabled()
    button(page, "Cancel").click()
    ready(page, fixture)
    button(page, "Revise").click()
    workspace(page).get_by_label("Title", exact=True).fill("Confirmed revised meeting")
    submitted = fixture.draft(title="Confirmed revised meeting") | {"expectedRevision": 2}
    fixture.read_plan("list", hold="accepted-list-refresh", body={"error": "Synthetic accepted-list refresh unavailable."}, status=503)
    fixture.expect_action("edit", submitted, after_fail=("list", "detail:" + MAIN, "commitments:" + MAIN))
    button(page, "Publish revision").click()
    expect(receipt(page)).to_contain_text("Meeting revision 3 confirmed.")
    expect(receipt(page)).to_be_focused()
    until(page, lambda: "accepted-list-refresh" in fixture.held, "Accepted edit follow-up GET was not held")
    expect(button(page, "New meeting")).to_be_enabled()
    checks.check("Accepted effect settles before its held follow-up GET", workspace(page).get_by_role("heading", name="Revise meeting", exact=True).count() == 0)
    fixture.release("accepted-list-refresh")
    expect(button(page, "Retry meeting list")).to_be_visible()
    expect(button(page, "Retry meeting detail")).to_be_visible()
    expect(selected(page).get_by_role("heading", name="Confirmed revised meeting", exact=True)).to_be_visible()
    expect(button(page, "New meeting")).to_be_enabled()
    expect(workspace(page).get_by_text("Last loaded: 2 in window", exact=True)).to_be_visible()
    expect(receipt(page).get_by_role("link")).to_have_attribute("href", meeting_path(MAIN))
    checks.check("Accepted edit closes saved draft and retains receipt, identity, focus and usable controls after independent read failure", True)
    fixture.defaults.clear()
    refresh(page, fixture)
    ready(page, fixture)


def create_lifecycle(page, fixture, checks):
    button(page, "New meeting").click()
    expect(workspace(page).get_by_role("heading", name="Create meeting", exact=True)).to_be_focused()
    workspace(page).get_by_label("Title", exact=True).fill("New bounded meeting")
    workspace(page).get_by_label("Starts", exact=True).fill("2026-10-04T10:00")
    workspace(page).get_by_label("Ends", exact=True).fill("2026-10-04T11:00")
    workspace(page).get_by_label("Timezone", exact=True).fill("UTC")
    body = {"title": "New bounded meeting", "summary": "", "status": "scheduled",
            "scheduledStartAt": "2026-10-04T10:00:00.000Z", "scheduledEndAt": "2026-10-04T11:00:00.000Z",
            "actualStartAt": None, "actualEndAt": None, "timezone": "UTC", "location": "", "projectId": None,
            "declaredAccessClass": "owner_private", "participants": [], "sourceLinks": [], "entityLinks": [],
            "decisions": [], "commitments": [], "followUps": []}
    fixture.expect_action("create", body, identity=CREATED, after_fail=("list", "detail:" + CREATED, "commitments:" + CREATED))
    button(page, "Create meeting").click()
    expect(receipt(page)).to_contain_text("Meeting creation confirmed.")
    expect(receipt(page)).to_be_focused()
    expect(selected(page).get_by_role("heading", name="New bounded meeting", exact=True)).to_be_visible()
    expect(receipt(page).get_by_role("link")).to_have_attribute("href", meeting_path(CREATED))
    expect(workspace(page).get_by_role("heading", name="Create meeting", exact=True)).to_have_count(0)
    checks.check("Accepted creation retains new selection and its permanent destination while refresh is unavailable", True)
    fixture.defaults.clear()
    before = fixture.calendar_count
    receipt(page).get_by_role("link").click()
    expect(page).to_have_url(fixture.origin + meeting_path(CREATED), timeout=30_000)
    ready(page, fixture, CREATED)
    until(page, lambda: fixture.calendar_count > before, "Created permanent route did not mount")
    expect(receipt(page)).to_have_count(0)
    click_meeting(page, fixture, MAIN)


def proposal_lifecycle(page, fixture, checks):
    form = review(page, 1)
    form.get_by_label("Confirmed owner", exact=True).select_option(GUEST)
    form.get_by_label("Confirmed due date · optional", exact=True).fill("2026-10-05T14:00")
    refresh(page, fixture)
    ready(page, fixture)
    expect(form.get_by_label("Confirmed owner", exact=True)).to_have_value(GUEST)
    expect(form.get_by_label("Confirmed due date · optional", exact=True)).to_have_value("2026-10-05T14:00")
    # A passive detail retry must preserve the user's current review field focus.
    fixture.fail("detail:" + MAIN)
    refresh(page, fixture)
    expect(button(page, "Retry meeting detail")).to_be_visible()
    fixture.defaults.clear()
    fixture.read_plan("detail:" + MAIN, hold="focus-detail")
    button(page, "Retry meeting detail").click()
    until(page, lambda: "focus-detail" in fixture.held, "Detail retry was not held")
    form.get_by_label("Confirmed due date · optional", exact=True).focus()
    fixture.release("focus-detail")
    ready(page, fixture)
    expect(form.get_by_label("Confirmed due date · optional", exact=True)).to_be_focused()
    checks.check("Same-digest refresh preserves local review values and passive reads keep field focus", True)
    fixture.proposals[0] = fixture.proposal(1, version=2)
    refresh(page, fixture)
    ready(page, fixture)
    expect(review(page, 1).get_by_text("Review action 1, source version 2.", exact=True)).to_be_visible()
    expect(review(page, 1).get_by_label("Confirmed owner", exact=True)).to_have_value(OWNER)
    expect(review(page, 1).get_by_label("Confirmed due date · optional", exact=True)).to_have_value("")
    checks.check("Same-ID changed proposal digest starts a fresh confirmation draft", True)
    body = {"mediaRevisionId": MEDIA, "actionItemId": "action:3"}
    fixture.expect_action("propose", body, mode="mismatch")
    button(page, "Propose as work").click()
    expect(workspace(page).get_by_role("alert")).to_contain_text("The proposal receipt does not match the submitted evidence.")
    expect(review(page, 3)).to_have_count(0)
    fixture.expect_action("propose", body)
    button(page, "Propose as work").click()
    expect(receipt(page)).to_contain_text("Proposal proposal:3 confirmed.")
    ready(page, fixture)
    expect(review(page, 3)).to_be_visible()
    checks.check("Explicit proposal uses exact media/action identity and rejects an unrelated receipt", True)


def decisions(page, fixture, checks):
    form = review(page, 1)
    form.get_by_label("Also prepare an unsent, governed follow-up email", exact=True).check()
    form.get_by_label("Subject", exact=True).fill(" Exact follow-up subject ")
    form.get_by_label("Message", exact=True).fill(" Exact recipient-bound draft body.\nNo message is sent. ")
    expect(form.get_by_text(re.compile(r"^Exact recipient: Review owner"))).to_be_visible()
    communication = {"policyId": POLICY, "recipientParticipantId": OWNER, "subject": " Exact follow-up subject ",
                     "body": " Exact recipient-bound draft body.\nNo message is sent. "}
    body = fixture.resolution_body(communication=communication)
    fixture.expect_action("resolve", body, mode="wrong_draft")
    form.get_by_role("button", name="Confirm WorkItem + draft", exact=True).click()
    expect(workspace(page).get_by_role("alert")).to_contain_text("The governed draft receipt does not match its submitted recipient or content.")
    expect(form.get_by_label("Message", exact=True)).to_have_value(communication["body"])
    checks.check("Mismatched draft200 cannot claim confirmation or erase review values", workspace(page).get_by_text("Confirmed commitment", exact=True).count() == 0)
    fixture.expect_action("resolve", body, hold="confirmed-decision", after_fail=("list", "detail:" + MAIN, "commitments:" + MAIN))
    form.get_by_role("button", name="Confirm WorkItem + draft", exact=True).click()
    until(page, lambda: "confirmed-decision" in fixture.held, "Decision was not held")
    expect(form.get_by_label("Message", exact=True)).to_be_disabled()
    expect(form.get_by_role("button", name="Dismiss", exact=True)).to_be_disabled()
    expect(button(page, "Sync Calendar")).to_be_disabled()
    fixture.release("confirmed-decision")
    expect(receipt(page)).to_contain_text("WorkItem work:browser-1; unsent draft draft:browser-1; recipient " + EMAIL)
    expect(receipt(page)).to_contain_text("Returned draft recipient and content match the submitted review.")
    expect(receipt(page)).to_be_focused()
    expect(workspace(page).get_by_text("Confirmed commitment", exact=True)).to_be_visible()
    expect(button(page, "Retry commitment review")).to_be_visible()
    expect(button(page, "New meeting")).to_be_enabled()
    checks.check("Exact decision receipt survives failed reads; accepted work and unsent draft are separate from read freshness", True)
    fixture.defaults.clear()
    # A successful but old unresolved projection is also insufficient to erase an accepted decision.
    stale = fixture.commitment_read()
    stale["commitments"][0]["resolution"] = None
    fixture.read_plan("commitments:" + MAIN, body=stale)
    button(page, "Retry commitment review").click()
    expect(button(page, "Retry commitment review")).to_be_enabled()
    expect(selected(page).get_by_text("The latest read has not confirmed the accepted commitment receipt. Its confirmed result is retained.", exact=True)).to_be_visible()
    expect(workspace(page).get_by_text("Confirmed commitment", exact=True)).to_be_visible()
    checks.check("An unresolved follow-up projection cannot replace a confirmed resolution", True)
    refresh(page, fixture)
    ready(page, fixture)
    fixture.expect_action("resolve", fixture.resolution_body(2, "dismissed"))
    review(page, 2).get_by_role("button", name="Dismiss", exact=True).click()
    expect(receipt(page)).to_contain_text("Proposal proposal:2 dismissal confirmed.")
    expect(workspace(page).get_by_text("Dismissed proposal", exact=True)).to_be_visible()
    ready(page, fixture)
    checks.check("Dismissal sends only exact proposal/digest/decision and creates no work or draft", fixture.writes[-1]["body"] == fixture.resolution_body(2, "dismissed"))


def media_and_calendar(page, fixture, checks):
    fixture.head = None
    people = copy.deepcopy(fixture.records[MAIN]["participants"])
    people[1]["recordingConsent"] = "unknown"
    fixture.bump(MAIN, participants=people)
    refresh(page, fixture)
    ready(page, fixture)
    expect(button(page, "Process recording")).to_be_disabled()
    expect(workspace(page).get_by_text("Every participant must explicitly grant recording consent or have consent marked not required.", exact=True)).to_be_visible()
    checks.check("Unknown participant consent blocks media processing locally", True)
    people[1]["recordingConsent"] = "granted"
    fixture.bump(MAIN, participants=copy.deepcopy(people))
    refresh(page, fixture)
    ready(page, fixture)
    body = {"meetingId": MAIN, "workspaceId": WORKSPACE, "rawAudioRetention": {"mode": "retain"}}
    fixture.expect_action("media", body, mode="mismatch")
    button(page, "Process recording").click()
    expect(workspace(page).get_by_role("alert")).to_contain_text("The processing receipt does not match the selected recording and meeting.")
    expect(button(page, "Process recording")).to_be_enabled()
    fixture.expect_action("media", body, after_fail=("detail:" + MAIN,))
    button(page, "Process recording").click()
    expect(receipt(page)).to_contain_text(f"Recording {RECORDING}: queued confirmed.")
    expect(receipt(page)).to_contain_text("Processing continues independently of this page.")
    expect(workspace(page).get_by_text("job:meeting-media", exact=True)).to_be_visible()
    checks.check("Only exact recording/meeting/job receipt enables confirmed background-processing feedback", True)
    fixture.defaults.clear()
    fixture.head = media()
    refresh(page, fixture)
    ready(page, fixture)
    for state, expected in (("syncing", "Calendar sync is continuing. 2 changes imported so far."),
                            ("error", "Google Calendar could not be synchronized. Check Connections."),
                            ("healthy", "2 calendar changes synchronized.")):
        fixture.calendar_plans.append({"body": {"provider": "google", "sources": [{"source": "calendar", "status": state, "imported": 2}]}})
        button(page, "Sync Calendar").click()
        calendar = workspace(page).get_by_role("status").filter(has=page.get_by_text("Google Calendar · " + state, exact=True))
        expect(calendar.get_by_text(expected, exact=True)).to_be_visible()
        expect(button(page, "Sync Calendar")).to_be_enabled()
        ready(page, fixture)
        checks.check("Calendar " + state + " receipt has distinct truthful feedback", True)


def disposal(page, fixture, checks):
    fixture.expect_action("resolve", fixture.resolution_body(3, "dismissed"), hold="disposed-decision")
    review(page, 3).get_by_role("button", name="Dismiss", exact=True).click()
    until(page, lambda: "disposed-decision" in fixture.held, "Disposal decision was not held")
    click_meeting(page, fixture, OTHER)
    fixture.release("disposed-decision")
    page.wait_for_timeout(150)
    ready(page, fixture, OTHER)
    expect(receipt(page)).to_have_count(0)
    expect(workspace(page).get_by_text("Proposal proposal:3 dismissal confirmed.", exact=True)).to_have_count(0)
    checks.check("Late effect receipt cannot enter a different route or release its action state", True)


def visual_checks(page, fixture, checks, coarse):
    label = "phone" if coarse else "desktop"
    root = workspace(page)
    for summary in ("Meeting identity and access", "Exact source identity"):
        root.locator("summary").get_by_text(summary, exact=True).click()
    citation = root.get_by_role("group", name="Transcript citations", exact=True).first
    citation.locator("summary").first.click()
    for theme in ("light", "dark"):
        select_theme(page, theme, coarse)
        settle_layout(page)
        checks.snapshot(page, f"meetings-{label}-{theme}", coarse)
    checks.check(label + ": full source identities remain selectable", root.locator("code").filter(has_text=LONG).first.evaluate("el=>getComputedStyle(el).userSelect!=='none'"))
    checks.check(label + ": literal evidence markup cannot execute", page.evaluate("window.untrustedMeetingRan !== true"))
    checks.check(label + ": interactive control target floor", root.locator("button:visible,a:visible,summary:visible").evaluate_all(
        "(els,min)=>els.every(el=>el.getBoundingClientRect().height>=min-1)", 48 if coarse else 44))
    button(page, "Revise").click()
    workspace(page).get_by_label("Summary", exact=True).fill("Local editor draft remains private to this route.")
    settle_layout(page)
    checks.snapshot(page, f"meetings-{label}-editor", coarse)
    button(page, "Cancel").click()
    ready(page, fixture)


def empty_and_read_disposal(page, fixture, checks, coarse):
    fixture.list_ids = []
    navigate(page, fixture.origin, "/app/meetings")
    expect(workspace(page).get_by_text("No meetings were returned in this readable window.", exact=True)).to_be_visible()
    expect(workspace(page).get_by_role("region", name="Meeting overview").get_by_text("0", exact=True)).to_have_count(4)
    checks.check("Successful bounded empty read establishes zero distinctly from initial failure", True)
    fixture.read_plan("list", hold="disposed-list", body={"error": "LATE_LIST_ERROR_MUST_NOT_APPEAR"}, status=503)
    button(page, "Refresh meetings").click()
    until(page, lambda: "disposed-list" in fixture.held, "Disposal list read was not held")
    fixture.leaving_for_assistant = True
    page.get_by_role("navigation", name="Everyday workspace navigation" if coarse else "Application navigation", exact=True).get_by_role("link", name="Assistant", exact=True).click()
    expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=30_000)
    fixture.release("disposed-list")
    page.wait_for_timeout(100)
    expect(workspace(page)).to_have_count(0)
    expect(page.get_by_text("LATE_LIST_ERROR_MUST_NOT_APPEAR", exact=True)).to_have_count(0)
    checks.check("Unmounted list read cannot restore Meetings state", True)


def exercise(browser, origin, credentials, checks, coarse):
    label, errors = ("phone" if coarse else "desktop"), []
    context = browser.new_context(viewport={"width": 390 if coarse else 1440, "height": 844 if coarse else 900},
                                  timezone_id="UTC", has_touch=coarse, service_workers="block", reduced_motion="reduce")
    fixture, page = None, None
    try:
        login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90_000)
        checks.check(label + ": real isolated login", login.ok)
        session_response = context.request.get(origin + "/api/auth/session", timeout=90_000)
        session = session_response.json()
        scope = session.get("context", {})
        checks.check(label + ": fixture scope comes from authenticated session", session_response.ok and session.get("authenticated") is True and bool(scope.get("tenantId") and scope.get("actorId")))
        fixture = MeetingFixtures(origin, scope["tenantId"], scope["actorId"])
        context.route("**/*", fixture.route)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("popup", lambda popup: (fixture.unexpected.append({"kind": "popup"}), popup.close()))
        page.on("download", lambda download: (fixture.unexpected.append({"kind": "download"}), download.cancel()))
        initial_reads(page, fixture, checks, label)
        visual_checks(page, fixture, checks, coarse)
        if coarse:
            create_lifecycle(page, fixture, checks)
            open_route(page, fixture, OUTSIDE)
            checks.check("Phone deep link retains outside-window selection", timeline_link(page, OUTSIDE).count() == 0)
        else:
            independent_reads(page, fixture, checks)
            route_and_poll(page, fixture, checks)
            edit_lifecycle(page, fixture, checks)
            create_lifecycle(page, fixture, checks)
            proposal_lifecycle(page, fixture, checks)
            decisions(page, fixture, checks)
            media_and_calendar(page, fixture, checks)
            disposal(page, fixture, checks)
        empty_and_read_disposal(page, fixture, checks, coarse)
        checks.check(label + ": every declared effect is consumed locally", not fixture.actions and not fixture.calendar_plans)
        checks.check(label + ": no unexpected request, popup, download or real effect", not fixture.unexpected, fixture.unexpected)
        checks.check(label + ": no uncaught browser errors", not errors, errors)
        return {"viewport": label, "scope": {key: scope[key] for key in ("tenantId", "actorId")}, "reads": fixture.requests, "writes": fixture.writes,
                "releases": fixture.releases, "unexpected": fixture.unexpected, "errors": errors}
    except Exception:
        if page is not None and not page.is_closed():
            page.screenshot(path=str(checks.output / f"{label}-failure.png"), full_page=False)
            (checks.output / f"{label}-failure-dom.html").write_text(page.content())
        if fixture:
            (checks.output / f"{label}-failure-requests.json").write_text(json.dumps({"reads": fixture.requests,
                "writes": fixture.writes, "held": list(fixture.held), "pendingActions": list(fixture.actions),
                "unexpected": fixture.unexpected, "errors": errors}, indent=2))
        raise
    finally:
        if fixture:
            fixture.abort_held()
        if page is not None and not page.is_closed():
            page.goto("about:blank")
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "test-results/meetings")
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--axe", required=True, type=Path)
    args = parser.parse_args()
    if not args.axe.is_file():
        parser.error("--axe must name a local axe.min.js file")
    args.output.mkdir(parents=True, exist_ok=True)
    checks = Checks(args.output, args.axe.resolve())
    contexts, failure = [], None
    try:
        with preview(args.output) as (origin, credentials), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome) if args.chrome else None)
            try:
                for coarse in (False, True):
                    contexts.append(exercise(browser, origin, credentials, checks, coarse))
            finally:
                browser.close()
    except Exception as error:
        failure = str(error)
        print(f"Meetings browser check failed: {failure}", flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps({"checks": checks.results, "contexts": contexts,
            "failure": failure, "boundary": "Real isolated login, actual Meetings routes and deep links; bounded synthetic GETs and exact wholly intercepted Calendar/create/edit/media/proposal/decision writes. No Calendar/provider/media execution or real WorkItem/draft creation. Read-only role denial, server authorization and stored persistence remain covered by separate unit/route tests."}, indent=2))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
