#!/usr/bin/env python3
"""One real composer flow; all capture effects are synthetic and intercepted."""
import argparse
import json
from pathlib import Path
from urllib.parse import unquote, urlsplit

from playwright.sync_api import expect, sync_playwright

from fixtures import Fixtures, THREAD_ID, STAMP
from atlas_fixtures import AtlasFixtures, ROOT as ATLAS_ROOT
from run import preview, navigate


def library_item(asset, title):
    return {"schemaVersion": 1, "id": f"library:capture_asset:{asset}", "tenantId": "browser-review", "kind": "file",
            "sourceAuthority": "capture_asset", "sourceId": asset, "title": title, "summary": "Synthetic attachment", "sourceLabel": "Capture", "status": "ready", "tags": [],
            "scope": {"visibility": "user_private", "ownerActorId": "synthetic", "workspaceId": None, "projectId": None, "missionId": None, "workItemId": None, "permissionBasis": "owner"},
            "currentVersion": {"versionId": f"version:capture_asset:{asset}:hash", "versionNumber": 1, "contentSha256": "a" * 64, "byteCount": 6, "mediaType": "text/plain", "sourceRevisionId": None, "createdAt": STAMP},
            "versionCount": 1, "citationRefs": [f"capture-asset:{asset}"], "links": [], "openHref": "/app/capture", "createdAt": STAMP, "updatedAt": STAMP}


class UploadFixtures(Fixtures):
    def __init__(self, origin):
        super().__init__(origin)
        self.uploads = []
        self.asset_reads = []
        self.catalog_reads = 0

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin:
            return super().route(route)
        path = unquote(parsed.path)
        if path == "/api/capture" and request.method == "POST":
            body = request.post_data_buffer or b""
            first = b'filename="first.txt"' in body
            second = b'filename="second.txt"' in body
            key = request.headers.get("idempotency-key", "")
            if first == second or not key.startswith("command-attachment-") or len(self.uploads) >= 3:
                raise AssertionError("Unexpected capture request")
            self.uploads.append({"file": "first" if first else "second", "key": key})
            if len(self.uploads) == 2:
                return self.fulfill(route, {"error": "Synthetic second-file transport failure"}, 503)
            return self.fulfill(route, {"asset": {"id": "reliability-first" if first else "reliability-second"}}, 201)
        if path.startswith("/api/library/library:capture_asset:") and request.method == "GET":
            asset = path.rsplit(":", 1)[1]
            if asset not in ("reliability-first", "reliability-second"):
                raise AssertionError("Unexpected attachment identity")
            self.asset_reads.append(asset)
            return self.fulfill(route, {"item": library_item(asset, "First synthetic file" if asset.endswith("first") else "Second synthetic file")})
        if path == "/api/command/catalog":
            self.catalog_reads += 1
        return super().route(route)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--chrome", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {"boundary": "Isolated real authentication/SSR; three intercepted capture POSTs; no provider or production changes."}
    try:
        # The repository preview explicitly excludes credentials/dotenv and owns
        # a temporary bootstrap store, unlike an ambient generic dev command.
        with preview(args.output) as (origin, credentials), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=str(args.chrome))
            try:
                context = browser.new_context(viewport={"width": 1440, "height": 1000}, service_workers="block", reduced_motion="reduce")
                login = context.request.post(origin + "/api/auth/login", data=credentials, headers={"Origin": origin}, timeout=90000)
                assert login.ok, "Isolated authentication failed"
                fixture = UploadFixtures(origin)
                context.route("**/*", fixture.route)
                context.route(origin + ATLAS_ROOT + "**", AtlasFixtures(origin).route)
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                navigate(page, origin, f"/app/command?thread={THREAD_ID}")
                expect(page.locator('textarea[role="combobox"]')).to_be_visible(timeout=90000)
                # Inspect the hydrated UI before choosing its actual controls.
                (args.output / "initial-controls.txt").write_text(page.locator("button,input[type=file]").evaluate_all("els => els.map(el => ({role:el.tagName,label:el.getAttribute('aria-label'),text:el.textContent})).map(x=>JSON.stringify(x)).join('\\n')"))
                picker = page.get_by_label("Attach files to conversation", exact=True)
                expect(picker).to_be_enabled(timeout=30000)
                catalog_before = fixture.catalog_reads
                picker.set_input_files([
                    {"name": "first.txt", "mimeType": "text/plain", "buffer": b"Synthetic first file"},
                    {"name": "second.txt", "mimeType": "text/plain", "buffer": b"Synthetic second file"},
                ])
                expect(page.get_by_role("button", name="Retry remaining upload", exact=True)).to_be_visible(timeout=30000)
                expect(page.get_by_role("button", name="Remove First synthetic file", exact=True)).to_be_visible(timeout=30000)
                page.screenshot(path=str(args.output / "partial-upload.png"))
                page.get_by_role("button", name="Retry remaining upload", exact=True).click()
                expect(page.get_by_role("button", name="Remove Second synthetic file", exact=True)).to_be_visible(timeout=30000)
                expect(page.get_by_role("button", name="Remove First synthetic file", exact=True)).to_be_visible()
                expect(page.get_by_role("button", name="Retry remaining upload", exact=True)).to_have_count(0)
                expect(picker).to_be_enabled()
                assert [row["file"] for row in fixture.uploads] == ["first", "second", "second"]
                assert fixture.uploads[1]["key"] == fixture.uploads[2]["key"] != fixture.uploads[0]["key"]
                assert set(fixture.asset_reads) == {"reliability-first", "reliability-second"}
                assert fixture.catalog_reads == catalog_before, "Readiness loaded the unrelated catalog"
                assert not fixture.unexpected, fixture.unexpected
                assert not errors, errors
                page.screenshot(path=str(args.output / "recovered-upload.png"))
                report.update(passed=True, retainedFirst=True, sameKeyRetry=True, exactReadiness=True,
                              catalogReadinessRequests=0, interceptedUploads=fixture.uploads, assetReads=fixture.asset_reads, pageErrors=errors)
            finally:
                browser.close()
    except Exception as error:
        report.update(passed=False, failure=str(error))
    finally:
        (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ("passed", "failure") if key in report}))
    return 0 if report.get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
