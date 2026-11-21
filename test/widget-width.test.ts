import assert from "node:assert/strict";
import test from "node:test";
import { paint, PREFERRED_LINE_CHARS, statusLine } from "../src/chrome.ts";
import { displayColumns } from "../src/text.ts";
import { PULSE_VERSION } from "../src/version.ts";

type Render = (width?: number) => string[];
type WidgetContent = string[] | undefined | ((tui: unknown, theme: object) => { render: Render });

/** Independent column count: CJK, Hangul, fullwidth and pictographic emoji take two columns. */
function columns(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f || cp === 0x200d) continue;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      cp === 0x2705 ||
      cp === 0x2728;
    n += wide ? 2 : 1;
  }
  return n;
}

/** Paint through the widget surface and return its component's render(width). */
function widgetFor(line: string): Render {
  let render: Render | undefined;
  const ui = {
    setStatus() {},
    setWidget(_key: string, content: WidgetContent) {
      if (typeof content === "function") render = content(null, {}).render;
    },
  };
  paint(ui, { surface: "widget", placement: "belowEditor" }, line);
  assert.ok(render, "widget was not painted");
  return render;
}

const MARK = "pulse · ";
const VERSION_MARK = `pulse · ${PULSE_VERSION} · `;

/** Fits the columns, keeps the mark, and drops only whole trailing words. */
function assertFinished(original: string, rendered: string, width: number, mark = MARK): void {
  assert.ok(columns(rendered) <= width, `${JSON.stringify(rendered)} is ${columns(rendered)} columns, over ${width}`);
  if (rendered === "" || rendered === "pulse") return;
  assert.ok(rendered.startsWith(mark), `${JSON.stringify(rendered)} lost its mark`);
  const want = original.slice(mark.length).split(" ");
  const got = rendered.slice(mark.length).split(" ");
  assert.ok(got.length >= 1 && got[0] !== "", `${JSON.stringify(rendered)} has an empty body`);
  assert.deepEqual(got, want.slice(0, got.length), `${JSON.stringify(rendered)} cut a word`);
}

test("a narrow pane gets a finished phrase, not a column-cut word", () => {
  const line = "pulse · Reviewing the release gate";
  const render = widgetFor(line);
  const narrow = render(20)[0] ?? "";
  assertFinished(line, narrow, 20);
  assert.equal(narrow, "pulse · Reviewing");
});

test("the same widget refits on resize", () => {
  const line = "pulse · Reviewing the release gate";
  const render = widgetFor(line);
  assert.equal(render(80)[0], line);
  assert.equal(render(34)[0], line);
  for (let width = 5; width <= 40; width += 1) assertFinished(line, render(width)[0] ?? "", width);
  assert.equal(render(80)[0], line, "widening restores the full line");
});

test("CJK content fits by display columns, not string length", () => {
  const body = "設定 ファイル 更新 確認 完了 次へ 移動 検証 実行 終了 保存 送信 準備 調整 公開";
  const line = statusLine(body);
  assert.ok(line.length <= PREFERRED_LINE_CHARS);
  assert.ok(columns(line) <= PREFERRED_LINE_CHARS, `${columns(line)} columns`);
  assertFinished(`${MARK}${body}`, line, PREFERRED_LINE_CHARS);

  const render = widgetFor(line);
  for (const width of [12, 20, 30, 45]) assertFinished(`${MARK}${body}`, render(width)[0] ?? "", width);
});

test("emoji content fits by display columns", () => {
  const line = "pulse · ✅ lint ✅ tests ✅ types ✨ docs 🚀 release";
  const render = widgetFor(line);
  for (let width = 10; width <= 50; width += 1) assertFinished(line, render(width)[0] ?? "", width);
  assert.equal(render(columns(line))[0], line);
});

test("the version prefix still leaves a fitted body", () => {
  const line = statusLine("Reviewing the release gate", { showVersion: true });
  assert.equal(line, `${VERSION_MARK}Reviewing the release gate`);
  const render = widgetFor(line);
  const narrow = render(30)[0] ?? "";
  assertFinished(line, narrow, 30, VERSION_MARK);
  assert.equal(narrow, `${VERSION_MARK}Reviewing`);
});

test("keycap sequences take two display columns", () => {
  assert.equal(displayColumns("1️⃣"), 2, "digit + VS16 + keycap is emoji presentation");
  const line = "pulse · 1️⃣ first 2️⃣ second";
  const render = widgetFor(line);
  for (const width of [10, 14, 20, 40]) {
    const out = render(width)[0] ?? "";
    assert.ok(displayColumns(out) <= width, `${JSON.stringify(out)} is ${displayColumns(out)} columns, over ${width}`);
  }
});
