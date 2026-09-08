import asyncio
import os
from pathlib import Path

from playwright.async_api import async_playwright


# The web build exercises only the responsive login surface. Asael native
# authentication intentionally rejects non-Android/iOS platforms; signed-in
# phone surfaces are covered by Flutter widget tests instead.


BASE_URL = os.environ.get("ASAEL_VISUAL_URL", "http://127.0.0.1:7357")
OUTPUT = Path(".design/flutter-app/screenshots")


async def capture_login(browser, name, width, height, color_scheme):
    page = await browser.new_page(
        viewport={"width": width, "height": height},
        color_scheme=color_scheme,
        reduced_motion="no-preference",
    )
    errors = []
    page.on(
        "console",
        lambda message: errors.append(message.text)
        if message.type == "error" and "ERR_CONNECTION_REFUSED" not in message.text
        else None,
    )
    await page.goto(BASE_URL, wait_until="networkidle")
    await page.locator("flutter-view").wait_for(timeout=90_000)
    await page.wait_for_timeout(750)
    await page.screenshot(path=OUTPUT / f"{name}.png", full_page=True)
    assert not errors, f"{name}: {'; '.join(errors)}"
    await page.close()


async def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        for case in [
            ("login-light-phone", 390, 844, "light"),
            ("login-dark-phone", 390, 844, "dark"),
            ("login-light-desktop", 1440, 960, "light"),
            ("login-dark-desktop", 1440, 960, "dark"),
        ]:
            await capture_login(browser, *case)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
