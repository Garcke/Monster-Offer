"""Headless browser smoke checks for the Meeting-Monster workspace."""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright


EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
BASE_URL = "http://127.0.0.1:9000/"
ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"


def main() -> None:
    page_errors: list[str] = []
    result: dict[str, object] = {}
    ARTIFACT_DIR.mkdir(exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=str(EDGE_PATH),
        )
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto(BASE_URL, wait_until="networkidle")
        page.locator("#modelStatus").wait_for()
        page.wait_for_function(
            "document.querySelector('#modelStatus').textContent.includes('local-model')"
        )

        interview_box = page.locator("#interviewPane").bounding_box()
        answer_box = page.locator("#answerPane").bounding_box()
        assert interview_box and answer_box
        assert abs(interview_box["y"] - answer_box["y"]) < 2
        ratio = interview_box["width"] / (interview_box["width"] + answer_box["width"])
        assert 0.31 <= ratio <= 0.37, ratio
        assert page.locator("#modelConfigButton").count() == 0
        assert page.locator("#modelConfigModal").count() == 0
        assert page.locator("#modelStatus").inner_text() == "Generic OpenAI Compatible · local-model"
        page.screenshot(path=str(ARTIFACT_DIR / "meeting-monster-desktop.png"), full_page=True)

        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(150)
        assert page.locator("#mobileTabs").is_visible()
        assert page.locator("#interviewPane").is_visible()
        assert not page.locator("#answerPane").is_visible()
        page.locator('[data-panel="answer"]').click()
        assert not page.locator("#interviewPane").is_visible()
        assert page.locator("#answerPane").is_visible()
        page.screenshot(path=str(ARTIFACT_DIR / "meeting-monster-mobile.png"), full_page=True)

        result = {
            "title": page.title(),
            "desktop_left_ratio": round(ratio, 3),
            "model_status": "Generic OpenAI Compatible · local-model",
            "mobile_active_panel": "answer",
            "page_errors": page_errors,
        }
        browser.close()

    assert not page_errors, page_errors
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
